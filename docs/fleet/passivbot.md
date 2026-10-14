# Passivbot backtest harness (registry id `passivbot`), Phase 3

Status: **backtest only.** No exchange account, no API key, no orders. Passivbot
(enarjord/passivbot @ `b9d6692`, Unlicense) is a grid market maker for perpetual futures. This
PR adds a harness that backtests it on two Hyperliquid perps and reports the result to the
fleet card. The long backtest runs on Joshua's PC (Thursday 15 October, 20:10 local task), not
in the cloud.

## What is in this PR

| Path | What |
|---|---|
| `bots/passivbot/backtest-hyperliquid.override.json` | our settings, merged over upstream's maintained default config |
| `bots/passivbot/run_backtest.py` | builds the config, runs Passivbot's backtester, writes the summary and the fleet metrics |
| `bots/passivbot/fixtures/backtest-sample/` | a small recorded result for the tests |
| `bots/wrapper/configs/passivbot.json` | wrapper config: `detect` = republish the last summary; `paper`, `live` empty |
| `test/fleet-passivbot.test.js` | summary, metrics, config merge, wrapper config |

## The backtest

Base: upstream `configs/examples/default_trailing_martingale_long.json` (their maintained
default strategy, unchanged). Our override:

- **Coins:** BTC and ETH, long only (`n_positions` 2, total wallet exposure 1.0, short side off).
- **Venue:** Hyperliquid fees, price and quantity steps (`market_settings_sources`), maker fee
  0.015 %. Hyperliquid's API only serves a few days of 1-minute candles, so the candles come
  from Binance (`coin_sources`), which has years of them. BTC and ETH trade within a few basis
  points across these venues; for a grid bot that is the closest honest proxy.
- **Period:** 1 April to 1 October 2026 (six months). **Balance:** $1,000.

Assumptions to check on Thursday: that this upstream commit accepts `hyperliquid` in
`market_settings_sources` without an `api-keys.json` (it fetches public market metadata via
ccxt), and that the merged config passes its schema. If the backtester rejects either, the
fallback is `"exchanges": ["binance"]` with no `market_settings_sources` (Binance fees, which
are higher, so a conservative result).

`run_backtest.py` writes `bots/passivbot/out/summary.json` (gitignored):

```json
{
  "period": {"start": "2026-04-01", "end": "2026-10-01"},
  "coins": ["BTC", "ETH"],
  "startingBalanceUsd": 1000,
  "trades": 1234,
  "netUsd": 221.5,
  "gainPct": 22.15,
  "maxDrawdownPct": 18.34,
  "realisedPnlUsd": 230.1,
  "feesUsd": -8.6
}
```

`trades` counts fills in `fills.csv`; `netUsd` is `starting balance × (gain_usd − 1)` from
Passivbot's `analysis.json`; `maxDrawdownPct` is its `drawdown_worst_usd`. (The numbers above
are the test fixture, not a result.)

The fleet card (wrapper in `detect`) shows that summary: detail line, `trades`, `netUsd`,
`gainPct`, `maxDrawdownPct`, and one route per coin. `pnlUsd` stays 0: a backtest is not
today's trading.

## Windows setup (Joshua's PC), once

Passivbot needs **Python 3.12** (3.13 is not supported by its pinned dependencies) and
**Rust** (it builds a Rust extension during install). In PowerShell:

```powershell
winget install --id Python.Python.3.12 -e
winget install --id Rustlang.Rustup -e
winget install --id Microsoft.VisualStudio.2022.BuildTools -e --override "--quiet --wait --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
# close and reopen PowerShell so python, cargo and the MSVC linker are on PATH
rustup default stable
```

Then, in the bot folder:

```powershell
git fetch origin
git switch fleet/compound-liquidator        # or pull the base branch once the PR is merged
git submodule update --init --depth 1 bots/upstream/passivbot
cd bots\upstream\passivbot
py -3.12 -m venv venv
.\venv\Scripts\python.exe -m pip install --upgrade pip
.\venv\Scripts\python.exe -m pip install -e ".[full]"     # builds the Rust extension: 5 to 15 minutes
cd ..\..\..
```

No `api-keys.json` is needed for backtests; do not create one for this.

## Running the backtest (Thursday's local task, or by hand)

From the bot folder, with Passivbot's own Python:

```powershell
bots\upstream\passivbot\venv\Scripts\python.exe bots\passivbot\run_backtest.py --dry-run   # builds the config only
bots\upstream\passivbot\venv\Scripts\python.exe bots\passivbot\run_backtest.py
```

The first run downloads six months of 1-minute BTC and ETH candles into
`bots\upstream\passivbot\caches\` (a few hundred MB) and then simulates; expect tens of minutes
on the first run and a few minutes after that. The full Passivbot result folder is under
`bots\upstream\passivbot\backtests\`; the summary is printed and saved to
`bots\passivbot\out\summary.json`.

Summarise an existing result folder again: `... run_backtest.py --summarize <result folder>`.

## On the fleet card

```powershell
python bots\wrapper\fleet_wrapper.py --config bots\wrapper\configs\passivbot.json
```

Then request **detect** for Passivbot in `/terminal` → Fleet. It only republishes
`out\summary.json` every 20 s (the wrapper's Python is enough; it does not need the venv).

Integrator note: `src/fleet/registry.ts` lists Passivbot's modes as `paper` and `live`. To let
the terminal request this report-only `detect`, add `"detect"` to that list (a one-word change
in a file this PR does not own).

## Not in this PR

- Paper trading (Passivbot's `fake_live` mode) and live trading: later PRs, with a Hyperliquid
  account and an API wallet that cannot withdraw, after Joshua decides.
- Optimisation runs (`passivbot optimize`): CPU-heavy, a separate local task if the backtest is
  promising.
