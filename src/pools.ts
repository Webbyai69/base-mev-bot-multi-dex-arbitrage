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
import { getAddress, AbiCoder, type Log } from "ethers";
import { CL_DEXES, DEXES, TOKENS, WETH, USDC, V4, NATIVE, type ClDexInfo, type DexInfo, type DexKind } from "./config.js";
import {
  TOPIC_BURN_V3,
  TOPIC_MINT_V3,
  TOPIC_MODIFY_LIQUIDITY_V4,
  TOPIC_SWAP_AERO,
  TOPIC_SWAP_PANCAKE_V3,
  TOPIC_SWAP_V2,
  TOPIC_SWAP_V3,
  TOPIC_SWAP_V4,
  TOPIC_SYNC,
  TOPIC_SYNC_AERO,
  aeroFactoryIface,
  aeroPoolIface,
  erc20Iface,
  slipstreamFactoryIface,
  slipstreamPoolIface,
  univ2FactoryIface,
  univ2PairIface,
  univ2RouterIface,
  univ3FactoryIface,
  univ3PoolIface,
  stateViewIface,
  v4PoolId,
} from "./abi.js";
import { getAmountOut, type FeeModel } from "./math.js";
import { compressTick, getAmount0Delta, getAmount1Delta, rangeBoundary, virtualReserves, wordPosition, wordsNeeded, type ClState } from "./clmath.js";
import type { Chain, Call, CallResult } from "./rpc.js";
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
  /** Concentrated-liquidity state (Uniswap V3 / Slipstream / PancakeSwap V3 / Uniswap V4). reserve0/1 then hold virtual reserves. */
  cl?: ClPoolState;
  /**
   * Uniswap V4 only: the pool lives inside the singleton PoolManager keyed by poolId (there is no pool
   * contract), so it is read via StateView and quoted via V4Quoter, never by calling `address`. token0/
   * token1 above are the graph tokens, with native ETH (currency 0x0) mapped to WETH; v4 holds the real key.
   */
  v4?: V4Info;
  /** Real token balances, only used for the liquidity floor during discovery. */
  bal0?: bigint;
  bal1?: bigint;
}

export interface ClPoolState extends ClState {
  /** Quoter used to cross-check this pool's maths (one per factory). */
  quoter: string;
}

export interface V4Info {
  /** keccak256(abi.encode(PoolKey)) — the registry key (Pool.address) for a V4 pool. */
  poolId: string;
  /** Real currencies; currency0 may be 0x0 (native ETH). token0/token1 are these with 0x0 mapped to WETH. */
  currency0: string;
  currency1: string;
  fee: number;
  tickSpacing: number;
  hooks: string;
}

type SnapshotPool = Omit<Pool, "reserve0" | "reserve1" | "updatedBlock" | "cl" | "bal0" | "bal1"> & {
  cl?: { tickSpacing: number; feePips: number; quoter: string };
};

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
  pools: SnapshotPool[];
}

const abi = AbiCoder.defaultAbiCoder();
const BASE_TOKEN_SET = new Set(Object.values(TOKENS).map((t) => t.address.toLowerCase()));

export function pairKey(a: string, b: string): string {
  const [x, y] = [a.toLowerCase(), b.toLowerCase()].sort();
  return `${x}-${y}`;
}

/** Price-relevant state of a pool in one string: two equal signatures mean nothing a route depends on changed. */
export function poolStateSig(p: Pool): string {
  return p.cl ? `${p.cl.sqrtPriceX96}:${p.cl.liquidity}:${p.cl.tick}:${p.cl.feePips}:${p.cl.words.size}` : `${p.reserve0}:${p.reserve1}:${p.feePpm}`;
}

/** A copy whose state can change without touching the original (the Flashblocks overlay). */
export function clonePool(p: Pool): Pool {
  return p.cl ? { ...p, cl: { ...p.cl, words: new Map(p.cl.words) } } : { ...p };
}

const POOL_MANAGER = V4.poolManager.toLowerCase();

/** A log as the RPC returns it, or as the Flashblocks stream carries it (no block number there). */
export interface StateLog {
  address: string;
  topics: readonly string[];
  data: string;
  blockNumber?: number;
}

/**
 * The watched pool a state-changing log belongs to: the emitting contract for V2/V3-style pools, the
 * poolId in topic 1 for Uniswap V4 (whose pools all live in the PoolManager).
 */
export function poolKeyOfLog(l: StateLog): string | undefined {
  const a = l.address.toLowerCase();
  if (a === POOL_MANAGER) {
    const t0 = l.topics[0];
    return (t0 === TOPIC_SWAP_V4 || t0 === TOPIC_MODIFY_LIQUIDITY_V4) && l.topics[1] ? l.topics[1].toLowerCase() : undefined;
  }
  return a;
}

/**
 * Apply one log to a pool's state, with no RPC.
 *   "set"    the log carried the new state exactly (V2/Aerodrome Sync, V3/PancakeSwap/V4 Swap)
 *   "fee"    as "set", but Slipstream's fee is dynamic, so fee() must be re-read
 *   "reread" liquidity or the tick bitmap changed (Mint/Burn/ModifyLiquidity): only a read can tell
 *   null     the log doesn't change this pool's price state
 */
export function applyStateLog(p: Pool, l: StateLog): "set" | "fee" | "reread" | null {
  const t0 = l.topics[0];
  if (!p.cl) {
    if (t0 !== TOPIC_SYNC && t0 !== TOPIC_SYNC_AERO) return null;
    const [r0, r1] = abi.decode(["uint256", "uint256"], l.data) as unknown as [bigint, bigint];
    p.reserve0 = r0;
    p.reserve1 = r1;
    if (l.blockNumber !== undefined) p.updatedBlock = l.blockNumber;
    return "set";
  }
  let d: ReturnType<typeof abi.decode> | undefined;
  if (p.v4) {
    if (t0 === TOPIC_MODIFY_LIQUIDITY_V4) return "reread";
    if (t0 !== TOPIC_SWAP_V4) return null;
    // amount0, amount1, sqrtPriceX96, liquidity, tick, fee
    d = abi.decode(["int128", "int128", "uint160", "uint128", "int24", "uint24"], l.data);
  } else if (t0 === TOPIC_SWAP_V3 || t0 === TOPIC_SWAP_PANCAKE_V3) {
    // PancakeSwap V3's Swap carries two extra protocol-fee fields; the first five (amount0, amount1,
    // sqrtPriceX96, liquidity, tick) match Uniswap V3, so we read those and ignore the rest.
    d = abi.decode(t0 === TOPIC_SWAP_PANCAKE_V3 ? ["int256", "int256", "uint160", "uint128", "int24", "uint128", "uint128"] : ["int256", "int256", "uint160", "uint128", "int24"], l.data);
  } else if (t0 === TOPIC_MINT_V3 || t0 === TOPIC_BURN_V3) {
    return "reread";
  } else {
    return null;
  }
  const s = p.cl;
  s.sqrtPriceX96 = d[2] as bigint;
  s.liquidity = d[3] as bigint;
  s.tick = Number(d[4]);
  const v = virtualReserves(s);
  p.reserve0 = v.reserve0;
  p.reserve1 = v.reserve1;
  if (l.blockNumber !== undefined) p.updatedBlock = l.blockNumber;
  return p.kind === "slipstream" ? "fee" : "set";
}

/**
 * Real token amounts a CL pool can trade before its liquidity next changes (between the nearest
 * initialized ticks we have loaded). Unlike virtual reserves, this can't overstate a narrow position.
 */
export function activeRangeAmounts(s: ClState): { amount0: bigint; amount1: bigint } | null {
  if (s.sqrtPriceX96 === 0n || s.liquidity <= 0n) return null;
  const lower = rangeBoundary(s, true);
  const upper = rangeBoundary(s, false);
  if (lower === null || upper === null) return null;
  return {
    amount0: upper > s.sqrtPriceX96 ? getAmount0Delta(s.sqrtPriceX96, upper, s.liquidity, false) : 0n,
    amount1: lower < s.sqrtPriceX96 ? getAmount1Delta(lower, s.sqrtPriceX96, s.liquidity, false) : 0n,
  };
}

export class PoolRegistry {
  readonly pools = new Map<string, Pool>();
  readonly tokens = new Map<string, TokenMeta>();
  /** Set when the watch list changed since the last snapshot write. */
  dirty = false;
  /** Watch Uniswap V3 / Slipstream pools too (CL_POOLS). */
  clPools = true;
  /** Tokens never watched or traded (TOKEN_BLACKLIST). */
  blacklist = new Set<string>();
  /** Last block whose state every watched pool reflects (0 = never fully read). */
  syncedBlock = 0;
  /** Pools last read at the pre-confirmed ("pending") state by the Flashblocks loop; re-read at the next block. */
  private pendingDirty = new Set<string>();
  /** Smallest real depth (WETH-equivalent) of a pool used to price a token in USD (PRICE_MIN_DEPTH_WETH). */
  priceMinDepthWeth = 1;
  /** Bumped whenever pool state may have changed; keys the per-token price cache. */
  private stateEpoch = 0;
  private priceCache = new Map<string, { epoch: number; ethUsd: number; usdPerUnit: number | null }>();

  constructor(readonly chain: Chain) {}

  private allowed(p: Pool): boolean {
    return !this.blacklist.has(p.token0) && !this.blacklist.has(p.token1);
  }

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
    for (let i = candidates.length - 1; i >= 0; i--) if (!this.allowed(candidates[i]!)) candidates.splice(i, 1);
    await this.refreshReserves(candidates, block);
    await this.loadClBalances(candidates, block);
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
    const lookups: Array<{ name: string; find: () => Promise<Pool[]> }> = [];
    for (const dex of DEXES) {
      if (mode === "full" && dex.id !== "uniswap-v2") continue; // already enumerated in full
      lookups.push({ name: dex.name, find: () => this.lookupPairs(dex, [...BASE_TOKEN_SET], [...counterTokens, ...BASE_TOKEN_SET], block) });
    }
    if (this.clPools) {
      for (const dex of CL_DEXES) lookups.push({ name: dex.name, find: () => this.lookupClPools(dex, [WETH, USDC], [...counterTokens, ...BASE_TOKEN_SET], block) });
      lookups.push({ name: "Uniswap V4 (hookless)", find: () => this.lookupV4Pools([WETH, USDC], [...counterTokens, ...BASE_TOKEN_SET], block) });
    }
    for (const { name, find } of lookups) {
      const found = (await find()).filter((p) => !have.has(p.address) && this.allowed(p));
      await this.refreshReserves(found, block);
      await this.loadClBalances(found, block);
      await this.loadTokenMetaForPools(found);
      const ok = found.filter((p) => this.liquidityInWeth(p, ethUsd) >= opts.minLiquidityWeth);
      log.info(`${name}: ${found.length} more pools found by lookup, ${ok.length} pass liquidity floor`);
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
    // bal0/bal1 stay: they are the pools' real depth (refreshed on every full refresh).
    for (const p of calibrated) this.pools.set(p.address, p);
    const cl = calibrated.filter((p) => p.cl).length;
    if (cl) log.info(`${cl} of them are concentrated-liquidity pools (Uniswap V3 / Slipstream)`);
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
        const topics = this.clPools ? [TOPIC_SWAP_V2, TOPIC_SWAP_AERO, TOPIC_SWAP_V3, TOPIC_SWAP_PANCAKE_V3] : [TOPIC_SWAP_V2, TOPIC_SWAP_AERO];
        const logs = await this.chain.getLogs({ fromBlock: start, toBlock: end, topics: [topics] });
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
    const PER = 6;
    const calls: Call[] = [];
    for (const a of addrs) {
      calls.push({ target: a, callData: univ2PairIface.encodeFunctionData("token0") });
      calls.push({ target: a, callData: univ2PairIface.encodeFunctionData("token1") });
      calls.push({ target: a, callData: univ2PairIface.encodeFunctionData("factory") });
      calls.push({ target: a, callData: aeroPoolIface.encodeFunctionData("stable") });
      calls.push({ target: a, callData: univ3PoolIface.encodeFunctionData("tickSpacing") });
      calls.push({ target: a, callData: univ3PoolIface.encodeFunctionData("fee") });
    }
    const res = await this.chain.multicall(calls, block);
    const byFactory = new Map(DEXES.map((d) => [d.factory.toLowerCase(), d]));
    const clByFactory = new Map(CL_DEXES.map((d) => [d.factory.toLowerCase(), d]));
    const pools: Pool[] = [];
    addrs.forEach((a, i) => {
      const r0 = res[i * PER]!;
      const r1 = res[i * PER + 1]!;
      const rf = res[i * PER + 2]!;
      const rs = res[i * PER + 3]!;
      if (!r0.success || !r1.success || !rf.success || r0.returnData.length < 66 || r1.returnData.length < 66 || rf.returnData.length < 66) return;
      const factory = (abi.decode(["address"], rf.returnData)[0] as string).toLowerCase();
      const clDex = this.clPools ? clByFactory.get(factory) : undefined;
      if (clDex) {
        const rt = res[i * PER + 4]!;
        const rfee = res[i * PER + 5]!;
        if (!rt.success || !rfee.success || rt.returnData.length < 66 || rfee.returnData.length < 66) return;
        pools.push(
          this.newClPool(
            a,
            clDex,
            (abi.decode(["address"], r0.returnData)[0] as string).toLowerCase(),
            (abi.decode(["address"], r1.returnData)[0] as string).toLowerCase(),
            Number(abi.decode(["int24"], rt.returnData)[0]),
            Number(abi.decode(["uint24"], rfee.returnData)[0]),
          ),
        );
        return;
      }
      const dex = byFactory.get(factory);
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

  private newClPool(address: string, dex: ClDexInfo, token0: string, token1: string, tickSpacing: number, feePips: number): Pool {
    return {
      address: address.toLowerCase(),
      dex: dex.id,
      kind: dex.kind,
      token0,
      token1,
      reserve0: 0n,
      reserve1: 0n,
      feePpm: feePips,
      feeModel: "ppm",
      stable: false,
      updatedBlock: 0,
      cl: { sqrtPriceX96: 0n, tick: 0, liquidity: 0n, tickSpacing, feePips, words: new Map(), quoter: dex.quoter.toLowerCase() },
    };
  }

  /** Factory lookups of CL pools for base x token pairs over every fee tier / tick spacing. */
  private async lookupClPools(dex: ClDexInfo, bases: string[], tokens: string[], block: number): Promise<Pool[]> {
    const calls: Call[] = [];
    const meta: Array<{ t0: string; t1: string; key: number }> = [];
    const seen = new Set<string>();
    for (const b of bases) {
      for (const t of tokens) {
        if (b === t) continue;
        const k = pairKey(b, t);
        if (seen.has(k)) continue;
        seen.add(k);
        const [t0, t1] = k.split("-") as [string, string];
        for (const key of dex.poolKeys) {
          meta.push({ t0, t1, key });
          calls.push({
            target: dex.factory,
            // Uniswap V3 and PancakeSwap V3 both key getPool by fee tier; Slipstream keys by tickSpacing.
            callData: dex.kind === "slipstream" ? slipstreamFactoryIface.encodeFunctionData("getPool", [t0, t1, key]) : univ3FactoryIface.encodeFunctionData("getPool", [t0, t1, key]),
          });
        }
      }
    }
    const res = await this.chain.multicall(calls, block);
    const addrs: string[] = [];
    res.forEach((r) => {
      if (!r.success || r.returnData.length < 66) return;
      const a = (abi.decode(["address"], r.returnData)[0] as string).toLowerCase();
      if (a !== "0x0000000000000000000000000000000000000000") addrs.push(a);
    });
    // describeUnknownPools reads tickSpacing/fee and checks the factory.
    return this.describeUnknownPools(addrs, block);
  }

  /** Real token balances of CL pools (virtual reserves overstate depth for the liquidity floor). */
  private async loadClBalances(pools: Pool[], block: number): Promise<void> {
    // V4 has no pool contract holding the tokens (the PoolManager pools them), so its depth is read from
    // virtual reserves instead — skip it here and liquidityInWeth falls back to reserve0/1.
    const cl = pools.filter((p) => p.cl && !p.v4);
    if (cl.length === 0) return;
    const calls: Call[] = cl.flatMap((p) => [
      { target: p.token0, callData: erc20Iface.encodeFunctionData("balanceOf", [p.address]) },
      { target: p.token1, callData: erc20Iface.encodeFunctionData("balanceOf", [p.address]) },
    ]);
    const res = await this.chain.multicall(calls, block);
    cl.forEach((p, i) => {
      const a = res[i * 2]!;
      const b = res[i * 2 + 1]!;
      p.bal0 = a.success && a.returnData.length >= 66 ? (abi.decode(["uint256"], a.returnData)[0] as bigint) : 0n;
      p.bal1 = b.success && b.returnData.length >= 66 ? (abi.decode(["uint256"], b.returnData)[0] as bigint) : 0n;
    });
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
  /** `via` lets the Flashblocks loop read pre-confirmed state through its own RPC endpoint. */
  async refreshReserves(pools: Pool[], block: number | "pending", via?: Chain): Promise<void> {
    if (pools.length === 0) return;
    // Only the registry's own pool objects need a re-read at the next block; the Flashblocks loop
    // reads into copies (clonePool), which leave the confirmed state alone.
    if (block === "pending") for (const p of pools) if (this.pools.get(p.address) === p) this.pendingDirty.add(p.address);
    const v2 = pools.filter((p) => !p.cl);
    // V4 pools have no pool contract to call — they're refreshed separately via StateView (refreshV4).
    const cl = pools.filter((p) => p.cl && !p.v4);
    await Promise.all([this.refreshV2(v2, block, via ?? this.chain), this.refreshCl(cl, block, via ?? this.chain)]);
  }

  private async refreshV2(pools: Pool[], block: number | "pending", chain: Chain): Promise<void> {
    if (pools.length === 0) return;
    const calls: Call[] = pools.map((p) => ({
      target: p.address,
      callData: (p.kind === "aerodrome" ? aeroPoolIface : univ2PairIface).encodeFunctionData("getReserves"),
    }));
    const res = await chain.multicall(calls, block);
    pools.forEach((p, i) => {
      const r = res[i]!;
      if (!r.success || r.returnData.length < 2 + 64 * 3) return;
      const [r0, r1] = abi.decode(["uint256", "uint256", "uint256"], r.returnData) as unknown as [bigint, bigint, bigint];
      p.reserve0 = r0;
      p.reserve1 = r1;
      if (block !== "pending") p.updatedBlock = block;
    });
  }

  /**
   * One multicall per refresh for CL pools: slot0, liquidity, fee (dynamic on
   * Slipstream) and the tick-bitmap words around the last known tick. If the
   * price moved more than one word since, the words we need are missing and
   * the pool is simply infeasible for routing until the next refresh.
   */
  private async refreshCl(pools: Pool[], block: number | "pending", chain: Chain): Promise<void> {
    if (pools.length === 0) return;
    // Pools never refreshed need their tick first to know which words to read.
    const fresh = pools.filter((p) => p.cl!.sqrtPriceX96 === 0n);
    if (fresh.length) await this.readCl(fresh, block, false, chain);
    await this.readCl(pools, block, true, chain);
  }

  private async readCl(pools: Pool[], block: number | "pending", withWords: boolean, chain: Chain): Promise<void> {
    const calls: Call[] = [];
    const layout: Array<{ start: number; words: number[] }> = [];
    for (const p of pools) {
      const s = p.cl!;
      const start = calls.length;
      const slot0Iface = p.kind === "slipstream" ? slipstreamPoolIface : univ3PoolIface;
      calls.push({ target: p.address, callData: slot0Iface.encodeFunctionData("slot0") });
      calls.push({ target: p.address, callData: univ3PoolIface.encodeFunctionData("liquidity") });
      calls.push({ target: p.address, callData: univ3PoolIface.encodeFunctionData("fee") });
      let words: number[] = [];
      if (withWords) {
        const w = wordPosition(compressTick(s.tick, s.tickSpacing));
        words = [w - 1, w, w + 1];
        for (const wp of words) calls.push({ target: p.address, callData: univ3PoolIface.encodeFunctionData("tickBitmap", [wp]) });
      }
      layout.push({ start, words });
    }
    const res = await chain.multicall(calls, block);
    pools.forEach((p, i) => {
      const s = p.cl!;
      const { start, words } = layout[i]!;
      const r0 = res[start]!;
      const rl = res[start + 1]!;
      const rf = res[start + 2]!;
      if (!r0.success || !rl.success || r0.returnData.length < 130) {
        s.liquidity = 0n; // unusable this round
        return;
      }
      const slot0Iface = p.kind === "slipstream" ? slipstreamPoolIface : univ3PoolIface;
      const slot = slot0Iface.decodeFunctionResult("slot0", r0.returnData);
      s.sqrtPriceX96 = slot[0] as bigint;
      s.tick = Number(slot[1]);
      s.liquidity = abi.decode(["uint128"], rl.returnData)[0] as bigint;
      if (rf.success && rf.returnData.length >= 66) {
        s.feePips = Number(abi.decode(["uint24"], rf.returnData)[0]);
        p.feePpm = s.feePips;
      }
      s.words = new Map();
      words.forEach((wp, k) => {
        const r = res[start + 3 + k]!;
        if (r.success && r.returnData.length >= 66) s.words.set(wp, abi.decode(["uint256"], r.returnData)[0] as bigint);
      });
      // Words for the *current* tick must be present, or swaps on this pool are not modelled this round.
      if (withWords && !wordsNeeded(s.tick, s.tickSpacing).every((w) => s.words.has(w))) s.words = new Map();
      const v = virtualReserves(s);
      p.reserve0 = v.reserve0;
      p.reserve1 = v.reserve1;
      if (block !== "pending") p.updatedBlock = block;
    });
  }

  // ---- Uniswap V4 (singleton PoolManager; poolId-keyed; read via StateView, quoted via V4Quoter) ----

  /** Build a V4 pool. token0/token1 are graph tokens (native ETH mapped to WETH); v4 holds the real key. */
  private newV4Pool(poolId: string, currency0: string, currency1: string, fee: number, tickSpacing: number, hooks: string): Pool {
    const graph = (c: string) => (c === NATIVE ? WETH : c);
    return {
      address: poolId,
      dex: "uniswap-v4",
      kind: "univ4",
      token0: graph(currency0),
      token1: graph(currency1),
      reserve0: 0n,
      reserve1: 0n,
      feePpm: fee,
      feeModel: "ppm",
      stable: false,
      updatedBlock: 0,
      cl: { sqrtPriceX96: 0n, tick: 0, liquidity: 0n, tickSpacing, feePips: fee, words: new Map(), quoter: V4.quoter.toLowerCase() },
      v4: { poolId, currency0, currency1, fee, tickSpacing, hooks },
    };
  }

  /**
   * Discover hookless V4 pools for base x counter pairs: compute each candidate poolId over V4.feeTiers
   * (hooks = 0x0), keep the ones StateView reports as initialised, and populate their state. For a WETH base
   * we also probe the native-ETH (0x0) variant, since the deep ETH pools use native ETH.
   */
  private async lookupV4Pools(bases: string[], tokens: string[], block: number): Promise<Pool[]> {
    const seen = new Set<string>();
    const cands: Array<{ c0: string; c1: string; fee: number; ts: number }> = [];
    const add = (a: string, b: string, fee: number, ts: number): void => {
      const [la, lb] = [a.toLowerCase(), b.toLowerCase()];
      const [c0, c1] = la < lb ? [la, lb] : [lb, la];
      const key = `${c0}-${c1}-${fee}`;
      if (seen.has(key)) return;
      seen.add(key);
      cands.push({ c0, c1, fee, ts });
    };
    for (const b of bases) {
      for (const t of tokens) {
        if (b.toLowerCase() === t.toLowerCase()) continue;
        for (const [fee, ts] of V4.feeTiers) {
          add(b, t, fee, ts);
          if (b.toLowerCase() === WETH) add(NATIVE, t, fee, ts);
        }
      }
    }
    if (!cands.length) return [];
    const calls: Call[] = cands.map((c) => ({ target: V4.stateView, callData: stateViewIface.encodeFunctionData("getSlot0", [v4PoolId(c.c0, c.c1, c.fee, c.ts, NATIVE)]) }));
    const res = await this.chain.multicall(calls, block);
    const found: Pool[] = [];
    cands.forEach((c, i) => {
      const r = res[i]!;
      if (!r.success || r.returnData.length < 66) return;
      const slot = stateViewIface.decodeFunctionResult("getSlot0", r.returnData);
      if ((slot[0] as bigint) === 0n) return; // not initialised
      found.push(this.newV4Pool(v4PoolId(c.c0, c.c1, c.fee, c.ts, NATIVE), c.c0, c.c1, c.fee, c.ts, NATIVE));
    });
    await this.refreshV4Set(found, block); // populate liquidity + words + virtual reserves for the floor check
    return found;
  }

  /** Re-read every watched V4 pool from StateView. Called each block (never throws into the block loop). */
  async refreshV4(block: number | "pending"): Promise<void> {
    const v4 = [...this.pools.values()].filter((p) => p.v4);
    if (v4.length) await this.refreshV4Set(v4, block);
  }

  private async refreshV4Set(pools: Pool[], block: number | "pending"): Promise<void> {
    if (!pools.length) return;
    this.stateEpoch++;
    const fresh = pools.filter((p) => p.cl!.sqrtPriceX96 === 0n);
    if (fresh.length) await this.readV4(fresh, block, false); // learn the tick before choosing bitmap words
    await this.readV4(pools, block, true);
  }

  /** One multicall of StateView.getSlot0 / getLiquidity / getTickBitmap per V4 pool (mirrors readCl). */
  private async readV4(pools: Pool[], block: number | "pending", withWords: boolean): Promise<void> {
    const calls: Call[] = [];
    const layout: Array<{ start: number; words: number[] }> = [];
    for (const p of pools) {
      const s = p.cl!;
      const id = p.v4!.poolId;
      const start = calls.length;
      calls.push({ target: V4.stateView, callData: stateViewIface.encodeFunctionData("getSlot0", [id]) });
      calls.push({ target: V4.stateView, callData: stateViewIface.encodeFunctionData("getLiquidity", [id]) });
      let words: number[] = [];
      if (withWords) {
        const w = wordPosition(compressTick(s.tick, s.tickSpacing));
        words = [w - 1, w, w + 1];
        for (const wp of words) calls.push({ target: V4.stateView, callData: stateViewIface.encodeFunctionData("getTickBitmap", [id, wp]) });
      }
      layout.push({ start, words });
    }
    const res = await this.chain.multicall(calls, block);
    pools.forEach((p, i) => {
      const s = p.cl!;
      const { start, words } = layout[i]!;
      const rs = res[start]!;
      const rl = res[start + 1]!;
      if (!rs.success || rs.returnData.length < 130) {
        s.liquidity = 0n; // unusable this round
        return;
      }
      const slot = stateViewIface.decodeFunctionResult("getSlot0", rs.returnData);
      s.sqrtPriceX96 = slot[0] as bigint;
      s.tick = Number(slot[1]);
      const lpFee = Number(slot[3]);
      if (lpFee > 0) ((s.feePips = lpFee), (p.feePpm = lpFee));
      s.liquidity = rl.success && rl.returnData.length >= 66 ? (stateViewIface.decodeFunctionResult("getLiquidity", rl.returnData)[0] as bigint) : 0n;
      s.words = new Map();
      words.forEach((wp, k) => {
        const r = res[start + 2 + k]!;
        if (r && r.success && r.returnData.length >= 66) s.words.set(wp, abi.decode(["uint256"], r.returnData)[0] as bigint);
      });
      if (withWords && !wordsNeeded(s.tick, s.tickSpacing).every((w) => s.words.has(w))) s.words = new Map();
      const v = virtualReserves(s);
      p.reserve0 = v.reserve0;
      p.reserve1 = v.reserve1;
      if (block !== "pending") p.updatedBlock = block;
    });
  }

  /**
   * Re-read every watched pool at `block`: V2/V3-style pools from their contracts, V4 pools from
   * StateView, and the real token balances of CL pools (their depth; changes slowly, so only here).
   */
  async refreshAll(block: number): Promise<void> {
    const all = [...this.pools.values()];
    await Promise.all([
      this.refreshReserves(all, block),
      this.refreshV4Set(
        all.filter((p) => p.v4),
        block,
      ),
      this.loadClBalances(all, block).catch((e: Error) => log.debug("pool balances:", e.message.slice(0, 100))),
    ]);
    this.pendingDirty.clear();
    this.syncedBlock = block;
    this.stateEpoch++;
  }

  /**
   * Event-driven refresh (low-RPC mode): bring every watched pool from
   * `syncedBlock` to `block` from that range's logs instead of re-reading all
   * of them, then re-read only what the logs cannot tell us, in one multicall.
   *
   *   V2 / Aerodrome  Sync carries the new reserves: exact, no call needed.
   *   CL pools        Swap carries sqrtPriceX96, liquidity and tick after the
   *                   swap: exact. Mint/Burn change liquidity and the tick
   *                   bitmap, so those pools are re-read. Slipstream's fee is
   *                   dynamic, so a swapped Slipstream pool re-reads fee(). A
   *                   tick that moved into a bitmap word we have not read
   *                   fetches just that word.
   *   Pending reads   pools the Flashblocks loop read at the pre-confirmed
   *                   state are re-read at the confirmed block.
   *
   * `logs` must cover (syncedBlock, block] and be in chain order (the order
   * eth_getLogs returns them in). A periodic full refresh (FULL_REFRESH_BLOCKS)
   * corrects anything this misses.
   */
  async applyLogs(logs: Log[], block: number): Promise<{ fromLogs: number; reread: number; changed: Set<string> }> {
    this.stateEpoch++;
    const fullRead = new Set<Pool>();
    const v2Read = new Set<Pool>();
    const feeRead = new Set<Pool>();
    const v4Read = new Set<Pool>();
    const touched = new Set<Pool>();
    let fromLogs = 0;
    for (const l of logs) {
      const key = poolKeyOfLog(l);
      const p = key ? this.pools.get(key) : undefined;
      if (!p) continue;
      const r = applyStateLog(p, l);
      if (r === "set" || r === "fee") {
        touched.add(p);
        if (r === "fee") feeRead.add(p);
        fromLogs++;
      } else if (r === "reread") {
        (p.v4 ? v4Read : fullRead).add(p);
      }
    }
    for (const a of this.pendingDirty) {
      const p = this.pools.get(a);
      if (p) (p.v4 ? v4Read : p.cl ? fullRead : v2Read).add(p);
    }
    this.pendingDirty.clear();
    // CL pools never read, or whose tick moved into bitmap words we don't have. V4 pools have no
    // pool contract: their words come from StateView, so they get a StateView read instead.
    const wordRead = new Map<Pool, number[]>();
    for (const p of this.pools.values()) {
      if (!p.cl || fullRead.has(p) || v4Read.has(p)) continue;
      const need = p.cl.sqrtPriceX96 === 0n ? null : wordsNeeded(p.cl.tick, p.cl.tickSpacing).filter((w) => !p.cl!.words.has(w));
      if (p.v4) {
        if (need === null || need.length) v4Read.add(p);
        continue;
      }
      if (need === null) fullRead.add(p);
      else if (need.length) wordRead.set(p, need);
    }

    // One multicall for everything the logs could not settle.
    const calls: Call[] = [];
    const apply: Array<(res: CallResult[]) => void> = [];
    for (const p of v2Read) {
      const at = calls.length;
      calls.push({ target: p.address, callData: (p.kind === "aerodrome" ? aeroPoolIface : univ2PairIface).encodeFunctionData("getReserves") });
      apply.push((res) => {
        const r = res[at]!;
        if (!r.success || r.returnData.length < 2 + 64 * 3) return;
        const [r0, r1] = abi.decode(["uint256", "uint256", "uint256"], r.returnData) as unknown as [bigint, bigint, bigint];
        p.reserve0 = r0;
        p.reserve1 = r1;
        p.updatedBlock = block;
      });
    }
    for (const p of feeRead) {
      if (fullRead.has(p)) continue;
      const at = calls.length;
      calls.push({ target: p.address, callData: univ3PoolIface.encodeFunctionData("fee") });
      apply.push((res) => {
        const r = res[at]!;
        if (!r.success || r.returnData.length < 66) return;
        p.cl!.feePips = Number(abi.decode(["uint24"], r.returnData)[0]);
        p.feePpm = p.cl!.feePips;
      });
    }
    for (const [p, words] of wordRead) {
      const at = calls.length;
      for (const w of words) calls.push({ target: p.address, callData: univ3PoolIface.encodeFunctionData("tickBitmap", [w]) });
      apply.push((res) => {
        words.forEach((w, k) => {
          const r = res[at + k]!;
          if (r.success && r.returnData.length >= 66) p.cl!.words.set(w, abi.decode(["uint256"], r.returnData)[0] as bigint);
        });
      });
    }
    const reread = v2Read.size + feeRead.size + wordRead.size + fullRead.size + v4Read.size;
    await Promise.all([
      calls.length ? this.chain.multicall(calls, block).then((res) => apply.forEach((f) => f(res))) : undefined,
      fullRead.size ? this.refreshCl([...fullRead], block, this.chain) : undefined,
      v4Read.size ? this.refreshV4Set([...v4Read], block) : undefined,
    ]);
    this.syncedBlock = block;
    const changed = new Set<string>();
    for (const set of [touched, v2Read, feeRead, fullRead, v4Read]) for (const p of set) changed.add(p.address);
    for (const p of wordRead.keys()) changed.add(p.address);
    this.stateEpoch++;
    return { fromLogs, reread, changed };
  }

  /** Price-relevant state of every watched pool, for the drift check (fee and bitmap words excluded). */
  stateSnapshot(): Map<string, string> {
    const m = new Map<string, string>();
    for (const p of this.pools.values()) {
      m.set(p.address, p.cl ? `${p.cl.sqrtPriceX96}:${p.cl.liquidity}:${p.cl.tick}` : `${p.reserve0}:${p.reserve1}`);
    }
    return m;
  }

  /**
   * Pools whose state now differs from a snapshot. Used at each periodic full
   * refresh in events mode: take the snapshot after applying the block's logs,
   * re-read everything at the same block, and any difference is state the
   * event-driven path got wrong.
   */
  driftAgainst(snapshot: Map<string, string>): string[] {
    const now = this.stateSnapshot();
    const out: string[] = [];
    for (const [a, v] of snapshot) {
      const w = now.get(a);
      if (w !== undefined && w !== v) out.push(a);
    }
    return out;
  }

  /** Pools sharing a token pair with any of the given pools (the other side of a spread). */
  siblings(addresses: Iterable<string>): Set<string> {
    const want = new Set<string>();
    for (const a of addresses) {
      const p = this.pools.get(a);
      if (p) want.add(pairKey(p.token0, p.token1));
    }
    const out = new Set<string>();
    for (const p of this.pools.values()) if (want.has(pairKey(p.token0, p.token1))) out.add(p.address);
    return out;
  }

  // ------------------------------------------------------------------------
  // Pricing helpers
  // ------------------------------------------------------------------------

  /**
   * Real amount of `token` a pool holds, as far as we know it: the token balance for V2-style pools
   * (their reserves) and for CL pools whose balances were read, otherwise the amount in the active
   * tick range. Never the virtual reserve, which overstates a narrow concentrated position by orders
   * of magnitude (a tight WETH/wstETH range showed as 113,967 WETH).
   */
  realAmount(p: Pool, token: string): bigint {
    const zero = p.token0 === token;
    if (!zero && p.token1 !== token) return 0n;
    if (!p.cl) return zero ? p.reserve0 : p.reserve1;
    const bal = zero ? p.bal0 : p.bal1;
    if (bal !== undefined) return bal;
    const a = activeRangeAmounts(p.cl);
    return a ? (zero ? a.amount0 : a.amount1) : 0n;
  }

  /** ETH/USD from the deepest WETH/USDC pool in the list (falls back to 3000 with a warning). */
  ethPriceFrom(pools: Pool[]): number {
    const usdc = TOKENS.USDC!.address.toLowerCase();
    let best: Pool | undefined;
    let bestDepth = 0n;
    for (const p of pools) {
      const isPair = (p.token0 === WETH && p.token1 === usdc) || (p.token1 === WETH && p.token0 === usdc);
      if (!isPair || p.reserve0 === 0n || p.reserve1 === 0n) continue;
      const depth = this.realAmount(p, WETH);
      if (!best || depth > bestDepth) {
        best = p;
        bestDepth = depth;
      }
    }
    if (!best || this.wethReserve(best) === 0n) {
      log.warn("no WETH/USDC pool found for pricing; assuming $3000/ETH");
      return 3000;
    }
    // The reserve ratio (virtual reserves for CL pools) is the pool's exact spot price.
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

  /** Pool depth measured in WETH-equivalent of its base-token side (0 if it has no base token), from real amounts. */
  liquidityInWeth(p: Pool, ethUsd: number): number {
    for (const tok of [p.token0, p.token1]) {
      if (tok === WETH) return Number(this.realAmount(p, tok)) / 1e18;
      const meta = Object.values(TOKENS).find((t) => t.address.toLowerCase() === tok);
      if (meta?.approxUsd) return ((Number(this.realAmount(p, tok)) / 10 ** meta.decimals) * meta.approxUsd) / ethUsd;
      if (meta?.symbol === "cbETH") return Number(this.realAmount(p, tok)) / 1e18; // close enough to ETH for a depth filter
    }
    return 0;
  }

  /**
   * USD value of `amount` of `token`. Base tokens are priced directly; anything else through the
   * deepest pool pairing it with WETH or a stablecoin, by real depth, and only if that pool is at
   * least PRICE_MIN_DEPTH_WETH deep. A thin pool's price is exactly what produced profit "outliers"
   * worth thousands of dollars, so a token with no deep pool has no price (null), not a wrong one.
   */
  usdValue(token: string, amount: bigint, ethUsd: number): number | null {
    const t = token.toLowerCase();
    const decimals = this.token(t)?.decimals ?? 18;
    const per = this.usdPerUnit(t, ethUsd);
    return per === null ? null : (Number(amount) / 10 ** decimals) * per;
  }

  /** USD price of one whole unit of `token`, or null when no deep enough pool prices it. Cached per state change. */
  usdPerUnit(token: string, ethUsd: number): number | null {
    const t = token.toLowerCase();
    if (t === WETH) return ethUsd;
    const known = Object.values(TOKENS).find((x) => x.address.toLowerCase() === t);
    if (known?.approxUsd) return known.approxUsd;
    if (known?.symbol === "cbETH") return ethUsd;
    const hit = this.priceCache.get(t);
    if (hit && hit.epoch === this.stateEpoch && hit.ethUsd === ethUsd) return hit.usdPerUnit;
    const decimals = this.token(t)?.decimals ?? 18;
    let best: { depth: number; price: number } | undefined;
    for (const p of this.pools.values()) {
      if (p.token0 !== t && p.token1 !== t) continue;
      const other = p.token0 === t ? p.token1 : p.token0;
      const otherUsd = other === WETH ? ethUsd : Object.values(TOKENS).find((x) => x.address.toLowerCase() === other)?.approxUsd;
      if (!otherUsd) continue;
      const depth = this.liquidityInWeth(p, ethUsd);
      if (!(depth >= this.priceMinDepthWeth) || (best && depth <= best.depth)) continue;
      const tokRes = Number(p.token0 === t ? p.reserve0 : p.reserve1) / 10 ** decimals;
      const otherDec = other === WETH ? 18 : (this.token(other)?.decimals ?? 18);
      const otherRes = Number(p.token0 === t ? p.reserve1 : p.reserve0) / 10 ** otherDec;
      if (!(tokRes > 0) || !(otherRes > 0)) continue;
      best = { depth, price: (otherRes / tokRes) * otherUsd };
    }
    const usdPerUnit = best && Number.isFinite(best.price) ? best.price : null;
    this.priceCache.set(t, { epoch: this.stateEpoch, ethUsd, usdPerUnit });
    return usdPerUnit;
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
  async calibrateFees(allPools: Pool[], block: number): Promise<void> {
    // CL pools report their exact fee (read every refresh); only V2-style pools need calibration.
    const pools = allPools.filter((p) => !p.cl);
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
    const found = (await this.describeUnknownPools(wanted, block)).filter((p) => this.allowed(p));
    if (found.length === 0) return [];
    await this.refreshReserves(found, block);
    await this.loadTokenMetaForPools(found);
    await this.calibrateFees(found, block);
    const ok = found.filter((p) => p.feePpm >= 0 && (!p.cl || p.cl.liquidity > 0n));
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
      // V4 pools are saved too (keyed by poolId, with their PoolKey in `v4`). They used to be left out
      // on the assumption a lookup re-added them on each start, but nothing did: every restart that
      // loaded this file dropped Uniswap V4 coverage until the next "discover".
      pools: [...this.pools.values()]
        .map(({ reserve0: _r0, reserve1: _r1, updatedBlock: _b, cl, bal0: _x, bal1: _y, ...rest }) =>
          cl ? { ...rest, cl: { tickSpacing: cl.tickSpacing, feePips: cl.feePips, quoter: cl.quoter } } : rest,
        ),
    };
  }

  loadSnapshot(s: PoolSnapshot): void {
    this.pools.clear();
    this.tokens.clear();
    for (const t of s.tokens) this.tokens.set(t.address, t);
    for (const sp of s.pools) {
      const { cl, ...rest } = sp;
      const p: Pool = { ...rest, reserve0: 0n, reserve1: 0n, updatedBlock: 0 };
      if (cl) {
        if (!this.clPools) continue;
        p.cl = { sqrtPriceX96: 0n, tick: 0, liquidity: 0n, tickSpacing: cl.tickSpacing, feePips: cl.feePips, words: new Map(), quoter: cl.quoter };
      }
      if (!this.allowed(p)) continue;
      this.pools.set(p.address, p);
    }
  }
}

export function checksum(a: string): string {
  try {
    return getAddress(a);
  } catch {
    return a;
  }
}
