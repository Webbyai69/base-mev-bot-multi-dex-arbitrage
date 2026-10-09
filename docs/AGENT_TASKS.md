# Tasks for helper agents

Eight self-contained prompts for other AI agents (DeepSeek, Codex, Cursor, another
Claude Code session). Copy one whole block into the agent. Each block already
contains the shared rules, so nothing else needs pasting.

**Which agent for which task.** Tasks 1, 3, 4 and 6 need to read and run the
repo, so give them to an agent with GitHub access (Claude Code, Codex, Cursor).
A chat-only agent such as DeepSeek can't open the private repo. For those, attach
the files listed under "Attach" in each prompt, and paste its answer back to
Claude to integrate. Tasks 2 and 5 work well that way.

**Avoiding clashes.** Claude owns these files and may change them in parallel:
`src/main.ts`, `src/rpc.ts`, `src/pools.ts` (the refresh path),
`src/classifier.ts`, `src/liquidations.ts` (the log plumbing),
`src/executor.ts`, `src/alerts.ts`, `src/cloud.ts`, `contracts/RouteExecutor.sol`,
`ui/`, `src/ui/`, `cloud/`. Each prompt says what it may touch. Anything else goes in new
files, plus a short note on how to wire it in. Claude merges the branches.
Rebase onto the latest base branch before you start: it now has the dashboard
(`src/ui/server.ts`, `ui/dashboard.html`), Telegram alerts, and a funnel of
rejection counters in `src/scanner.ts` (`Scanner.funnel`).

| # | Task | Branch | Size |
|---|---|---|---|
| 1 | Uniswap V4 pools | `agent/uniswap-v4` | large |
| 2 | Curve and Balancer pools (measure first) | `agent/curve-balancer` | medium, may stop at the report |
| 3 | Split-trade optimisation | `agent/split-trades` | large |
| 4 | Aave liquidation executor contract | `agent/aave-liquidator` | large |
| 5 | Encrypted key store | `agent/keystore` | small |
| 6 | Tests against a copy of real Base pools, gas calibration, CI | `agent/fork-tests` | medium |
| 7 | Opportunity history, near misses and size curves | `agent/opportunity-history` | medium |
| 8 | Why did a rival get it? Replay and classify missed trades | `agent/miss-replay` | large |

---

## 1. Uniswap V4 pools

```text
You are helping build base-arb-bot, a TypeScript arbitrage bot for Base (chain id 8453): Node 20, ESM, strict TypeScript, ethers v6. It runs in PAPER mode: it finds arbitrage opportunities, verifies them on-chain with eth_call simulations, and records what would have happened. Repo: github.com/Webbyai69/base-mev-bot-multi-dex-arbitrage (private). Base branch: upgrade/v3-multihop-flashblocks-liquidations. Work on a new branch: agent/uniswap-v4.

HOW THE BOT WORKS (read these files first)
- src/pools.ts: PoolRegistry. Discovers pools, refreshes their state every block through Multicall3 (Chain.multicall in src/rpc.ts). A Pool is { address, dex, kind: "univ2"|"aerodrome"|"univ3"|"slipstream", token0, token1 (lowercase), reserve0, reserve1, feePpm, feeModel "ppm"|"bps", cl?: ClState & { quoter } }. For CL pools reserve0/1 hold "virtual reserves" (L/sqrtP, L*sqrtP) so pricing code works unchanged.
- src/clmath.ts: exact Uniswap V3 maths (TickMath, SqrtPriceMath, one SwapMath step, TickBitmap). ClState = { sqrtPriceX96, tick, liquidity, tickSpacing, feePips, words: Map<wordPos, bitmap> }. A swap is only modelled up to the next initialized tick; beyond it clSwapExactIn returns null (infeasible). Tested to match the continuous formula within 2 wei.
- src/routes.ts: findCycles (2-3 hop cycles from WETH/USDC pruned by marginal log-rates) and optimizeRoute (exact integer evaluation, bisection for the feasible size, ternary search for the best size). hopOut(pool, tokenIn, amountIn) uses clmath when pool.cl is set.
- src/scanner.ts: per block, finds classic V2 routes and multi-hop/CL routes, prices them in USD, subtracts gas, and verifies every hop against the DEX's own quoter in one multicall (hopQuoteCall / decodeHopQuote), or the whole route with RouteExecutor.simulate() injected through an eth_call state override.
- src/classifier.ts: decodes every Swap log in a block to detect other bots' arbitrages (the MEV feed). The paper engine (src/paper.ts) uses it to mark our opportunities as "taken" when another bot hits the same pools.
- Tests: npm test (node:test against dist/), forge test (Foundry, test/forge).

GOAL
Add Uniswap V4 pools on Base to discovery, pricing, routing, verification and the MEV feed, in paper mode. A lot of Base volume (Clanker, Zora and other token launches) trades on V4, and the bot can't see it today.

FACTS (verified from Uniswap's docs for Base; re-check anything else against v4-core / v4-periphery source)
- PoolManager 0x498581ff718922c3f8e6a244956af099b2652b2b (singleton: every V4 pool lives here, identified by PoolId = keccak256(abi.encode(PoolKey))).
- StateView 0xa3c0c9b65bad0b08107aa264b0f3db444b867a71: getSlot0(poolId) -> (sqrtPriceX96, tick, protocolFee, lpFee); getLiquidity(poolId); getTickBitmap(poolId, int16 word); getTickLiquidity(poolId, int24 tick).
- V4Quoter 0x0d5e0f971ed27fbff6c2837bf31316121532048d: quoteExactInputSingle((PoolKey poolKey, bool zeroForOne, uint128 exactAmount, bytes hookData)) -> (amountOut, gasEstimate). Not a view; call it with eth_call / inside Multicall3.
- PositionManager 0x7c5f5a4bbd8fd63184577525326123b519429bdc: poolKeys(bytes25) returns the PoolKey for a poolId's first 25 bytes (for pools with positions). Use it to recover keys for poolIds seen in Swap logs, so you don't have to scan Initialize events from genesis.
- PoolKey = (currency0, currency1, fee, tickSpacing, hooks). Native ETH is currency address(0).
- Events (verify signatures in v4-core IPoolManager): Initialize, Swap(PoolId indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee), ModifyLiquidity.
- Fees: key.fee == 0x800000 marks a dynamic-fee pool (the hook sets the fee, possibly per swap). Effective swap fee combines protocolFee (12 bits per direction) and lpFee (ProtocolFeeLibrary.calculateSwapFee); replicate it exactly per direction.
- Hooks: permission flags are the low 14 bits of the hook address (Hooks.sol). Pools whose hook has BEFORE_SWAP_RETURNS_DELTA or AFTER_SWAP_RETURNS_DELTA, or a dynamic fee, can't be modelled locally. Treat them as quoter-only: price them via V4Quoter, never with local maths.

WHAT TO BUILD
1. src/v4.ts (new): PoolKey <-> PoolId (keccak256 of the ABI-encoded key), hook-flag parsing, the swap-fee calculation, ABIs for StateView / V4Quoter / PositionManager / PoolManager events, and functions the registry can call:
   - describeV4Pools(poolIds, block, chain): recover keys via PositionManager.poolKeys, drop pools you can't model or quote.
   - refreshV4(pools, block, chain): one multicall to StateView (slot0, liquidity, bitmap words around the tick), filling pool.cl so clmath works unchanged.
   - v4SwapToEvent(log): decode a V4 Swap log into the classifier's swap shape (pool = poolId).
   - A quoter call encoder/decoder for scanner verification.
2. Represent a V4 pool as a Pool with address = poolId (0x + 64 hex), kind "univ4", dex "uniswap-v4", plus pool.v4 = { key, nativeEth: boolean, modelledLocally: boolean }. Map native ETH to the WETH address in token0/token1, so cycles through ETH and WETH pools connect. Add the wrap/unwrap gas (about 30k) in the route gas model for hops that touch native ETH.
3. ClState has one feePips. V4's fee can differ by direction, so either add optional per-direction fees to ClState (and use them in clSwapExactIn / clMaxInput / logRate) or compute the effective fee in hopOut. Keep every existing test passing.
4. Hooks into existing files, kept minimal and marked "// v4:" so they're easy to review. pools.ts gets a dispatch for kind "univ4" in discovery and refresh, with no restructuring because the refresh path is being changed in parallel. scanner.ts gets V4 in hopQuoteCall / decodeHopQuote, and a quoter-only path for routes with any V4 hop (RouteExecutor can't execute V4 yet, so never use its simulate() for them). classifier.ts gets one dispatch line calling v4SwapToEvent. config.ts gets a V4 block appended at the end, with a CL_V4=true setting.
5. Design note only, no contract changes: how RouteExecutor would execute a V4 hop (PoolManager.unlock -> unlockCallback -> swap -> settle/take, including native ETH), as docs/v4-execution.md.

TESTS AND ACCEPTANCE
- Unit tests (test/v4.test.js): poolId computation against a known pool, hook-flag parsing, swap-fee calculation for both directions, Swap-log decoding.
- scripts/verify-v4.mjs: with BASE_RPC_URL set, picks at least 10 active V4 pools on Base that are modelled locally. At one pinned block it compares clmath's output with V4Quoter for 10 sizes per pool, inside the tick range. Required result: exact match. Print a table.
- npm run build, npm test and forge test pass.
- A short summary: what works, how many V4 pools discovery now finds on Base, which hook types you excluded and why.

RULES
1. Paper mode only. Nothing you write may send a transaction. No private keys anywhere. Read RPC URLs from the BASE_RPC_URL environment variable and never commit them.
2. On-chain amounts are integers: use BigInt and replicate on-chain rounding exactly. If you can't, mark it approximate and rely on the quoter.
3. No sandwiching, front-running, JIT liquidity, or anything that profits from other users' trades.
4. Don't edit src/main.ts, src/rpc.ts, src/executor.ts, src/liquidations.ts, contracts/RouteExecutor.sol, ui/ or src/ui/. Keep pools.ts, scanner.ts and classifier.ts changes to the small hooks described above.
5. ethers v6 is the only runtime dependency. Don't add others.

ATTACH (only if you can't open the repo): src/pools.ts, src/clmath.ts, src/routes.ts, src/math.ts, src/scanner.ts, src/classifier.ts, src/abi.ts, src/config.ts, src/rpc.ts, test/clmath.test.js, test/routes.test.js
```

---

## 2. Curve and Balancer pools (measure first)

```text
You are helping build base-arb-bot, a TypeScript arbitrage bot for Base (chain id 8453): Node 20, ESM, strict TypeScript, ethers v6. It runs in PAPER mode: it finds arbitrage opportunities, verifies them on-chain with eth_call simulations, and records what would have happened. Repo: github.com/Webbyai69/base-mev-bot-multi-dex-arbitrage (private). Base branch: upgrade/v3-multihop-flashblocks-liquidations. Work on a new branch: agent/curve-balancer.

HOW THE BOT WORKS
- src/pools.ts: PoolRegistry with Pool objects { address, dex, kind, token0, token1 (lowercase), reserve0, reserve1, feePpm, feeModel, cl? } refreshed every block via Multicall3.
- src/routes.ts: findCycles + optimizeRoute. Every hop goes through hopOut(pool, tokenIn, amountIn), which must return the exact on-chain output (BigInt) or null if infeasible. The optimiser assumes profit is concave in the input size.
- src/scanner.ts verifies every hop against an on-chain quoter in one multicall before an opportunity counts.

GOAL
Decide with data whether Curve and Balancer pools on Base are worth adding, and if they are, add them in paper mode.

STEP 0: MEASURE, AND STOP IF IT ISN'T WORTH IT
Using official sources only (Curve and Balancer docs and deployment files, on-chain reads, DefiLlama's public API), list the Curve (stableswap-ng, twocrypto-ng, tricrypto-ng) and Balancer (V2 Vault, V3 Vault) pools on Base with more than $250k TVL whose tokens overlap the bot's tokens (WETH, USDC, USDbC, DAI, cbETH, plus any token with an active Uniswap/Aerodrome pool). Give their 7-day volume too. Write docs/curve-balancer-assessment.md with the table and a recommendation. If fewer than about 10 such pools exist, or their combined volume is under about 5% of Uniswap + Aerodrome volume on the same tokens, STOP here and deliver only the report.

IF WORTH IT: WHAT TO BUILD
1. src/curve.ts and src/balancer.ts (new): discovery of the pools from step 0, per-block state refresh in one multicall, and hopOut-compatible maths.
   - Curve stableswap(-ng): port get_dy exactly from the pool's Vyper source (A with ramping, rates for each coin, fee and offpeg multiplier in -ng, Newton iterations with the same integer rounding). Exactness is required.
   - Balancer weighted pools: porting LogExpMath exactly is hard. Implement a float model for the route search and mark the pool approximate (pool.approximate = true). The scanner must then size approximate routes with on-chain queries: Balancer V2 Vault.queryBatchSwap or the V3 Router query functions via eth_call. Evaluate about 5 sizes, keep the best, and use the quoted amounts as the final numbers.
2. Minimal hooks marked "// curve:" / "// balancer:" in pools.ts (dispatch only, because the refresh path is being restructured in parallel), routes.ts (hopOut dispatch), scanner.ts (quoter calls; sizing via on-chain queries for approximate pools), and classifier.ts (decode their swap events so "taken" detection works). New settings go in an appended block at the end of config.ts: CURVE=true, BALANCER=true.
3. Execution design note only (docs/curve-balancer-execution.md): how RouteExecutor would execute these hops. Don't edit the contract.

TESTS AND ACCEPTANCE
- Unit tests: Curve get_dy against recorded on-chain values for at least 3 pools; Balancer float model within 0.1% of on-chain queries.
- scripts/verify-curve-balancer.mjs (BASE_RPC_URL, pinned block): exact match for Curve, documented error for Balancer.
- npm run build, npm test and forge test pass.

RULES
1. Paper mode only. No transactions, no private keys; read BASE_RPC_URL from the environment and never commit it.
2. BigInt and exact on-chain rounding wherever you claim exactness.
3. No sandwiching, front-running or JIT liquidity.
4. Don't edit src/main.ts, src/rpc.ts, src/executor.ts, src/liquidations.ts, contracts/RouteExecutor.sol, ui/ or src/ui/. Keep edits to shared files to the small hooks above.
5. ethers v6 only for runtime dependencies.

ATTACH (only if you can't open the repo): src/pools.ts, src/routes.ts, src/math.ts, src/scanner.ts, src/classifier.ts, src/config.ts, src/abi.ts
```

---

## 3. Split-trade optimisation

```text
You are helping build base-arb-bot, a TypeScript arbitrage bot for Base (chain id 8453): Node 20, ESM, strict TypeScript, ethers v6. It runs in PAPER mode: it finds arbitrage opportunities, verifies them on-chain with eth_call simulations, and records what would have happened. Repo: github.com/Webbyai69/base-mev-bot-multi-dex-arbitrage (private). Base branch: upgrade/v3-multihop-flashblocks-liquidations. Work on a new branch: agent/split-trades.

HOW THE BOT WORKS
- Pools: src/pools.ts. A Pool is { address, dex, kind, token0, token1, reserve0, reserve1, feePpm, feeModel "ppm"|"bps", cl?: ClState }. src/math.ts has exact constant-product maths (fee on input; "ppm" Uniswap V2 style, "bps" Aerodrome style). src/clmath.ts has exact concentrated-liquidity maths inside one tick range: clSwapExactIn returns null past the next initialized tick, and clMaxInput gives the in-range capacity.
- src/routes.ts: findCycles + optimizeRoute handle one pool per hop. src/scanner.ts turns routes into Opportunity records. Opportunity has route?: { tokens, pools, dexes, amounts, label, executorHops }, hops (number of swaps), sim (verification status), profit/profitUsd/gasUsd/netUsd. It verifies each hop with the DEX's quoter (verifyRoutes).
- src/paper.ts: PaperEngine records each opportunity and re-prices it 1-2 blocks later (repriceUsd) to decide persisted / taken / closed.

GOAL
When one token pair trades on three or more pools, the best trade often buys from several cheap pools at once and sells into one or more dear pools. Today the bot takes one buy pool and one sell pool. Add an optimiser for these split trades and report them in paper mode next to the existing routes, so we can measure how much they add.

THE MATHS (the shape of the solution; derive and verify the details)
- Work on one pair (start token X, e.g. WETH or USDC; other token Y). For a fee-on-input constant-product pool with reserves (x, y) and r = 1 - fee, paying dx of X gives dy = r*dx*y/(x + r*dx). The marginal cost of Y in X after paying dx is (x + r*dx)^2 / (r*x*y). For a given marginal price q you get a closed form for the dx that moves the pool to q; selling Y into a pool is the mirror image. CL pools in range behave like constant-product pools on virtual reserves (L/sqrtP, L*sqrtP), capped at clMaxInput.
- For a common marginal price q, B(q) = total Y bought from all pools cheaper than q, and S(q) = total Y sold into all pools dearer than q. B rises with q and S falls, so bisect for q* where B(q*) = S(q*). Profit in X = X received from the sells - X paid to the buys.
- Then make it exact. Compute integer amounts per pool with the exact formulas, balance the Y bought and sold exactly (rounding dust stays in the contract as a tiny loss, so account for it), re-evaluate profit with the exact per-pool functions, and polish with a 1-D search on an overall scale factor. Respect CL capacity caps throughout.
- Keep a split only if its exact profit, minus the gas for its extra legs, beats the best single route on the same pools.

WHAT TO BUILD
1. src/split.ts (new): findSplitTrades(pools, startTokens, opts) -> SplitQuote[] where SplitQuote = { tokenIn, tokenMid, buys: Leg[], sells: Leg[], profit } and Leg = { pool, amountIn, amountOut }. Pure maths, no ethers import (like routes.ts and clmath.ts), fully unit-tested.
2. Opportunity support: an optional split field { buys, sells } on Opportunity (scanner.ts) and a gas model (base + per leg, using the existing GAS_* settings). Per-leg quoter verification reuses hopQuoteCall. Paper re-pricing of a split goes in paper.ts. The report and digest label a split as e.g. "WETH/AERO split 2>1". Mark scanner.ts, paper.ts and digest.ts changes "// split:".
3. A SPLIT_TRADES=true setting in an appended block at the end of config.ts.
4. Contract design note only (docs/split-execution.md): a proposed executeSplit for RouteExecutor that does the buys, then the sells, with explicit per-leg amounts under one flash loan. Don't edit the contract; it is being changed in parallel.

TESTS AND ACCEPTANCE
- test/split.test.js covers three-, four- and five-pool scenarios (CP and CL mixed). The optimiser must be within 0.1% of a brute-force grid search. Splits must never beat the exact re-evaluation, and CL caps must be respected. Two equal pools must produce no trade.
- A paper-mode run shows split opportunities with sim = quoter-ok.
- npm run build, npm test and forge test pass.

RULES
1. Paper mode only. No transactions and no private keys; read BASE_RPC_URL from the environment if you need an RPC, and never commit it.
2. BigInt and exact on-chain rounding for every amount you report.
3. No sandwiching, front-running or JIT liquidity.
4. Don't edit src/main.ts, src/rpc.ts, src/pools.ts, src/executor.ts, src/classifier.ts, src/liquidations.ts, contracts/RouteExecutor.sol, ui/ or src/ui/.
5. ethers v6 only for runtime dependencies.

ATTACH (only if you can't open the repo): src/math.ts, src/clmath.ts, src/routes.ts, src/scanner.ts, src/paper.ts, src/digest.ts, src/config.ts, test/routes.test.js, test/clmath.test.js
```

---

## 4. Aave liquidation executor contract

```text
You are helping build base-arb-bot, a TypeScript arbitrage bot for Base (chain id 8453): Node 20, ESM, strict TypeScript, ethers v6, Solidity 0.8.26 contracts tested with Foundry. It runs in PAPER mode: it finds opportunities, verifies them on-chain with eth_call simulations, and records what would have happened. Repo: github.com/Webbyai69/base-mev-bot-multi-dex-arbitrage (private). Base branch: upgrade/v3-multihop-flashblocks-liquidations. Work on a new branch: agent/aave-liquidator.

HOW THE BOT WORKS
- src/liquidations.ts: LiquidationMonitor watches Aave V3 borrowers on Base and checks health factors. For HF < 1 it picks the largest debt and collateral reserves and estimates profit with Aave's rules: close factor 100% if HF <= 0.95 or either side < $2,000, else 50%; repay = min(debt x close factor, collateral / bonus); minus Aave's protocol share of the bonus, a flat swap-cost assumption and gas. It records liq-opportunity records and later their outcomes (taken / recovered / open). Everything is in USD; nothing is simulated on-chain yet.
- contracts/RouteExecutor.sol is the pattern to copy: Morpho Blue flash loan (free) or Balancer V2 flash loan, swaps through hop kinds 0 (Uniswap V2 ppm fee), 1 (Aerodrome, uses pool.getAmountOut), 2 (Uniswap V3 / Slipstream via uniswapV3SwapCallback) and 3 (V2 bps fee). simulate() always reverts with Simulated(profit), so the bot can run it with eth_call and a state override (scripts/build-bytecode.cjs makes the runtime bytecode). test/forge/RouteExecutor.t.sol has EVM tests with mocks; reuse its mocks.
- Roles: RouteExecutor is getting an owner/operator split in parallel. The owner (a cold wallet) can withdraw, setOperator and transferOwnership. The operator (the bot's hot key) can only execute. Use the same pattern: errors NotOwner / NotOperator, with the owner also allowed to execute.

FACTS (Aave V3 on Base, from bgd-labs/aave-address-book; verify anything else in aave-v3-origin source)
- Pool 0xA238Dd80C259a72e81d7e4664a9801593F98d1c5, PoolDataProvider 0x0F43731EB8d45A581f4a36DD74F5f358bc90C73A, Oracle 0x2Cc0Fc26eD4563A5ce5e8bdcfe1A2878676Ae156.
- liquidationCall(collateralAsset, debtAsset, user, debtToCover, receiveAToken). The liquidator must approve debtAsset to the Pool first. Use receiveAToken = false to get the underlying collateral.
- v3.3+ rules: close factor as above, plus a dust rule. A partial liquidation that would leave less than $1,000 of debt or collateral reverts, so liquidate in full or leave at least $1,000. Check the exact constants in LiquidationLogic.sol.
- Morpho Blue 0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb: flashLoan(token, assets, data) calls onMorphoFlashLoan(assets, data) and then pulls repayment with transferFrom (approve it). Balancer V2 Vault 0xBA12222222228d8Ba445958a75a0704d566BF2C8.

WHAT TO BUILD
1. contracts/AaveLiquidator.sol (new, standalone, 0.8.26, cancun). Flow: flash-borrow debtToCover of debtAsset -> approve the Pool -> liquidationCall(...) -> swap all the collateral received into debtAsset through the given hops (same hop kinds and validation as RouteExecutor) -> repay the flash loan -> profit = growth in the debtAsset balance -> require profit >= minProfit. Handle collateral == debt (no swap needed). simulate(...) reverts Simulated(profit). Owner/operator roles as above. withdraw(token, amount) sends to the owner only. Strict callback checks (expectedCaller pattern).
2. test/forge/AaveLiquidator.t.sol. Use a MockAavePool whose liquidationCall pulls the debt and sends collateral = debtToCover x price x bonus, plus the DEX/Morpho/Balancer mocks copied from RouteExecutor.t.sol into test/forge/mocks/. Cover: profitable via Morpho, via Balancer, same-asset, minProfit guard, simulate == execute, only owner/operator, stranger callbacks revert, owner-only withdraw.
3. add LiquidatorExecutor to scripts/build-bytecode.cjs -> src/simBytecodeLiquidator.ts.
4. src/liquidations.ts, evaluate/record path only (the log-fetch plumbing in this file is being changed in parallel). For each candidate:
   - convert repay USD into debt-token units with the oracle price;
   - build the collateral -> debt swap route from the PoolRegistry: best direct pool, or two hops via WETH. Take the registry as a new optional constructor argument, and describe the one-line wiring needed in main.ts;
   - simulate with eth_call + state override at the candidate's block, trying several debtToCover fractions (respecting the close factor and the dust rule) and keeping the best;
   - record sim ("executor-ok" | "executor-revert" | "unpriced"), simulatedProfitUsd and the chosen fraction on the liq-opportunity record. "Realistic profit" in liquidationSummary should use simulated profit when it's available.
5. A short docs/liquidator-review.md: threat model (reentrancy, callback spoofing, approvals left behind, griefing), what the tests cover, and what a real audit should check.

ACCEPTANCE
- forge test passes, with the new tests; npm run build and npm test pass.
- With BASE_RPC_URL set, a script (scripts/liquidator-fork-check.mjs) forks Base at a block where a known liquidation happened, ideally one found by the bot's LiquidationCall log reading. It shows our simulate() at the previous block returns a profit within 5% of what the real liquidator made.

RULES
1. Paper mode only. Nothing you write may send a transaction. No private keys anywhere; read BASE_RPC_URL from the environment and never commit it.
2. BigInt and exact on-chain rounding for every amount.
3. No sandwiching, front-running or JIT liquidity. Liquidations are fine.
4. Don't edit src/main.ts, src/rpc.ts, src/pools.ts, src/executor.ts, src/classifier.ts, contracts/RouteExecutor.sol, ui/ or src/ui/.
5. ethers v6 only for runtime dependencies.

ATTACH (only if you can't open the repo): contracts/RouteExecutor.sol, test/forge/RouteExecutor.t.sol, scripts/build-bytecode.cjs, src/liquidations.ts, src/scanner.ts (state-override simulation pattern), src/routes.ts, src/abi.ts, src/config.ts, foundry.toml
```

---

## 5. Encrypted key store

```text
You are helping build base-arb-bot, a TypeScript arbitrage bot for Base (chain id 8453): Node 20, ESM, strict TypeScript, ethers v6. Repo: github.com/Webbyai69/base-mev-bot-multi-dex-arbitrage (private). Base branch: upgrade/v3-multihop-flashblocks-liquidations. Work on a new branch: agent/keystore. The owner runs it on Windows 11 in PowerShell.

TODAY
Live mode (MODE=live, not used yet) reads PRIVATE_KEY in plain text from .env. src/executor.ts builds new Wallet(privateKey, chain.provider). That key is a hot key: it can only execute trades through the bot's contracts, and the owner (a separate cold wallet) withdraws profits. It still must never sit in plain text on disk.

GOAL
Replace the plain-text key with an encrypted keystore and a password prompt, with a smooth migration and no way to print the key by accident.

WHAT TO BUILD
1. src/keystore.ts (new):
   - createKeystore({ password, privateKey? }): a new random key (Wallet.createRandom) or an imported one, encrypted with ethers' standard JSON keystore (scrypt; keep ethers' default strength for real files).
   - saveKeystore(json, path): by default to %USERPROFILE%\.base-arb-bot\keystore.json, outside the repo. Never overwrite an existing file without an explicit --force.
   - loadSigner({ keystorePath, password }): returns an ethers Wallet; a clear error on a wrong password.
   - promptPassword(question): reads a password without echoing it (raw-mode stdin on a TTY; works in Windows PowerShell and cmd). Supports KEYSTORE_PASSWORD_FILE for unattended runs, printing a warning that the file must be outside the repo.
   - loadLiveSigner(settings): the single entry point main.ts will call. Order: KEYSTORE_PATH (prompt or password file) -> legacy PRIVATE_KEY (allowed, with a loud warning every start telling the owner to migrate) -> error.
2. src/keystore-cli.ts (new), run with: node dist/keystore-cli.js <command>
   - new: create a fresh hot wallet; print its ADDRESS only; save the keystore.
   - import: read a private key from a hidden prompt (or the PRIVATE_KEY in .env with --from-env) and save the keystore. Then tell the owner to delete the PRIVATE_KEY line from .env, and offer to do it after a yes/no confirmation.
   - address: print the keystore's address (asks for the password).
   - verify: decrypt and confirm the password works, without printing the key.
   No command ever prints a private key or mnemonic. There is no "export" command.
3. Config (an appended block at the end of src/config.ts only): KEYSTORE_PATH, KEYSTORE_PASSWORD_FILE.
4. .gitignore: add keystore*.json and *.keystore.
5. README section "Keys": why the bot's hot key differs from the owner's cold wallet, how to create and migrate, how unattended runs work, and how to rotate a key (new keystore -> set the new operator on the contracts -> retire the old one).
6. Integration note (don't edit main.ts or executor.ts; they are being changed in parallel). Describe exactly what changes: LiveExecutor should accept a Wallet instead of a private-key string, and main.ts should call loadLiveSigner(settings) only when MODE=live.

TESTS AND ACCEPTANCE
- test/keystore.test.js: create -> save -> load round trip (use low scrypt parameters in tests only), wrong password rejected, no secret ever written to stdout or stderr (capture both and assert), password-file path works, refuses to overwrite.
- npm run build and npm test pass.

RULES
1. Never print, log or return a private key or mnemonic, in code, tests or your answer.
2. Never send transactions.
3. ethers v6 only for runtime dependencies (Node built-ins are fine).
4. Don't edit src/main.ts, src/executor.ts, src/rpc.ts, src/pools.ts, contracts/, ui/ or src/ui/.

ATTACH (only if you can't open the repo): src/config.ts, src/executor.ts, src/main.ts (read only), .env.example, .gitignore, package.json, tsconfig.json
```

---

## 6. Tests against a copy of real Base pools, gas calibration and CI

```text
You are helping build base-arb-bot, a TypeScript arbitrage bot for Base (chain id 8453): Node 20, ESM, strict TypeScript, ethers v6, Solidity 0.8.26 contracts tested with Foundry. It runs in PAPER mode. Repo: github.com/Webbyai69/base-mev-bot-multi-dex-arbitrage (private). Base branch: upgrade/v3-multihop-flashblocks-liquidations. Work on a new branch: agent/fork-tests.

WHY
The bot's maths (src/math.ts for V2/Aerodrome, src/clmath.ts for Uniswap V3/Slipstream) is unit-tested against formulas, and contracts/RouteExecutor.sol is tested against mocks (test/forge/RouteExecutor.t.sol). Neither has been checked against real Base pools. Prove both against a fork of Base mainnet, measure real gas, and add CI.

WHAT TO BUILD
1. Exactness check (scripts/verify-exactness.mjs, run after npm run build). Use BASE_RPC_URL (an env variable; never commit it) and an optional FORK_BLOCK (default: latest minus 5, then pinned for the whole run):
   - load pools the way the bot does: PoolRegistry from dist/pools.js, discover() or the saved data/pools.json, then refreshReserves(pools, block);
   - for at least 20 V2-style, 10 Aerodrome, 15 Uniswap V3 and 10 Slipstream pools, compute outputs for 10 sizes each (from 1e-6 of reserves up to the CL in-range capacity) with the bot's own functions (poolAmountOut / clSwapExactIn);
   - compare each with the DEX's on-chain quote at the same block (V2 router getAmountsOut, Aerodrome pool getAmountOut, Uniswap QuoterV2 / Slipstream quoter quoteExactInputSingle, as in src/scanner.ts hopQuoteCall);
   - print a table and write reports/exactness-<block>.json. Expected result: zero mismatches. For any mismatch, find the cause and report it. Don't "fix" it by loosening the comparison.
2. RouteExecutor fork tests (test/fork/RouteExecutor.fork.t.sol, Foundry, vm.createSelectFork(BASE_RPC_URL, FORK_BLOCK)). Skip cleanly when BASE_RPC_URL isn't set. forge-std may be added as a lib if you prefer.
   - Find real pools through their factories at runtime (Uniswap V3 factory 0x33128a8fC17869897dcE68Ed026d694621f6FDfD getPool(WETH, USDC, 500); the Aerodrome factory in src/config.ts). Don't hard-code pool addresses.
   - Create a real price gap: vm.deal a test account, wrap ETH to WETH (0x4200000000000000000000000000000000000006), swap a large amount through one pool, then check that a two-hop route back through another pool simulates with Simulated(profit > 0). Do this for a Morpho flash loan (real Morpho Blue at 0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb) and a Balancer V2 flash loan (real vault 0xBA12222222228d8Ba445958a75a0704d566BF2C8).
   - Execute the same route as the owner and assert the realised profit equals the simulated profit. Do a three-hop route (V2 -> Aerodrome -> V3) as well.
   - RouteExecutor has an owner/operator split: the deployer is the owner (withdraws, sets the operator); the operator or the owner may call execute(). Cover both, plus a stranger being refused.
3. Gas calibration: from the fork runs, record the gas used by execute() for two- and three-hop routes with V2-only, CL-only and mixed hops, with each flash-loan source. Recommend values for GAS_ROUTE_BASE, GAS_HOP_V2 and GAS_HOP_CL (src/config.ts defaults: 70000 / 75000 / 115000) in docs/gas-calibration.md. Don't change the defaults yourself.
4. CI (.github/workflows/test.yml): on push and PR, Node 20, npm ci, npm run build, npm test, then Foundry (foundry-rs/foundry-toolchain) with forge test --no-match-path "test/fork/*". Add a second job that runs the fork tests only when a BASE_RPC_URL repository secret exists.

ACCEPTANCE
- The exactness report shows zero mismatches, or every mismatch is explained with a root cause.
- Fork tests pass, and simulated profit equals executed profit to the wei.
- CI is green on your branch.

RULES
1. Fork tests only: never broadcast to Base mainnet. No real private keys; use Foundry test accounts only.
2. Never commit RPC URLs or keys; read them from the environment.
3. Don't edit src/ (except fixing a bug you can prove; describe it and keep it small), contracts/RouteExecutor.sol, ui/ or src/ui/. New files go in scripts/, test/fork/, docs/ and .github/.

ATTACH (only if you can't open the repo): contracts/RouteExecutor.sol, test/forge/RouteExecutor.t.sol, foundry.toml, src/math.ts, src/clmath.ts, src/pools.ts, src/scanner.ts, src/config.ts, package.json
```

---

## 7. Opportunity history, near misses and size curves

```text
You are helping build base-arb-bot, a TypeScript arbitrage bot for Base (chain id 8453): Node 20, ESM, strict TypeScript, ethers v6. It runs in PAPER mode. Repo: github.com/Webbyai69/base-mev-bot-multi-dex-arbitrage (private). Base branch: upgrade/v3-multihop-flashblocks-liquidations. Work on a new branch: agent/opportunity-history.

WHY
The dashboard (src/ui/server.ts + ui/dashboard.html) shows the last 40 opportunities and since-start counters of where candidates drop out (Scanner.funnel in src/scanner.ts: gasAteIt, belowMin, muted, overlapping, reverted, quoteMismatch, verified...). To decide what to improve next we need history: search every recorded opportunity, see "near misses" that just failed the minimum, and see how profit changes with trade size.

HOW THE DATA LOOKS
- data/opportunities.jsonl: one JSON object per line. kind "opportunity" (an Opportunity from src/scanner.ts plus mode) and kind "outcome" (src/paper.ts OutcomeRecord: id, status persisted|taken|closed, realisticNetUsd, takenBy). bigints are stored as decimal strings. Files grow to hundreds of MB, so never load a whole file into memory at once; stream it (Store.read in src/store.ts) or index it.
- Day = the UTC date of foundAt.

WHAT TO BUILD
1. src/history.ts: class OpportunityIndex(store). It builds a compact in-memory index by streaming opportunities.jsonl once, then follows new records through store.onAppend (src/store.ts). query({ from?, to?, pair?, dex?, kind?: "classic"|"cl"|"triangular", status?, sim?, minNetUsd?, limit, offset }) returns { total, rows } with rows slimmed the way UiServer.slimOpp does (no bigints, legs with token symbols). Memory budget: under 200 bytes per opportunity in the index; full records are re-read from the file by byte offset when a page of rows is returned.
2. Near misses: in src/scanner.ts, where a candidate is dropped for gas or the minimum (the priceOut helper in scan()), keep at most 5 per block with the best net value, and append them to data/near-misses.jsonl as { block, at, code: "NET_NEGATIVE_AFTER_GAS"|"NET_PROFIT_TOO_LOW", pairSymbols, dexes, amountIn, profitUsd, gasUsd, netUsd }. Only when NEAR_MISSES=true (default false) and only candidates whose net is within 50% of MIN_PROFIT_USD. Use the same codes as FUNNEL_STAGES in src/digest.ts.
3. Size curves: give optimizeRoute in src/routes.ts an optional callback that receives every (amountIn, profit) pair it evaluates. In the scanner, keep up to 12 evenly spread samples per recorded opportunity as sizeCurve: Array<[amountIn: string, profitUsd: number]>. This is what shows sizing bugs.
4. Tests (node:test, test/history.test.js) with a generated 50k-line file: correct totals per filter, paging, offsets stable while new records are appended, memory per record under the budget.
5. A short WIRING.md section: how Claude should expose OpportunityIndex as GET /api/opportunities in src/ui/server.ts and draw sizeCurve in the opportunity detail. Don't edit src/ui/ or ui/ yourself.

RULES
1. Paper only: nothing here may send a transaction.
2. Don't edit src/main.ts, src/rpc.ts, src/ui/, ui/, src/executor.ts or contracts/. In src/scanner.ts and src/routes.ts keep changes small and behind the new options.
3. The extra work per block must stay under 2 ms with 400 pools (measure it and say so).

ATTACH (only if you can't open the repo): src/scanner.ts, src/routes.ts, src/paper.ts, src/store.ts, src/digest.ts, src/ui/server.ts
```

---

## 8. Why did a rival get it? Replay and classify missed trades

```text
You are helping build base-arb-bot, a TypeScript arbitrage bot for Base (chain id 8453): Node 20, ESM, strict TypeScript, ethers v6. It runs in PAPER mode. Repo: github.com/Webbyai69/base-mev-bot-multi-dex-arbitrage (private). Base branch: upgrade/v3-multihop-flashblocks-liquidations. Work on a new branch: agent/miss-replay.

WHY
src/classifier.ts records every arbitrage other bots land on Base (data/mev.jsonl: block, txHash, bot, pools, dexes, tokens, profitUsd). The dashboard already shows whether those trades used pools our bot watches. A rival trade isn't automatically "profit we missed": it may depend on ordering, inventory or access we don't have. We need a defensible, repeatable classification of why our bot didn't have each one, so the next engineering task is obvious.

WHAT TO BUILD
scripts/replay-misses.mjs (run after npm run build; reads RPC_URL from .env; needs an RPC that serves historical state for recent blocks, so check that first and stop with a clear message if it doesn't). For a day (default: yesterday UTC), take up to MAX_REPLAYS (default 200) rival arbitrages from data/mev.jsonl, and for each:
1. Rebuild the state of its pools at block N-1 (the state the rival saw) with the bot's own code: PoolRegistry from dist/pools.js (addPoolsByAddress, then refreshReserves(pools, N - 1)).
2. Classify into exactly one of:
   - COVERAGE: at least one pool wasn't in our watch list at that time (data/pools.json snapshot history if available, otherwise "not watched now").
   - PROTOCOL: a pool type the bot can't model (Uniswap V4, Curve, Balancer, anything unknown).
   - ROUTE_SEARCH: all pools supported and watched, but the route's shape is outside what findCycles searches (more than MAX_HOPS hops, a start token other than WETH/USDC, or pruned by minLogEdge).
   - PRICING: the bot's maths for the route at N-1 disagrees with the DEX quoters at N-1 by more than 0.1%.
   - ECONOMICS: the route was there at N-1 but our gas model makes it net-negative or below MIN_PROFIT_USD (report the gap).
   - TIMING: the route was profitable for us at N-1 and our paper engine recorded it too (match data/opportunities.jsonl by pools and block): we saw it and lost the race. Report their priority fee vs ours.
   - UNKNOWN: anything that doesn't fit; say why.
3. Write reports/misses-<day>.md (counts per class, top 20 uncovered pools with how often they appeared, top routes by lost profit) and reports/misses-<day>.json. The daily AI review will read the Markdown file, so keep it under 10 KB.
4. Cap RPC use: at most 15 calls per replay, and print the total at the end.
5. Tests with recorded fixtures (no network): one case per class.

RULES
1. Read-only: eth_call and eth_getLogs only; never send a transaction.
2. Never commit RPC URLs or keys.
3. Don't edit src/; import from dist/. If you need a hook in src/, describe it in WIRING.md for Claude.

ATTACH (only if you can't open the repo): src/classifier.ts, src/pools.ts, src/routes.ts, src/scanner.ts, src/config.ts, src/paper.ts
```
