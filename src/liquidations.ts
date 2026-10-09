/**
 * Aave V3 liquidation monitor (upgrade 4) — paper mode.
 *
 * Liquidations are a separate, legitimate profit source: when a borrower's
 * health factor (HF) drops below 1, anyone may repay part of their debt and
 * receive the same value of collateral plus a bonus (typically 4-10%).
 *
 * What this does every block:
 *   1. Reads the Aave Pool's Borrow and LiquidationCall events for the new
 *      block: new borrowers join the watch list (persisted to
 *      data/aave-borrowers.json so it grows across runs); liquidations by
 *      other bots resolve our pending candidates as "taken".
 *   2. Checks health factors with getUserAccountData in one multicall —
 *      borrowers near the line (HF < 1.10) every LIQ_CHECK_EVERY blocks,
 *      everyone else 12x less often.
 *   3. For each HF < 1 position, reads the user's per-reserve balances and
 *      oracle prices, picks the most valuable debt and collateral reserves and
 *      estimates the profit of liquidating:
 *        close factor  100% if HF <= 0.95 or either side < $2,000, else 50%
 *                      (Aave v3.3+ LiquidationLogic)
 *        repay         min(debt x close factor, collateral / bonus)
 *        gross bonus   repay x (bonus - 1), minus Aave's protocol share
 *        costs         collateral -> debt swap (LIQ_SWAP_COST_BPS), gas;
 *                      the flash loan is from Morpho (free)
 *   4. Records the candidate in data/liquidations.jsonl and, a few blocks
 *      later, its outcome: taken (by whom), recovered (HF back above 1), or
 *      open (nobody liquidated it — we would have).
 *
 * Simplifications, stated so the numbers are read correctly: E-mode bonuses
 * use the reserve's normal bonus, isolated-mode debt ceilings are ignored,
 * and the swap cost is a flat estimate rather than a quoted route. Execution
 * (a liquidation contract) is the next step once these numbers look real.
 */
import { AbiCoder, type Log } from "ethers";
import { AAVE_V3 } from "./config.js";
import { TOPIC_AAVE_BORROW, TOPIC_AAVE_LIQUIDATION, aaveDataProviderIface, aaveOracleIface, aavePoolIface, erc20Iface } from "./abi.js";
import type { Chain, Call } from "./rpc.js";
import type { LiquidatablePosition } from "./liquidate.js";
import type { Store } from "./store.js";
import { log } from "./log.js";

const abi = AbiCoder.defaultAbiCoder();
export const LIQ_FILE = "liquidations.jsonl";
const BORROWERS_FILE = "aave-borrowers.json";
const ONE = 10n ** 18n;

export interface LiqOpportunityRecord {
  kind: "liq-opportunity";
  id: string;
  block: number;
  foundAt: string;
  user: string;
  healthFactor: number;
  debtAsset: string;
  debtSymbol: string;
  collateralAsset: string;
  collateralSymbol: string;
  debtUsd: number;
  collateralUsd: number;
  closeFactor: number;
  repayUsd: number;
  bonusPct: number;
  grossBonusUsd: number;
  protocolFeeUsd: number;
  swapCostUsd: number;
  gasUsd: number;
  estProfitUsd: number;
}

export interface LiqOutcomeRecord {
  kind: "liq-outcome";
  id: string;
  block: number;
  finalizedAt: string;
  status: "taken" | "recovered" | "open";
  takenBy?: string;
  takenTx?: string;
  takenBlock?: number;
  /** What we would realistically have banked: estProfitUsd if still open, else 0. */
  realisticProfitUsd: number;
}

interface ReserveMeta {
  asset: string;
  symbol: string;
  decimals: number;
  bonusBps: number;
  protocolFeeBps: number;
}

interface Borrower {
  firstSeen: number;
  lastChecked: number;
  hf: number | null;
}

interface PendingLiq {
  rec: LiqOpportunityRecord;
  checks: number;
}

export interface LiqOptions {
  lookbackBlocks: number;
  checkEvery: number;
  swapCostBps: number;
  gasUnits: number;
  /** Minimum debt in USD for a position to be worth evaluating. */
  minDebtUsd: number;
  outcomeBlocks: number;
}

export class LiquidationMonitor {
  private borrowers = new Map<string, Borrower>();
  private reserves = new Map<string, ReserveMeta>();
  private pending = new Map<string, PendingLiq>();
  private lastLogBlock = 0;
  private logRange = 500;
  private dirtyBorrowers = false;
  stats = { checks: 0, liquidatable: 0, recorded: 0 };
  /** Live sender hook: called with each profitable liquidatable position (set by main only when live). */
  onLiquidatable?: (pos: LiquidatablePosition) => void;

  constructor(readonly chain: Chain, readonly store: Store, readonly opts: LiqOptions) {}

  get watched(): number {
    return this.borrowers.size;
  }

  async init(block: number): Promise<void> {
    const saved = this.store.readJson<{ lastBlock: number; borrowers: string[] }>(BORROWERS_FILE);
    if (saved) {
      for (const b of saved.borrowers) this.borrowers.set(b, { firstSeen: saved.lastBlock, lastChecked: 0, hf: null });
      this.lastLogBlock = saved.lastBlock;
    }
    await this.loadReserves();
    // Backfill borrowers from recent Borrow events (bounded so startup stays quick).
    const from = Math.max(this.lastLogBlock + 1, block - this.opts.lookbackBlocks);
    await this.scanLogs(from, block);
    log.info(`liquidations: watching ${this.borrowers.size} Aave V3 borrowers across ${this.reserves.size} reserves`);
  }

  private async loadReserves(): Promise<void> {
    const raw = await this.chain.call(AAVE_V3.pool, aavePoolIface.encodeFunctionData("getReservesList"));
    const assets = (aavePoolIface.decodeFunctionResult("getReservesList", raw)[0] as string[]).map((a) => a.toLowerCase());
    const calls: Call[] = [];
    for (const a of assets) {
      calls.push({ target: AAVE_V3.dataProvider, callData: aaveDataProviderIface.encodeFunctionData("getReserveConfigurationData", [a]) });
      calls.push({ target: AAVE_V3.dataProvider, callData: aaveDataProviderIface.encodeFunctionData("getLiquidationProtocolFee", [a]) });
      calls.push({ target: a, callData: erc20Iface.encodeFunctionData("symbol") });
    }
    const res = await this.chain.multicall(calls);
    assets.forEach((a, i) => {
      const rc = res[i * 3]!;
      const rf = res[i * 3 + 1]!;
      const rs = res[i * 3 + 2]!;
      if (!rc.success) return;
      const cfg = aaveDataProviderIface.decodeFunctionResult("getReserveConfigurationData", rc.returnData);
      let symbol = a.slice(0, 8);
      try {
        if (rs.success) symbol = abi.decode(["string"], rs.returnData)[0] as string;
      } catch {
        /* bytes32 symbol */
      }
      this.reserves.set(a, {
        asset: a,
        symbol,
        decimals: Number(cfg[0]),
        bonusBps: Number(cfg[3]),
        protocolFeeBps: rf.success && rf.returnData.length >= 66 ? Number(abi.decode(["uint256"], rf.returnData)[0]) : 1000,
      });
    });
  }

  /** Borrow + LiquidationCall events in [from, to], shrinking the window if the RPC caps eth_getLogs. */
  private async scanLogs(from: number, to: number): Promise<Array<{ user: string; liquidator: string; tx: string; block: number }>> {
    const liquidations: Array<{ user: string; liquidator: string; tx: string; block: number }> = [];
    let start = from;
    while (start <= to) {
      const end = Math.min(to, start + this.logRange - 1);
      try {
        const logs = await this.chain.getLogs({ fromBlock: start, toBlock: end, address: AAVE_V3.pool, topics: [[TOPIC_AAVE_BORROW, TOPIC_AAVE_LIQUIDATION]] });
        for (const l of logs) {
          if (l.topics[0] === TOPIC_AAVE_BORROW) {
            const onBehalfOf = ("0x" + l.topics[2]!.slice(26)).toLowerCase();
            if (!this.borrowers.has(onBehalfOf)) {
              this.borrowers.set(onBehalfOf, { firstSeen: l.blockNumber, lastChecked: 0, hf: null });
              this.dirtyBorrowers = true;
            }
          } else {
            const parsed = aavePoolIface.parseLog({ topics: [...l.topics], data: l.data });
            if (parsed) liquidations.push({ user: (parsed.args[2] as string).toLowerCase(), liquidator: (parsed.args[5] as string).toLowerCase(), tx: l.transactionHash, block: l.blockNumber });
          }
        }
        start = end + 1;
      } catch (err) {
        const msg = (err as Error).message ?? "";
        if (this.logRange > 1 && /block range|range|too many|limit|exceed|response size|query returned more/i.test(msg)) {
          const suggested = /up to a (\d+) block/i.exec(msg);
          this.logRange = suggested ? Math.max(1, Number(suggested[1])) : Math.max(1, Math.floor(this.logRange / 4));
          continue;
        }
        throw err;
      }
    }
    this.lastLogBlock = to;
    return liquidations;
  }

  private busy = false;
  /** Liquidations seen in shared logs that the next step has not resolved yet. */
  private queued: Array<{ user: string; liquidator: string; tx: string; block: number }> = [];
  private sharedLogs = false;

  /**
   * Take Borrow / LiquidationCall events from logs the block loop already fetched
   * (low-RPC mode), instead of a separate eth_getLogs. Runs synchronously, so
   * nothing is lost even while a slower health-factor step is still running.
   */
  ingest(logs: Log[], uptoBlock: number): void {
    this.sharedLogs = true;
    const pool = AAVE_V3.pool.toLowerCase();
    for (const l of logs) {
      if (l.address.toLowerCase() !== pool) continue;
      if (l.topics[0] === TOPIC_AAVE_BORROW) {
        const onBehalfOf = ("0x" + l.topics[2]!.slice(26)).toLowerCase();
        if (!this.borrowers.has(onBehalfOf)) {
          this.borrowers.set(onBehalfOf, { firstSeen: l.blockNumber, lastChecked: 0, hf: null });
          this.dirtyBorrowers = true;
        }
      } else if (l.topics[0] === TOPIC_AAVE_LIQUIDATION) {
        const parsed = aavePoolIface.parseLog({ topics: [...l.topics], data: l.data });
        if (parsed) this.queued.push({ user: (parsed.args[2] as string).toLowerCase(), liquidator: (parsed.args[5] as string).toLowerCase(), tx: l.transactionHash, block: l.blockNumber });
      }
    }
    if (uptoBlock > this.lastLogBlock) this.lastLogBlock = uptoBlock;
  }

  /**
   * Not awaited by the block loop; overlapping calls are skipped (the next one catches up).
   * Pass the block's logs when the caller already has them (low-RPC mode).
   */
  async onBlock(block: number, ethUsd: number, gasPriceWei: bigint, logs?: Log[]): Promise<void> {
    if (logs) this.ingest(logs, block);
    if (this.busy) return;
    this.busy = true;
    try {
      await this.step(block, ethUsd, gasPriceWei);
    } finally {
      this.busy = false;
    }
  }

  private async step(block: number, ethUsd: number, gasPriceWei: bigint): Promise<void> {
    let liquidations: Array<{ user: string; liquidator: string; tx: string; block: number }>;
    if (this.sharedLogs) {
      liquidations = this.queued;
      this.queued = [];
    } else {
      liquidations = await this.scanLogs(this.lastLogBlock + 1, block);
    }
    this.resolve(block, liquidations);

    const nearEvery = this.opts.checkEvery;
    const farEvery = this.opts.checkEvery * 12;
    const due = [...this.borrowers.entries()].filter(([, b]) => {
      const every = b.hf !== null && b.hf < 1.1 ? nearEvery : farEvery;
      return block - b.lastChecked >= every;
    });
    if (due.length) {
      const calls: Call[] = due.map(([u]) => ({ target: AAVE_V3.pool, callData: aavePoolIface.encodeFunctionData("getUserAccountData", [u]) }));
      const res = await this.chain.multicall(calls, block);
      this.stats.checks += due.length;
      const underwater: Array<{ user: string; hf: number }> = [];
      due.forEach(([user, b], i) => {
        const r = res[i]!;
        b.lastChecked = block;
        if (!r.success) return;
        const d = aavePoolIface.decodeFunctionResult("getUserAccountData", r.returnData);
        const debtBase = d[1] as bigint;
        const hfRaw = d[5] as bigint;
        if (debtBase === 0n) {
          // Fully repaid: stop watching.
          this.borrowers.delete(user);
          this.dirtyBorrowers = true;
          return;
        }
        b.hf = Number((hfRaw * 1_000_000n) / ONE) / 1_000_000;
        if (hfRaw < ONE && !this.pending.has(user)) underwater.push({ user, hf: b.hf });
      });
      if (underwater.length) {
        this.stats.liquidatable += underwater.length;
        for (const u of underwater.slice(0, 10)) await this.evaluate(block, u.user, u.hf, ethUsd, gasPriceWei).catch((e: Error) => log.warn("liquidation evaluate failed:", e.message.slice(0, 120)));
      }
    }
    if (this.dirtyBorrowers && block % 100 === 0) this.saveBorrowers(block);
  }

  saveBorrowers(block: number): void {
    this.store.writeJson(BORROWERS_FILE, { lastBlock: block, borrowers: [...this.borrowers.keys()] });
    this.dirtyBorrowers = false;
  }

  private async evaluate(block: number, user: string, hf: number, ethUsd: number, gasPriceWei: bigint): Promise<void> {
    const assets = [...this.reserves.keys()];
    const calls: Call[] = assets.map((a) => ({ target: AAVE_V3.dataProvider, callData: aaveDataProviderIface.encodeFunctionData("getUserReserveData", [a, user]) }));
    calls.push({ target: AAVE_V3.oracle, callData: aaveOracleIface.encodeFunctionData("getAssetsPrices", [assets]) });
    calls.push({ target: AAVE_V3.oracle, callData: aaveOracleIface.encodeFunctionData("BASE_CURRENCY_UNIT") });
    const res = await this.chain.multicall(calls, block);
    const pr = res[assets.length]!;
    const ur = res[assets.length + 1]!;
    if (!pr.success) return;
    const prices = aaveOracleIface.decodeFunctionResult("getAssetsPrices", pr.returnData)[0] as bigint[];
    const unit = ur.success ? Number(abi.decode(["uint256"], ur.returnData)[0]) : 1e8;

    let best: { debt?: { a: string; usd: number; price: number; decimals: number }; coll?: { a: string; usd: number } } = {};
    assets.forEach((a, i) => {
      const r = res[i]!;
      if (!r.success) return;
      const d = aaveDataProviderIface.decodeFunctionResult("getUserReserveData", r.returnData);
      const meta = this.reserves.get(a)!;
      const price = Number(prices[i] ?? 0n) / unit;
      const toUsd = (x: bigint) => (Number(x) / 10 ** meta.decimals) * price;
      const debtUsd = toUsd((d[1] as bigint) + (d[2] as bigint));
      const collUsd = d[8] ? toUsd(d[0] as bigint) : 0;
      if (debtUsd > (best.debt?.usd ?? 0)) best.debt = { a, usd: debtUsd, price, decimals: meta.decimals };
      if (collUsd > (best.coll?.usd ?? 0)) best.coll = { a, usd: collUsd };
    });
    if (!best.debt || !best.coll || best.debt.usd < this.opts.minDebtUsd) return;
    const debtMeta = this.reserves.get(best.debt.a)!;
    const collMeta = this.reserves.get(best.coll.a)!;
    const bonus = collMeta.bonusBps / 10_000; // e.g. 1.05
    if (bonus <= 1) return;
    const closeFactor = hf <= 0.95 || best.debt.usd < 2000 || best.coll.usd < 2000 ? 1 : 0.5;
    const repayUsd = Math.min(best.debt.usd * closeFactor, best.coll.usd / bonus);
    const grossBonusUsd = repayUsd * (bonus - 1);
    const protocolFeeUsd = grossBonusUsd * (collMeta.protocolFeeBps / 10_000);
    const swapCostUsd = best.coll.a === best.debt.a ? 0 : repayUsd * bonus * (this.opts.swapCostBps / 10_000);
    const gasUsd = (Number(BigInt(this.opts.gasUnits) * gasPriceWei) / 1e18) * ethUsd;
    const estProfitUsd = grossBonusUsd - protocolFeeUsd - swapCostUsd - gasUsd;
    const rec: LiqOpportunityRecord = {
      kind: "liq-opportunity",
      id: `${block}-${user.slice(2, 10)}`,
      block,
      foundAt: new Date().toISOString(),
      user,
      healthFactor: hf,
      debtAsset: debtMeta.asset,
      debtSymbol: debtMeta.symbol,
      collateralAsset: collMeta.asset,
      collateralSymbol: collMeta.symbol,
      debtUsd: best.debt.usd,
      collateralUsd: best.coll.usd,
      closeFactor,
      repayUsd,
      bonusPct: (bonus - 1) * 100,
      grossBonusUsd,
      protocolFeeUsd,
      swapCostUsd,
      gasUsd,
      estProfitUsd,
    };
    this.store.append(LIQ_FILE, rec);
    this.pending.set(user, { rec, checks: 0 });
    this.stats.recorded++;
    log.info(
      `liquidation: ${user.slice(0, 10)} HF ${hf.toFixed(4)} — repay $${repayUsd.toFixed(0)} ${debtMeta.symbol} for ${collMeta.symbol} (+${rec.bonusPct.toFixed(1)}%), est. profit $${estProfitUsd.toFixed(2)}`,
    );
    // Hand a live sender the raw amount to repay (debt units), if one is attached and it looks profitable.
    if (this.onLiquidatable && estProfitUsd > 0 && best.debt.price > 0) {
      const debtToCover = BigInt(Math.floor((repayUsd / best.debt.price) * 10 ** best.debt.decimals));
      if (debtToCover > 0n) {
        try {
          this.onLiquidatable({
            id: rec.id,
            block,
            user,
            collateralAsset: collMeta.asset,
            collateralSymbol: collMeta.symbol,
            debtAsset: debtMeta.asset,
            debtSymbol: debtMeta.symbol,
            debtToCover,
            estProfitUsd,
          });
        } catch (err) {
          log.warn("live liquidation hook failed:", (err as Error).message.slice(0, 140));
        }
      }
    }
  }

  /** Resolve pending candidates: taken by someone, recovered, or still open after N blocks. */
  private resolve(block: number, liquidations: Array<{ user: string; liquidator: string; tx: string; block: number }>): void {
    for (const l of liquidations) {
      const p = this.pending.get(l.user);
      if (p) this.finish(l.user, p, "taken", { takenBy: l.liquidator, takenTx: l.tx, takenBlock: l.block });
    }
    for (const [user, p] of this.pending) {
      if (block <= p.rec.block) continue;
      p.checks++;
      const b = this.borrowers.get(user);
      // Gone from the watch list = debt fully repaid by the borrower.
      if (!b || (b.hf !== null && b.hf >= 1 && b.lastChecked > p.rec.block)) this.finish(user, p, "recovered");
      else if (p.checks >= this.opts.outcomeBlocks) this.finish(user, p, "open");
    }
  }

  private finish(user: string, p: PendingLiq, status: LiqOutcomeRecord["status"], extra: Partial<LiqOutcomeRecord> = {}): void {
    const out: LiqOutcomeRecord = {
      kind: "liq-outcome",
      id: p.rec.id,
      block: p.rec.block,
      finalizedAt: new Date().toISOString(),
      status,
      realisticProfitUsd: status === "open" ? Math.max(0, p.rec.estProfitUsd) : 0,
      ...extra,
    };
    this.store.append(LIQ_FILE, out);
    this.pending.delete(user);
    log.info(`liquidation ${p.rec.id}: ${status}${extra.takenBy ? ` by ${extra.takenBy.slice(0, 10)}` : ""}`);
  }
}

// ---------------------------------------------------------------------------
// Daily summary
// ---------------------------------------------------------------------------

export interface LiqDaySummary {
  day: string;
  found: number;
  taken: number;
  recovered: number;
  open: number;
  estProfitUsd: number;
  realisticProfitUsd: number;
  liquidators: Array<{ bot: string; count: number }>;
  biggest: Array<{ user: string; debtSymbol: string; collateralSymbol: string; repayUsd: number; estProfitUsd: number; status: string }>;
}

export async function liquidationSummary(store: Store, days?: string[]): Promise<LiqDaySummary[]> {
  const opps = new Map<string, LiqOpportunityRecord>();
  const outs = new Map<string, LiqOutcomeRecord>();
  for await (const r of store.read<LiqOpportunityRecord | LiqOutcomeRecord>(LIQ_FILE)) {
    if (r.kind === "liq-opportunity") opps.set(r.id, r);
    else if (r.kind === "liq-outcome") outs.set(r.id, r);
  }
  const byDay = new Map<string, LiqDaySummary & { _bots: Map<string, number> }>();
  for (const o of opps.values()) {
    const day = o.foundAt.slice(0, 10);
    if (days && !days.includes(day)) continue;
    let s = byDay.get(day);
    if (!s) byDay.set(day, (s = { day, found: 0, taken: 0, recovered: 0, open: 0, estProfitUsd: 0, realisticProfitUsd: 0, liquidators: [], biggest: [], _bots: new Map() }));
    s.found++;
    s.estProfitUsd += o.estProfitUsd;
    const out = outs.get(o.id);
    if (out) {
      s[out.status]++;
      s.realisticProfitUsd += out.realisticProfitUsd;
      if (out.takenBy) s._bots.set(out.takenBy, (s._bots.get(out.takenBy) ?? 0) + 1);
    }
    s.biggest.push({ user: o.user, debtSymbol: o.debtSymbol, collateralSymbol: o.collateralSymbol, repayUsd: o.repayUsd, estProfitUsd: o.estProfitUsd, status: out?.status ?? "pending" });
  }
  return [...byDay.values()]
    .map(({ _bots, ...s }) => ({
      ...s,
      liquidators: [..._bots.entries()].map(([bot, count]) => ({ bot, count })).sort((a, b) => b.count - a.count).slice(0, 10),
      biggest: s.biggest.sort((a, b) => b.estProfitUsd - a.estProfitUsd).slice(0, 10),
    }))
    .sort((a, b) => (a.day < b.day ? 1 : -1));
}
