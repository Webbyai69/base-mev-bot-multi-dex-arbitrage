# The fleet: upstream code, licences and how each bot plugs in

Ten systems from the field guide join base-arb-bot under one command center.
Their code is **pinned, not pasted**: each upstream repo is a git submodule
under `bots/upstream/` at an exact commit, and our own code talks to it
through a wrapper (`bots/wrapper/`, contract in `bots/CONTRACT.md`).

Why not copy everything into `src/`? Licences. Some of these are GPL or had no
licence at all; pasting them into the trading bot would either relicense our
code or break someone else's copyright. Pinned submodules keep each project's
licence attached to its own code, keep upstream fixes one `git` command away,
and keep the live bot's process free of code nobody here has reviewed.

Licences were read from each repo on **2026-10-11** at the pinned commit.

| Bot (registry id) | Upstream @ pinned commit | Licence | What we may do | Phase |
|---|---|---|---|---|
| `morpho-liquidator` | morpho-org/morpho-bots @ `08d0a41` (main) | Apache-2.0 | use, modify, port; keep NOTICE and attribution | 1 |
| `compound-liquidator` | compound-finance/comet @ `f766f51` (main) | BUSL-1.1, change date 2025-12-31 passed, so now GPL-2.0-or-later | read and fork-test against it; write our own liquidator contract rather than copy GPL code into `contracts/` | 3 |
| `blind-backrun` | flashbots/simple-blind-arbitrage @ `73c6c27` (main) | MIT | use, modify, port with the copyright notice | 4 |
| `triangular` | solidquant/mev-templates @ `67c46cc` (main) — **not a submodule** | none published (all rights reserved) | study only; we reimplement from our own `src/routes.ts` | 4 |
| `artemis` | paradigmxyz/artemis @ `4bb1580` (main) | MIT OR Apache-2.0 | use and modify with either notice | 5 |
| `uniswapx-filler` | marktoda/uniswapx-artemis @ `f703161` (main) | MIT | use and modify with the copyright notice | 5 |
| `hummingbot` | hummingbot/hummingbot @ `9af100d` (master) | Apache-2.0 | run unmodified in its own container; changes in our fork keep NOTICE | 2 |
| `freqtrade` | freqtrade/freqtrade @ `1f394ea` (**stable**) | GPL-3.0 | run as a separate program over its REST API only; never import or copy it into `src/` | 2 |
| `passivbot` | enarjord/passivbot @ `b9d6692` (master) | Unlicense (public domain) | free to use, modify, port | 3 |
| `jito-searcher` | jito-labs/searcher-examples @ `f710c30` (master) | Apache-2.0 | use, modify, port; keep NOTICE. Sandwich bundles are never built or enabled. | 5 |

The commits above are the single source of truth in `src/fleet/registry.ts`
(the command center shows them on each fleet card). Bumping one is a PR that
updates the submodule pointer, the registry and this table together, after the
bot's tests pass at the new commit.

## Fetching one bot's code

Submodules are not cloned by default, so `git pull` on the trading PC stays
small and fast. Fetch only the one you are working on:

```bash
git submodule update --init --depth 1 bots/upstream/morpho-bots
```

`mev-templates` is study-only: clone it **outside** this repo
(`git clone --depth 1 https://github.com/solidquant/mev-templates ../study/mev-templates`)
and never copy files from it into ours.

## Hard lines (every bot, every phase)

- **Backruns and permissionless liquidations only.** No front-running, no JIT
  liquidity, no sandwiching — including inside the upstream code. Any such
  path stays disabled and is named in the registry's `excluded` field.
- **Each bot has its own key or exchange account**, set by the owner in the
  wrapper's `.env` (gitignored). Exchange keys are trade-only, withdrawals off.
  The main wallet's key is never used, asked for or stored anywhere.
- **Live is the owner's call.** The dashboard and agents can only request
  `detect` or `paper`. See `bots/CONTRACT.md`.
- **Agents never merge.** Every integration lands as a PR a human reviews.

## Layout

```
bots/
  CONTRACT.md            control/heartbeat files between a wrapper and the command center
  README.md              this file
  upstream/<name>/       pinned submodules (fetch on demand)
  wrapper/
    fleet_wrapper.py     reference wrapper (Python 3 standard library)
    configs/_template.json
    configs/<id>.json    added by the phase that integrates <id>
    .env                 owner-only, gitignored: FLEET_LIVE_<ID>, keys, caps
  adapters/              bridges that turn a bot's own status into the wrapper's metrics file
  compose/               containers for the exchange bots (Hummingbot, Freqtrade), paper only
```

Containerised bots (Phase 2): see `docs/fleet/hummingbot-freqtrade.md`.
