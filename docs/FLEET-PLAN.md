# Fleet plan: 12–18 October 2026

**Goal for Sunday 18 October.** Each of the ten field-guide systems is either
reporting into the command center in detect or paper mode, or is blocked only
on a step that has to be a person's (an account, a key, a review). Meanwhile
the flagship gets the work its own numbers say matters most: a faster node and
Denim-proofing.

Live trading for any new bot is out of scope this week. It needs at least
three days of paper numbers and Joshua's decision.

## Who does what

| Who | Does | Never does |
|---|---|---|
| **Cloud agents** (scheduled tasks) | Code: wrappers, adapters, monitors, tests, one pull request per task | merge, touch `.env`, deploy, sign, start or stop the live bot |
| **Local agents** (scheduled, on Joshua's PC through the Claude app) | Read the bot's own data on the PC, run CPU-heavy backtests, write reports to `reports/` | edit code, data or `.env`; run git in the bot folder; send anything |
| **Joshua** | Review and merge PRs; `.env` values; exchange accounts and trade-only API keys (withdrawals off); fund each bot's own wallet; the go-live call per bot; contract and Cloudflare deploys from the browser; the Ashburn server | |
| **Claude Code + the dev** | Integration: merge CC's local dashboard changes with this branch, wire agent PRs into `src/`, run forge and fork tests on the PC, the node switch and Denim work below | |

The PC must be on, with the Claude desktop app open, for a local task to run.

## Hard rules for every agent

1. Backruns and permissionless liquidations only. No front-running, JIT
   liquidity or sandwiching, even where upstream code offers it.
2. No private keys, seed phrases, API secrets or `.env` contents: never read,
   write, print or ask for them. Keys and RPC URLs are added by Joshua.
3. No deploys, transactions, signatures, bridging or fund movements. No
   starting, stopping or restarting the live bot. Detect and paper only.
4. Never merge, never push to `upgrade/v3-multihop-flashblocks-liquidations`
   or `main`. One branch `fleet/<slug>` per task, PR into the base branch.
5. Licences as in `bots/README.md`: upstream code stays in its submodule; no
   GPL (freqtrade, comet) or unlicensed (mev-templates) code in `src/` or
   `contracts/`.
6. Files: `bots/**`, `docs/fleet/**`, `test/fleet-*.test.js` and whatever the
   task names. The integrator owns `src/main.ts`, `src/rpc.ts`, `src/pools.ts`,
   `src/executor.ts`, `src/ui/**`, `ui/**` and the contracts.
7. Credits: before starting, count unmerged `fleet/*` branches. With four or
   more waiting for review, report status and stop instead of building more.

## Schedule (times are Dublin)

| Day | Time | Who | Task | Ends with (human step) |
|---|---|---|---|---|
| Sun 11 | done | this session | **Phase 0**: terminal, agent API, fleet contract, wrapper, pinned submodules | Pull, merge CC's dashboard work, restart, open `/terminal`, issue agent tokens |
| Mon 12 | 07:40 | cloud | **P1** Morpho Blue liquidator: wrapper + detection adapter | Review PR; Base RPC URL in `bots/wrapper/.env` |
| Mon 12 | 11:10 | cloud | **P2** Hummingbot + Freqtrade: paper setup, REST bridge | Review PR; exchange accounts, trade-only keys, Docker Desktop |
| Mon 12 | 20:10 | local | Live-data baseline from the PC (finds, rivals, latency, leaks) | Read the report |
| Tue 13 | 07:40 | cloud | **P3** Compound III: clean-room monitor + contract draft; Passivbot backtest harness | Review PR; CC runs forge tests |
| Tue 13 | 11:10 | cloud | **P4a** cross-chain spread monitor (passive) | Review PR; RPC URLs for Arbitrum/Optimism/Ethereum |
| Wed 14 | 07:40 | cloud | **P4b** triangular detector for Arbitrum and Optimism (our own code) | Review PR |
| Wed 14 | 11:10 | cloud | **P4c** MEV-Share blind-backrun detector (Ethereum) | Review PR |
| Thu 15 | 07:40 | cloud | **Checkpoint**: PR status, tests, rule check, credit check, replan | Check credit balance; pause later tasks if ahead of budget |
| Thu 15 | 20:10 | local | Passivbot and Freqtrade backtests on the PC's CPU | Read results |
| Fri 16 | 07:40 | cloud | **P5a** UniswapX DutchV3 order collector, Artemis structure (read-only) | Review PR |
| Fri 16 | 11:10 | cloud | **P5b** Solana: Jito bundle test kit + Raydium/Orca spread detector | Review PR; Solana keypair with a little SOL, if you want the test bundle |
| Sat 17 | 07:40 | cloud | **Integration pass**: spreads and fleet routes into the terminal, docs | Review PR |
| Sat 17 | 20:10 | local | Re-baseline after the node change, compared with Monday | Read the report |
| Sun 18 | 09:10 | cloud | **Independent security and ethics review** of the week's PRs | Act on findings before merging |
| Sun 18 | 18:10 | cloud | **Week wrap-up** and next week's plan | Approve next week |

Every task ends with a phone message that has a `NEEDS YOU:` line. Push
notifications are on for all of them. The existing daily tasks (08:54 bot
review, 08:57 airdrop scan) keep running unchanged.

## Phases

**Phase 0, command center (done).** `/terminal` reads live data; agents get
scoped tokens; the fleet contract (`bots/CONTRACT.md`) and the reference
wrapper let any bot report in; nine upstreams are pinned as submodules.

**Phase 1, Morpho Blue liquidator.** Gas-only, permissionless, bonus-driven:
the best next earner with the least latency pressure. Done when its wrapper
runs `ALLOW_DETECTION_ONLY=true` against Base and the fleet card shows
positions watched and liquidatable positions found.

**Phase 2, Hummingbot and Freqtrade.** Venue breadth (140+ exchanges,
Hyperliquid). Each runs in its own container; Freqtrade only through its REST
API. Done when both run in paper mode and report heartbeats. Needs accounts
and trade-only keys from Joshua.

**Phase 3, Compound III and Passivbot.** Our own clean-room Compound III
liquidator (monitor first, contract draft with fork tests, no deploy) and a
Passivbot backtest. Done when the monitor reports absorbable accounts in
detect mode.

**Phase 4, other EVM chains.** A passive cross-chain spread monitor (feeds the
terminal's spreads panel), a triangular detector for Arbitrum and Optimism
written from our own `src/routes.ts`, and a MEV-Share hint listener for
Ethereum blind backruns. All detect-only.

**Phase 5, framework and Solana.** UniswapX DutchV3 order collector on the
Artemis collector/strategy/executor pattern; Jito bundle test kit and a
Raydium/Orca spread detector. Sandwich bundles are never built.

**Phase 6, integration and review.** Wire the new data into the terminal, an
independent security review, and next week's plan.

## The flagship track (Claude Code + dev, not scheduled)

1. **Node.** Point `RPC_URL`, `WS_URL` and `FLASHBLOCKS_RPC_URL` at the faster
   node (Joshua's `.env`), compare it first on Terminal → Nodes. Then turn the
   400 ms Flashblocks poll into a stream-driven backrun loop (Tier 0.2).
2. **Denim** (Base mainnet, around November 2026): put the pre-confirmation
   source behind one interface and rescale the constants that assume 2 s
   blocks, before the Flashblocks streams and the `pending` tag go away.
3. **Dashboard merge.** Merge CC's unpushed dashboard changes with this branch.
   Keep `/` and `/terminal` side by side until the terminal covers everything
   the classic page does (wallet deploys and withdrawals stay on `/`).

## Credits ($210)

| Runs | Estimate each | Subtotal |
|---|---|---|
| 9 cloud build tasks | $10–15 | $90–135 |
| 3 cloud light tasks (checkpoint, review, wrap-up) | $3–8 | $10–25 |
| 3 local tasks | $3–6 | $10–18 |
| **Planned** | | **$110–178** |
| Reserve (re-runs, fixes, your own requests) | | **$32–100** |

These are estimates: a run's cost depends on how much it reads and builds.
Check the real balance on Thursday morning after the checkpoint. If spending is
ahead of plan, pause the Friday and Saturday build tasks; the Sunday review is
the one to keep.

## When a bot may go live

Not this week. Afterwards, per bot: at least three days of paper numbers in its
heartbeat, a merged PR that passed the security review, its own wallet or
account funded by Joshua, then `FLEET_LIVE_<ID>=1` in its wrapper `.env` and a
start from Joshua's own terminal with `--live`.
