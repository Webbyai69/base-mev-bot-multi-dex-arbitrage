# Hummingbot and Freqtrade in paper mode (Phase 2)

Two exchange bots join the fleet, each in its own Docker container, **paper /
dry-run only**. They report into the command center through the fleet wrapper
(`bots/CONTRACT.md`) like every other bot: registry ids `hummingbot` and
`freqtrade`.

| | Hummingbot | Freqtrade |
|---|---|---|
| What runs | `simple_pmm` V2 script (two quotes around mid, refreshed every 15 s) | freqtrade's own `SampleStrategy` (RSI / TEMA / Bollinger), 5 m candles |
| Venue | `binance_paper_trade` (Binance public data, simulated fills), ETH-USDT | Binance spot, dry-run wallet of 1,000 USDT, 6 USDT pairs |
| Container | built once from the pinned submodule `bots/upstream/hummingbot` @ `9af100d` | official image `freqtradeorg/freqtrade:2026.9` (= pinned stable `1f394ea`) |
| Reports through | `bots/adapters/hummingbot_bridge.py`: trades DB + log in `bots/compose/hummingbot/` | `bots/adapters/freqtrade_bridge.py`: Freqtrade's REST API on `127.0.0.1:8080` |
| Paper guard | launcher refuses any connector not ending `_paper_trade`; bridge stops the container if a non-paper fill ever appears | `--dry-run` on the command line (beats config and env) + `FREQTRADE__DRY_RUN=true`; bridge stops the container if the API reports `dry_run=false` |
| Licence | Apache-2.0: run unmodified, NOTICE stays in the submodule | GPL-3.0: separate program, we only speak HTTP to it; no freqtrade code in this repo (its sample strategy is copied into the gitignored `user_data/` by freqtrade itself at start) |

Paper mode needs **no exchange account and no API key**: both bots use public
market data. You only need three passwords for the local Freqtrade API and one
for Hummingbot's keystore.

## Files

```
bots/compose/docker-compose.yml           services: freqtrade, freqtrade-cli (tools profile), hummingbot
bots/compose/.env.example                 the env NAMES (values go in bots/wrapper/.env)
bots/compose/freqtrade/config.example.json    -> copied to freqtrade/config.json (gitignored) on first run
bots/compose/hummingbot/conf_simple_pmm.example.yml -> copied to hummingbot/conf/scripts/conf_simple_pmm.yml
bots/adapters/compose_paper.py            launcher the wrapper runs: compose up (foreground) + bridge
bots/adapters/freqtrade_bridge.py         REST -> state/freqtrade/fleet-metrics.json
bots/adapters/hummingbot_bridge.py        files -> state/hummingbot/fleet-metrics.json
bots/wrapper/configs/{freqtrade,hummingbot}.json   paper = the launcher; detect and live empty
```

## One-time setup on the Windows PC

1. **Docker Desktop.** Install from docker.com (WSL 2 backend, the default),
   start it, and wait for "Engine running". Check in PowerShell:
   `docker version` and `docker compose version`.
2. **Python 3** is already there for the wrapper (`py --version`).
3. **Fetch the Hummingbot source without Windows line endings** (the image is
   built from it, and CRLF breaks its shell scripts inside Linux):

   ```powershell
   cd C:\path\to\base-mev-bot-multi-dex-arbitrage
   git -c core.autocrlf=false submodule update --init --depth 1 bots/upstream/hummingbot
   git -c core.autocrlf=false submodule update --init --depth 1 bots/upstream/freqtrade   # optional: reference only
   ```

4. **Env values.** Open `bots/wrapper/.env` yourself and add these names with
   your own values (see `bots/compose/.env.example`). Use long random strings,
   for example from a password manager:

   | Name | What |
   |---|---|
   | `FREQTRADE_API_USERNAME` | login for the local Freqtrade API |
   | `FREQTRADE_API_PASSWORD` | its password |
   | `FREQTRADE_JWT_SECRET` | signing secret for the API's tokens |
   | `HUMMINGBOT_PASSWORD` | Hummingbot keystore password (the first one used sticks) |
   | `FREQTRADE_API_PORT` | optional, default 8080 |

   Nothing else. No exchange keys this week.

## Run in paper mode

### Through the wrapper (how the command center sees it)

Two PowerShell windows, from the repo root:

```powershell
py bots\wrapper\fleet_wrapper.py --config bots\wrapper\configs\freqtrade.json
py bots\wrapper\fleet_wrapper.py --config bots\wrapper\configs\hummingbot.json
```

Then in the terminal (`http://localhost:8787/terminal` -> Fleet) set each to
**paper / running**, or have an agent with the `deploy` scope call
`POST /api/fleet/freqtrade/control {"desired":"running","mode":"paper"}`.
The wrapper runs `compose_paper.py`, which copies the example configs on first
run, checks the guards, runs `docker compose up <service>` in the foreground
and refreshes the metrics file every 10 s. The fleet card shows P&L, trades,
open positions and errors within a minute. The first Hummingbot start builds
its image (10-20 minutes, once); the card says so meanwhile.

Stopping from the terminal (**stopped**) ends the foreground compose and the
wrapper then runs `docker compose stop <service>`. Ctrl-C in the wrapper
window does the same.

### By hand (without the wrapper)

```powershell
cd bots\compose
copy freqtrade\config.example.json freqtrade\config.json             # first time only
mkdir hummingbot\conf\scripts; copy hummingbot\conf_simple_pmm.example.yml hummingbot\conf\scripts\conf_simple_pmm.yml
docker compose --env-file ..\wrapper\.env up freqtrade                # Ctrl-C to stop
docker compose --env-file ..\wrapper\.env up hummingbot
```

Freqtrade's own web UI and API are then on `http://127.0.0.1:8080` (login with
the API username and password above). Hummingbot status from the container:
`docker exec fleet-hummingbot hbot status` and `hbot history`.

### Stop and clean up

```powershell
cd bots\compose
docker compose --env-file ..\wrapper\.env down        # stops and removes both containers
py ..\adapters\compose_paper.py --service freqtrade --down   # just one of them
```

Data stays in `bots/compose/freqtrade/user_data/` and
`bots/compose/hummingbot/{data,logs}/` (all gitignored). Delete those folders
to start the paper accounts from zero.

## Freqtrade backtesting

Uses the `freqtrade-cli` service (tools profile; never trades). From `bots\compose`:

```powershell
docker compose --env-file ..\wrapper\.env run --rm freqtrade-cli create-userdir --userdir /freqtrade/user_data
docker compose --env-file ..\wrapper\.env run --rm freqtrade-cli download-data --config /freqtrade/config/config.json --userdir /freqtrade/user_data --timeframes 5m 1h --days 90
docker compose --env-file ..\wrapper\.env run --rm freqtrade-cli backtesting --config /freqtrade/config/config.json --userdir /freqtrade/user_data --strategy SampleStrategy --timeframe 5m --timerange 20260715-
docker compose --env-file ..\wrapper\.env run --rm freqtrade-cli backtesting-show --userdir /freqtrade/user_data
```

Results land in `freqtrade/user_data/backtest_results/`. This is the job the
Thursday 20:10 local task runs on the PC's CPU. Hyperliquid instead of Binance:
set `"name": "hyperliquid"`, `stake_currency` `USDC` and `/USDC` pairs in your
`config.json`; Hyperliquid serves only the last 5,000 candles, so backtests
there are short.

## What the fleet card shows

| Field | Freqtrade | Hummingbot |
|---|---|---|
| `pnlUsd` | realised dry-run profit today (UTC), from `/api/v1/daily` | today's fills marked to the last fill price, minus fees (estimate) |
| `sends` | trades closed today | fills today |
| `gasUsd` | 0 | 0 |
| `metrics` | apiUp, dryRun, openTrades, unrealisedUsd, closedTrades, profitClosedUsd, profitAllUsd, winRatePct, paperBalanceUsd, startingCapitalUsd | paper, fillsToday, buysToday, sellsToday, volumeTodayUsd, pnlAllUsd, fillsAll, logErrors, logAgeS, uptimeS |
| `routes` | per pair: trades and profit (`venues: binance-paper`) | per pair: fills today and estimated P&L |

USD values assume the quote is a USD stablecoin; any other quote shows $0 and
says so in `detail` rather than guessing a rate.

## Accounts and keys for later (not this week)

When, after at least three days of paper numbers, you decide to try one live,
you create these yourself. Agents never see or handle them.

- **Exchange account** (Binance, Bybit or OKX: check which serve Ireland and
  your account type) with 2FA. One sub-account per bot if the exchange offers
  it, funded only with what that bot may lose.
- **Trade-only API key** per bot: spot trading on, **withdrawals OFF**,
  transfers off, and an **IP allow-list** with only the public IP of the PC or
  server that runs the bot. Prefer a fresh key per bot so you can revoke one
  without touching the others.
- **Hyperliquid**: create an *API wallet* at app.hyperliquid.xyz/API (it can
  trade but cannot withdraw); never use the main wallet's key.
- Where they go: Freqtrade reads `FREQTRADE__EXCHANGE__KEY` and
  `FREQTRADE__EXCHANGE__SECRET`; Hummingbot stores keys encrypted with
  `HUMMINGBOT_PASSWORD` via `hbot connect <exchange>`. Live also needs a
  `live` command in the wrapper config, a removed `--dry-run`, and
  `FLEET_LIVE_<ID>=1` plus `--live` typed by you (`bots/CONTRACT.md`). None of
  that exists in this PR on purpose.

## Why live stays off this week

- `docs/FLEET-PLAN.md`: live for a new bot needs at least three days of paper
  numbers, a merged PR that passed the Sunday security review, its own funded
  account, and your decision. None of that can be true before next week.
- These are not MEV bots: market making and directional strategies carry real
  inventory and market risk, and paper fills are optimistic (no queue
  position, no adverse selection). The paper numbers are a ceiling, not a
  forecast.
- The keys don't exist yet, by design: paper needs none, so nothing that can
  trade real money is on the PC this week.
