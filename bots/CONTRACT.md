# Fleet contract: how an external bot joins the command center

base-arb-bot runs in its own process and never starts, stops or signals any
other program. Every other bot in the fleet (`src/fleet/registry.ts`) runs as
its **own process** — its own language, virtualenv or container — next to a
small **wrapper**. The wrapper and the command center talk through two JSON
files in the base bot's data directory:

```
data/fleet/<id>.control.json    written by the command center: what the owner or an agent WANTS
data/fleet/<id>.heartbeat.json  written by the wrapper:         what IS happening
```

`<id>` is the bot's id in `src/fleet/registry.ts` (for example
`morpho-liquidator`). A reference wrapper that does all of this is in
`bots/wrapper/fleet_wrapper.py` (Python 3, standard library only).

## The rules that never bend

1. **Live trading starts only from the owner's own terminal.** The dashboard
   and agents can ask for `detect` or `paper` and can stop any run. A live run
   needs both `FLEET_LIVE_<ID>=1` in the wrapper's own `.env` (for example
   `FLEET_LIVE_MORPHO_LIQUIDATOR=1`) **and** `--live` on the wrapper's command
   line, typed by the owner. Same rule as `MODE=live` for the main bot.
2. **STOP stops everyone.** When `data/STOP` exists, a wrapper running live
   stops its bot within one poll and reports `status: "stopped"` with the
   reason. Resuming is manual, as for the main bot.
3. **Backruns and permissionless liquidations only.** No front-running, no JIT
   liquidity, no sandwiches, whatever the upstream code offers. Paths like
   that stay disabled and are listed under `excluded` in the registry.
4. **Keys never pass through these files**, the dashboard, the agents or git.
   Each bot gets its own wallet or exchange key, set by the owner in that
   wrapper's `.env`. Exchange API keys are trade-only with withdrawals off.
5. **Budgets live with the owner.** A gas or capital cap in the control file
   (`gasCapUsd`, at most $5/day) can only lower the cap the owner set in the
   wrapper's `.env`, never raise it.

## control.json (command center -> wrapper)

Written atomically (temp file + rename). The wrapper polls it every 5 s.

```json
{
  "id": "morpho-liquidator",
  "desired": "running",
  "mode": "detect",
  "target": "base:morpho-blue",
  "gasCapUsd": 1,
  "requestedAt": "2026-10-11T12:00:00.000Z",
  "requestedBy": "agent:ops-1"
}
```

| field | meaning |
|---|---|
| `desired` | `running` or `stopped` |
| `mode` | `detect` (find and log, no orders) or `paper` (simulate fills). Never `live`. |
| `target` | free text the bot may use to pick markets or pairs (optional) |
| `gasCapUsd` | per-day cap the bot must not exceed; `null` = the owner's `.env` cap |
| `requestedBy` | `owner` or `agent:<name>`, for the audit trail |

A wrapper that has no command for the requested mode reports
`status: "error"` and `lastError: "no <mode> command configured"` rather than
guessing.

## heartbeat.json (wrapper -> command center)

Written atomically at least every 30 s. A heartbeat older than **90 s** shows
the bot as `stale`, and the health page raises an issue for it.

```json
{
  "id": "morpho-liquidator",
  "status": "running",
  "mode": "detect",
  "pnlUsd": 0,
  "sends": 0,
  "gasUsd": 0,
  "lastError": null,
  "detail": "watching 412 positions on 38 markets",
  "version": "morpho-bots@08d0a41 wrapper 0.1",
  "updatedAt": "2026-10-11T12:00:05.000Z",
  "routes": [
    { "pair": "cbBTC/USDC", "venues": ["morpho-blue", "aerodrome"], "count": 3, "usd": 1.42 }
  ],
  "metrics": { "positionsWatched": 412, "detectMs": 180 }
}
```

| field | meaning |
|---|---|
| `status` | `running`, `stopped` or `error` |
| `mode` | the mode actually running: `detect`, `paper` or `live` |
| `pnlUsd`, `sends`, `gasUsd` | today (UTC) so far; `pnlUsd` is realised for live, simulated for paper |
| `lastError`, `detail` | short human text (300 chars max) |
| `routes` | optional, at most 12: the bot's busiest routes. They draw the market atlas for its network. |
| `metrics` | optional, at most 12 named numbers shown on its fleet card |

The command center treats every heartbeat as untrusted input: unknown fields
are dropped, numbers are bounded, strings are cut, files over 64 KB are ignored.

## Checklist for a new bot (each phase in docs/FLEET-PLAN.md)

1. The upstream repo is a pinned submodule under `bots/upstream/` (or, for
   code we may not copy, a reimplementation under `bots/<id>/`). Its licence
   and obligations are recorded in `bots/README.md` and the registry.
2. A wrapper config under `bots/wrapper/configs/<id>.json` names the exact
   command for each mode the bot offers. `live` is optional and only used with
   `--live` from the owner's terminal.
3. Detect mode runs for 24 h and its heartbeat stays fresh.
4. Paper mode runs for at least 3 days; the numbers go into the PR.
5. The PR is reviewed and merged by a human. Agents never merge.
6. The owner, not an agent, decides on live and sets the flag.
