# Command center: the terminal, the agent API and the fleet

The bot's local server (`src/ui/server.ts`, port 8787) now serves two pages:

| Page | What it is |
|---|---|
| `http://localhost:8787/` | the classic dashboard (wallet, deploys, withdrawals, tuning) |
| `http://localhost:8787/terminal` | the command center: racers, latency, leaks, simulator, route atlas, fleet, agents, analytics, nodes |

Both read the bot's own records (`data/*.jsonl`). The terminal labels anything
modelled (the simulator's race odds) and shows empty states rather than
invented numbers. Opened outside the bot (for example as a file), the terminal
runs on demo data and says so in its footer.

## Who can do what

Every `/api` call carries a token.

- **Owner**: the page's own token, new on every start, held only by the browser
  tab. It can do everything below, plus issue and revoke agent tokens and test
  node URLs.
- **Agents**: long-lived tokens issued from Terminal → AI agents → Issue token
  (`POST /api/agents`). Shown once, stored only as a SHA-256 hash in
  `data/agents.json`, rate-limited to 120 requests a minute, at most 24 tokens.

| Scope | Allows |
|---|---|
| `read` | every GET, `POST /api/simulate`, claiming an open issue |
| `tune` | `POST /api/tuning` (apply / dismiss a learned suggestion) |
| `pause` | `POST /api/stop`, `POST /api/sending {paused:true}` (writes `data/STOP`) |
| `deploy` | `POST /api/fleet/:id/control` (detect or paper only) |

There is no `sign` or `withdraw` scope and no route that signs: the server
never holds a signer. Nothing in the API edits `.env`, resumes live sending,
starts a process or switches a bot to live. Agents send their token as
`Authorization: Bearer agt_…` (or `x-bot-token`); EventSource clients use
`?t=`. A paused agent is refused at once; a revoked token gets 401.

## The routes agents use

`GET /api/help` lists every route with the scope it needs and whether the
calling token may use it. The ones that matter most:

| Route | Returns |
|---|---|
| `GET /api/brief` | one call: health, issues, latency, leaks, top racers, top routes, fleet |
| `GET /api/stream` | server-sent events: `block`, `opp`, `outcome`, `mev`, `live`, `stop`, `fleet`, `issue`, and a `brief` every 30 s |
| `GET /api/health` | systems matrix plus issues with stable ids and the numbers each rule fired on |
| `POST /api/issues/:id/assign` | claim an open issue `{note}` or release it `{release:true}` |
| `GET /api/latency?hours=24` | detect (ms into block), find→send and land percentiles, hourly |
| `GET /api/leaks?hours=6` | captured / still there / lost the race / closed / gas wall / below minimum |
| `GET /api/racers?hours=1` | rival bots: $/hour, share, priority fee, block position, finds taken from us |
| `GET /api/routes/scores` | pairs ranked by recoverable $ × win rate × gas efficiency |
| `GET /api/targets` | today's targeting brief, plus rival pairs we have no find on |
| `GET /api/market?chain=base` | route atlas; other networks fill in from fleet heartbeats |
| `POST /api/simulate` | replay recorded finds under `{minProfitUsd, gasX, latencyCutMs, gapMs, excludeDexes, hours}` |
| `GET /api/analytics?hours=24` | hourly buckets for the charts |
| `GET /api/fleet`, `POST /api/fleet/:id/control` | the fleet and its desired-state requests |
| `GET /api/nodes` | configured RPC endpoints (host only), RPC usage, candidate timings |

## Health rules

Each rule raises an issue with a stable id while the condition lasts:
`blocks-stalled` (no block for 30 s), `block-processing-slow` (p90 over 2 s),
`rpc-on-fallback`, `rpc-errors` (over 5% of at least 200 requests),
`live-failures` (half the breaker limit, critical at the limit),
`gas-budget` (80% of `MAX_DAILY_GAS_USD`, critical at 100%), `stop-file`,
`flashblocks-silent`, `cloud-stale` (no push for 5 min), `no-candidates`
(30 min without a candidate) and `fleet-<id>` for a stale or failing fleet bot.
Claims live in `data/issues.json`; they never change the bot.

## The learning loop

The bot learns every block: rival bids, failing routes and tokens
(`data/learned.json`) and the pools rivals trade on (`data/pools.json`, up to
`MAX_WATCHED_POOLS`). Overnight the night watch, an AI agent on the PC, measures
the bot with `tools/night-watch/night_watch.mjs` (the same maths as this
terminal), keeps the system's memory in `base-arb-watch\MEMORY.md` next to the
bot folder, and proposes changes. The 08:54 daily review turns its tuning
proposals into suggestions with an Apply button. Nothing changes without
Joshua: Apply for tuning, his `.env` for settings, a pull request for code.
Details in `tools/night-watch/README.md`.

## Nodes

`GET /api/nodes` shows hosts only: any URL label that looks like a key is
masked, and paths, queries and passwords are never returned or stored. Testing
a node (`POST /api/nodes/test`) is owner-only, so an agent can't make the bot
fetch arbitrary URLs. A tested candidate keeps its label, host and timings in
`data/nodes.json`; its URL stays in the browser tab. Switching nodes is an
`.env` edit you make, then a restart of `run-24h.ps1`.

## The fleet

`src/fleet/registry.ts` lists the flagship and the ten field-guide bots.
External bots run as their own processes beside a wrapper; the contract is in
`bots/CONTRACT.md`, licences and pinned commits in `bots/README.md`, the
schedule in `docs/FLEET-PLAN.md`.

## Files

```
src/command/agents.ts     tokens, scopes, rate limits
src/command/api.ts        the routes above
src/command/health.ts     systems matrix, issue rules, claims
src/command/nodes.ts      redaction, probes, candidate book
src/command/records.ts    bounded in-memory copies of data/*.jsonl
src/command/telemetry.ts  latency, leaks, racers, scores, simulator, atlas, hourly
src/fleet/registry.ts     the eleven bots
src/fleet/control.ts      control and heartbeat files
ui/terminal.html          the terminal page
tools/night-watch/        the night watch's read-only report and simulator runner
data/agents.json  data/issues.json  data/nodes.json  data/fleet/   (gitignored)
```
