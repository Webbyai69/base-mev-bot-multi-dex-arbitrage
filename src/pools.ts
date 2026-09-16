/**
 * Pool discovery, token metadata, fee calibration and the per-block reserve
 * cache.
 *
 * Discovery strategy (cheap on a public RPC):
 *   1. Enumerate every pool on the smaller factories (Aerodrome, SushiSwap,
 *      BaseSwap) via Multicall3.
 *   2. Keep pools that contain one of our base tokens and pass the liquidity
 *      floor; collect the set of "interesting" counter-tokens from them.
 *   3. Ask the huge Uniswap V2 factory only for getPair(base, token) for that
 *      token set, instead of enumerating its tens of thousands of pairs.
 *   4. Calibrate every pool's fee against the DEX's own quoter so that our
 *      local maths reproduces on-chain outputs to the wei.
 * The MEV classifier can add pools it sees arbitrage bots use at runtime.
 */
import { getAddress, AbiCoder } from "ethers";
import { DEXES, TOKENS, WETH, type DexInfo, type DexKind } from "./config.js";
import {
  TOPIC_SWAP_AERO,
  TOPIC_SWAP_V2,
  aeroFactoryIface,
  aeroPoolIface,
  erc20Iface,
  univ2FactoryIface,
  univ2PairIface,
  univ2RouterIface,
} from "./abi.js";
import { getAmountOut, type FeeModel } from "./math.js";
import type { Chain, Call } from "./rpc.js";
import { log } from "./log.js";

export interface Pool {
  address: string;
  dex: string;
  kind: DexKind;
  token0: string;
  token1: string;
  reserve0: bigint;
  reserve1: bigint;
  feePpm: number;
  feeModel: FeeModel;
  stable: boolean;
  updatedBlock: number;
}

export interface TokenMeta {
  address: string;
  symbol: string;
  decimals: number;
}

export interface PoolSnapshot {
  version: 1;
  discoveredAt: string;
  block: number;
  tokens: TokenMeta[];
  pools: Array<Omit<Pool, "reserve0" | "reserve1" | "updatedBlock">>;
}

const abi = AbiCoder.defaultAbiCoder();
const BASE_TOKEN_SET = new Set(Object.values(TOKENS).map((t) => t.address.toLowerCase()));

export function pairKey(a: string, b: string): string {
  const [x, y] = [a.toLowerCase(), b.toLowerCase()].sort();
  return `${x}-${y}`;
}

export class PoolRegistry {
  readonly pools = new Map<string, Pool>();
  readonly tokens = new Map<string, TokenMeta>();
  /** Set when the watch list changed since the last snapshot write. */
  dirty = false;

  constructor(readonly chain: Chain) {}

  /** Pools grouped by unordered token pair; only groups with >= 2 pools matter. */
  groups(): Map<string, Pool[]> {
    const g = new Map<string, Pool[]>();
    for (const p of this.pools.values()) {
      const k = pairKey(p.token0, p.token1);
      const arr = g.get(k);
      if (arr) arr.push(p);
      else g.set(k, [p]);
    }
    return g;
  }

  token(address: string): TokenMeta | undefined {
    return this.tokens.get(address.toLowerCase());
  }

  symbol(address: string): string {
    return this.token(address)?.symbol ?? address.slice(0, 8);
  }

  // ------------------------------------------------------------------------
  // Discovery
  // ------------------------------------------------------------------------

  /**
   * Build the watch list.
   *
   * mode "activity" (default): pools that actually traded in the last
   * `lookbackBlocks` blocks, found from Swap logs — a few getLogs calls and a
   * few thousand cheap view calls, fine on a public RPC — plus factory
   * lookups of the same token pairs on every DEX so a deep-but-quiet pool
   * on the other side of the spread is not missed.
   *
   * mode "full": enumerate every pool on every factory (tens of thousands
   * of calls; needs a proper RPC provider).
   */
  async discover(opts: { minLiquidityWeth: number; maxPools: number; mode?: "activity" | "full"; lookbackBlocks?: number; logRange?: number }): Promise<void> {
    const block = await this.chain.blockNumber();
    const mode = opts.mode ?? "activity";
    log.info(`discovering pools at block ${block} (${mode} mode)`);

    const candidates: Pool[] = [];
    if (mode === "full") {
      for (const dex of DEXES.filter((d) => d.id !== "uniswap-v2")) {
        const found = await this.enumerateFactory(dex, block);
        log.info(`${dex.name}: ${found.length} pools enumerated`);
        candidates.push(...found);
      }
    } else {
      const active = await this.activePools(block, opts.lookbackBlocks ?? 900, opts.logRange ?? 100);
      log.info(`${active.length} pools on known DEXes traded in the last ${opts.lookbackBlocks ?? 900} blocks`);
      candidates.push(...active);
    }

    // Reserves for all candidates (one consistent block), then liquidity filter.
    await this.refreshReserves(candidates, block);
    await this.loadTokenMetaForPools(candidates);
    const ethUsd = this.ethPriceFrom(candidates);
    log.info(`reference ETH price from pools: $${ethUsd.toFixed(2)}`);

    const kept = candidates.filter((p) => this.liquidityInWeth(p, ethUsd) >= opts.minLiquidityWeth);
    log.info(`${kept.length} pools pass the ${opts.minLiquidityWeth} WETH liquidity floor`);

    // Every token seen next to a base token -> ask each factory for that pair too.
    const counterTokens = new Set<string>();
    for (const p of kept) {
      for (const t of [p.token0, p.token1]) if (!BASE_TOKEN_SET.has(t)) counterTokens.add(t);
    }
    const have = new Set(kept.map((p) => p.address));
    for (const dex of DEXES) {
      if (mode === "full" && dex.id !== "uniswap-v2") continue; // already enumerated in full
      const found = (await this.lookupPairs(dex, [...BASE_TOKEN_SET], [...counterTokens, ...BASE_TOKEN_SET], block)).filter((p) => !have.has(p.address));
      await this.refreshReserves(found, block);
      await this.loadTokenMetaForPools(found);
      const ok = found.filter((p) => this.liquidityInWeth(p, ethUsd) >= opts.minLiquidityWeth);
      log.info(`${dex.name}: ${found.length} more pairs found by lookup, ${ok.length} pass liquidity floor`);
      for (const p of ok) {
        have.add(p.address);
        kept.push(p);
      }
    }

    // Only pairs that exist on at least two pools are useful for arbitrage.
    const byPair = new Map<string, Pool[]>();
    for (const p of kept) {
      const k = pairKey(p.token0, p.token1);
      byPair.set(k, [...(byPair.get(k) ?? []), p]);
    }
    let arbable = [...byPair.values()].filter((arr) => arr.length >= 2).flat();
    arbable.sort((x, y) => this.liquidityInWeth(y, ethUsd) - this.liquidityInWeth(x, ethUsd));
    if (arbable.length > opts.maxPools) {
      log.warn(`capping watch list at ${opts.maxPools} of ${arbable.length} pools (raise MAX_POOLS to watch more)`);
      arbable = arbable.slice(0, opts.maxPools);
    }

    await this.calibrateFees(arbable, block);
    const calibrated = arbable.filter((p) => p.feePpm >= 0);
    log.info(`${calibrated.length} pools calibrated across ${new Set(calibrated.map((p) => pairKey(p.token0, p.token1))).size} token pairs`);

    this.pools.clear();
    for (const p of calibrated) this.pools.set(p.address, p);
  }

  /** Pools (on DEXes we can trade) that emitted a Swap in the last `lookback` blocks. */
  private async activePools(block: number, lookback: number, range: number): Promise<Pool[]> {
    const addrs = new Set<string>();
    const from = Math.max(0, block - lookback);
    let start = from;
    let shrunk = false;
    while (start <= block) {
      const end = Math.min(block, start + range - 1);
      try {
        const logs = await this.chain.getLogs({ fromBlock: start, toBlock: end, topics: [[TOPIC_SWAP_V2, TOPIC_SWAP_AERO]] });
        for (const l of logs) addrs.add(l.address.toLowerCase());
        log.debug(`blocks ${start}-${end}: ${logs.length} swaps, ${addrs.size} distinct pools so far`);
        start = end + 1;
      } catch (err) {
        // Providers cap eth_getLogs differently (Alchemy free tier: 10 blocks; others: 2k-10k
        // blocks or N results). Shrink the window and retry the same span.
        const msg = (err as Error).message ?? "";
        if (range > 1 && /block range|range|too many|limit|exceed|response size|query returned more/i.test(msg)) {
          const suggested = /up to a (\d+) block/i.exec(msg);
          range = suggested ? Math.max(1, Number(suggested[1])) : Math.max(1, Math.floor(range / 4));
          if (!shrunk) log.info(`this RPC limits eth_getLogs ranges; using ${range}-block windows for discovery (set DISCOVERY_LOG_RANGE=${range} to skip this probe)`);
          shrunk = true;
          continue;
        }
        throw err;
      }
    }
    return this.describeUnknownPools([...addrs], block);
  }

  /**
   * token0/token1/factory for pools of unknown origin; keeps only pools whose
   * factory is one of ours (and, for Aerodrome, volatile ones).
   */
  async describeUnknownPools(addrs: string[], block: number): Promise<Pool[]> {
    const calls: Call[] = [];
    for (const a of addrs) {
      calls.push({ target: a, callData: univ2PairIface.encodeFunctionData("token0") });
      calls.push({ target: a, callData: univ2PairIface.encodeFunctionData("token1") });
      calls.push({ target: a, callData: univ2PairIface.encodeFunctionData("factory") });
      calls.push({ target: a, callData: aeroPoolIface.encodeFunctionData("stable") });
    }
    const res = await this.chain.multicall(calls, block);
    const byFactory = new Map(DEXES.map((d) => [d.factory.toLowerCase(), d]));
    const pools: Pool[] = [];
    addrs.forEach((a, i) => {
      const r0 = res[i * 4]!;
      const r1 = res[i * 4 + 1]!;
      const rf = res[i * 4 + 2]!;
      const rs = res[i * 4 + 3]!;
      if (!r0.success || !r1.success || !rf.success || r0.returnData.length < 66 || r1.returnData.length < 66 || rf.returnData.length < 66) return;
      const dex = byFactory.get((abi.decode(["address"], rf.returnData)[0] as string).toLowerCase());
      if (!dex) return;
      const stable = rs.success && rs.returnData.length >= 66 ? Boolean(abi.decode(["bool"], rs.returnData)[0]) : false;
      if (stable) return;
      pools.push({
        address: a,
        dex: dex.id,
        kind: dex.kind,
        token0: (abi.decode(["address"], r0.returnData)[0] as string).toLowerCase(),
        token1: (abi.decode(["address"], r1.returnData)[0] as string).toLowerCase(),
        reserve0: 0n,
        reserve1: 0n,
        feePpm: dex.defaultFeePpm,
        feeModel: dex.kind === "aerodrome" ? "bps" : "ppm",
        stable: false,
        updatedBlock: 0,
      });
    });
    return pools;
  }

  private async enumerateFactory(dex: DexInfo, block: number): Promise<Pool[]> {
    const isAero = dex.kind === "aerodrome";
    const lenData = isAero
      ? aeroFactoryIface.encodeFunctionData("allPoolsLength")
      : univ2FactoryIface.encodeFunctionData("allPairsLength");
    const lenRaw = await this.chain.call(dex.factory, lenData, block);
    const length = Number(abi.decode(["uint256"], lenRaw)[0]);
    if (length > 20_000) log.warn(`${dex.name} has ${length} pools; enumeration will take a while`);

    const idxCalls: Call[] = [];
    for (let i = 0; i < length; i++) {
      idxCalls.push({
        target: dex.factory,
        callData: isAero ? aeroFactoryIface.encodeFunctionData("allPools", [i]) : univ2FactoryIface.encodeFunctionData("allPairs", [i]),
      });
    }
    const addrs = (await this.chain.multicall(idxCalls, block))
      .filter((r) => r.success && r.returnData.length >= 66)
      .map((r) => (abi.decode(["address"], r.returnData)[0] as string).toLowerCase());
    return this.describePools(dex, addrs, block);
  }

  /** token0/token1 (+stable for Aerodrome) for a list of pool addresses. */
  private async describePools(dex: DexInfo, addrs: string[], block: number): Promise<Pool[]> {
    const isAero = dex.kind === "aerodrome";
    const iface = isAero ? aeroPoolIface : univ2PairIface;
    const calls: Call[] = [];
    for (const a of addrs) {
      calls.push({ target: a, callData: iface.encodeFunctionData("token0") });
      calls.push({ target: a, callData: iface.encodeFunctionData("token1") });
      if (isAero) calls.push({ target: a, callData: aeroPoolIface.encodeFunctionData("stable") });
    }
    const res = await this.chain.multicall(calls, block);
    const per = isAero ? 3 : 2;
    const pools: Pool[] = [];
    addrs.forEach((a, i) => {
      const r0 = res[i * per]!;
      const r1 = res[i * per + 1]!;
      if (!r0.success || !r1.success || r0.returnData.length < 66 || r1.returnData.length < 66) return;
      const stable = isAero ? Boolean(abi.decode(["bool"], res[i * per + 2]!.returnData)[0]) : false;
      if (stable) return; // stable-curve pools are not constant product; skipped in v1
      pools.push({
        address: a,
        dex: dex.id,
        kind: dex.kind,
        token0: (abi.decode(["address"], r0.returnData)[0] as string).toLowerCase(),
        token1: (abi.decode(["address"], r1.returnData)[0] as string).toLowerCase(),
        reserve0: 0n,
        reserve1: 0n,
        feePpm: dex.defaultFeePpm,
        feeModel: isAero ? "bps" : "ppm",
        stable,
        updatedBlock: 0,
      });
    });
    return pools;
  }

  private async lookupPairs(dex: DexInfo, bases: string[], tokens: string[], block: number): Promise<Pool[]> {
    const seen = new Set<string>();
    const calls: Call[] = [];
    const combos: Array<[string, string]> = [];
    for (const b of bases) {
      for (const t of tokens) {
        if (b === t) continue;
        const k = pairKey(b, t);
        if (seen.has(k)) continue;
        seen.add(k);
        combos.push([b, t]);
        calls.push({
          target: dex.factory,
          callData:
            dex.kind === "aerodrome"
              ? aeroFactoryIface.encodeFunctionData("getPool", [b, t, false])
              : univ2FactoryIface.encodeFunctionData("getPair", [b, t]),
        });
      }
    }
    const res = await this.chain.multicall(calls, block);
    const addrs: string[] = [];
    res.forEach((r) => {
      if (!r.success || r.returnData.length < 66) return;
      const a = (abi.decode(["address"], r.returnData)[0] as string).toLowerCase();
      if (a !== "0x0000000000000000000000000000000000000000") addrs.push(a);
    });
    return this.describePools(dex, addrs, block);
  }

  async loadTokenMetaForPools(pools: Pool[]): Promise<void> {
    await this.loadTokenMeta(pools.flatMap((p) => [p.token0, p.token1]));
  }

  async loadTokenMeta(tokenAddresses: Iterable<string>): Promise<void> {
    const need = new Set<string>();
    for (const raw of tokenAddresses) {
      const t = raw.toLowerCase();
      if (!this.tokens.has(t)) need.add(t);
    }
    // Seed known tokens without a round trip.
    for (const t of Object.values(TOKENS)) {
      const a = t.address.toLowerCase();
      if (need.has(a)) {
        this.tokens.set(a, { address: a, symbol: t.symbol, decimals: t.decimals });
        need.delete(a);
      }
    }
    if (need.size === 0) return;
    const addrs = [...need];
    const calls: Call[] = [];
    for (const a of addrs) {
      calls.push({ target: a, callData: erc20Iface.encodeFunctionData("symbol") });
      calls.push({ target: a, callData: erc20Iface.encodeFunctionData("decimals") });
    }
    const res = await this.chain.multicall(calls);
    addrs.forEach((a, i) => {
      const s = res[i * 2]!;
      const d = res[i * 2 + 1]!;
      let symbol = a.slice(0, 8);
      if (s.success && s.returnData.length > 2) {
        try {
          symbol = abi.decode(["string"], s.returnData)[0] as string;
        } catch {
          // Some tokens return bytes32 symbols; keep the fallback.
        }
      }
      const decimals = d.success && d.returnData.length >= 66 ? Number(abi.decode(["uint8"], d.returnData)[0]) : 18;
      this.tokens.set(a, { address: a, symbol: symbol.replace(/[^\x20-\x7e]/g, "").slice(0, 16) || a.slice(0, 8), decimals });
    });
  }

  // ------------------------------------------------------------------------
  // Reserves
  // ------------------------------------------------------------------------

  /** Refresh reserves for the given pools at one block (consistent snapshot). */
  async refreshReserves(pools: Pool[], block: number): Promise<void> {
    if (pools.length === 0) return;
    const calls: Call[] = pools.map((p) => ({
      target: p.address,
      callData: (p.kind === "aerodrome" ? aeroPoolIface : univ2PairIface).encodeFunctionData("getReserves"),
    }));
    const res = await this.chain.multicall(calls, block);
    pools.forEach((p, i) => {
      const r = res[i]!;
      if (!r.success || r.returnData.length < 2 + 64 * 3) return;
      const [r0, r1] = abi.decode(["uint256", "uint256", "uint256"], r.returnData) as unknown as [bigint, bigint, bigint];
      p.reserve0 = r0;
      p.reserve1 = r1;
      p.updatedBlock = block;
    });
  }

  async refreshAll(block: number): Promise<void> {
    await this.refreshReserves([...this.pools.values()], block);
  }

  // ------------------------------------------------------------------------
  // Pricing helpers
  // ------------------------------------------------------------------------

  /** ETH/USD from the deepest WETH/USDC pool in the list (falls back to 3000 with a warning). */
  ethPriceFrom(pools: Pool[]): number {
    const usdc = TOKENS.USDC!.address.toLowerCase();
    let best: Pool | undefined;
    for (const p of pools) {
      const isPair = (p.token0 === WETH && p.token1 === usdc) || (p.token1 === WETH && p.token0 === usdc);
      if (!isPair) continue;
      if (!best || this.wethReserve(p) > this.wethReserve(best)) best = p;
    }
    if (!best || this.wethReserve(best) === 0n) {
      log.warn("no WETH/USDC pool found for pricing; assuming $3000/ETH");
      return 3000;
    }
    const wethRes = Number(this.wethReserve(best)) / 1e18;
    const usdcRes = Number(best.token0 === usdc ? best.reserve0 : best.reserve1) / 1e6;
    return usdcRes / wethRes;
  }

  ethPrice(): number {
    return this.ethPriceFrom([...this.pools.values()]);
  }

  private wethReserve(p: Pool): bigint {
    if (p.token0 === WETH) return p.reserve0;
    if (p.token1 === WETH) return p.reserve1;
    return 0n;
  }

  /** Pool depth measured in WETH-equivalent of its base-token side (0 if it has no base token). */
  liquidityInWeth(p: Pool, ethUsd: number): number {
    for (const [tok, res] of [
      [p.token0, p.reserve0],
      [p.token1, p.reserve1],
    ] as Array<[string, bigint]>) {
      if (tok === WETH) return Number(res) / 1e18;
      const meta = Object.values(TOKENS).find((t) => t.address.toLowerCase() === tok);
      if (meta?.approxUsd) return (Number(res) / 10 ** meta.decimals) * meta.approxUsd / ethUsd;
      if (meta?.symbol === "cbETH") return Number(res) / 1e18; // close enough to ETH for a depth filter
    }
    return 0;
  }

  /**
   * USD value of `amount` of `token`, priced through the deepest pool that
   * pairs it with WETH or a stablecoin. Returns null when no route is known.
   */
  usdValue(token: string, amount: bigint, ethUsd: number): number | null {
    const t = token.toLowerCase();
    const meta = this.token(t);
    const decimals = meta?.decimals ?? 18;
    const amt = Number(amount) / 10 ** decimals;
    if (t === WETH) return amt * ethUsd;
    const known = Object.values(TOKENS).find((x) => x.address.toLowerCase() === t);
    if (known?.approxUsd) return amt * known.approxUsd;
    if (known?.symbol === "cbETH") return amt * ethUsd;
    // Price via the deepest WETH pool containing the token.
    let best: Pool | undefined;
    for (const p of this.pools.values()) {
      if (p.token0 !== t && p.token1 !== t) continue;
      const other = p.token0 === t ? p.token1 : p.token0;
      if (other !== WETH) continue;
      if (!best || this.wethReserve(p) > this.wethReserve(best)) best = p;
    }
    if (!best) return null;
    const tokRes = Number(best.token0 === t ? best.reserve0 : best.reserve1) / 10 ** decimals;
    const wethRes = Number(this.wethReserve(best)) / 1e18;
    if (tokRes === 0) return null;
    return amt * (wethRes / tokRes) * ethUsd;
  }

  // ------------------------------------------------------------------------
  // Fee calibration
  // ------------------------------------------------------------------------

  /**
   * Determine each pool's real fee by asking the DEX's own quoter for a sample
   * swap and matching it against our formula. Pools whose output cannot be
   * reproduced (fee-on-transfer tokens, exotic curves) get feePpm = -1 and are
   * excluded, because we could not trust our own profit calculation for them.
   */
  async calibrateFees(pools: Pool[], block: number): Promise<void> {
    const calls: Call[] = [];
    const samples: bigint[] = [];
    for (const p of pools) {
      const sample = p.reserve0 / 1000n > 0n ? p.reserve0 / 1000n : 1n;
      samples.push(sample);
      if (p.kind === "aerodrome") {
        calls.push({ target: p.address, callData: aeroPoolIface.encodeFunctionData("getAmountOut", [sample, p.token0]) });
      } else {
        const dex = DEXES.find((d) => d.id === p.dex)!;
        calls.push({ target: dex.router, callData: univ2RouterIface.encodeFunctionData("getAmountsOut", [sample, [p.token0, p.token1]]) });
      }
    }
    const res = await this.chain.multicall(calls, block);
    const candidatesPpm = [3000, 2500, 2000, 1700, 1500, 1000, 500, 300, 250, 100, 50, 10000, 5000, 4000, 0];
    let excluded = 0;
    pools.forEach((p, i) => {
      const r = res[i]!;
      const sample = samples[i]!;
      if (!r.success || r.returnData.length < 66) {
        p.feePpm = -1;
        excluded++;
        return;
      }
      let onchain: bigint;
      if (p.kind === "aerodrome") {
        onchain = abi.decode(["uint256"], r.returnData)[0] as bigint;
      } else {
        const amounts = abi.decode(["uint256[]"], r.returnData)[0] as bigint[];
        onchain = amounts[amounts.length - 1]!;
      }
      let match = -1;
      const models: FeeModel[] = p.kind === "aerodrome" ? ["bps"] : ["ppm", "bps"];
      outer: for (const model of models) {
        for (const fee of candidatesPpm) {
          if (getAmountOut(sample, p.reserve0, p.reserve1, fee, model) === onchain) {
            match = fee;
            p.feeModel = model;
            break outer;
          }
        }
      }
      if (match < 0) {
        log.debug(`fee calibration failed for ${p.dex} ${p.address} (quoter=${onchain})`);
        excluded++;
      }
      p.feePpm = match;
    });
    if (excluded) log.info(`${excluded} pools excluded: on-chain quote did not match any known fee model`);
  }

  // ------------------------------------------------------------------------
  // Runtime additions & persistence
  // ------------------------------------------------------------------------

  /** Add a pool seen in the wild (e.g. used by an arbitrage bot). Returns the pool or null. */
  async addPoolByAddress(address: string, dexHint?: string): Promise<Pool | null> {
    void dexHint; // the factory() call in describeUnknownPools is authoritative
    const [p] = await this.addPoolsByAddress([address]);
    return p ?? null;
  }

  /** Batched variant: one round of describe/reserves/tokens/calibration for all addresses. */
  async addPoolsByAddress(addresses: string[]): Promise<Pool[]> {
    const wanted = [...new Set(addresses.map((a) => a.toLowerCase()))].filter((a) => !this.pools.has(a));
    if (wanted.length === 0) return [];
    const block = await this.chain.blockNumber();
    const found = await this.describeUnknownPools(wanted, block);
    if (found.length === 0) return [];
    await this.refreshReserves(found, block);
    await this.loadTokenMetaForPools(found);
    await this.calibrateFees(found, block);
    const ok = found.filter((p) => p.feePpm >= 0);
    for (const p of ok) this.pools.set(p.address, p);
    if (ok.length) this.dirty = true;
    return ok;
  }

  toSnapshot(block: number): PoolSnapshot {
    return {
      version: 1,
      discoveredAt: new Date().toISOString(),
      block,
      tokens: [...this.tokens.values()],
      pools: [...this.pools.values()].map(({ reserve0: _r0, reserve1: _r1, updatedBlock: _b, ...rest }) => rest),
    };
  }

  loadSnapshot(s: PoolSnapshot): void {
    this.pools.clear();
    this.tokens.clear();
    for (const t of s.tokens) this.tokens.set(t.address, t);
    for (const p of s.pools) this.pools.set(p.address, { ...p, reserve0: 0n, reserve1: 0n, updatedBlock: 0 });
  }
}

export function checksum(a: string): string {
  try {
    return getAddress(a);
  } catch {
    return a;
  }
}
