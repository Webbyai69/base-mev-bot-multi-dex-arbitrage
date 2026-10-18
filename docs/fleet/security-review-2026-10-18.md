# Fleet security and ethics review, 2026-10-18

Independent, read-only review. Scope: a1f843d (command center) on `upgrade/v3-multihop-flashblocks-liquidations`, and open PRs #4 (morpho-liquidator), #5 (hummingbot-freqtrade), #6 (compound-liquidator) and #7 (xchain-monitor), each diffed against its merge base. Line numbers are at the branch heads: base 668d4b3, #4 40af1f2, #5 f00417f, #6 d8729d9, #7 a1e17eb.

## Findings

| # | Sev | Where | Finding | Fix |
|---|---|---|---|---|
| 1 | **High** | `src/ui/server.ts:367-368, 462, 467` | `GET /` and `/terminal` need no auth, and both embed the owner token in `window.__BOT__`. The Host check (:360) stops browser DNS rebinding, but not a local process that sets `Host: localhost:8787` itself. Any local agent, even one with only a `read` token, can `curl` the page and become owner: it can then mint all-scope tokens, revoke other agents, and probe URLs through `api.ts:286` (SSRF). | Take the token out of the HTML. Give it out once per start, for example printed to the console as a `#t=` fragment URL, or require a launch secret before serving the page. |
| 2 | **High** | `bots/wrapper/fleet_wrapper.py:125-133` | The live run doesn't stay stopped. (a) Deleting `data/STOP` resumes live on the next poll, which contradicts the "resume is manual" note at :130 and CONTRACT rule 2. (b) After a dashboard stop, a later `desired:"running"` resumes **live** (:132), ignoring the requested mode. Any `deploy`-scope agent can send that through `POST /api/fleet/:id/control` (`api.ts:228`, `agents.ts:186`). That is an agent route that resumes live sending. (c) `float(FLEET_GAS_CAP_USD_MAX)` at :123 runs before the STOP check, and `stop_file.exists()` can raise. Either exception is swallowed at :233, so STOP fails open. | Check STOP first and fail closed on any error. Once STOP or a dashboard stop is seen in live mode, latch a `live_halted` flag that only a fresh `--live` start clears. Honour STOP in every mode. Validate the gas cap once at startup. |
| 3 | Medium | `fleet_wrapper.py:147` | `child_env = {**os.environ, **self.env, ...}` gives every child, in detect and paper too, every bot's keys, RPC URLs and `FLEET_LIVE_*` flags. Paper mode is then only as safe as the upstream bot's respect for `FLEET_MODE`. | A minimal env plus per-bot allowlisted keys. Add signing keys only when `mode=="live"`. Never forward `FLEET_LIVE_*`. |
| 4 | Medium | `src/ui/server.ts:526, 491`; `src/cloud.ts:86,112` | `/api/state` and the `/api/events` hello message send `activeEndpoint`, which is masked only by `rpc.ts:161 redactUrl`. That misses `user:pass@`, UUID or base62 path keys and `auth=` queries. These go to read agents and to the cloud mirror. | Serve `redactHost(...).host`, as `nodes.ts`/`api.ts:389` already do. |
| 5 | Medium | `bots/adapters/morpho/parser.ts:171,180,206`; `run.ts:158` (PR #4) | Upstream error text (viem errors include `URL: …/v2/<key>`) is copied unredacted into `lastError`, then into the metrics file, the heartbeat and `/api/fleet`. Raw stderr is also written to the log. | Redact the RPC env values, and anything URL-shaped, before storing or teeing, as xchain `rpc.ts:20` does. |
| 6 | Medium | `src/ui/server.ts:478-495` vs `api.ts:604` | Pausing or revoking an agent doesn't close its `/api/events` stream. A read agent can also evict the owner's stream once 8 are open. | Tag event clients with the agent id and close them on pause or revoke. Give agents a separate cap. |
| 7 | Low | `bots/adapters/morpho/run.ts:101-103` (PR #4) | Detect mode forwards a real `MORPHO_DETECT_PRIVATE_KEY` to upstream. A `tx.sent` is only counted (`parser.ts:229-233`), and the process keeps running. | Generate a throwaway key in memory. Exit on any send or signing event. |
| 8 | Low | `src/fleet/control.ts:126-127`; `nodes.ts:177,205` | Heartbeat `lastError`/`detail` and probe error messages are served without a key scrubber. | One shared URL and key scrubber at ingest. |
| 9 | Low | `ui/terminal.html:1119, 1259, 1454` | `d.finds`, `L.n` and the summed `s[2]` go into innerHTML without `esc()`. The nonce CSP blocks script execution, so the risk is HTML injection only. | `esc()`/`num()`, and coerce `+x\|\|0` in the sums. |
| 10 | Low | `ui/terminal.html:1514` | The owner token goes in a query string (`/api/stream?t=`), so it can end up in logs. | A short-lived stream ticket. |
| 11 | Low | `contracts/fleet/CompoundLiquidator.sol:146,153,205,248` (PR #6) | The operator sets `minProfit`, and there is no per-hop `minOut`. A leaked operator key can give away the liquidation discount, but not principal. | An owner-set `minProfitFloor` that `liquidate` enforces. |
| 12 | Low | `CompoundLiquidator.sol:318-322, 99-104` (PR #6) | Single-step `transferOwnership`. The "transient" guards are plain storage, and there is no `nonReentrant`. Not exploitable today. | Two-step ownership. Add a reentrancy lock or `transient` storage. |
| 13 | Low | `bots/compound-liquidator/monitor/rpc.ts:24,44`, `monitor.ts:398-402` (PR #6) | A malformed RPC URL makes `fetch` throw with the full URL, which then reaches the log and metrics. | Parse with `new URL` at construction and rethrow errors that name the host only. |
| 14 | Low | `bots/compose/docker-compose.yml:747-761`; `config.example.json:835-837` (PR #5) | Run by hand, compose starts the freqtrade API with empty or placeholder credentials (bound to 127.0.0.1). `FREQTRADE_STRATEGY` is placed into `sh -c`. | `${VAR:?}` for credentials, validate the strategy name, pin the image digest. |
| 15 | Low | `src/command/api.ts:243-252`, `src/ui/server.ts:669-682`, `fleet_wrapper.py:99-103` | Any agent can release another agent's issue claim. `/api/wallet` lets read agents trigger multicalls. Config paths are not confined to the repo. | An ownership check on claims, a global wallet limit, `resolve()` and assert paths stay inside REPO. |

## Checked and clean

- **(a) Ethics.** No front-running, sandwich, JIT or pending-transaction logic in any scope, disabled or otherwise. "Sandwich" appears only in the after-the-fact classifier and in the registry's `excluded` list (`registry.ts:295`). The monitors use `eth_getLogs` and multicall only, and xchain and compound allowlist read-only RPC methods.
- **(c)** No route signs, edits `.env`, deletes STOP or sets live. `/api/sending` only accepts `paused:true` (`api.ts:223`). `control.ts:154,177` forces detect or paper. The live gate needs `--live` plus `FLEET_LIVE_<ID>=1` from the .env file only. All four PR wrapper configs have empty `live` commands.
- **(d)** Tokens come from `randomBytes(24)`, are stored as SHA-256 and compared with `timingSafeEqual`. They are never listed or logged. Unknown POSTs default to owner. Bodies are capped at 4 KB, with no CORS headers and an Origin check.
- **(e)** Every subprocess call takes an argv list, with no `shell=True`. Ids are regex-checked, so there is no path traversal. `esc()` covers `& < > " '` everywhere else.
- **(f)** No GPL (freqtrade, comet) or mev-templates code is copied. Upstreams stay in submodules, freqtrade runs as its image over REST, and the Comet interface is re-declared. Not verified: the upstream LICENSE files, because the submodules were not checked out.
- **(g)** On `CompoundLiquidator`, the operator can call only `liquidate` and `simulate`. Withdrawals always go to the owner. Callbacks check the caller and an in-flight flag, and approvals are reset. A leaked operator key costs gas and expected profit, not principal.

## Merge guidance

- **#4:** fix finding 5 before merging.
- **#5:** fine for paper.
- **#6:** draft contract. Fix findings 11 and 12 before any deploy.
- **#7:** clean.
- **Base:** fix findings 1 and 2 before any agent token is issued or any fleet bot gets a live command.
