/**
 * Finding, verifying and reading the deepest pool per (chain, asset).
 *
 * Nothing is trusted from config alone: every candidate pool comes from a factory's own getPool,
 * and is kept only if it has code, its token0/token1 are the two tokens we asked for, and both
 * tokens report the decimals we expect. Among the survivors the one with the most in-range
 * liquidity wins (Uniswap V3 / Slipstream L are in the same units, so this compares depth at the
 * current price).
 */
import { RpcError, encAddress, encInt24, encUint, isZeroAddress, sameAddress, word, wordAddress } from "./rpc.ts";
import type { RpcCall, RpcTransport } from "./rpc.ts";
import { selector } from "./keccak.ts";

export const SEL = {
  token0: selector("token0()"),
  token1: selector("token1()"),
  fee: selector("fee()"),
  slot0: selector("slot0()"),
  liquidity: selector("liquidity()"),
  decimals: selector("decimals()"),
  getPoolFee: selector("getPool(address,address,uint24)"),
  getPoolTick: selector("getPool(address,address,int24)"),
};

export interface TokenCfg {
  address: string;
  decimals: number;
}
export interface FactoryCfg {
  venue: string;
  kind: "v3-fee" | "v3-tickspacing";
  address: string;
  tiers: number[];
}
export interface ChainCfg {
  name: string;
  chainId: number;
  rpcEnv: string;
  tokens: Record<string, TokenCfg>;
  factories: FactoryCfg[];
  expected?: Record<string, string>;
}
export interface AssetCfg {
  id: string;
  base: string;
  quote: string;
  bridge: string;
}

export interface Pool {
  chain: string;
  asset: string;
  venue: string;
  address: string;
  /** factory tier: fee in hundredths of a bip (v3-fee) or tick spacing (v3-tickspacing) */
  tier: number;
  /** swap fee in bps, read from the pool's own fee() */
  feeBps: number;
  baseIsToken0: boolean;
  dec0: number;
  dec1: number;
  liquidity: string;
  /** true when it matches config.expected, false when it differs, null when nothing was expected */
  matchesExpected: boolean | null;
}

const call = (to: string, data: string): RpcCall => ({ method: "eth_call", params: [{ to, data }, "latest"] });
const ok = (v: unknown): boolean => !(v instanceof Error) && v !== null && v !== undefined;

/** Check the endpoint really is the chain we think it is. */
export async function checkChainId(rpc: RpcTransport, expected: number): Promise<void> {
  const [r] = await rpc([{ method: "eth_chainId", params: [] }]);
  if (!ok(r)) throw new RpcError("eth_chainId failed");
  const got = Number(BigInt(String(r)));
  if (got !== expected) throw new RpcError(`endpoint is chain ${got}, expected ${expected}`);
}

/**
 * Resolve the deepest verified pool for each asset on one chain. Returns the pools found and a
 * list of short notes (why a candidate or an asset was dropped) for the log.
 */
export async function resolvePools(
  rpc: RpcTransport,
  chainId: string,
  chain: ChainCfg,
  assets: AssetCfg[],
): Promise<{ pools: Pool[]; notes: string[] }> {
  const notes: string[] = [];
  const pools: Pool[] = [];

  // 1. token decimals, once per chain
  const symbols = [...new Set(assets.flatMap((a) => [a.base, a.quote]))].filter((s) => chain.tokens[s]);
  const decRes = await rpc(symbols.map((s) => call(chain.tokens[s]!.address, SEL.decimals)));
  const badToken = new Set<string>();
  symbols.forEach((s, i) => {
    try {
      const d = Number(word(decRes[i]));
      if (d !== chain.tokens[s]!.decimals) {
        badToken.add(s);
        notes.push(`${chainId}: ${s} decimals ${d}, expected ${chain.tokens[s]!.decimals}`);
      }
    } catch {
      badToken.add(s);
      notes.push(`${chainId}: ${s} decimals() failed`);
    }
  });

  for (const asset of assets) {
    const tb = chain.tokens[asset.base];
    const tq = chain.tokens[asset.quote];
    if (!tb || !tq || badToken.has(asset.base) || badToken.has(asset.quote)) {
      notes.push(`${chainId}: ${asset.id} skipped (token missing or unverified)`);
      continue;
    }
    // 2. ask every factory for every tier
    const cands: { f: FactoryCfg; tier: number }[] = [];
    for (const f of chain.factories) for (const t of f.tiers) cands.push({ f, tier: t });
    const getRes = await rpc(
      cands.map(({ f, tier }) =>
        call(
          f.address,
          (f.kind === "v3-fee" ? SEL.getPoolFee : SEL.getPoolTick) +
            encAddress(tb.address) +
            encAddress(tq.address) +
            (f.kind === "v3-fee" ? encUint(tier) : encInt24(tier)),
        ),
      ),
    );
    const found: { f: FactoryCfg; tier: number; addr: string }[] = [];
    cands.forEach((c, i) => {
      try {
        const addr = wordAddress(getRes[i]);
        if (!isZeroAddress(addr)) found.push({ ...c, addr });
      } catch {
        /* factory missing on this chain or call reverted: skip */
      }
    });
    if (found.length === 0) {
      notes.push(`${chainId}: ${asset.id} no pool from any factory`);
      continue;
    }
    // 3. verify each candidate: code, token0, token1, fee, liquidity
    const verify: RpcCall[] = [];
    for (const c of found) {
      verify.push({ method: "eth_getCode", params: [c.addr, "latest"] });
      verify.push(call(c.addr, SEL.token0), call(c.addr, SEL.token1), call(c.addr, SEL.fee), call(c.addr, SEL.liquidity));
    }
    const vr = await rpc(verify);
    const [lo, hi] = BigInt(tb.address) < BigInt(tq.address) ? [tb, tq] : [tq, tb];
    let best: Pool | null = null;
    let bestL = -1n;
    found.forEach((c, i) => {
      const [code, t0, t1, fee, liq] = vr.slice(i * 5, i * 5 + 5);
      try {
        if (typeof code !== "string" || code.length <= 2) throw new Error("no code");
        if (!sameAddress(wordAddress(t0), lo.address) || !sameAddress(wordAddress(t1), hi.address)) throw new Error("token mismatch");
        const L = word(liq);
        const feePips = Number(word(fee));
        if (L > bestL) {
          bestL = L;
          const exp = chain.expected?.[asset.id];
          best = {
            chain: chainId,
            asset: asset.id,
            venue: c.f.venue,
            address: c.addr,
            tier: c.tier,
            feeBps: feePips / 100,
            baseIsToken0: sameAddress(lo.address, tb.address),
            dec0: lo.decimals,
            dec1: hi.decimals,
            liquidity: L.toString(),
            matchesExpected: exp ? sameAddress(exp, c.addr) : null,
          };
        }
      } catch (e) {
        notes.push(`${chainId}: ${asset.id} ${c.f.venue}/${c.tier} rejected (${e instanceof Error ? e.message : "bad"})`);
      }
    });
    if (best && bestL > 0n) pools.push(best);
    else notes.push(`${chainId}: ${asset.id} no verified pool with liquidity`);
  }
  return { pools, notes };
}

/** Price of the asset's base token in its quote token, from a V3-style sqrtPriceX96. */
export function priceFromSqrtX96(sqrtPriceX96: bigint, p: Pick<Pool, "baseIsToken0" | "dec0" | "dec1">): number {
  if (sqrtPriceX96 <= 0n) return NaN;
  const s = Number(sqrtPriceX96) / 2 ** 96;
  const oneIn0 = s * s * 10 ** (p.dec0 - p.dec1); // token1 per token0, human units
  return p.baseIsToken0 ? oneIn0 : 1 / oneIn0;
}

/** Read every pool's current price on one chain in a single batch. NaN where a read failed. */
export async function readPrices(rpc: RpcTransport, pools: Pool[]): Promise<number[]> {
  if (pools.length === 0) return [];
  const res = await rpc(pools.map((p) => call(p.address, SEL.slot0)));
  return pools.map((p, i) => {
    try {
      return priceFromSqrtX96(word(res[i]), p);
    } catch {
      return NaN;
    }
  });
}
