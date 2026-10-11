# Night watch

The learning side of the bot. The bot already learns every block (rival bids,
failing routes and tokens in `data/learned.json`, the pools it watches in
`data/pools.json`). The night watch is the slower loop: an AI agent that
checks the bot through the night, keeps the system's memory, tests one idea per
run and proposes changes. Joshua approves every change.

## How it runs

| What | Where |
|---|---|
| Scheduled task "Night watch: arb bot learning" | 23:40, 02:40 and 05:40 Dublin, on Joshua's PC through the Claude desktop app (the PC must be on with the app open) |
| Its working folder | `C:\Users\joshu\source\base-arb-watch`, next to the bot folder, never inside it |
| `MEMORY.md` there | the system's memory: facts with evidence, hypotheses, numbered proposals (P-NNN), decisions and their effect |
| `nights\YYYY-MM-DD.md` there | each night's log; the 05:40 run puts a morning brief at the top |
| `history.jsonl` there | one line of numbers per run, for trends |
| Daily review, 08:54 | reads the memory and turns tuning proposals into Apply suggestions on the dashboard |

Nothing the night watch does changes the bot. Tuning goes through the
dashboard's Apply button, settings through Joshua's own `.env`, and code
through a pull request he merges. Its one exception is a safety brake: if the
digest shows the daily gas cap or the failed-sends limit passed with no
`data/STOP` file, the bot's own brakes have failed, so it creates `data/STOP`
and messages him.

## The measuring tool

`night_watch.mjs` is read-only: it reads the bot's records and logs, never
writes inside the bot folder, never opens `.env`, never uses the network. It
imports the bot's compiled analytics (`dist/command/records.js` and
`telemetry.js`), so its latency, leaks, racers, route scores and simulator
match `/terminal`.

```
node tools/night-watch/night_watch.mjs                  last 3 hours
node tools/night-watch/night_watch.mjs --hours 8        a whole night
node tools/night-watch/night_watch.mjs --simulate '{"minProfitUsd":0.2,"gasX":0.5,"hours":24}'
```

The report covers: whether the bot is running, block-handler speed per run,
grouped warnings, live sends and who beat us (their bid and block position
against ours), our finds, the funnel, what rival bots took and whether we watch
those pools (and how much went through DEXes the bot can't name yet), the
terminal's views, the watch list by venue, fleet heartbeats, and the trend from
earlier runs. `--record` appends the numbers to `history.jsonl`.

Paths: `BOT_DIR` sets the bot folder (default: this repo when run from here,
or a `base-arb-bot` folder next to the script). `WATCH_DIR` sets where
`history.jsonl` goes (default: beside the script).

The scheduled task runs the copy in `base-arb-watch`. This file is the
versioned source: after changing it, copy it there too.
