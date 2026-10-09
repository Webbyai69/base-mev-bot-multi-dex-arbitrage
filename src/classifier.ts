/**
 * On-chain MEV classifier for Base — the replacement for the EigenPhi feed.
 *
 * Works purely from Swap event logs of one block plus the block's transaction
 * list, so it runs on any RPC:
 *
 *   arbitrage  a single transaction whose swaps net out to a gain in exactly
 *              one token (every other token's inflow ~ outflow) across >= 2
 *              pools. Profit = that token's net gain.
 *   sandwich   in one block, on one pool: tx A swaps, a different sender's tx
 *              V swaps the same direction, then tx B from A's sender swaps the
 *              opposite direction. Profit = A+B net gain.
 *
 * Every detection is appended to data/mev.jsonl and aggregated into a bot
 * leaderboard, most-arbed pairs and a per-day market summary.
 */
import { AbiCoder, type Log } from "ethers";
import { CL_DEXES, DEXES, UNISWAP_V3_FACTORY } from "./config.js";
import { TOPIC_SWAP_AERO, TOPIC_SWAP_V2, TOPIC_SWAP_V3, aeroPoolIface, univ2PairIface, univ3PoolIface } from "./abi.js";
import type { PoolRegistry } from "./pools.js";
import type { Chain, Call } from "./rpc.js";
import { Store, dayKey } from "./store.js";
import { log } from "./log.js";

const abi = AbiCoder.defaultAbiCoder();
export const MEV_FILE = "mev.jsonl";

/** A "bot" (called contract) seen with at least this many distinct EOA senders in a day is a shared router/aggregator, not one competitor. */
const SHARED_SENDER_MIN = 5;
/** Cap on distinct senders tracked per bot per day (memory bound; we only need to know it crossed SHARED_SENDER_MIN). */
const SENDER_CAP = 64;

export type MevType = "arbitrage" | "sandwich";

export interface DetectedMev {
  kind: "mev";
  type: MevType;
  block: number;
  timestamp: string;
  txHash: string;
  txIndex: number;
  /** EOA that sent the transaction. */
  sender: string;
  /** Contract the transaction called (the "bot"); equals sender when it was a plain EOA call. */
  bot: string;
  pools: string[];
  dexes: string[];
  tokens: string[];
  profitToken: string;
  profitTokenSymbol: string;
  profitAmount: bigint;
  profitUsd: number | null;
  /** Sandwich only */
  victimTx?: string;
  backrunTx?: string;
  /** Best-effort transaction cost (gas) in USD when receipts are available. */
  costUsd?: number;
  /** Priority fee the bot paid (effective gas price - base fee), in gwei; how searchers bid for position on Base. */
  priorityGwei?: number;
}

interface SwapEvent {
  txHash: string;
  txIndex: number;
  logIndex: number;
  pool: string;
  poolKind: "univ2" | "aerodrome" | "univ3";
  tokenIn: string;
  tokenOut: string;
  amountIn: bigint;
  amountOut: bigint;
}

interface PoolMeta {
  token0: string;
  token1: string;
  kind: "univ2" | "aerodrome" | "univ3";
  dex: string;
}

interface TxInfo {
  hash: string;
  from: string;
  to: string | null;
  index: number;
}

/** The parts of eth_getBlockByNumber(n, true) the bot uses; fetched once per block and shared. */
export interface FullBlock {
  number: string;
  timestamp: string;
  baseFeePerGas?: string;
  transactions: Array<{ hash: string; from: string; to: string | null; transactionIndex: string }>;
}

export async function fetchFullBlock(chain: Chain, block: number): Promise<FullBlock | null> {
  return chain.send<FullBlock | null>("eth_getBlockByNumber", ["0x" + block.toString(16), true]);
}

export class Classifier {
  private poolMeta = new Map<string, PoolMeta>();
  /** Max transaction receipts fetched per block for bot gas costs (15 CU each on Alchemy). */
  maxReceiptsPerBlock = 4;

  constructor(readonly chain: Chain, readonly registry: PoolRegistry, readonly store: Store) {}

  /**
   * @param logs this block's logs when the caller already fetched them (low-RPC mode shares one
   *             eth_getLogs per block between the classifier, the pool refresh and the liquidation
   *             monitor); only the Swap logs are used here.
   */
  async classifyBlock(block: number, ethUsd: number, fullBlock?: FullBlock | null, prefetched?: Log[]): Promise<DetectedMev[]> {
    const swapTopics = new Set([TOPIC_SWAP_V2, TOPIC_SWAP_AERO, TOPIC_SWAP_V3]);
    const [rawLogs, blk] = await Promise.all([
      prefetched ? Promise.resolve(prefetched) : this.chain.getLogs({ fromBlock: block, toBlock: block, topics: [[TOPIC_SWAP_V2, TOPIC_SWAP_AERO, TOPIC_SWAP_V3]] }),
      fullBlock !== undefined ? Promise.resolve(fullBlock) : fetchFullBlock(this.chain, block),
    ]);
    const logs = rawLogs.filter((l) => l.blockNumber === block && swapTopics.has(l.topics[0] ?? ""));
    if (!blk) return [];
    const timestamp = new Date(Number(blk.timestamp) * 1000).toISOString();
    const txs = new Map<string, TxInfo>();
    for (const t of blk.transactions) {
      txs.set(t.hash.toLowerCase(), { hash: t.hash.toLowerCase(), from: t.from.toLowerCase(), to: t.to ? t.to.toLowerCase() : null, index: Number(t.transactionIndex) });
    }

    await this.ensurePoolMeta([...new Set(logs.map((l) => l.address.toLowerCase()))]);
    const swaps = logs.map((l) => this.parseSwap(l)).filter((s): s is SwapEvent => s !== null);

    const detected: DetectedMev[] = [];
    detected.push(...this.detectArbitrage(swaps, txs, block, timestamp, ethUsd));
    detected.push(...this.detectSandwiches(swaps, txs, block, timestamp, ethUsd));

    if (detected.length) await this.attachCosts(detected, block, ethUsd, blk.baseFeePerGas ? BigInt(blk.baseFeePerGas) : null);
    for (const d of detected) {
      this.store.append(MEV_FILE, d);
      log.info(
        `mev: ${d.type} ${d.bot.slice(0, 10)} ${d.dexes.join("+")} ${d.tokens.map((t) => this.registry.symbol(t)).join("/")} ` +
          `profit ${d.profitAmount} ${d.profitTokenSymbol}${d.profitUsd !== null ? ` ($${d.profitUsd.toFixed(2)})` : ""} tx ${d.txHash.slice(0, 12)}`,
      );
    }
    return detected;
  }

  // ------------------------------------------------------------------------

  private parseSwap(l: Log): SwapEvent | null {
    const pool = l.address.toLowerCase();
    const meta = this.poolMeta.get(pool);
    if (!meta) return null;
    const topic = l.topics[0];
    try {
      if (topic === TOPIC_SWAP_V2 && meta.kind === "univ2") {
        const p = univ2PairIface.parseLog({ topics: [...l.topics], data: l.data });
        if (!p) return null;
        const [a0In, a1In, a0Out, a1Out] = [p.args[1], p.args[2], p.args[3], p.args[4]] as bigint[];
        return this.flows(l, meta, a0In!, a1In!, a0Out!, a1Out!);
      }
      if (topic === TOPIC_SWAP_AERO && meta.kind === "aerodrome") {
        const p = aeroPoolIface.parseLog({ topics: [...l.topics], data: l.data });
        if (!p) return null;
        const [a0In, a1In, a0Out, a1Out] = [p.args[2], p.args[3], p.args[4], p.args[5]] as bigint[];
        return this.flows(l, meta, a0In!, a1In!, a0Out!, a1Out!);
      }
      if (topic === TOPIC_SWAP_V3 && meta.kind === "univ3") {
        const p = univ3PoolIface.parseLog({ topics: [...l.topics], data: l.data });
        if (!p) return null;
        const amount0 = p.args[2] as bigint;
        const amount1 = p.args[3] as bigint;
        const a0In = amount0 > 0n ? amount0 : 0n;
        const a1In = amount1 > 0n ? amount1 : 0n;
        const a0Out = amount0 < 0n ? -amount0 : 0n;
        const a1Out = amount1 < 0n ? -amount1 : 0n;
        return this.flows(l, meta, a0In, a1In, a0Out, a1Out);
      }
    } catch {
      return null;
    }
    return null;
  }

  private flows(l: Log, meta: PoolMeta, a0In: bigint, a1In: bigint, a0Out: bigint, a1Out: bigint): SwapEvent | null {
    const zeroIn = a0In >= a1In;
    const amountIn = zeroIn ? a0In : a1In;
    const amountOut = zeroIn ? a1Out : a0Out;
    if (amountIn === 0n || amountOut === 0n) return null;
    return {
      txHash: l.transactionHash.toLowerCase(),
      txIndex: l.transactionIndex,
      logIndex: l.index,
      pool: l.address.toLowerCase(),
      poolKind: meta.kind,
      tokenIn: zeroIn ? meta.token0 : meta.token1,
      tokenOut: zeroIn ? meta.token1 : meta.token0,
      amountIn,
      amountOut,
    };
  }

  private detectArbitrage(swaps: SwapEvent[], txs: Map<string, TxInfo>, block: number, timestamp: string, ethUsd: number): DetectedMev[] {
    const byTx = new Map<string, SwapEvent[]>();
    for (const s of swaps) byTx.set(s.txHash, [...(byTx.get(s.txHash) ?? []), s]);
    const out: DetectedMev[] = [];
    for (const [txHash, list] of byTx) {
      if (list.length < 2) continue;
      const pools = new Set(list.map((s) => s.pool));
      if (pools.size < 2) continue;
      const net = new Map<string, bigint>();
      const gross = new Map<string, bigint>();
      for (const s of list) {
        net.set(s.tokenIn, (net.get(s.tokenIn) ?? 0n) - s.amountIn);
        net.set(s.tokenOut, (net.get(s.tokenOut) ?? 0n) + s.amountOut);
        gross.set(s.tokenIn, (gross.get(s.tokenIn) ?? 0n) + s.amountIn);
        gross.set(s.tokenOut, (gross.get(s.tokenOut) ?? 0n) + s.amountOut);
      }
      let profitToken: string | undefined;
      let profitAmount = 0n;
      let balanced = true;
      for (const [token, n] of net) {
        const g = gross.get(token) ?? 0n;
        const tolerance = g / 1000n; // 0.1% of gross volume in that token
        if (n > tolerance) {
          if (profitToken !== undefined) {
            balanced = false; // two tokens gained: a swap, not an arbitrage
            break;
          }
          profitToken = token;
          profitAmount = n;
        } else if (n < -tolerance) {
          balanced = false; // paid a token away: ordinary trade
          break;
        }
      }
      if (!balanced || profitToken === undefined || profitAmount <= 0n) continue;
      const tx = txs.get(txHash);
      const sorted = [...list].sort((a, b) => a.logIndex - b.logIndex);
      const tokens = [...new Set(sorted.flatMap((s) => [s.tokenIn, s.tokenOut]))];
      out.push({
        kind: "mev",
        type: "arbitrage",
        block,
        timestamp,
        txHash,
        txIndex: tx?.index ?? sorted[0]!.txIndex,
        sender: tx?.from ?? "unknown",
        bot: tx?.to ?? tx?.from ?? "unknown",
        pools: [...pools],
        dexes: [...new Set([...pools].map((p) => this.poolMeta.get(p)?.dex ?? "unknown"))],
        tokens,
        profitToken,
        profitTokenSymbol: this.registry.symbol(profitToken),
        profitAmount,
        profitUsd: this.registry.usdValue(profitToken, profitAmount, ethUsd),
      });
    }
    return out;
  }

  private detectSandwiches(swaps: SwapEvent[], txs: Map<string, TxInfo>, block: number, timestamp: string, ethUsd: number): DetectedMev[] {
    const out: DetectedMev[] = [];
    const byPool = new Map<string, SwapEvent[]>();
    for (const s of swaps) byPool.set(s.pool, [...(byPool.get(s.pool) ?? []), s]);
    const seen = new Set<string>();
    for (const [pool, list] of byPool) {
      const ordered = [...list].sort((a, b) => a.txIndex - b.txIndex || a.logIndex - b.logIndex);
      for (let i = 0; i < ordered.length; i++) {
        const front = ordered[i]!;
        const ft = txs.get(front.txHash);
        if (!ft) continue;
        for (let k = i + 2; k < ordered.length && k <= i + 6; k++) {
          const back = ordered[k]!;
          const bt = txs.get(back.txHash);
          if (!bt || bt.from !== ft.from || back.txHash === front.txHash) continue;
          if (back.tokenIn !== front.tokenOut) continue; // must reverse direction
          const victims = ordered.slice(i + 1, k).filter((v) => v.tokenIn === front.tokenIn && txs.get(v.txHash)?.from !== ft.from);
          if (victims.length === 0) continue;
          const key = `${front.txHash}-${back.txHash}`;
          if (seen.has(key)) continue;
          seen.add(key);
          // Attacker net flow across the two legs.
          const profitToken = front.tokenIn;
          const profitAmount = back.amountOut - front.amountIn;
          if (profitAmount <= 0n) continue; // two-way flow that lost money is not a sandwich (market making, retries)
          out.push({
            kind: "mev",
            type: "sandwich",
            block,
            timestamp,
            txHash: front.txHash,
            txIndex: front.txIndex,
            sender: ft.from,
            bot: ft.to ?? ft.from,
            pools: [pool],
            dexes: [this.poolMeta.get(pool)?.dex ?? "unknown"],
            tokens: [front.tokenIn, front.tokenOut],
            profitToken,
            profitTokenSymbol: this.registry.symbol(profitToken),
            profitAmount,
            profitUsd: profitAmount > 0n ? this.registry.usdValue(profitToken, profitAmount, ethUsd) : 0,
            victimTx: victims[0]!.txHash,
            backrunTx: back.txHash,
          });
          break;
        }
      }
    }
    return out;
  }

  /**
   * Gas cost of each detected transaction from its receipt (one cheap
   * eth_getTransactionReceipt per MEV tx, capped per block; OP-stack receipts
   * carry the L1 data fee as `l1Fee`).
   */
  private async attachCosts(detected: DetectedMev[], _block: number, ethUsd: number, baseFee: bigint | null): Promise<void> {
    const targets = detected.slice(0, this.maxReceiptsPerBlock);
    await Promise.all(
      targets.map(async (d) => {
        try {
          const r = await this.chain.send<{ gasUsed: string; effectiveGasPrice: string; l1Fee?: string } | null>("eth_getTransactionReceipt", [d.txHash]);
          if (!r) return;
          const wei = BigInt(r.gasUsed) * BigInt(r.effectiveGasPrice) + (r.l1Fee ? BigInt(r.l1Fee) : 0n);
          d.costUsd = (Number(wei) / 1e18) * ethUsd;
          if (baseFee !== null) {
            const tip = BigInt(r.effectiveGasPrice) - baseFee;
            d.priorityGwei = Number(tip > 0n ? tip : 0n) / 1e9;
          }
        } catch (err) {
          log.debug(`receipt for ${d.txHash.slice(0, 12)} unavailable: ${(err as Error).message.slice(0, 80)}`);
        }
      }),
    );
  }

  /** token0/token1/kind for pools we have not seen before; V3 pools identified via fee(). */
  private async ensurePoolMeta(addresses: string[]): Promise<void> {
    // Seed from the registry.
    for (const a of addresses) {
      if (this.poolMeta.has(a)) continue;
      const p = this.registry.pools.get(a);
      // Slipstream and PancakeSwap V3 are CL venues the classifier lumps with Uniswap V3 for metadata.
      // (It won't match Pancake's distinct Swap topic yet, so Pancake rival arbs aren't classified — a follow-up.)
      if (p) this.poolMeta.set(a, { token0: p.token0, token1: p.token1, kind: p.kind === "slipstream" || p.kind === "pancakev3" ? "univ3" : p.kind, dex: p.dex });
    }
    const unknown = addresses.filter((a) => !this.poolMeta.has(a));
    if (unknown.length === 0) return;
    const calls: Call[] = [];
    for (const a of unknown) {
      calls.push({ target: a, callData: univ2PairIface.encodeFunctionData("token0") });
      calls.push({ target: a, callData: univ2PairIface.encodeFunctionData("token1") });
      calls.push({ target: a, callData: univ3PoolIface.encodeFunctionData("fee") });
      calls.push({ target: a, callData: aeroPoolIface.encodeFunctionData("stable") });
      calls.push({ target: a, callData: "0xc45a0155" }); // factory()
    }
    const res = await this.chain.multicall(calls);
    unknown.forEach((a, i) => {
      const r0 = res[i * 5]!;
      const r1 = res[i * 5 + 1]!;
      const rFee = res[i * 5 + 2]!;
      const rStable = res[i * 5 + 3]!;
      const rFactory = res[i * 5 + 4]!;
      if (!r0.success || !r1.success || r0.returnData.length < 66 || r1.returnData.length < 66) return;
      const token0 = (abi.decode(["address"], r0.returnData)[0] as string).toLowerCase();
      const token1 = (abi.decode(["address"], r1.returnData)[0] as string).toLowerCase();
      const factory = rFactory.success && rFactory.returnData.length >= 66 ? (abi.decode(["address"], rFactory.returnData)[0] as string).toLowerCase() : "";
      let kind: PoolMeta["kind"] = "univ2";
      let dex = "unknown-v2";
      if (rStable.success && rStable.returnData.length >= 66 && factory === DEXES.find((d) => d.kind === "aerodrome")?.factory.toLowerCase()) {
        kind = "aerodrome";
        dex = "aerodrome";
      } else if (rFee.success && rFee.returnData.length >= 66 && factory === UNISWAP_V3_FACTORY.toLowerCase()) {
        kind = "univ3";
        dex = "uniswap-v3";
      } else if (rFee.success && rFee.returnData.length >= 66 && CL_DEXES.some((d) => d.factory.toLowerCase() === factory)) {
        kind = "univ3"; // Slipstream emits the Uniswap V3 Swap event
        dex = CL_DEXES.find((d) => d.factory.toLowerCase() === factory)!.id;
      } else if (rFee.success && rFee.returnData.length >= 66 && !(rStable.success && rStable.returnData.length >= 66)) {
        // fee() but no stable(): some V3-style fork we do not know by factory.
        kind = "univ3";
        dex = "unknown-v3";
      } else {
        const known = DEXES.find((d) => d.factory.toLowerCase() === factory);
        if (known) dex = known.id;
      }
      this.poolMeta.set(a, { token0, token1, kind, dex });
    });
    // Learn symbols for new tokens so logs and reports are readable.
    const tokens = new Set<string>();
    for (const a of unknown) {
      const m = this.poolMeta.get(a);
      if (m) {
        tokens.add(m.token0);
        tokens.add(m.token1);
      }
    }
    await this.registry.loadTokenMeta(tokens);
  }

  /** Pools that arbitrage bots used which we are not watching yet, by DEX id we can trade on. */
  candidatePoolsToWatch(detected: DetectedMev[]): Array<{ address: string; dex: string }> {
    const out: Array<{ address: string; dex: string }> = [];
    for (const d of detected) {
      if (d.type !== "arbitrage") continue;
      for (const p of d.pools) {
        if (this.registry.pools.has(p)) continue;
        const m = this.poolMeta.get(p);
        if (!m) continue;
        const tradable = DEXES.some((x) => x.id === m.dex) || (this.registry.clPools && CL_DEXES.some((x) => x.id === m.dex));
        if (!tradable) continue;
        out.push({ address: p, dex: m.dex });
      }
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// Aggregations for the leaderboard / report
// ---------------------------------------------------------------------------

export interface BotStats {
  bot: string;
  txs: number;
  arbitrage: number;
  sandwich: number;
  profitUsd: number;
  costUsd: number;
  unpricedTxs: number;
  lastSeenBlock: number;
  /** Distinct EOA senders that called this contract (capped at SENDER_CAP). Many ⇒ a shared router/aggregator. */
  senders: number;
  /** True when this address looks like a shared router/aggregator (>= SHARED_SENDER_MIN distinct senders), not one bot. */
  shared: boolean;
}

export interface MarketSummary {
  day: string;
  arbitrageTxs: number;
  sandwichTxs: number;
  arbitrageProfitUsd: number;
  sandwichProfitUsd: number;
  bots: BotStats[];
  /** Addresses that look like shared routers/aggregators (many distinct senders) — e.g. the V4 Universal Router. Kept out of `bots`. */
  routers: BotStats[];
  topPairs: Array<{ pair: string; txs: number; profitUsd: number }>;
  topDexRoutes: Array<{ route: string; txs: number; profitUsd: number }>;
  hourly: Array<{ hour: string; txs: number; profitUsd: number }>;
  watched: BotStats[];
  /** Priority fees paid by arbitrage transactions (gwei): what it takes to win position on Base. */
  arbPriority: { samples: number; medianGwei: number | null; p90Gwei: number | null; maxGwei: number | null };
}

function quantile(sorted: number[], q: number): number | null {
  if (sorted.length === 0) return null;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))));
  return sorted[i]!;
}

export async function marketSummary(store: Store, symbolOf: (a: string) => string, watchBots: string[] = [], days?: string[]): Promise<MarketSummary[]> {
  const byDay = new Map<string, MarketSummary>();
  const bots = new Map<string, Map<string, BotStats>>();
  const senders = new Map<string, Map<string, Set<string>>>();
  const pairs = new Map<string, Map<string, { txs: number; profitUsd: number }>>();
  const routes = new Map<string, Map<string, { txs: number; profitUsd: number }>>();
  const hourly = new Map<string, Map<string, { txs: number; profitUsd: number }>>();
  const tips = new Map<string, number[]>();
  for await (const d of store.read<DetectedMev>(MEV_FILE)) {
    if (d.kind !== "mev") continue;
    const day = dayKey(d.timestamp);
    if (days && !days.includes(day)) continue;
    let s = byDay.get(day);
    if (!s) {
      s = { day, arbitrageTxs: 0, sandwichTxs: 0, arbitrageProfitUsd: 0, sandwichProfitUsd: 0, bots: [], routers: [], topPairs: [], topDexRoutes: [], hourly: [], watched: [], arbPriority: { samples: 0, medianGwei: null, p90Gwei: null, maxGwei: null } };
      byDay.set(day, s);
    }
    const usd = d.profitUsd ?? 0;
    if (d.type === "arbitrage" && typeof d.priorityGwei === "number") {
      const t = tips.get(day) ?? [];
      t.push(d.priorityGwei);
      tips.set(day, t);
    }
    if (d.type === "arbitrage") {
      s.arbitrageTxs++;
      s.arbitrageProfitUsd += usd;
    } else {
      s.sandwichTxs++;
      s.sandwichProfitUsd += usd;
    }
    const bm = bots.get(day) ?? new Map<string, BotStats>();
    const b = bm.get(d.bot) ?? { bot: d.bot, txs: 0, arbitrage: 0, sandwich: 0, profitUsd: 0, costUsd: 0, unpricedTxs: 0, lastSeenBlock: 0, senders: 0, shared: false };
    b.txs++;
    b[d.type]++;
    b.profitUsd += usd;
    b.costUsd += d.costUsd ?? 0;
    if (d.profitUsd === null) b.unpricedTxs++;
    b.lastSeenBlock = Math.max(b.lastSeenBlock, d.block);
    bm.set(d.bot, b);
    bots.set(day, bm);

    // Distinct EOAs that called this contract — many ⇒ a shared router/aggregator, not one bot.
    const sd = senders.get(day) ?? new Map<string, Set<string>>();
    let ss = sd.get(d.bot);
    if (!ss) {
      ss = new Set<string>();
      sd.set(d.bot, ss);
    }
    if (ss.size < SENDER_CAP && d.sender) ss.add(String(d.sender).toLowerCase());
    senders.set(day, sd);

    const pairKey = d.tokens.map(symbolOf).sort().join("/");
    const pm = pairs.get(day) ?? new Map();
    const pe = pm.get(pairKey) ?? { txs: 0, profitUsd: 0 };
    pe.txs++;
    pe.profitUsd += usd;
    pm.set(pairKey, pe);
    pairs.set(day, pm);

    const routeKey = [...d.dexes].sort().join(" + ");
    const rm = routes.get(day) ?? new Map();
    const re = rm.get(routeKey) ?? { txs: 0, profitUsd: 0 };
    re.txs++;
    re.profitUsd += usd;
    rm.set(routeKey, re);
    routes.set(day, rm);

    const hour = d.timestamp.slice(11, 13) + ":00";
    const hm = hourly.get(day) ?? new Map();
    const he = hm.get(hour) ?? { txs: 0, profitUsd: 0 };
    he.txs++;
    he.profitUsd += usd;
    hm.set(hour, he);
    hourly.set(day, hm);
  }
  for (const s of byDay.values()) {
    const senderMap = senders.get(s.day) ?? new Map<string, Set<string>>();
    const all = [...(bots.get(s.day)?.values() ?? [])].sort((a, b) => b.profitUsd - a.profitUsd);
    for (const b of all) {
      b.senders = senderMap.get(b.bot)?.size ?? 0;
      b.shared = b.senders >= SHARED_SENDER_MIN;
    }
    s.bots = all.filter((b) => !b.shared).slice(0, 20);
    s.routers = all.filter((b) => b.shared).slice(0, 10);
    s.watched = all.filter((b) => watchBots.includes(b.bot));
    s.topPairs = [...(pairs.get(s.day) ?? new Map()).entries()].map(([pair, v]) => ({ pair, ...v })).sort((a, b) => b.txs - a.txs).slice(0, 15);
    s.topDexRoutes = [...(routes.get(s.day) ?? new Map()).entries()].map(([route, v]) => ({ route, ...v })).sort((a, b) => b.txs - a.txs).slice(0, 10);
    s.hourly = [...(hourly.get(s.day) ?? new Map()).entries()].map(([hour, v]) => ({ hour, ...v })).sort((a, b) => (a.hour < b.hour ? -1 : 1));
    const t = (tips.get(s.day) ?? []).sort((a, b) => a - b);
    s.arbPriority = { samples: t.length, medianGwei: quantile(t, 0.5), p90Gwei: quantile(t, 0.9), maxGwei: t.length ? t[t.length - 1]! : null };
  }
  return [...byDay.values()].sort((a, b) => (a.day < b.day ? 1 : -1));
}
