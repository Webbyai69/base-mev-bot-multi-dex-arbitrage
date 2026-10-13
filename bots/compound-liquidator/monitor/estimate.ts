/**
 * Pure maths for the Compound III monitor: discount, value, gas, profit, and the
 * metrics file the fleet wrapper reads. No I/O here, so it is all unit-tested.
 *
 * Comet prices come from getPrice(feed) with 8 decimals, in the market's feed unit
 * (USD for stablecoin markets). `feedUsd` converts one feed unit to USD.
 */

export const PRICE_SCALE = 1e8;

export interface AssetView {
  asset: string;
  symbol: string;
  scale: bigint; // 10^decimals, from getAssetInfo
  price: bigint; // getPrice(priceFeed), 8 decimals, feed units
  quote: bigint; // quoteCollateral(asset, quoteBase)
  reserves: bigint; // getCollateralReserves(asset): collateral the protocol holds and may sell
}

export interface MarketView {
  id: string;
  chain: string;
  comet: string;
  baseSymbol: string;
  baseScale: bigint;
  basePrice: bigint; // feed units, 8 decimals
  quoteBase: bigint; // base amount (in base units * baseScale) used for the quotes
  feedUsd: number; // USD per feed unit
  forSale: boolean; // getReserves() < targetReserves(): buyCollateral is open
  assets: AssetView[];
}

/**
 * Discount the protocol gives on `a` versus its feed price, from quoteCollateral.
 * fair = quoteBase * basePrice * assetScale / (assetPrice * baseScale); discount = 1 - fair / quote.
 * Clamped to [0, 0.5]; 0 when a price or quote is missing.
 */
export function discountOf(m: Pick<MarketView, "baseScale" | "basePrice" | "quoteBase">, a: Pick<AssetView, "scale" | "price" | "quote">): number {
  if (a.price <= 0n || a.quote <= 0n || m.basePrice <= 0n || m.baseScale <= 0n) return 0;
  const fair = (m.quoteBase * m.basePrice * a.scale) / (a.price * m.baseScale);
  const d = 1 - Number((fair * 1_000_000n) / a.quote) / 1_000_000;
  return Math.min(0.5, Math.max(0, d));
}

export function usdValue(amount: bigint, scale: bigint, price: bigint, feedUsd: number): number {
  if (scale <= 0n) return 0;
  // keep precision: amount/scale can be tiny or huge
  const units = Number((amount * 1_000_000n) / scale) / 1_000_000;
  return units * (Number(price) / PRICE_SCALE) * feedUsd;
}

export interface GasModel {
  absorbPerAccount: number;
  absorbPerAsset: number;
  flashBuySwap: number;
}

/** USD gas for absorbing `accounts` holding `assetsHeld` collateral kinds in total, plus `buys` flash buys. */
export function gasUsd(g: GasModel, accounts: number, assetsHeld: number, buys: number, gasPriceWei: bigint, ethUsd: number, l1FeeUsd: number): number {
  const units = accounts * g.absorbPerAccount + assetsHeld * g.absorbPerAsset + buys * g.flashBuySwap;
  return (units * Number(gasPriceWei)) / 1e18 * ethUsd + (buys > 0 || accounts > 0 ? l1FeeUsd : 0);
}

export interface Holding {
  asset: string;
  amount: bigint;
}

export interface Estimate {
  pair: string; // collateral/base, e.g. WETH/USDC
  collateralUsd: number;
  discount: number;
  grossUsd: number; // discount captured minus the swap back to base
}

/**
 * What buying `amount` of collateral at the protocol's discount and swapping it back is worth.
 * swapCostBps covers pool fee and price impact of the swap back to the base token.
 */
export function estimateBuy(m: MarketView, h: Holding, swapCostBps: number): Estimate | null {
  const a = m.assets.find((x) => x.asset.toLowerCase() === h.asset.toLowerCase());
  if (!a || h.amount <= 0n) return null;
  const collateralUsd = usdValue(h.amount, a.scale, a.price, m.feedUsd);
  const discount = discountOf(m, a);
  const grossUsd = m.forSale ? collateralUsd * discount - collateralUsd * (swapCostBps / 10_000) : 0;
  return { pair: `${a.symbol}/${m.baseSymbol}`, collateralUsd, discount, grossUsd };
}

export interface AccountFind {
  chain: string;
  market: string;
  account: string;
  forSale: boolean;
  collateralUsd: number;
  grossUsd: number;
  gasUsd: number;
  netUsd: number;
  pairs: Estimate[];
}

export function estimateAccount(
  m: MarketView,
  account: string,
  holdings: Holding[],
  gas: GasModel,
  gasPriceWei: bigint,
  ethUsd: number,
  l1FeeUsd: number,
  swapCostBps: number,
): AccountFind {
  const pairs = holdings.map((h) => estimateBuy(m, h, swapCostBps)).filter((e): e is Estimate => e !== null);
  const held = pairs.length;
  const buys = m.forSale ? pairs.filter((p) => p.grossUsd > 0).length : 0;
  const g = gasUsd(gas, 1, held, buys, gasPriceWei, ethUsd, l1FeeUsd);
  const grossUsd = pairs.reduce((s, p) => s + Math.max(0, p.grossUsd), 0);
  return {
    chain: m.chain,
    market: m.id,
    account,
    forSale: m.forSale,
    collateralUsd: pairs.reduce((s, p) => s + p.collateralUsd, 0),
    grossUsd,
    gasUsd: g,
    netUsd: grossUsd - g,
    pairs,
  };
}

/** Collateral the protocol already holds and sells (no absorb needed): one find per asset. */
export function estimateReserves(m: MarketView, gas: GasModel, gasPriceWei: bigint, ethUsd: number, l1FeeUsd: number, swapCostBps: number, minUsd = 1): Estimate[] {
  if (!m.forSale) return [];
  const out: Estimate[] = [];
  for (const a of m.assets) {
    const e = estimateBuy(m, { asset: a.asset, amount: a.reserves }, swapCostBps);
    if (!e || e.collateralUsd < minUsd) continue;
    e.grossUsd -= gasUsd(gas, 0, 0, 1, gasPriceWei, ethUsd, l1FeeUsd);
    out.push(e);
  }
  return out;
}

export interface Route {
  pair: string;
  venues: string[];
  count: number;
  usd: number;
}

export interface FleetMetrics {
  pnlUsd: number;
  sends: number;
  gasUsd: number;
  detail: string;
  routes: Route[];
  metrics: Record<string, number>;
  updatedAt: string;
}

export interface ChainSummary {
  chain: string;
  markets: number;
  borrowers: number;
  lastBlock: number;
  error?: string;
}

const r2 = (x: number): number => Math.round(x * 100) / 100;

/** The metrics file (bots/CONTRACT.md): detect mode never sends, so pnl, sends and gas stay 0. */
export function buildMetrics(chains: ChainSummary[], finds: AccountFind[], reserves: { chain: string; market: string; e: Estimate }[], detectMs: number, now = new Date()): FleetMetrics {
  const routes = new Map<string, Route>();
  const add = (pair: string, venue: string, usd: number): void => {
    const key = `${pair}|${venue}`;
    const r = routes.get(key) ?? { pair, venues: ["compound-v3", venue], count: 0, usd: 0 };
    r.count += 1;
    r.usd = r2(r.usd + Math.max(0, usd));
    routes.set(key, r);
  };
  for (const f of finds) {
    // split the account's net across its pairs by gross share, so route totals add up to the find
    const gross = f.pairs.reduce((s, p) => s + Math.max(0, p.grossUsd), 0);
    for (const p of f.pairs) add(p.pair, f.market, gross > 0 ? (f.netUsd * Math.max(0, p.grossUsd)) / gross : 0);
  }
  for (const r of reserves) add(r.e.pair, `${r.market}:reserves`, r.e.grossUsd);

  const borrowers = chains.reduce((s, c) => s + c.borrowers, 0);
  const markets = chains.reduce((s, c) => s + c.markets, 0);
  const best = Math.max(0, ...finds.map((f) => f.netUsd), ...reserves.map((r) => r.e.grossUsd));
  const forSaleUsd = reserves.reduce((s, r) => s + Math.max(0, r.e.grossUsd), 0);
  const errors = chains.filter((c) => c.error).map((c) => `${c.chain}: ${c.error}`);
  const parts = chains.filter((c) => !c.error).map((c) => `${c.chain} ${c.borrowers} borrowers/${c.markets} markets @${c.lastBlock}`);
  let detail = `detect: ${parts.join("; ") || "no chain up"}; ${finds.length} absorbable, best $${r2(best)}`;
  if (errors.length) detail += ` | ${errors.join("; ")}`;
  return {
    pnlUsd: 0,
    sends: 0,
    gasUsd: 0,
    detail: detail.slice(0, 300),
    routes: [...routes.values()].sort((a, b) => b.usd - a.usd || b.count - a.count).slice(0, 12),
    metrics: {
      borrowersWatched: borrowers,
      absorbable: finds.length,
      bestUsd: r2(best),
      forSaleUsd: r2(forSaleUsd),
      markets,
      detectMs: Math.round(detectMs),
    },
    updatedAt: now.toISOString(),
  };
}
