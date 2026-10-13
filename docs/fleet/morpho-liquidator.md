# Morpho Blue liquidator (`morpho-liquidator`), Phase 1: detect mode

**What it is.** Morpho's own liquidation bot for Morpho Blue
(`morpho-org/morpho-bots`, `bots/blue-liquidation`, Apache-2.0, pinned at
`08d0a41`), run on Base (chain 8453) in **detection-only** mode. Every block it
reads every Morpho Blue position with health factor 1.02 or lower (from the
public Morpho API), re-checks each one on chain, and logs the ones that are
liquidatable. With no swap venue it can never act on them: each one ends at
`config.no_swap_path`, nothing is simulated, signed or sent.

Permissionless liquidations only. Nothing here trades ahead of anyone's
pending transaction.

## How the pieces fit

```
bots/wrapper/fleet_wrapper.py --config bots/wrapper/configs/morpho-liquidator.json
  └─ node bots/adapters/morpho/run.ts --mode detect           (one process)
       ├─ loads bots/upstream/morpho-bots/bots/blue-liquidation/dist/src/index.js
       ├─ reads its JSON log lines  ->  data/fleet/morpho-liquidator.fleet-metrics.json
       └─ (wrapper)  ->  data/fleet/morpho-liquidator.heartbeat.json  ->  fleet card
```

`run.ts` enforces detect mode whatever the `.env` holds: it forces
`ALLOW_DETECTION_ONLY=true`, `ENABLE_LIFI=false`, `CHAIN_ID=8453`, drops every
venue key (`ZEROX_API_KEY`, `ONEINCH_API_KEY`, `LIFI_API_KEY`), and hands the
upstream bot only an allowlist of variables, so other fleet bots' keys never
reach it. It refuses `paper` and `live`. It never prints a variable's value.

The fleet card shows:

| metric | meaning |
|---|---|
| `positionsWatched` | positions the last block's check covered |
| `liquidatable` | liquidatable at the last block |
| `liquidatableToday` | distinct positions seen liquidatable today (UTC) |
| `bestBonusUsd` | largest liquidation bonus seen today: seized collateral value × (1 − 1/LIF). Gross, before swap cost and gas |
| `ticks`, `discoverErrors`, `tickErrors`, `lastBlock` | health |

Routes are the collateral/loan pairs of liquidatable positions (names and
prices from the public Morpho API, looked up at most once a minute). In detect
mode their venue is `morpho-blue` only, because no swap venue is enabled.

**Paper mode: none.** The upstream has no dry run that never broadcasts
(`probe:lens` is a one-shot read probe), so `paper` is empty in the config. The
registry (`src/fleet/registry.ts`) still lists `paper` for this bot; the
integrator should drop it there or add the paper mode described at the end.

## Setup on Windows (once)

1. **Node 24.18.1** (the upstream needs `^24.14.1`; the main bot runs on it too).
   Install from nodejs.org or with nvm-windows: `nvm install 24.18.1` then
   `nvm use 24.18.1`. Check: `node --version`.
2. **pnpm 11.11.0** through corepack, in a PowerShell opened as administrator:
   ```powershell
   corepack enable
   corepack prepare pnpm@11.11.0 --activate
   pnpm --version
   ```
3. **Python 3** for the wrapper (`py --version`); it is already used by the fleet.
4. Fetch and build the upstream, from the bot folder:
   ```powershell
   git submodule update --init --depth 1 bots/upstream/morpho-bots
   cd bots\upstream\morpho-bots
   pnpm install --frozen-lockfile
   pnpm --filter "@morpho-org/blue-liquidation..." --if-present run build
   cd ..\..\..
   dir bots\upstream\morpho-bots\bots\blue-liquidation\dist\src\index.js
   ```
   **If the build fails on Windows**, or the fleet card later says
   `startup failed` with something about `sol`/soltag: the upstream build
   script matches source paths with `/`, which Windows paths don't use, so its
   Solidity templates may not compile there. Use WSL (Ubuntu) instead: install
   Node 24.18.1 and pnpm there, run the same commands in the same folder
   (`/mnt/c/...`), and start the wrapper from WSL too (`python3 ...`). The
   heartbeat lands in the same `data/fleet` folder, so the command center on
   Windows sees it.

## Settings (names only; you set the values)

In `bots/wrapper/.env` (gitignored; agents never open it):

| name | required | what |
|---|---|---|
| `BASE_RPC_URL` | yes | your Base RPC URL (already in `.env.example`). It must accept large `eth_call`s: the bot checks all positions in one call |
| `MORPHO_DETECT_PRIVATE_KEY` | yes | a **brand-new key that never holds funds**. The upstream refuses to boot without a key, even in detect mode; with zero ETH it could not pay gas for anything even if a send were ever attempted. Never your main wallet's key, never reused for live. Make one with, for example, `cast wallet new` |
| `MORPHO_RPC_URL` | no | overrides `BASE_RPC_URL` for this bot only |
| `MORPHO_RPC_URL_FALLBACK` | no | second RPC |
| `HEALTH_FACTOR_LTE` | no | discovery cutoff, default `1.02` |
| `MAX_DEPLOYLESS_BATCH_SIZE` | no | only if your RPC rejects large calls |
| `EXCLUDE_COLLATERALS`, `MORPHO_API_URL`, `LOG_LEVEL` | no | upstream defaults are fine |

`FLEET_LIVE_MORPHO_LIQUIDATOR` stays `0`.

## Start in detect mode

From the bot folder, in its own PowerShell window:

```powershell
py bots\wrapper\fleet_wrapper.py --config bots\wrapper\configs\morpho-liquidator.json
```

Then ask for detect from Terminal → Fleet → Morpho Blue Liquidator (or an agent
with the `deploy` scope: `POST /api/fleet/morpho-liquidator/control
{"desired":"running","mode":"detect"}`). The wrapper starts the bot within 5 s.
Its log is `data\fleet\morpho-liquidator.log`; look for `startup`,
`quoting.no_routes` (confirms detection-only) and `discovery.startup` with a
candidate count. Stop with `desired: stopped`, or Ctrl+C in the wrapper window.

Done for Phase 1 when it runs 24 h with a fresh heartbeat and the card shows
positions watched.

If the card says `startup failed: ... EXECUTOOOR_ADDRESS ...`: the upstream
checks that Morpho's Executor contract exists on Base at its fixed address
before it starts. Morpho runs this bot on Base, so it should; if not, stop
there and tell the integrator. Deploying it is not part of detect mode.

## Going live later (not now, and not by an agent)

Everything below is Joshua's decision, after this PR is reviewed and merged and
after the security review. Nothing in this PR enables any of it.

1. **A paper mode first** (separate PR): an entry point built from the
   upstream's modules that stops at `simulate.ok` (an `eth_call`, never a
   broadcast) with a venue enabled, and records simulated bonus minus gas. Three
   days of those numbers, per `docs/FLEET-PLAN.md`.
2. **Its own wallet**: a new key funded with a small amount of ETH for gas
   only, never the main wallet. The detect key above stays unfunded.
3. **A swap venue**: `ENABLE_LIFI=true` (keyless) or a 0x / 1inch API key.
4. **A gas cap**: the upstream only caps the fee per transaction
   (`MAX_FEE_GWEI`, default 300). The fleet's daily USD cap
   (`FLEET_GAS_CAP_USD_MAX`, at most $5) is not enforced by the upstream, so
   the live adapter must count gas from `tx.confirmed` and stop the bot at the
   cap; that is code to write and review first.
5. A filled `live` command in the config, `FLEET_LIVE_MORPHO_LIQUIDATOR=1` in
   the wrapper `.env`, and a start with `--live` typed by Joshua in his own
   terminal. `data/STOP` stops it.

## Licence

Upstream: Apache-2.0, Copyright 2026 Morpho Association, kept in its submodule
with its LICENSE. `bots/adapters/morpho/` is our own code: it loads the
upstream's build output and reads its logs; it copies none of its source.
