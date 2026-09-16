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

export type DexKind = "univ2" | "aerodrome";

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

/** Uniswap V3 factory — used by the MEV classifier only (phase 2 for trading). */
export const UNISWAP_V3_FACTORY = "0x33128a8fC17869897dcE68Ed026d694621f6FDfD";

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
  /** Verify opportunities with the executor bytecode injected via eth_call state override (no deployment). */
  simOverride: boolean;
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
    simOverride: (str("SIM_OVERRIDE", "true") ?? "true").toLowerCase() !== "false",
  };
  if (settings.discovery !== "activity" && settings.discovery !== "full") throw new Error("DISCOVERY must be activity or full");
  if (settings.mode === "live") {
    if (!settings.executorAddress) throw new Error("MODE=live requires EXECUTOR_ADDRESS");
    if (!settings.privateKey) throw new Error("MODE=live requires PRIVATE_KEY");
  }
  return settings;
}
