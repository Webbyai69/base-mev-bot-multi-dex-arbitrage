/**
 * Compound III (Comet) markets the monitor watches.
 *
 * Source of every Comet proxy address: compound-finance/comet @ f766f51 (the pinned
 * submodule bots/upstream/comet), file deployments/<network>/<market>/roots.json, key
 * "comet". The monitor checks each one with eth_getCode and baseToken() at start-up and
 * drops any market that has no code, so a wrong address is reported, never used.
 *
 * denom: what the market's price feeds are quoted in. "usd" for stablecoin-based markets.
 * "auto": derive the USD value of one feed unit from a USD market on the same chain that
 * lists this market's base token as collateral (works whether the feed is in USD or ETH).
 */

export interface MarketDef {
  id: string; // short, stable: <chain>-<market>
  comet: string;
  denom: "usd" | "auto";
  /** base units used to ask quoteCollateral for the discount (it is linear) */
  quoteBaseUnits: number;
}

export interface ChainDef {
  name: "base" | "ethereum" | "arbitrum";
  chainId: number;
  rpcEnv: string; // the env var holding this chain's RPC URL (set by Joshua in bots/wrapper/.env)
  /** backfill window for borrower discovery on the first run, in blocks */
  backfillBlocks: number;
  /** max block range per eth_getLogs call (halved automatically on provider errors) */
  logChunk: number;
  /** run the isLiquidatable sweep every this many blocks */
  checkEveryBlocks: number;
  /** gas units we assume for absorb (per account + per collateral asset) and for the flash buy + swap */
  gas: { absorbPerAccount: number; absorbPerAsset: number; flashBuySwap: number };
  /** rough L1 data fee per liquidation transaction on rollups, USD */
  l1FeeUsd: number;
  markets: MarketDef[];
}

export const CHAINS: ChainDef[] = [
  {
    name: "base",
    chainId: 8453,
    rpcEnv: "BASE_RPC_URL",
    backfillBlocks: 1_300_000, // about 30 days at 2 s
    logChunk: 9_000,
    checkEveryBlocks: 2,
    gas: { absorbPerAccount: 120_000, absorbPerAsset: 45_000, flashBuySwap: 330_000 },
    l1FeeUsd: 0.01,
    markets: [
      { id: "base-usdc", comet: "0xb125E6687d4313864e53df431d5425969c15Eb2F", denom: "usd", quoteBaseUnits: 1000 },
      { id: "base-weth", comet: "0x46e6b214b524310239732D51387075E0e70970bf", denom: "auto", quoteBaseUnits: 1 },
      { id: "base-usdbc", comet: "0x9c4ec768c28520B50860ea7a15bd7213a9fF58bf", denom: "usd", quoteBaseUnits: 1000 },
      { id: "base-aero", comet: "0x784efeB622244d2348d4F2522f8860B96fbEcE89", denom: "auto", quoteBaseUnits: 1000 },
      { id: "base-usds", comet: "0x2c776041CCFe903071AF44aa147368a9c8EEA518", denom: "usd", quoteBaseUnits: 1000 },
    ],
  },
  {
    name: "ethereum",
    chainId: 1,
    rpcEnv: "ETHEREUM_RPC_URL",
    backfillBlocks: 216_000, // about 30 days at 12 s
    logChunk: 5_000,
    checkEveryBlocks: 1,
    gas: { absorbPerAccount: 120_000, absorbPerAsset: 45_000, flashBuySwap: 330_000 },
    l1FeeUsd: 0,
    markets: [
      { id: "eth-usdc", comet: "0xc3d688B66703497DAA19211EEdff47f25384cdc3", denom: "usd", quoteBaseUnits: 1000 },
      { id: "eth-weth", comet: "0xA17581A9E3356d9A858b789D68B4d866e593aE94", denom: "auto", quoteBaseUnits: 1 },
      { id: "eth-usdt", comet: "0x3Afdc9BCA9213A35503b077a6072F3D0d5AB0840", denom: "usd", quoteBaseUnits: 1000 },
      { id: "eth-wsteth", comet: "0x3D0bb1ccaB520A66e607822fC55BC921738fAFE3", denom: "auto", quoteBaseUnits: 1 },
      { id: "eth-usds", comet: "0x5D409e56D886231aDAf00c8775665AD0f9897b56", denom: "usd", quoteBaseUnits: 1000 },
      { id: "eth-wbtc", comet: "0xe85Dc543813B8c2CFEaAc371517b925a166a9293", denom: "auto", quoteBaseUnits: 1 },
    ],
  },
  {
    name: "arbitrum",
    chainId: 42161,
    rpcEnv: "ARBITRUM_RPC_URL",
    backfillBlocks: 3_000_000, // about 9 days at 0.25 s; raise COMPOUND_BACKFILL_BLOCKS_ARBITRUM for more
    logChunk: 50_000,
    checkEveryBlocks: 20,
    gas: { absorbPerAccount: 120_000, absorbPerAsset: 45_000, flashBuySwap: 330_000 },
    l1FeeUsd: 0.02,
    markets: [
      { id: "arb-usdc", comet: "0x9c4ec768c28520B50860ea7a15bd7213a9fF58bf", denom: "usd", quoteBaseUnits: 1000 },
      { id: "arb-usdc.e", comet: "0xA5EDBDD9646f8dFF606d7448e414884C7d905dCA", denom: "usd", quoteBaseUnits: 1000 },
      { id: "arb-usdt", comet: "0xd98Be00b5D27fc98112BdE293e487f8D4cA57d07", denom: "usd", quoteBaseUnits: 1000 },
      { id: "arb-weth", comet: "0x6f7D514bbD4aFf3BcD1140B7344b32f063dEe486", denom: "auto", quoteBaseUnits: 1 },
    ],
  },
];

/** COMPOUND_CHAINS=base,ethereum,arbitrum (default: base). Unknown names are ignored. */
export function selectChains(env: Record<string, string | undefined>, all: ChainDef[] = CHAINS): ChainDef[] {
  const want = (env.COMPOUND_CHAINS || "base")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return all
    .filter((c) => want.includes(c.name))
    .map((c) => {
      const up = c.name.toUpperCase();
      const n = (k: string, d: number): number => {
        const v = Number(env[`${k}_${up}`]);
        return Number.isFinite(v) && v > 0 ? Math.floor(v) : d;
      };
      return {
        ...c,
        backfillBlocks: n("COMPOUND_BACKFILL_BLOCKS", c.backfillBlocks),
        logChunk: n("COMPOUND_LOG_CHUNK", c.logChunk),
        checkEveryBlocks: n("COMPOUND_CHECK_EVERY_BLOCKS", c.checkEveryBlocks),
      };
    });
}
