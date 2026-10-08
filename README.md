# base-arb-bot

Cross-DEX atomic arbitrage bot for **Base**, with a paper-trading mode that
tells you the truth about what you would have made, plus an on-chain **MEV
market feed** (the EigenPhi replacement): arbitrage/sandwich classifier,
competitor leaderboard, most-arbed pairs and a daily HTML report.

```
   every block ──► refresh reserves of every watched pool (one Multicall)
              ──► closed-form optimal trade for every pair on 2+ DEXes
              ──► price the profit in USD, subtract L2 + L1 gas
              ──► verify against the DEX quoters / the executor's simulate()
              ──► paper: log it, then watch blocks N+1 and N+2 to see whether
                         the spread persisted, got taken, or closed
                  live:  send executeFlash() through ArbExecutor.sol
              ──► classify every Swap in the block: who arbed what, for how much
              ──► every minute: reports/YYYY-MM-DD.html
```

## What's new in 0.2

All five upgrades run in **paper mode**. Multi-hop routes are never sent live
in this version; live mode still only sends classic two-pool V2 routes,
exactly as before.

| # | upgrade | what it does | switch |
|---|---|---|---|
| 1 | **Uniswap V3 + Aerodrome Slipstream** | Discovers and watches concentrated-liquidity pools (where most Base volume is). Swaps inside a tick range are modelled exactly (`src/clmath.ts`, a port of Uniswap's TickMath/SqrtPriceMath/SwapMath/TickBitmap), and a pool is only traded up to its next initialized tick. Slipstream's dynamic fee is re-read every block. | `CL_POOLS` |
| 2 | **Triangular / multi-hop routes** | Searches the pool graph for profitable 2- and 3-hop cycles from WETH or USDC (pruned by marginal rates), sizes each one exactly (`src/routes.ts`), prices gas per hop and verifies every hop against the DEX's own quoter, or the whole route with `RouteExecutor.simulate()` injected via state override (real pools, real transfers, real Morpho flash loan; no deployment). | `MULTI_HOP`, `MAX_HOPS` |
| 3 | **Flashblocks reaction** | Base has no public mempool. Instead it publishes each block in ~200ms "flashblocks". Between blocks the bot re-reads the hot pools at that pre-confirmed state and rescans, so a big swap is seen within ~0.4s instead of 2s. The report compares flashblock finds against block finds. | `FLASHBLOCKS` |
| 4 | **Aave V3 liquidations** | Tracks borrowers from Borrow events, checks health factors, prices each liquidation with Aave's real close-factor and bonus rules, and records whether it was taken by another bot, recovered, or left open (ours). | `LIQUIDATIONS` |
| 5 | **Daily AI review** | `reports/digest-latest.md` is a compact summary rewritten every 10 minutes. A scheduled Claude Opus task reads the last week of digests every morning and sends you concrete recommendations (`reports/ai-review-*.md`). It never edits `.env`. | `digest` command |

Also new: per-strategy and per-route **win rates** (how often a verified
opportunity was still there one block later), a `TOKEN_BLACKLIST`, and more
`check` coverage.

### Updating from 0.1 (Windows)

```powershell
cd C:\Users\joshu\source\base-arb-bot
git fetch
git checkout upgrade/v3-multihop-flashblocks-liquidations
npm install
npm run build
node dist/main.js check      # new lines for Uniswap V3, Slipstream, Morpho, Balancer, Aave
node dist/main.js discover   # once: adds the concentrated-liquidity pools
node dist/main.js run
```

Then copy the new settings from `.env.example` into your `.env`. Every one
has a default, so you only need to add the ones you want to change.

## What "paper trading" means here

Seeing a spread at block N is not the same as capturing it. For each
opportunity the bot re-prices the exact same route one and two blocks later
and looks at what the classifier saw:

| outcome     | meaning                                                          | counted in realistic P&L |
|-------------|------------------------------------------------------------------|--------------------------|
| `persisted` | still profitable at the end of N+1: nobody took it, we would have | yes, at the N+1 profit  |
| `taken`     | another bot's arbitrage hit those pools in N+1/N+2               | no (we lost the race)    |
| `closed`    | the spread vanished without a detectable arbitrage tx            | no                       |

A spread that stays open for many blocks is booked **once** (one spread, one
trade). "Optimistic net" in the report is the sum of everything found;
"Realistic net" is what a bot with ~1 block of latency would plausibly have
banked. Live mode only makes sense once realistic net is consistently positive.

## Setup on Windows

1. Install **Node.js 20 LTS or newer** from https://nodejs.org (tick "add to PATH").
2. Open PowerShell **in this folder** (`cd C:\Users\joshu\source\base-arb-bot`).
   Every `node dist/main.js …` command below must be run from here, or Node
   will look for `dist\main.js` in the wrong place. If you would rather not
   use the terminal at all, the folder contains `check.cmd`, `discover.cmd`,
   `scan.cmd`, `run.cmd`, `summary.cmd` and `report.cmd`: double-click one in
   Explorer and it runs that command from the right place and keeps the
   window open so you can read the output.
3. Install dependencies and build:
   ```powershell
   npm install
   npm run build
   ```
   (If `npm install` is ever unavailable, the exact dependency versions the
   bot was tested with are in `vendor/node_modules.zip` — unzip it into the
   project folder.)
4. Create your config:
   ```powershell
   copy .env.example .env
   ```
   Open `.env` and set `RPC_URL`. The public `https://mainnet.base.org` works
   for `check`, `discover` and `scan` (the bot slows itself down for it), but
   it rate-limits hard, so for `run` you want a free Alchemy / QuickNode /
   Ankr Base endpoint; their WebSocket URL in `WS_URL` also shaves a second
   off reaction time. On Alchemy's free tier `eth_getLogs` is capped at 10
   blocks per call; discovery notices and switches to 10-block windows by
   itself (about 90 calls for the default 30-minute lookback). Rate-limit
   errors from ethers look like
   `missing revert data (CALL_EXCEPTION)`; the bot recognises and retries
   them, but a block loop that needs ~8 requests every 2 seconds cannot live
   on the public endpoint for long.
5. Verify the RPC and every configured address:
   ```powershell
   node dist/main.js check
   ```
   Every line should say `ok`. If a factory or token says FAIL, look the
   address up on https://basescan.org and fix it in `src/config.ts`, then
   `npm run build` again.
6. Build the pool watch list:
   ```powershell
   node dist/main.js discover
   ```
   By default this is **activity-based**: it reads the Swap events of the last
   900 blocks (~30 minutes), keeps the pools on our DEXes that actually
   traded, then asks every factory for the same token pairs so a deep but
   quiet pool on the other side of a spread is not missed. That is a few
   `eth_getLogs` calls plus a few thousand cheap view calls, which the public
   endpoint tolerates (the bot paces itself to one request at a time on
   `mainnet.base.org`). `DISCOVERY=full` enumerates every pool on every
   factory instead (tens of thousands of calls; only with a real provider).
7. Look at the market right now:
   ```powershell
   node dist/main.js scan
   ```
8. Run the bot in paper mode (Ctrl+C stops it):
   ```powershell
   node dist/main.js run
   ```
   Open `reports\latest.html` in a browser; it refreshes every minute.
   `node dist/main.js summary` prints the same numbers in the terminal.

Leave it running for a few days. `data\opportunities.jsonl` and
`data\mev.jsonl` are the raw records (one JSON object per line).

## Files

| path | what |
|---|---|
| `src/config.ts` | Base addresses (Multicall3, DEX factories/routers, tokens) and `.env` settings |
| `src/pools.ts` | discovery, token metadata, per-pool **fee calibration** against each DEX's quoter, reserve cache |
| `src/math.ts` | exact constant-product maths + closed-form optimal trade size |
| `src/scanner.ts` | per-block search, USD pricing, gas-adjusted ranking, on-chain verification |
| `src/gas.ts` | L2 fee + Base L1 data fee via the GasPriceOracle predeploy |
| `src/paper.ts` | paper engine with N+1/N+2 outcome tracking, summaries |
| `src/classifier.ts` | MEV classifier (arbitrage + sandwich) from Swap logs, leaderboard, market summary |
| `src/report.ts` | daily HTML report |
| `src/executor.ts` | live sender (one tx in flight, STOP file, daily gas budget); classic routes only |
| `contracts/ArbExecutor.sol` | on-chain executor: flash-swap or own-capital, min-profit check, `simulate()` |
| `src/clmath.ts` | exact concentrated-liquidity maths (tick maths, single-range swaps, tick bitmap) |
| `src/routes.ts` | cycle search over the pool graph + exact route optimiser |
| `src/flashblocks.ts` | pre-confirmed-state reaction loop |
| `src/liquidations.ts` | Aave V3 liquidation monitor and summaries |
| `src/digest.ts` | daily Markdown digest for the AI review |
| `contracts/RouteExecutor.sol` | multi-hop executor: V2 / Aerodrome / CL hops, Morpho or Balancer flash loan, `simulate()` |
| `src/simBytecodeRoute.ts` | compiled RouteExecutor runtime (solc 0.8.26) for state-override simulation |
| `test/forge/` | EVM tests for RouteExecutor (`npm run test:contracts`, needs Foundry) |
| `test/` | unit tests, a mock Base JSON-RPC chain for end-to-end tests, an in-EVM contract test |

## How opportunities are verified

Every candidate route is checked on-chain at the same block before it is
logged (`sim` field in `data/opportunities.jsonl`):

| `sim`             | how                                                                                   |
|-------------------|---------------------------------------------------------------------------------------|
| `executor-ok`     | `ArbExecutor.simulate()` ran the whole flash-swap for real and reported the profit    |
| `executor-revert` | the same call reverted: fee-on-transfer/blacklisted token, stale quote, broken pool   |
| `quoter-ok`       | each DEX's own quoter agreed with our maths (cannot see token transfer quirks)        |
| `quoter-mismatch` | the quoter disagreed; something about the pool is not what we model                  |

You do not need to deploy anything for `executor-*`: with `SIM_OVERRIDE=true`
(default) the bot injects the compiled ArbExecutor bytecode into `eth_call`
through a *state override*, so the simulation runs against the real pools
with real token transfers but no contract on chain. A route that reverts is
muted for 20 minutes; after three reverts the token pair is dropped from the
watch list. This is what separates a real spread from a trap: the first
"opportunity" this bot ever found (WETH/Fren Pet, $0.31, quoter-approved,
untouched by other bots for minutes) reverts with `TransferFailed` when
actually executed, which is exactly why nobody was taking it.

Only verified opportunities count towards "realistic net" in the report.

## The MEV feed

`MEV_FEED=true` (default) runs the classifier on every block:

* **arbitrage** — one transaction whose swaps net out to a gain in exactly one
  token across two or more pools. Profit is that token's net gain, priced in
  USD through the deepest WETH/USDC route we know.
* **sandwich** — same pool, same block: attacker swap, victim swap in the same
  direction, attacker swap back.

`WATCH_BOTS=0xabc...,0xdef...` pins specific competitor addresses to their
own section of the report. Pools that real arbitrage bots use and we do not
watch yet are added to the watch list automatically (max 5 per block), so the
bot learns where the action is.

## Going live (phase 3)

Only after paper mode shows consistent realistic profit.

1. Compile and deploy `contracts/ArbExecutor.sol` from the wallet that will
   run the bot. Easiest: https://remix.ethereum.org → paste the file →
   compiler 0.8.24+ (EVM version *cancun*) → Deploy with MetaMask on Base.
   The deployer becomes `owner`. Or with Foundry:
   `forge create contracts/ArbExecutor.sol:ArbExecutor --rpc-url $RPC_URL --private-key $PK`
2. Put `EXECUTOR_ADDRESS` in `.env` and keep running in paper mode for a
   while: the scanner now verifies every opportunity with the contract's
   `simulate()` (exact, includes any token transfer quirks) and the report's
   "failed on-chain verification" count should stay at zero.
3. Fund the wallet with a little ETH for gas (flash mode needs no trading
   capital; `USE_FLASH=false` needs the executor to hold the input token).
4. Set `MODE=live`, `PRIVATE_KEY`, `MAX_DAILY_GAS_USD` (default 20).
   A file named `STOP` in the data folder halts sending instantly.

The contract reverts with `InsufficientProfit` if the trade would return less
than `minProfit`, so a stale quote costs a failed transaction's gas (cents on
Base) and never principal. Never reuse a private key that has ever been in a
source file or chat.

## Honest limitations

* Concentrated-liquidity trades are limited to the current tick range (up to
  the next initialized tick). That is exact but conservative: a route that
  would profit from crossing several ticks is sized down, not skipped.
* Multi-hop and CL routes are paper-only. RouteExecutor has EVM tests against
  mocks, not yet against live Base pools. Watch the "failed on-chain
  verification" count in the report before ever considering live use.
* Aerodrome stable pools and Uniswap V4 are not traded.
* The Flashblocks loop depends on a Flashblocks-aware RPC answering
  `eth_call` at the `pending` tag. Base plans to deprecate Flashblocks in a
  future hardfork.
* Liquidation profit is an estimate: flat swap-cost assumption, no E-mode
  bonuses, no isolated-mode ceilings. There is no liquidation contract yet.
* Competition on Base is real: expect most opportunities to show as `taken`
  or `closed`. The point of paper mode is to measure exactly that before
  spending anything.
* Fee-on-transfer and rebasing tokens are excluded by the fee calibration
  step (their quotes cannot be reproduced), which is deliberate.

## Tests

```powershell
npm test                 # maths, CL maths, routing, mock-chain end-to-end
npm run test:contracts   # RouteExecutor in an EVM (needs Foundry: https://getfoundry.sh)
```
Unit tests for the maths, an end-to-end run against a mock Base chain, and
(when `SOLC_NODE_MODULES` points at a `node_modules` containing `solc` and
`@nomicfoundation/ethereumjs-vm`, e.g. from any Hardhat project) an in-EVM
test of the executor contract.
