# Compound III liquidator (registry id `compound-liquidator`), Phase 3

Status: **detect mode only.** A monitor that finds absorbable Compound III accounts on Base
(Ethereum and Arbitrum when you add their RPC URLs) and a draft flash-liquidation contract
with tests. Nothing is deployed, nothing is signed, nothing is sent.

## How Compound III liquidation works

Comet has no "repay and seize" call like Aave or Morpho. It is two permissionless steps:

1. **`absorb(absorber, accounts)`**: when `isLiquidatable(account)` is true, anyone can make
   the protocol take the account over. The debt is written off against protocol reserves and
   the collateral becomes the protocol's. The absorber gets no payment, only "liquidator
   points" (gas is the cost).
2. **`buyCollateral(asset, minAmount, baseAmount, recipient)`**: while the protocol's reserves
   are below `targetReserves`, anyone can buy that collateral with the base token at a
   discount (`quoteCollateral(asset, baseAmount)` tells you how much you get). The discount is
   `storeFrontPriceFactor × (1 − liquidationFactor)` below the oracle price, typically a few
   percent.

So the profit is the discount on step 2, minus the swap back to the base token, minus gas.
Step 2 is open whenever reserves are under target, so collateral the protocol **already holds**
can be bought too; the monitor prices that separately (`forSaleUsd`).

## What is in this PR

| Path | What |
|---|---|
| `bots/compound-liquidator/monitor/monitor.ts` | the detect loop (entry point) |
| `bots/compound-liquidator/monitor/markets.ts` | chains, Comet addresses, gas model, defaults |
| `bots/compound-liquidator/monitor/estimate.ts` | discount, USD value, gas, profit, metrics file (pure, tested) |
| `bots/compound-liquidator/monitor/rpc.ts` | JSON-RPC client that refuses every non-read method |
| `bots/compound-liquidator/monitor/abi.ts` | selectors, topics, Multicall3 encoding (no dependencies) |
| `bots/wrapper/configs/compound-liquidator.json` | wrapper config: `detect` only, `paper` and `live` empty |
| `contracts/fleet/CompoundLiquidator.sol` | **draft** absorb + flash buy + swap + repay contract |
| `test/forge/fleet/CompoundLiquidator.t.sol` | mock-market tests incl. the leaked-operator drain attempt |
| `test/forge/fleet/CompoundLiquidatorFork.t.sol` | Base-fork tests, skipped unless `FORK_URL` is set |
| `test/fleet-compound.test.js` | monitor tests incl. a full run against a fake Base node |

### Clean room

Comet is GPL-2.0-or-later now (BUSL change date passed). From `bots/upstream/comet` we read
only the interface (`CometMainInterface.sol`, `CometExtInterface.sol`, the `AssetInfo` struct)
and the `deployments/<chain>/<market>/roots.json` files for addresses. Every line of the
monitor and the contract is our own and MIT. The forge tests use our own toy market model,
not Comet code.

## The monitor

Per chain, in order:

1. `eth_chainId` must match; every Comet address must have code and answer `baseToken()`,
   `baseTokenPriceFeed()`, `baseScale()`, `numAssets()`. A market that does not is dropped and
   logged (`market.dropped`), never used.
2. Borrowers come from `Withdraw` (`src`) and `SupplyCollateral` (`dst`) logs. The first run
   backfills about 30 days on Base and Ethereum, 9 days on Arbitrum; after that it follows new
   blocks. Known borrowers and the last block are kept in
   `data/fleet/compound-liquidator.state.json`, so a restart does not backfill again.
3. Every `checkEveryBlocks` (Base 2, Ethereum 1, Arbitrum 20) it calls `isLiquidatable` for
   every borrower through Multicall3 (250 calls per request).
4. For each absorbable account it reads `collateralBalanceOf` per asset, prices it with
   `getPrice`, takes the discount from `quoteCollateral` versus the oracle price, subtracts
   `COMPOUND_SWAP_COST_BPS` (default 30 bps) for the swap back and the gas of absorb + flash
   buy + swap at the current gas price. If reserves are at target, buying is closed and the
   find is reported with gross $0 (absorb alone only costs gas).
5. It writes `data/fleet/compound-liquidator.fleet-metrics.json` for the wrapper, logs each
   new absorbable account once as a JSON line, and appends it to
   `data/fleet/compound-liquidator.finds.jsonl`.

Fleet card: `routes` are collateral/base pairs (e.g. `WETH/USDC`, venue `base-usdc`, or
`base-usdc:reserves` for collateral already for sale) with the estimated net USD; `metrics`
are `borrowersWatched`, `absorbable`, `bestUsd`, `forSaleUsd`, `markets`, `detectMs`.
`pnlUsd`, `sends` and `gasUsd` stay 0 in detect mode.

**It cannot send.** There is no key and no signer; `rpc.ts` rejects everything except
`eth_chainId`, `eth_blockNumber`, `eth_call`, `eth_getLogs`, `eth_getCode`, `eth_gasPrice`
before any request leaves the process, and only `--mode detect` exists. Logs show the RPC
host only, never the URL path (where providers put keys).

### Settings (bots/wrapper/.env or the wrapper config's `env.detect`)

| Variable | Default | Meaning |
|---|---|---|
| `BASE_RPC_URL` | none (needed) | Base RPC. Same name the Morpho adapter uses. |
| `ETHEREUM_RPC_URL`, `ARBITRUM_RPC_URL` | none | needed only if those chains are in `COMPOUND_CHAINS` |
| `COMPOUND_CHAINS` | `base` | e.g. `base,ethereum,arbitrum` (set in the wrapper config, which wins over `.env`) |
| `COMPOUND_SWAP_COST_BPS` | 30 | pool fee + price impact assumed for the swap back |
| `COMPOUND_BACKFILL_BLOCKS_<CHAIN>` | 1,300,000 / 216,000 / 3,000,000 | first-run log window |
| `COMPOUND_LOG_CHUNK_<CHAIN>` | 9,000 / 5,000 / 50,000 | blocks per `eth_getLogs` (halves itself on provider errors) |
| `COMPOUND_CHECK_EVERY_BLOCKS_<CHAIN>` | 2 / 1 / 20 | sweep cadence |
| `COMPOUND_POLL_MS` | 1500 | how often it looks for a new block |
| `ETH_USD` | none | fallback ETH price if no USD market lists WETH |

Known limits: borrowers older than the backfill window who never touch the market again are
missed until you raise `COMPOUND_BACKFILL_BLOCKS_<CHAIN>` once; the gas model is a fixed
estimate per call, not an `eth_estimateGas`; the profit assumes we buy all of an account's
collateral of each kind and sell it at the oracle price minus the swap cost.

## Comet addresses and sources

All from `compound-finance/comet` @ `f766f51`, `deployments/<network>/<market>/roots.json`,
key `comet`. The cloud session that wrote this could not reach any public RPC (egress
blocked), so `eth_getCode` was **not** run here; the monitor runs that check itself at every
start and drops a market without code. The Base fork test checks the USDC market's code and
base token.

| Market id | Chain | Comet proxy | roots.json |
|---|---|---|---|
| base-usdc | Base 8453 | `0xb125E6687d4313864e53df431d5425969c15Eb2F` | deployments/base/usdc |
| base-weth | Base | `0x46e6b214b524310239732D51387075E0e70970bf` | deployments/base/weth |
| base-usdbc | Base | `0x9c4ec768c28520B50860ea7a15bd7213a9fF58bf` | deployments/base/usdbc |
| base-aero | Base | `0x784efeB622244d2348d4F2522f8860B96fbEcE89` | deployments/base/aero |
| base-usds | Base | `0x2c776041CCFe903071AF44aa147368a9c8EEA518` | deployments/base/usds |
| eth-usdc | Ethereum 1 | `0xc3d688B66703497DAA19211EEdff47f25384cdc3` | deployments/mainnet/usdc |
| eth-weth | Ethereum | `0xA17581A9E3356d9A858b789D68B4d866e593aE94` | deployments/mainnet/weth |
| eth-usdt | Ethereum | `0x3Afdc9BCA9213A35503b077a6072F3D0d5AB0840` | deployments/mainnet/usdt |
| eth-wsteth | Ethereum | `0x3D0bb1ccaB520A66e607822fC55BC921738fAFE3` | deployments/mainnet/wsteth |
| eth-usds | Ethereum | `0x5D409e56D886231aDAf00c8775665AD0f9897b56` | deployments/mainnet/usds |
| eth-wbtc | Ethereum | `0xe85Dc543813B8c2CFEaAc371517b925a166a9293` | deployments/mainnet/wbtc |
| arb-usdc | Arbitrum 42161 | `0x9c4ec768c28520B50860ea7a15bd7213a9fF58bf` | deployments/arbitrum/usdc |
| arb-usdc.e | Arbitrum | `0xA5EDBDD9646f8dFF606d7448e414884C7d905dCA` | deployments/arbitrum/usdc.e |
| arb-usdt | Arbitrum | `0xd98Be00b5D27fc98112BdE293e487f8D4cA57d07` | deployments/arbitrum/usdt |
| arb-weth | Arbitrum | `0x6f7D514bbD4aFf3BcD1140B7344b32f063dEe486` | deployments/arbitrum/weth |

(base-usdbc and arb-usdc share an address: same deployer and nonce on two chains.)

Other addresses used: Multicall3 `0xcA11bde05977b3631167028862bE2a173976CA11` (same on all
three chains); Morpho Blue `0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb` on Base and Ethereum
(as in `contracts/LiquidationExecutor.sol`); USDC on Base
`0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`; WETH on Base `0x4200…0006`.

Function selectors and event topics are re-derived in `test/fleet-compound.test.js` with an
independent keccak. To re-check by hand: `cast sig "isLiquidatable(address)"`,
`cast keccak "SupplyCollateral(address,address,address,uint256)"`.

## Run it in detect mode on the Windows PC

Needs Node 22.18 or newer (`node -v`; it runs the `.ts` files directly) and Python 3 for the
wrapper. In PowerShell, in the bot folder:

```powershell
git fetch origin
git switch fleet/compound-liquidator      # or pull the base branch after the PR is merged
node --test test/fleet-compound.test.js   # 11 tests, no network needed
```

1. Joshua: add `BASE_RPC_URL=` to `bots\wrapper\.env` (the template is
   `bots\wrapper\.env.example`). The monitor makes about one Multicall per market every two
   blocks plus one `eth_getLogs` per market per sweep; the first run backfills about 725
   `eth_getLogs` calls on Base, a few minutes on a paid RPC.
2. Start the wrapper in its own window:
   ```powershell
   python bots\wrapper\fleet_wrapper.py --config bots\wrapper\configs\compound-liquidator.json
   ```
3. In `http://localhost:8787/terminal` → Fleet → Compound III Liquidator, request **detect**.
   The card fills in within a few seconds of the backfill finishing; `data\fleet\compound-liquidator.log`
   has the JSON log, `data\fleet\compound-liquidator.finds.jsonl` the absorbable accounts.

Ethereum and Arbitrum: add `ETHEREUM_RPC_URL` / `ARBITRUM_RPC_URL` to the `.env` and change
`COMPOUND_CHAINS` in `bots\wrapper\configs\compound-liquidator.json` to `base,ethereum,arbitrum`.

## The contract draft (`contracts/fleet/CompoundLiquidator.sol`)

`liquidate(job, swapTokens, hops, minProfit, source)`: absorb `job.accounts` (may be empty),
flash-borrow `job.baseAmount` of the base token from Morpho Blue (or use own capital),
`buyCollateral(job.asset, job.minCollateral, baseAmount, this)`, swap the measured amount back
to the base token through V2 / Aerodrome / concentrated-liquidity hops, repay, and revert unless
the base token balance grew by at least `minProfit`. `simulate(...)` does the same and always
reverts with `Simulated(profit)` for `eth_call`.

Safety, following `LiquidationExecutor`'s owner/operator pattern and tightening it:

- **owner** (your own wallet) deploys, withdraws, sets the operator, and keeps the list of
  Comet markets the contract may touch (`setComet`). **operator** (the hot key) can only call
  `liquidate` / `simulate`.
- **A leaked operator key costs gas, never principal**: a Comet off the allowlist reverts;
  every token on the swap path must end at or above its starting balance and the base token
  strictly above; a concentrated-liquidity callback may claim at most the amount we offered,
  only from the pool we are swapping with, only once; the flash callback is accepted only
  from the lender while we asked for a loan; the Comet approval is reset to zero after the buy.
- The lender is an immutable constructor argument (Morpho Blue on Base and Ethereum; Arbitrum
  needs its own lender before it can be used there).

It is a **draft**: not deployed, not wired into the bot, and `scripts/build-bytecode.cjs` is
unchanged. Before any live use: Sunday's security review, the fork tests on the PC, a review of
the gas model against a real absorb, and Joshua's go-live decision.

### Forge tests (for Claude Code on the PC)

Ran here with forge 1.5.1 / solc 0.8.26: **9 passed, 4 fork tests skipped** (no `FORK_URL`);
the existing suites still pass (51 passed in total). On the PC, from the bot folder:

```powershell
forge test --match-path "test/forge/fleet/*" -vv
$env:FORK_URL = "https://mainnet.base.org"    # public Base RPC, no key; or Joshua pastes his own
forge test --match-path "test/forge/fleet/*" -vv
# optional full path once the monitor has logged an absorbable account:
$env:FORK_BLOCK = "<block from finds.jsonl>"; $env:COMPOUND_FORK_ACCOUNT = "<account>"
$env:COMPOUND_FORK_POOL = "<a WETH/USDC CL pool on Base>"
forge test --match-test testForkAbsorbBuySwap -vvv
```

Expected with `FORK_URL`: 12 passed, 1 skipped (`testForkAbsorbBuySwap` without an account).
