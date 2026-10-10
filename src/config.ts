/**
 * Static configuration for Base mainnet (chain id 8453) plus runtime settings
 * loaded from .env / the environment.
 *
 * Every address here is checked at start-up by `check` (src/check.ts): each
 * factory must answer `allPairsLength()` / `allPoolsLength()` and each token
 * must answer `symbol()` and `decimals()`. If an address is wrong you find out
 * on the first run, not after a bad trade.
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { Wallet } from "ethers";

export const CHAIN_ID = 8453;

/** Multicall3 — same address on every chain it is deployed to. */
export const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";

/** OP-stack gas price oracle: exposes getL1Fee(bytes) for the L1 data fee. */
export const GAS_PRICE_ORACLE = "0x420000000000000000000000000000000000000F";

export interface TokenInfo {
  symbol: string;
  address: string;
  decimals: number;
  /** Rough USD price used only as a fallback for gas/profit conversion. */
  approxUsd?: number;
}

/** Tokens we are happy to hold profit in and to price everything against. */
export const TOKENS: Record<string, TokenInfo> = {
  WETH: { symbol: "WETH", address: "0x4200000000000000000000000000000000000006", decimals: 18 },
  USDC: { symbol: "USDC", address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", decimals: 6, approxUsd: 1 },
  USDbC: { symbol: "USDbC", address: "0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA", decimals: 6, approxUsd: 1 },
  DAI: { symbol: "DAI", address: "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb", decimals: 18, approxUsd: 1 },
  cbETH: { symbol: "cbETH", address: "0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22", decimals: 18 },
};

export const WETH = TOKENS.WETH!.address.toLowerCase();
export const USDC = TOKENS.USDC!.address.toLowerCase();

export type DexKind = "univ2" | "aerodrome" | "univ3" | "slipstream" | "pancakev3" | "univ4";

/** The zero address: Uniswap V4's native-ETH currency, and a sentinel elsewhere. */
export const NATIVE = "0x0000000000000000000000000000000000000000";

export interface DexInfo {
  /** Short id used in logs and data files. */
  id: string;
  name: string;
  kind: DexKind;
  factory: string;
  router: string;
  /**
   * Default swap fee in parts-per-million of the input (3000 = 0.30%).
   * The real fee is calibrated per pool at start-up (see fees.ts) because
   * several forks make it configurable.
   */
  defaultFeePpm: number;
}

export const DEXES: DexInfo[] = [
  {
    id: "uniswap-v2",
    name: "Uniswap V2",
    kind: "univ2",
    factory: "0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6",
    router: "0x4752ba5dbc23f44d87826276bf6fd6b1c372ad24",
    defaultFeePpm: 3000,
  },
  {
    id: "sushiswap-v2",
    name: "SushiSwap V2",
    kind: "univ2",
    factory: "0x71524B4f93c58fcbF659783284E38825f0622859",
    router: "0x6BDED42c6DA8FBf0d2bA55B2fa120C5e0c8D7891",
    defaultFeePpm: 3000,
  },
  {
    id: "baseswap",
    name: "BaseSwap",
    kind: "univ2",
    factory: "0xFDa619b6d20975be80A10332cD39b9a4b0FAa8BB",
    router: "0x327Df1E6de05895d2ab08513aaDD9313Fe505d86",
    defaultFeePpm: 2500,
  },
  {
    id: "aerodrome",
    name: "Aerodrome (volatile pools)",
    kind: "aerodrome",
    factory: "0x420DD381b31aEf6683db6B902084cB0FFECe40Da",
    router: "0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43",
    defaultFeePpm: 3000,
  },
];

/** Uniswap V3 factory (classifier + concentrated-liquidity trading). */
export const UNISWAP_V3_FACTORY = "0x33128a8fC17869897dcE68Ed026d694621f6FDfD";

/**
 * Concentrated-liquidity DEXes. Swaps inside one tick range are modelled
 * exactly (src/clmath.ts); every opportunity is cross-checked with the DEX's
 * own quoter. Slipstream has three live factories, each with its own quoter,
 * and its quoter takes tickSpacing where Uniswap's takes fee.
 * Sources: docs.uniswap.org Base deployments; github.com/aerodrome-finance/slipstream README.
 */
export interface ClDexInfo {
  id: string;
  name: string;
  kind: "univ3" | "slipstream" | "pancakev3";
  factory: string;
  quoter: string;
  /** Uniswap V3 / PancakeSwap V3: getPool(a, b, fee) over these fee tiers. Slipstream: getPool(a, b, tickSpacing). */
  poolKeys: number[];
  /**
   * Can the deployed RouteExecutor actually trade this venue? Default true. When false the venue is
   * quote-only: its pools are watched, priced and scanned (so cross-venue spreads surface in paper,
   * the dashboard and the value-score), but routes touching it are verified by quoters rather than the
   * executor and so never reach a live send (the live path requires an executor-ok simulation). Flip to
   * true once the RouteExecutor is rebuilt with the venue's swap callback.
   */
  executable?: boolean;
}

export const CL_DEXES: ClDexInfo[] = [
  {
    id: "uniswap-v3",
    name: "Uniswap V3",
    kind: "univ3",
    factory: "0x33128a8fC17869897dcE68Ed026d694621f6FDfD",
    quoter: "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a",
    poolKeys: [100, 500, 3000, 10000],
  },
  {
    // PancakeSwap V3 (~$121M/day on Base): a Uniswap V3 fork. Same tick math and QuoterV2 interface,
    // but its own Swap event (two extra protocol-fee fields) and fee tiers (2500 where Uni has 3000).
    // Quote-only for now: the deployed RouteExecutor can't call its pancakeV3SwapCallback, so these pools
    // are watched and priced (surfacing Pancake<->Uni/Aero spreads in paper) but never live-sent. Verified
    // on-chain: factory 5151 bytes, QuoterV2 answers the Uni QuoterV2 interface, pools report this factory.
    id: "pancakeswap-v3",
    name: "PancakeSwap V3",
    kind: "pancakev3",
    factory: "0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865",
    quoter: "0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997",
    poolKeys: [100, 500, 2500, 10000],
    executable: false,
  },
  {
    id: "slipstream",
    name: "Aerodrome Slipstream",
    kind: "slipstream",
    factory: "0x5e7BB104d84c7CB9B682AaC2F3d509f5F406809A",
    quoter: "0x254cF9E1E6e233aa1AC962CB9B05b2cfeAaE15b0",
    poolKeys: [1, 50, 100, 200, 2000],
  },
  {
    id: "slipstream-gc",
    name: "Aerodrome Slipstream (gauge caps)",
    kind: "slipstream",
    factory: "0xaDe65c38CD4849aDBA595a4323a8C7DdfE89716a",
    quoter: "0x3d4C22254F86f64B7eC90ab8F7aeC1FBFD271c6C",
    poolKeys: [1, 50, 100, 200, 2000],
  },
  {
    id: "slipstream-v3",
    name: "Aerodrome Slipstream (gauges v3)",
    kind: "slipstream",
    factory: "0xf8f2eB4940CFE7d13603DDDD87f123820Fc061Ef",
    quoter: "0x514c8B5f54112481E28028F1166Bd78501089259",
    poolKeys: [1, 50, 100, 200, 2000],
  },
];

/**
 * Uniswap V4 (~$197M/day on Base): a singleton PoolManager holding every pool, keyed by a poolId hash of
 * the PoolKey (currency0, currency1, fee, tickSpacing, hooks). State is read through StateView and quoted
 * through V4Quoter — there are no per-pool contracts. Quote-only for now (the RouteExecutor has no V4
 * unlock hop): V4 pools are watched, priced and scanned so V4<->V3/Aerodrome spreads surface in paper, the
 * dashboard and the value-score, but they never live-send. Verified on-chain: PoolManager/StateView/
 * V4Quoter have code, the poolId derivation matches live pools, and the deep ETH/USDC pools use native ETH
 * (currency 0x0), which we map to WETH in the token graph (1:1). Hookless pools only (hooks == 0x0).
 */
export const V4 = {
  poolManager: "0x498581fF718922c3f8e6A244956aF099B2652b2b",
  stateView: "0xA3c0c9b65baD0b08107Aa264b0f3dB444b867A71",
  quoter: "0x0d5e0F971ED27FBfF6c2837bf31316121532048D",
  /** [fee ppm, tickSpacing] tiers probed for each base/counter pair (V4 allows any pair; these are the liquid ones). */
  feeTiers: [
    [100, 1],
    [500, 10],
    [2500, 50],
    [3000, 60],
    [10000, 200],
  ] as Array<[number, number]>,
} as const;

/** Free flash loans: Morpho Blue (single token, no fee) and Balancer V2 (fee set by governance, 0 so far). */
export const MORPHO_BLUE = "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb";
export const BALANCER_VAULT = "0xBA12222222228d8Ba445958a75a0704d566BF2C8";
export const BALANCER_FEES_COLLECTOR = "0xce88686553686DA562CE7Cea497CE749DA109f9F";

/** Aave V3 on Base (bgd-labs/aave-address-book AaveV3Base.sol). */
export const AAVE_V3 = {
  pool: "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5",
  dataProvider: "0x0F43731EB8d45A581f4a36DD74F5f358bc90C73A",
  oracle: "0x2Cc0Fc26eD4563A5ce5e8bdcfe1A2878676Ae156",
};

// ---------------------------------------------------------------------------
// Runtime settings
// ---------------------------------------------------------------------------

export interface Settings {
  rpcUrl: string;
  wsUrl: string | undefined;
  mode: "paper" | "live";
  minProfitUsd: number;
  minPoolLiquidityWeth: number;
  maxPools: number;
  arbGasLimit: number;
  /** Gas limit for a live multi-hop / CL route through the RouteExecutor (bigger: more hops, flash-loan overhead). */
  routeGasLimit: number;
  priorityFeeGwei: number;
  executorAddress: string | undefined;
  privateKey: string | undefined;
  mevFeed: boolean;
  watchBots: string[];
  dataDir: string;
  reportDir: string;
  logLevel: "debug" | "info" | "warn" | "error";
  discovery: "activity" | "full";
  discoveryLookbackBlocks: number;
  discoveryLogRange: number;
  rpcConcurrency: number | undefined;
  rpcMinIntervalMs: number | undefined;
  rpcBatchMaxCount: number | undefined;
  /** One RPC HTTP request is abandoned (and retried) after this long; a whole call, retries included, after 3x. */
  rpcTimeoutMs: number;
  /** Scan-loop watchdog: a block handler running longer than this is reported and the next block goes ahead. */
  blockWatchdogMs: number;
  /** Re-score every route (not only those touching changed pools) every N blocks. */
  fullRescanBlocks: number;
  /** A trade valued above this (USD) is treated as mispriced: not recorded, not shown, not learned from. */
  sanityMaxProfitUsd: number;
  /** A pool must be at least this deep (WETH-equivalent, real tokens) to set a token's USD price. */
  priceMinDepthWeth: number;
  /** Verify opportunities with the executor bytecode injected via eth_call state override (no deployment). */
  simOverride: boolean;

  // --- upgrade 1: concentrated liquidity ---
  clPools: boolean;
  // --- upgrade 2: multi-hop routes ---
  multiHop: boolean;
  maxHops: 2 | 3;
  maxCycles: number;
  /** Gas units per route: fixed overhead + per hop by pool type (paper-mode cost model). */
  gasRouteBase: number;
  gasHopV2: number;
  gasHopCl: number;
  /** Deployed RouteExecutor (contracts/RouteExecutor.sol) for multi-hop / CL routes. */
  routeExecutorAddress: string | undefined;
  flashSource: "morpho" | "balancer" | "capital";
  // --- upgrade 3: Flashblocks ---
  flashblocks: boolean;
  flashblocksRpcUrl: string;
  /** Base's Flashblocks websocket: every ~200ms Flashblock with its receipts (logs). Empty = poll the RPC instead. */
  flashblocksWsUrl: string | undefined;
  flashblockPollMs: number;
  flashblockMaxPools: number;
  // --- upgrade 4: liquidations ---
  liquidations: boolean;
  liqLookbackBlocks: number;
  liqCheckEvery: number;
  liqSwapCostBps: number;
  /** 0.8: actually send liquidations live (needs LIQ_EXECUTOR_ADDRESS). Off by default. */
  liquidationsLive: boolean;
  /** Deployed LiquidationExecutor (contracts/LiquidationExecutor.sol). */
  liqExecutorAddress: string | undefined;
  liqGasLimit: number;
  // --- risk ---
  tokenBlacklist: Set<string>;
  // --- low-RPC mode ---
  /** "events": update pools from each block's logs (one eth_getLogs) and re-read only what changed; "full": re-read every pool every block. */
  refreshMode: "events" | "full";
  /** In events mode, re-read every pool anyway every N blocks (catches anything the logs missed). */
  fullRefreshBlocks: number;
  /** Fall back to a full refresh when this many blocks behind (instead of fetching that many blocks of logs). */
  maxLogGap: number;
  /** Extra HTTP endpoints, used in order when the active one keeps failing. */
  rpcFallbackUrls: string[];
  // --- dashboard & alerts ---
  /** Serve the dashboard on http://localhost:<uiPort> while the bot runs. */
  ui: boolean;
  uiPort: number;
  /** Public address of the bot's hot wallet (balances, gas top-up, RouteExecutor operator). Never a key. */
  botAddress: string | undefined;
  telegramBotToken: string | undefined;
  telegramChatId: string | undefined;
  alertMinProfitUsd: number;
  alertMinLiqProfitUsd: number;
  alertMaxPerHour: number;
  // --- online copy of the dashboard (cloud/) ---
  /** The Worker's address, e.g. https://base-arb-dashboard.<you>.workers.dev. Unset = off. */
  cloudUrl: string | undefined;
  /** Must equal the Worker's INGEST_TOKEN secret. */
  cloudToken: string | undefined;
  cloudAccessClientId: string | undefined;
  cloudAccessClientSecret: string | undefined;
  cloudPushMs: number;
  /** Ceiling for the watch list, which grows as the bot learns pools other bots trade on. */
  maxWatchedPools: number;
  /** The learning engine (src/learn.ts). */
  learning: boolean;
  learnHalfLifeHours: number;
  learnPruneDays: number;
  /** Live: most of the expected profit it may bid as priority fee, and the smallest expected value worth a send. */
  liveMaxBidShare: number;
  liveMinEvUsd: number;
  /** Act mode (0.9): send every find that passes the on-chain simulation + min-profit floor, bid sized by learning, instead of only positive expected-value finds. */
  liveActAlways: boolean;
  /** Hard ceiling (gwei) for the live priority-fee bid; the bid is also capped at liveMaxBidShare of a trade's profit, so a higher ceiling lets bigger-profit trades bid proportionally more to win. */
  liveMaxBidGwei: number;
}

/** Minimal .env loader (no dependency): KEY=VALUE lines, # comments, optional quotes. */
export function loadDotEnv(path = ".env"): void {
  const file = resolve(path);
  if (!existsSync(file)) return;
  for (const raw of readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

function num(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`Environment variable ${name} is not a number: ${v}`);
  return n;
}

function bool(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  return !["false", "0", "no", "off"].includes(v.toLowerCase());
}

function str(name: string, fallback?: string): string | undefined {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  return v;
}

export function loadSettings(): Settings {
  loadDotEnv();
  const mode = (str("MODE", "paper") as Settings["mode"]);
  if (mode !== "paper" && mode !== "live") throw new Error(`MODE must be paper or live, got ${mode}`);
  const settings: Settings = {
    rpcUrl: str("RPC_URL", "https://mainnet.base.org")!,
    wsUrl: str("WS_URL"),
    mode,
    minProfitUsd: num("MIN_PROFIT_USD", 0.25),
    minPoolLiquidityWeth: num("MIN_POOL_LIQUIDITY_WETH", 2),
    maxPools: num("MAX_POOLS", 400),
    arbGasLimit: num("ARB_GAS_LIMIT", 260_000),
    routeGasLimit: num("ROUTE_GAS_LIMIT", 600_000),
    priorityFeeGwei: num("PRIORITY_FEE_GWEI", 0.005),
    executorAddress: str("EXECUTOR_ADDRESS"),
    privateKey: str("PRIVATE_KEY"),
    mevFeed: (str("MEV_FEED", "true") ?? "true").toLowerCase() !== "false",
    watchBots: (str("WATCH_BOTS", "") ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.length > 0),
    dataDir: str("DATA_DIR", "./data")!,
    reportDir: str("REPORT_DIR", "./reports")!,
    logLevel: (str("LOG_LEVEL", "info") as Settings["logLevel"]),
    discovery: (str("DISCOVERY", "activity") as Settings["discovery"]),
    discoveryLookbackBlocks: num("DISCOVERY_LOOKBACK_BLOCKS", 900),
    discoveryLogRange: num("DISCOVERY_LOG_RANGE", 100),
    rpcConcurrency: process.env.RPC_CONCURRENCY ? num("RPC_CONCURRENCY", 6) : undefined,
    rpcMinIntervalMs: process.env.RPC_MIN_INTERVAL_MS ? num("RPC_MIN_INTERVAL_MS", 0) : undefined,
    rpcBatchMaxCount: process.env.RPC_BATCH_MAX_COUNT ? num("RPC_BATCH_MAX_COUNT", 20) : undefined,
    rpcTimeoutMs: num("RPC_TIMEOUT_MS", 10_000),
    blockWatchdogMs: num("BLOCK_WATCHDOG_MS", 30_000),
    fullRescanBlocks: Math.max(1, num("FULL_RESCAN_BLOCKS", 30)),
    sanityMaxProfitUsd: num("SANITY_MAX_PROFIT_USD", 1000),
    priceMinDepthWeth: num("PRICE_MIN_DEPTH_WETH", 1),
    simOverride: (str("SIM_OVERRIDE", "true") ?? "true").toLowerCase() !== "false",
    clPools: bool("CL_POOLS", true),
    multiHop: bool("MULTI_HOP", true),
    maxHops: num("MAX_HOPS", 3) >= 3 ? 3 : 2,
    maxCycles: num("MAX_CYCLES", 150),
    gasRouteBase: num("GAS_ROUTE_BASE", 70_000),
    gasHopV2: num("GAS_HOP_V2", 75_000),
    gasHopCl: num("GAS_HOP_CL", 115_000),
    routeExecutorAddress: str("ROUTE_EXECUTOR_ADDRESS"),
    flashSource: (str("FLASH_SOURCE", "morpho") as Settings["flashSource"]),
    flashblocks: bool("FLASHBLOCKS", false),
    flashblocksRpcUrl: str("FLASHBLOCKS_RPC_URL", "https://mainnet.base.org")!,
    // "off" (or "none") switches the stream off and falls back to polling the RPC at the pending state.
    flashblocksWsUrl: ((v) => (v && !/^(off|none|false)$/i.test(v) ? v : undefined))(process.env.FLASHBLOCKS_WS_URL === undefined ? "wss://mainnet.flashblocks.base.org/ws" : process.env.FLASHBLOCKS_WS_URL),
    flashblockPollMs: num("FLASHBLOCK_POLL_MS", 400),
    flashblockMaxPools: num("FLASHBLOCK_MAX_POOLS", 120),
    liquidations: bool("LIQUIDATIONS", true),
    liqLookbackBlocks: num("LIQ_LOOKBACK_BLOCKS", 1800),
    liqCheckEvery: num("LIQ_CHECK_EVERY", 5),
    liqSwapCostBps: num("LIQ_SWAP_COST_BPS", 30),
    liquidationsLive: bool("LIQUIDATIONS_LIVE", false),
    liqExecutorAddress: str("LIQ_EXECUTOR_ADDRESS"),
    liqGasLimit: num("LIQ_GAS_LIMIT", 900_000),
    refreshMode: (str("REFRESH_MODE", "events") as Settings["refreshMode"]),
    fullRefreshBlocks: num("FULL_REFRESH_BLOCKS", 150),
    maxLogGap: num("MAX_LOG_GAP", 30),
    rpcFallbackUrls: (str("RPC_FALLBACK_URLS", "") ?? "")
      .split(",")
      .map((u) => u.trim())
      .filter((u) => /^https?:\/\//.test(u)),
    tokenBlacklist: new Set(
      (str("TOKEN_BLACKLIST", "") ?? "")
        .split(",")
        .map((x) => x.trim().toLowerCase())
        .filter((x) => /^0x[0-9a-f]{40}$/.test(x)),
    ),
    ui: bool("UI", true),
    uiPort: num("UI_PORT", 8787),
    botAddress: str("BOT_ADDRESS"),
    telegramBotToken: str("TELEGRAM_BOT_TOKEN"),
    telegramChatId: str("TELEGRAM_CHAT_ID"),
    alertMinProfitUsd: num("ALERT_MIN_PROFIT_USD", 5),
    alertMinLiqProfitUsd: num("ALERT_MIN_LIQ_PROFIT_USD", 25),
    alertMaxPerHour: num("ALERT_MAX_PER_HOUR", 20),
    cloudUrl: str("CLOUD_URL"),
    cloudToken: str("CLOUD_TOKEN"),
    cloudAccessClientId: str("CLOUD_ACCESS_CLIENT_ID"),
    cloudAccessClientSecret: str("CLOUD_ACCESS_CLIENT_SECRET"),
    cloudPushMs: Math.max(2000, num("CLOUD_PUSH_MS", 4000)),
    maxWatchedPools: num("MAX_WATCHED_POOLS", 1500),
    learning: bool("LEARNING", true),
    learnHalfLifeHours: num("LEARN_HALF_LIFE_HOURS", 72),
    learnPruneDays: num("LEARN_PRUNE_DAYS", 3),
    liveMaxBidShare: num("LIVE_MAX_BID_SHARE", 0.3),
    liveMinEvUsd: num("LIVE_MIN_EV_USD", 0.01),
    liveActAlways: bool("LIVE_ACT_ALWAYS", false),
    liveMaxBidGwei: num("LIVE_MAX_BID_GWEI", 25),
  };
  if (settings.cloudUrl) {
    let u: URL;
    try {
      u = new URL(settings.cloudUrl);
    } catch {
      throw new Error("CLOUD_URL must be the Worker's address, e.g. https://base-arb-dashboard.you.workers.dev");
    }
    const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
    if (u.protocol !== "https:" && !(local && u.protocol === "http:")) throw new Error("CLOUD_URL must start with https://");
    if (!settings.cloudToken || settings.cloudToken.length < 24) throw new Error("CLOUD_URL is set, so CLOUD_TOKEN must be set too (the Worker's INGEST_TOKEN secret, at least 24 characters)");
  }
  if (settings.botAddress && !/^0x[0-9a-fA-F]{40}$/.test(settings.botAddress)) {
    throw new Error("BOT_ADDRESS must be a public 0x address (42 characters). Never put a private key there.");
  }
  if (!Number.isInteger(settings.uiPort) || settings.uiPort < 1 || settings.uiPort > 65535) throw new Error("UI_PORT must be a port number");
  if (!["morpho", "balancer", "capital"].includes(settings.flashSource)) throw new Error("FLASH_SOURCE must be morpho, balancer or capital");
  if (settings.refreshMode !== "events" && settings.refreshMode !== "full") throw new Error("REFRESH_MODE must be events or full");
  if (settings.discovery !== "activity" && settings.discovery !== "full") throw new Error("DISCOVERY must be activity or full");
  if (!(settings.learnHalfLifeHours >= 1 && settings.learnHalfLifeHours <= 720)) throw new Error("LEARN_HALF_LIFE_HOURS must be between 1 and 720");
  if (!(settings.learnPruneDays >= 0.5 && settings.learnPruneDays <= 60)) throw new Error("LEARN_PRUNE_DAYS must be between 0.5 and 60");
  if (!(settings.liveMaxBidShare >= 0 && settings.liveMaxBidShare <= 0.5)) throw new Error("LIVE_MAX_BID_SHARE must be between 0 and 0.5");
  if (!(settings.liveMinEvUsd >= 0 && settings.liveMinEvUsd <= 1)) throw new Error("LIVE_MIN_EV_USD must be between 0 and 1");
  if (!(settings.liveMaxBidGwei >= 0 && settings.liveMaxBidGwei <= 100)) throw new Error("LIVE_MAX_BID_GWEI must be between 0 and 100");
  if (!(settings.rpcTimeoutMs >= 1000 && settings.rpcTimeoutMs <= 120_000)) throw new Error("RPC_TIMEOUT_MS must be between 1000 and 120000");
  if (!(settings.blockWatchdogMs >= 5000)) throw new Error("BLOCK_WATCHDOG_MS must be at least 5000");
  if (!(settings.sanityMaxProfitUsd > 0)) throw new Error("SANITY_MAX_PROFIT_USD must be above 0");
  if (settings.flashblocksWsUrl && !/^wss?:\/\//.test(settings.flashblocksWsUrl)) throw new Error("FLASHBLOCKS_WS_URL must start with wss:// (or be off)");
  if (settings.mode === "live") {
    if (!settings.executorAddress) throw new Error("MODE=live requires EXECUTOR_ADDRESS (deploy the ArbExecutor from the dashboard, then copy its address into .env)");
    if (!settings.privateKey) throw new Error("MODE=live requires PRIVATE_KEY (run: node dist/main.js new-wallet)");
    if (!/^0x[0-9a-fA-F]{40}$/.test(settings.executorAddress)) throw new Error("EXECUTOR_ADDRESS must be an address (0x + 40 hex characters)");
    if (settings.liquidationsLive && !settings.liqExecutorAddress) throw new Error("LIQUIDATIONS_LIVE=true requires LIQ_EXECUTOR_ADDRESS (deploy the LiquidationExecutor from the dashboard, then copy its address into .env)");
  }
  if (settings.liqExecutorAddress && !/^0x[0-9a-fA-F]{40}$/.test(settings.liqExecutorAddress)) throw new Error("LIQ_EXECUTOR_ADDRESS must be an address (0x + 40 hex characters)");
  if (settings.privateKey && settings.botAddress) {
    // A BOT_ADDRESS for another wallet would make the dashboard fund and authorise the wrong one.
    let derived = "";
    try {
      derived = new Wallet(settings.privateKey).address;
    } catch {
      throw new Error("PRIVATE_KEY is not a valid private key");
    }
    if (derived.toLowerCase() !== settings.botAddress.toLowerCase()) {
      throw new Error(`BOT_ADDRESS is not the address of PRIVATE_KEY (that is ${derived}). Remove the BOT_ADDRESS line or fix it.`);
    }
  }
  return settings;
}
