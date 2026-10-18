# Fleet security and ethics review, 2026-10-18

Independent, read-only review. Scope: a1f843d (command center) on the base branch, and open PRs #4 (morpho), #5 (hummingbot-freqtrade), #6 (compound) and #7 (xchain), each diffed against its merge base. Line numbers are at the branch heads: base 668d4b3, #4 40af1f2, #5 f00417f, #6 d8729d9.

## Findings

| # | Sev | Where | Finding | Fix |
|---|---|---|---|---|
| 1 | **High** | `src/ui/server.ts:367-368,462,467` | `/` and `/terminal` need no auth and embed the owner token in `window.__BOT__`. The Host check (:360) doesn't stop a local process that sets `Host:` itself. Any local agent, even one with only a read token, can become owner: mint tokens, revoke other agents, and probe URLs through `api.ts:286` (SSRF). | Keep the token out of the HTML. Give it out once per start, for example as a console `#t=` URL. |
| 2 | **High** | `bots/wrapper/fleet_wrapper.py:123-133` | A live run doesn't stay stopped. Deleting `data/STOP` resumes live. After a dashboard stop, a deploy-scope agent's `desired:"running"` (`api.ts:228`) resumes **live** and ignores the requested mode. A bad `FLEET_GAS_CAP_USD_MAX`, or a `stop_file.exists()` error, raises before the STOP check; the exception is swallowed at :233, so STOP fails open. | Check STOP first and fail closed. Latch `live_halted` until a fresh `--live` start. Honour STOP in every mode. |
| 3 | Medium | `fleet_wrapper.py:147` | Every child, in detect and paper too, gets the full env: every bot's keys, RPC URLs and `FLEET_LIVE_*`. | Minimal env plus per-bot allowlisted keys. Signing keys only when live. |
| 4 | Medium | `src/ui/server.ts:491,526`; `src/cloud.ts:86,112` | `activeEndpoint` is masked only by `redactUrl` (`rpc.ts:161`), which misses `user:pass@`, UUID or base62 path keys and `auth=`. It reaches read agents and the cloud mirror. | Serve `redactHost(...).host`. |
| 5 | Medium | `bots/adapters/morpho/parser.ts:171,180,206`; `run.ts:158` (PR #4) | Upstream (viem) errors, which carry the keyed RPC URL, go unredacted into `lastError`, metrics, heartbeat, `/api/fleet` and the log. | Redact as xchain `rpc.ts:20` does. |
| 6 | Medium | `src/ui/server.ts:478-495` | A revoked or paused agent keeps its `/api/events` stream. Agents can evict the owner's stream at 8 clients. | Tag streams by agent and close them on revoke. Give agents a separate cap. |
| 7 | Low | `morpho/run.ts:101-103`, `parser.ts:229-233` (PR #4) | Detect mode hands upstream a real private key, and a `tx.sent` is only counted. | Use an in-memory throwaway key. Exit on any send. |
| 8 | Low | `src/fleet/control.ts:126-127`; `src/command/nodes.ts:177,205`; `compound-liquidator/monitor/rpc.ts:24,44` (PR #6) | Heartbeat, probe and fetch error text is served without a key scrubber. | One shared URL and key scrubber at ingest. |
| 9 | Low | `ui/terminal.html:1119,1259,1454,1514` | Three numeric fields go into innerHTML without `esc()`; the CSP limits this to HTML injection. The owner token is sent in the `/api/stream?t=` query string. | `esc()`/`num()`. A short-lived stream ticket. |
| 10 | Low | `contracts/fleet/CompoundLiquidator.sol:146,205,248,318,99` (PR #6) | The operator sets `minProfit` and there is no per-hop `minOut`, so a leaked operator key can give away the discount, but not principal. Single-step `transferOwnership`. The "transient" guards are plain storage, and there is no `nonReentrant`. | Owner-set profit floor, two-step ownership, reentrancy lock. |
| 11 | Low | `bots/compose/docker-compose.yml:747-761` (PR #5) | Run by hand, compose starts the freqtrade API with empty credentials (127.0.0.1 only). The strategy name goes into `sh -c`. | `${VAR:?}`, validate the name, pin the image digest. |
| 12 | Low | `api.ts:243-252`; `server.ts:669-682`; `fleet_wrapper.py:99-103` | Any agent can release another's issue claim. `/api/wallet` lets read agents trigger multicalls. Config paths aren't confined to the repo. | Ownership check, global limit, path assert. |

## Checked and clean

- **(a) Ethics:** no front-running, sandwich, JIT or pending-transaction code, disabled or not. "Sandwich" appears only in the after-the-fact classifier and in `registry.ts:295` (excluded). The monitors use logs and multicall only, with read-only RPC allowlists.
- **(c) Live gating:** no route signs, edits `.env`, deletes STOP or sets live. `/api/sending` only accepts a pause (`api.ts:223`), and `control.ts:154,177` force detect or paper. The live gate needs `--live` plus `FLEET_LIVE_<ID>=1` from the .env file. Every PR config has an empty `live` command.
- **(d) Agent tokens:** `randomBytes(24)`, stored as SHA-256 and compared with `timingSafeEqual`. They are never listed or logged. Unknown POSTs default to owner, bodies are capped at 4 KB, and Origin is checked.
- **(e) Injection:** argv lists only, no `shell=True`. Ids are regex-checked, so there is no traversal. `esc()` is used everywhere else.
- **(f) Licences:** no GPL (freqtrade, comet) or mev-templates code is copied. Freqtrade runs as its image over REST, and the Comet interface is re-declared. The upstream LICENSE files were not checked, because the submodules weren't checked out.
- **(g) Contract:** the operator can only call `liquidate` and `simulate`. Withdrawals always go to the owner, callbacks check the caller and an in-flight flag, and approvals are reset.
- **PR #7:** no findings.

## Merge guidance

- **#4:** fix finding 5 before merging.
- **#5:** fine for paper.
- **#6:** draft. Fix finding 10 before any deploy.
- **#7:** clean.
- **Base:** fix findings 1 and 2 before issuing agent tokens or adding any live command.
