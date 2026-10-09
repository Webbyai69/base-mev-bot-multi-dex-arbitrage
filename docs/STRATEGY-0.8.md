# 0.8.0 strategy: where the money actually is

Research for the next update, written 2026-10-09 ~10:45 while 0.7.0 runs live.
Grounded in the bot's own data (`data/mev.jsonl`, the digest funnel) and the
live Base MEV market, not guesswork. **Ethics unchanged: backrunning only — we
react *after* someone else's swap, never reorder, front-run, JIT or sandwich.**

## The uncomfortable finding

0.7.0 does everything we planned, but the data says it's aimed at the wrong
thing. In the first ~15 minutes live after the restart it found **0 candidate
spreads above $0.10**, while rivals did dozens of profitable arbs. Digging into
why:

1. **We already watch the right pools.** Of the 481 rival arbs worth >$1 today,
   **1,002 of 1,282 pool-legs (78%) are pools we already track** — including the
   $1,438, $942 and $489 trades (all 3/3 legs watched). Only ~$700 of ~$11,700
   touched a DEX we don't recognise. So coverage is *not* the main problem.

2. **The profit lives inside a single block.** 94% of those big arbs land at
   transaction index 11+ (median **139**, max 3,154) — deep in the block, right
   after a large swap that moved a concentrated-liquidity pool. They are
   **atomic same-block backruns**: a swap moves a Slipstream/Uniswap-V3 pool, and
   a faster bot appends its arb in the very next transaction slot. By the next
   block — or even the next 200 ms flashblock — the price has reverted and the
   spread is gone.

3. **It's won on speed, not gas.** 208 of 383 big arbs paid **under 0.5 gwei**
   priority fee; only 26 were gas wars (>5 gwei). ~**$1,900/day** of big-arb
   profit is effectively *uncontested* — won purely by being first to append
   after the triggering swap.

**Our architecture can't see any of this.** We re-read pool reserves at block
(and 400 ms flashblock) boundaries, find a spread, and send on the *next* block.
That only ever shows us the world *after* the backrun already happened. It can
catch a slow, persistent spread (last night's WHUF, the odd two-pool gap) — but
those are the exception. The rule is sub-block backruns we structurally miss.

This is why gas, the daily cap, and "more pools" were never the blocker. The
bot has ~$23 of gas it hasn't touched. The blocker is *when* and *how* it looks.

## What would actually make money (0.8.0), in priority order

### 1. Flashblock-stream backrunning — the core change
Stop polling pool state on a timer. Instead **subscribe to the Flashblocks
stream** (Base broadcasts a pre-confirmed sub-block every 200 ms; ordering locks
once broadcast, so a swap in flashblock N is visible and we target N+1). For each
swap on a pool we watch:
- decode it, find the pools it moved,
- simulate a backrun arb across just those pools (fast — a handful of pools, not
  the whole 1,500-pool graph),
- if it clears EV, submit immediately with a priority fee just above that pool's
  recent backrun fees, to land in the next flashblock.

This reacts to the *event* that creates the spread, in the same block, which is
the only way to capture it. It is pure backrunning. Build it to target the
**uncontested long tail** (the <0.5 gwei backruns, smaller/newer pools the top
bots deprioritise), not the $1k gas-war trades we'd lose.

Sub-tasks: Flashblocks WebSocket subscription; Swap-log decode → affected pools;
a fast single/two-pool CL backrun simulator on just those pools; same-block
submit path reusing the existing RouteExecutor and safety rails.

### 2. Fix the lag (prerequisite for #1)
Block processing is ~2.0–2.5 s against 2 s blocks (the "Lagging" badge). You
cannot backrun inside 200 ms if a scan takes 2 s. Make the scan **incremental**:
only re-examine pools touched by the latest swaps, not the full graph every
block. This is required for #1 and also cuts RPC (~9.6M CU/day today).

### 3. Lower-latency data + submit path
The home-PC round-trip to the sequencer is the real ceiling. Levers: a
Flashblocks-aware WebSocket endpoint close to the sequencer; a fast submit
endpoint. Be honest that this caps what's winnable — co-located pros will always
beat us on the contested trades.

### 4. Recognise the "unknown" DEXes
~15–20% of rival-arb *legs* are on `unknown-v2` / `unknown-v3` factories we don't
know (~$700/day of >$1 profit). Add those factories so their pools become
watchable and tradable. Modest but cheap.

### 5. Fee-on-transfer filter
One cheap probe when a token first appears catches traps like MESSY (the
"UniswapV2: K" reverts) before they waste a sim or a live revert.

### 6. Smarter, cheaper bidding
Most backruns win at <0.5 gwei. Tie the learned bid to each pool's *observed*
backrun fee, and only enter a gas war when EV is strongly positive. The daily
cap stays; we're not trying to outspend the pros.

## The honest ceiling, and two alternatives worth weighing

A home PC on a free Alchemy plan will lose the contested, high-value races to
bots co-located with the sequencer. Even done well, flashblock backrunning
realistically catches a *slice* of the ~$1,900/day uncontested long tail — not
the top bots' $3k/day. Worth doing, but set expectations: this is a small, real
edge, not a money printer.

Two complementary income sources that suit a home setup *better* than millisecond
arb races, both within our ethics:

- **Aave V3 liquidations (make the monitor live).** We already watch 607
  borrowers (paper only). Liquidations are a *monitoring* game, not a
  sub-block latency race: when the market drops, positions become liquidatable
  and the bot that's watching and ready wins — less about microseconds. Lower
  frequency, lower variance, and permissionless (not front-running). Strong
  candidate for a live path alongside arb.
- **New-pool / new-token early inefficiency.** Fresh launches have fat,
  uncontested spreads in their first minutes before the pros arrive. A watcher
  that aggressively tracks brand-new pools and arbs them early could catch gaps
  with little competition.

## Suggested shape of 0.8.0
Lead with **#2 (incremental scan)** because it unblocks everything and is pure
win. Then **#1 (flashblock backrunning)** as the headline. Fold in #4, #5, #6 as
they're cheap. Evaluate **live liquidations** as a second, lower-variance engine.
Treat #3 (latency/infra) as the honest constraint we optimise within, and keep
XDP-scale gas wars out of scope.

Decide at the 5pm check-in with a few hours of live 0.7.0 data in hand.

## Reality check (added 11:05): the hardware can't backrun

Follow-up research changed the recommendation. The profitable arbs are won
**inside a single 200 ms flashblock** — see a swap, append your backrun before
the sub-block closes. Our bot processes a block in **~2 seconds** (nearly every
block exceeds the 1.8 s "lagging" line), because each block is several RPC
round-trips from a home connection in Ireland to a US-hosted Alchemy endpoint.
That is a **~10× gap**, and it is **network latency, not CPU** — no incremental
scan, faster poll, or code change closes it. A home PC on a shared RPC will lose
every contested backrun race to bots co-located with the sequencer. The
`~$1,900/day` "uncontested" tail still mostly goes to whoever is merely *fast
enough*, which we are not.

**Conclusion: chasing CL backruns from this setup is the wrong fight.** We keep
the arb bot running (it still catches the occasional slow/large spread for
cents-to-a-few-dollars), but the realistic ways to actually earn on *this*
hardware are the ones that are **not** a millisecond race:

### The real options (pick deliberately, not in an hour)
1. **Faster infrastructure** — a Base node co-located / in-region (dedicated
   RPC, or a cheap VPS in the sequencer's region running a Flashblocks-aware
   node). This is a **cost** (~tens to low-hundreds /month) and the only thing
   that makes backrunning viable. Without it, the arb bot is a learning project,
   not an income stream.
2. **Aave V3 liquidations, made live** — the best fit for a home PC. The window
   is seconds, not milliseconds; it's permissionless (within our ethics, no
   front-running); and we already monitor 607 borrowers on paper. It needs a
   proper, forge-tested liquidation contract (flash-loan the debt, call
   `liquidationCall`, swap the seized collateral, repay, keep the bonus). That's
   a deliberate, tested build — not a same-day live ship — and it only earns when
   the market moves enough to put positions underwater (none today).
3. **New-pool / new-token early arbs** — fresh launches carry fat, uncontested
   spreads for minutes before the pros arrive. Latency-tolerant; a watcher that
   aggressively tracks brand-new pools could catch these.

### Honest targets
- Today, on this hardware: realistically **cents to maybe a dollar or two** if a
  slow spread or a liquidation happens to land — **not $10–20**, and **nowhere
  near $3k** (those are co-located professional operations).
- With option 1 (infra) **or** option 2 (a tested liquidations engine): a few
  dollars a day becomes plausible; double digits on active days is a stretch
  goal, not a baseline.

The next real build is **the liquidations engine (option 2)** — it suits the
hardware and respects the ethics line. Build it carefully and tested, ship it
behind a flag (off by default), and enable once validated. Infra (option 1) is a
spend decision for the user, not code.
