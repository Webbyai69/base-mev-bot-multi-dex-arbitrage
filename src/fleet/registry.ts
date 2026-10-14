/**
 * The fleet: base-arb-bot plus the ten systems from the field guide
 * (docs/FLEET-PLAN.md). This file is the single source of truth the command
 * center, the agents and the docs all read.
 *
 * Integration model (see bots/CONTRACT.md):
 *   - base-arb-bot runs in this process.
 *   - Every other bot runs as its OWN process (its own language, venv or
 *     container) next to a small wrapper. The trading process never spawns
 *     or kills anything. The command center writes a desired-state file
 *     (data/fleet/<id>.control.json) and reads the wrapper's heartbeat
 *     (data/fleet/<id>.heartbeat.json).
 *   - The dashboard can only ask for "detect" or "paper". Live trading for an
 *     external bot needs FLEET_LIVE_<ID>=1 in that wrapper's own .env, which
 *     only the owner edits. Same rule as MODE for the main bot.
 *
 * Upstream code is pinned (git submodules under bots/upstream/) and never
 * copied into src/. Licences were checked on 2026-10-11; see bots/README.md.
 */

export type Network = "base" | "eth" | "arb" | "op" | "sol" | "hl" | "cex";
export type BotMode = "detect" | "paper" | "live";

export interface Upstream {
  repo: string;
  /** Pinned commit (full SHA) the wrapper builds against. */
  commit: string;
  branch: string;
  /** SPDX id, or a short note when the licence needs explaining. */
  license: string;
  /** What the licence lets us do with it. */
  obligations: string;
  /** Submodule path, when the repo is vendored as one. */
  path?: string;
}

export interface BotDef {
  id: string;
  name: string;
  networks: Network[];
  kind: "in-process" | "external";
  language: "TypeScript" | "Python" | "Rust" | "Solidity";
  strategy: string;
  description: string;
  /** What the bot needs to trade: flash loans need only gas; the rest need balances. */
  capital: "gas-only" | "inventory" | "exchange-balance";
  /** The phase in docs/FLEET-PLAN.md that integrates it. */
  phase: number;
  /** The first safe run, from the field guide. */
  firstStep: string;
  /** Modes its wrapper may offer. "live" is never requested by the dashboard. */
  modes: BotMode[];
  /** Code paths we never enable, whatever the upstream offers. */
  excluded?: string;
  upstream?: Upstream;
  /** Where its money comes from when it works (for the targeting brief). */
  edge: string;
}

export const FLEET: readonly BotDef[] = [
  {
    id: "base-arb-bot",
    name: "base-arb-bot",
    networks: ["base"],
    kind: "in-process",
    language: "TypeScript",
    strategy: "backrun + flash-loan arbitrage, liquidations",
    description:
      "Our flagship: multi-DEX backruns across Uniswap V2/V3/V4, Aerodrome, Slipstream and PancakeSwap V3, with a learning engine, Flashblocks reaction and Aave liquidations.",
    capital: "gas-only",
    phase: 0,
    firstStep: "already live on a $1/day gas cap",
    modes: ["paper", "live"],
    edge: "latency on contested backruns; Ashburn is the next step",
  },
  {
    id: "morpho-liquidator",
    name: "Morpho Blue Liquidator",
    networks: ["base"],
    kind: "external",
    language: "TypeScript",
    strategy: "permissionless liquidations",
    description:
      "Finds Morpho Blue positions at health factor 1.02 or lower, sizes the seize with LIF maths, quotes the collateral swap through 0x, 1inch or LiFi, and broadcasts only plans that simulate cleanly.",
    capital: "gas-only",
    phase: 1,
    firstStep: "ALLOW_DETECTION_ONLY=true: logs every liquidatable position without trading",
    modes: ["detect", "paper", "live"],
    edge: "liquidation bonus (LIF) on Morpho Blue markets",
    upstream: {
      repo: "morpho-org/morpho-bots",
      commit: "08d0a415d6d027f7e401fd6a904b09bedb441668",
      branch: "main",
      license: "Apache-2.0",
      obligations: "use, modify and port with attribution; keep NOTICE",
      path: "bots/upstream/morpho-bots",
    },
  },
  {
    id: "compound-liquidator",
    name: "Compound III Liquidator",
    networks: ["base", "eth", "arb"],
    kind: "external",
    language: "Solidity",
    strategy: "absorb + flash liquidation",
    description:
      "Absorbs underwater Compound III accounts, flash-borrows the base asset, buys the discounted collateral, sells it and repays in one transaction.",
    capital: "gas-only",
    phase: 3,
    firstStep: "fork-test the absorb/buy/swap/repay path against a Base fork",
    modes: ["detect", "paper", "live"],
    edge: "collateral discount on absorbed Compound III accounts",
    upstream: {
      repo: "compound-finance/comet",
      commit: "f766f51583c23acc33b2a7824654ef2029a96804",
      branch: "main",
      license: "BUSL-1.1 (change date 2025-12-31 passed: now GPL-2.0-or-later)",
      obligations: "reference and fork-test only; write our own liquidator rather than copy GPL code into contracts/",
      path: "bots/upstream/comet",
    },
  },
  {
    id: "blind-backrun",
    name: "simple-blind-arbitrage",
    networks: ["eth"],
    kind: "external",
    language: "Solidity",
    strategy: "MEV-Share backrun",
    description:
      "Backruns MEV-Share hints on Ethereum and sizes the trade on-chain from live reserves, so a stale read can't turn a winner into a revert.",
    capital: "gas-only",
    phase: 4,
    firstStep: "run the forked Foundry test",
    modes: ["detect", "paper", "live"],
    edge: "refund-sharing backruns of user swaps",
    upstream: {
      repo: "flashbots/simple-blind-arbitrage",
      commit: "73c6c270b27059e6dc0469a6c08e0f7739e5d531",
      branch: "main",
      license: "MIT",
      obligations: "use, modify and port with the copyright notice; its on-chain sizing is a candidate for RouteExecutor",
      path: "bots/upstream/simple-blind-arbitrage",
    },
  },
  {
    id: "triangular",
    name: "Triangular cycles (mev-templates pattern)",
    networks: ["base", "arb", "op"],
    kind: "external",
    language: "TypeScript",
    strategy: "3-hop flash-loan arbitrage",
    description:
      "Discovers every V2-style pool, builds all 3-hop cycles and reads 6,000+ reserves in one multicall. base-arb-bot already does this on Base; this bot ports it to other EVM chains.",
    capital: "gas-only",
    phase: 4,
    firstStep: "simulator only on an Arbitrum fork",
    modes: ["detect", "paper", "live"],
    edge: "multi-hop price gaps on chains without a resident bot",
    upstream: {
      repo: "solidquant/mev-templates",
      commit: "67c46cca4337f8ba4e781e6ac152ebe2e59dd672",
      branch: "main",
      license: "none published (all rights reserved)",
      obligations: "study only: do not copy code; we reimplement from our own routes.ts",
    },
  },
  {
    id: "artemis",
    name: "Artemis",
    networks: ["eth", "base"],
    kind: "external",
    language: "Rust",
    strategy: "MEV framework (collector / strategy / executor)",
    description:
      "Paradigm's Rust framework. Its collector, strategy and executor split is the structure every new bot in the fleet follows, and the base the UniswapX filler builds on.",
    capital: "gas-only",
    phase: 5,
    firstStep: "cargo test --all",
    modes: ["detect", "paper"],
    edge: "framework layer: speed and structure for the Rust bots",
    upstream: {
      repo: "paradigmxyz/artemis",
      commit: "4bb158070833ec2b789a2ece14c896c4b28ce3be",
      branch: "main",
      license: "MIT OR Apache-2.0",
      obligations: "use and modify with either licence's notice",
      path: "bots/upstream/artemis",
    },
  },
  {
    id: "uniswapx-filler",
    name: "UniswapX Filler",
    networks: ["base", "eth"],
    kind: "external",
    language: "Rust",
    strategy: "Dutch-auction order filling",
    description:
      "Fills UniswapX orders once their exclusivity window ends. Base moved to DutchV3 auctions in June 2026, so the filler needs DutchV3 support added before it can run there.",
    capital: "inventory",
    phase: 5,
    firstStep: "read-only order collector",
    modes: ["detect", "paper", "live"],
    edge: "auction spread on user orders after exclusivity",
    upstream: {
      repo: "marktoda/uniswapx-artemis",
      commit: "f7031614f281a69db2b2296eec74e8bd1f71436a",
      branch: "main",
      license: "MIT",
      obligations: "use and modify with the copyright notice",
      path: "bots/upstream/uniswapx-artemis",
    },
  },
  {
    id: "hummingbot",
    name: "Hummingbot",
    networks: ["cex", "hl", "base"],
    kind: "external",
    language: "Python",
    strategy: "market making + cross-venue arbitrage",
    description:
      "Market making and cross-venue arbitrage across 140+ exchanges, Hyperliquid and Uniswap. The AI tunes it; its own code signs and sends (the Condor pattern).",
    capital: "exchange-balance",
    phase: 2,
    firstStep: "simple_pmm in paper mode",
    modes: ["paper", "live"],
    edge: "spread capture and CEX-DEX gaps",
    upstream: {
      repo: "hummingbot/hummingbot",
      commit: "9af100d6822da7d2d0291a906c730ef172284ee2",
      branch: "master",
      license: "Apache-2.0",
      obligations: "run unmodified in its own container; changes stay in our fork with NOTICE kept",
      path: "bots/upstream/hummingbot",
    },
  },
  {
    id: "freqtrade",
    name: "Freqtrade",
    networks: ["cex", "hl"],
    kind: "external",
    language: "Python",
    strategy: "indicator and ML strategies",
    description:
      "Strategy engine: backtest, then dry-run, then live on Hyperliquid, Binance, Bybit or OKX. Talks to the command center through its own REST API.",
    capital: "exchange-balance",
    phase: 2,
    firstStep: "backtest, then dry-run",
    modes: ["paper", "live"],
    edge: "directional strategies (not MEV): real market risk",
    upstream: {
      repo: "freqtrade/freqtrade",
      commit: "1f394eaebc2f46a83d26971388628707802f8602",
      branch: "stable",
      license: "GPL-3.0",
      obligations: "run as a separate program over its REST API only; never copy its code into src/ (that would make our code GPL)",
      path: "bots/upstream/freqtrade",
    },
  },
  {
    id: "passivbot",
    name: "Passivbot",
    networks: ["hl", "cex"],
    kind: "external",
    language: "Python",
    strategy: "grid market making on perpetuals",
    description:
      "Grid market maker on perpetual futures that backtests its own config before any order. Runs on Hyperliquid, Lighter, Bybit and Binance.",
    capital: "exchange-balance",
    phase: 3,
    firstStep: "backtest the default config",
    modes: ["paper", "live"],
    edge: "grid spread on perps: liquidation risk if mis-sized",
    upstream: {
      repo: "enarjord/passivbot",
      commit: "b9d6692ea41266ecb4ab81d40bb5e5baef29b50a",
      branch: "master",
      license: "Unlicense",
      obligations: "public domain: free to use, modify and port",
      path: "bots/upstream/passivbot",
    },
  },
  {
    id: "jito-searcher",
    name: "Jito Searcher",
    networks: ["sol"],
    kind: "external",
    language: "Rust",
    strategy: "Solana bundle backruns",
    description:
      "Bundle client for the Jito block engine: the entry ticket to Solana's Raydium and Orca flow.",
    capital: "inventory",
    phase: 5,
    firstStep: "send a CLI test bundle",
    modes: ["detect", "paper", "live"],
    excluded: "sandwich bundles (never built, never enabled)",
    edge: "backruns of Solana DEX swaps via bundles",
    upstream: {
      repo: "jito-labs/searcher-examples",
      commit: "f710c30b0ec7449b5122f827b0997218ab1a0315",
      branch: "master",
      license: "Apache-2.0",
      obligations: "use, modify and port with attribution; keep NOTICE",
      path: "bots/upstream/searcher-examples",
    },
  },
];

export function botById(id: string): BotDef | undefined {
  return FLEET.find((b) => b.id === id);
}

/** Env flag the OWNER sets in an external bot's wrapper .env to let it trade live. */
export function liveFlag(id: string): string {
  return "FLEET_LIVE_" + id.toUpperCase().replace(/[^A-Z0-9]/g, "_");
}
