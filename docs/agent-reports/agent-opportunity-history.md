# Agent report: opportunity history, near misses and size curves

Branch `agent/opportunity-history` (from `origin/main` at 2da9109). Task 7 in
`docs/AGENT_TASKS.md`. Paper-only bookkeeping: nothing here sends a
transaction, reads keys, or needs an RPC.

## Read this first: what could not be verified here

The cloud sandbox's npm registry access was denied by policy (403 on
`registry.npmjs.org`), so `npm ci` could not install `ethers`. I built against
`@types/node`, `ws` and `typescript` copied from the sandbox's own tools plus a
local type-only stub for `ethers` (not committed). The result:

- `npm run build`: all new and changed files type-check. The only 3 errors are
  in the untouched `src/rpc.ts:356`, and they come from the stub (it types
  ethers as `any`). With the real ethers they should go away.
- `npm test`: 49 pass, 15 fail. The 15 failures are the existing suites that
  import `ethers` at runtime (`e2e`, `ui`, `executor`, ...). They fail the same
  way on `origin/main` in this sandbox (30 pass / 15 fail there). All 19 new
  tests pass.
- **The scanner hooks (`src/scanner.ts`) are type-checked but not run** here,
  because `scanner.ts` imports ethers. `test/e2e.test.js` covers `scan()`.

**Before merging: run `npm ci && npm run build && npm test` on a machine with
registry access.** I'd expect 64/64 tests.

## What I built

| Piece | Where | Notes |
|---|---|---|
| History index | `src/history.ts` (new) | `OpportunityIndex(store)`: `start()`, `query()`, `facets()`, `stats()`, `memoryBytes()` |
| Near-miss log | `src/nearmiss.ts` (new) | `NearMissCollector`, `nearMissesFromEnv()`, writes `data/near-misses.jsonl` |
| Size curves | `src/sizecurve.ts` (new) | `attachSizeCurve()`, probe and optimizer modes, `SizeCurveRecorder` |
| Optimiser callback | `src/routes.ts` | `optimizeRoute(route, maxAmountIn?, onSample?)` |
| Scanner hooks | `src/scanner.ts` | 14 added lines, all marked `// history:` |
| Tests | `test/history.test.js`, `test/nearmiss.test.js` (new) | added to `npm test` |
| Wiring notes | `WIRING.md` (new) | `/api/opportunities`, sizeCurve chart, near-miss switch-on |
| Scripts | `scripts/history-query.mjs`, `scripts/bench-history.mjs` (new) | offline only, both run here |

### 1. OpportunityIndex (`src/history.ts`)

- It streams `opportunities.jsonl` once, in 4 MB chunks, and yields to the event
  loop between chunks. It never loads the whole file. Byte offsets are exact, and
  a torn line is skipped without shifting anything.
- It keeps 12 typed-array columns per opportunity: offset, length, time, block,
  net, pair id, dex bitmask, kind, sim, status, plus the outcome line's offset and
  length. Pair, dex and sim strings are stored once in dictionaries. Each outcome
  line is matched to its opportunity through a small map of opportunities still
  waiting for one, so the index doesn't keep a full id→row map.
- New lines are picked up on the tick after `store.onAppend`. That catch-up is
  coalesced, so `paper.register` doesn't wait for it (it costs ~45 µs per
  append). Every `query()` also catches up first, so a dashboard-only process
  (`main.js ui`) sees what the bot writes. A truncated or replaced file triggers
  a rebuild.
- `query({ from, to, pair, dex, kind, status, sim, minNetUsd, limit, offset, order, asOf })`
  returns `{ total, asOf, building, rows }`. Rows are newest first by default.
  Pass back `asOf` to pin paging to a snapshot, so offsets don't move while the
  bot keeps recording. `limit` is capped at 500.
- Rows have the same shape as `UiServer.slimOpp` (the code is copied in, because
  `src/ui/` was off-limits). They also carry `status`, `outcome` (shaped like
  `slimOutcome`), `mode`, `tokenIn`, `amountIn` and `sizeCurve`.
- Filter semantics:
  - `pair` is a case-insensitive exact match on `pairSymbols`.
  - `dex` matches if any leg uses that dex.
  - A `YYYY-MM-DD` value for `from`/`to` means that whole UTC day of `foundAt`.
  - `minNetUsd` compares at float32 precision (a tie at the 7th significant digit
    can go either way).
  - An unknown pair, dex or sim matches nothing.

### 2. Near misses (`src/nearmiss.ts`)

- The hook runs right before the existing `priceOut()` drop, in both the route
  loop and the classic loop. It is off unless `scanner.nearMisses` is set; that
  needs one line in `main.ts` (see WIRING.md §1), which then reads
  `NEAR_MISSES=true`.
- It keeps at most 5 per block, best net first. The same route seen again in
  the block (from a flashblock rescan) keeps only its best. The block's records
  are written when the next block number shows up.
- Record fields: `{ block, at, code, pairSymbols, dexes, amountIn, profitUsd, gasUsd, netUsd }`,
  as the task asked, plus `minProfitUsd`, `shortUsd`, `tokenInSymbol`, `hops`
  and `stage`. `code` is looked up from `FUNNEL_STAGES` (`NET_NEGATIVE_AFTER_GAS`
  / `NET_PROFIT_TOO_LOW`).
- The record is only built (in a closure) when the candidate is in band and would
  make the top 5.

### 3. Size curves (`src/sizecurve.ts`, `src/routes.ts`)

- `optimizeRoute` takes an optional `onSample(amountIn, profit)`, called for
  every feasible size it evaluates. Without it, the optimiser runs exactly as
  before: the same function is called and the results are the same (tested).
- `Scanner.scan()` calls `attachSizeCurve` once for each opportunity that
  survives the filters. It runs before verification, on the same reserves.
  Modes, set with `SIZE_CURVES`:
  - `probe` (default): exact profit at 1/6 … 12/6 of the chosen size, for both
    classic and multi-hop routes, up to 12 points. Point 6 is the chosen size.
  - `optimizer`: re-runs multi-hop routes with `onSample` and keeps 12 points
    spread over what the optimiser looked at, always including its best.
  - `false`: off.
- USD values are scaled from the opportunity's own `profitUsd`, so it makes no
  extra price lookups.
- `attachSizeCurve` never throws; a curve is diagnostics only.

## Test results (this sandbox)

`node --test test/history.test.js test/nearmiss.test.js`: **19/19 pass.**

- History, on a generated 50k-line file (25,622 opportunities, the rest
  outcomes, 1,244 with no outcome, plus one torn line):
  - totals match brute force for 18 filter combinations
  - the first page matches too, in both orders
  - paging visits every match exactly once
  - `asOf` keeps pages identical while 300 records are appended
  - new records and late outcomes are picked up
  - writes from another process (including a torn tail) are seen, and a
    replaced file triggers a rebuild
- **Memory: 53.5 bytes per opportunity (self-accounting), 58.9 bytes per
  opportunity measured** in a child process with `--expose-gc` (heap + array
  buffers). The budget is 200.
- Near misses: top-5 per block, de-duplication, band edges, no-minimum
  (`check` command) case, codes match `FUNNEL_STAGES`, and a cost test
  (1.1M offers).
- Size curves: `onSample` doesn't change the optimiser's result. Curves are
  sorted with no duplicates and peak at the optimiser's profit. Also covered:
  the classic curve, probe and optimizer modes, a missing pool, and a resolver
  that throws.

### Per-block cost with 400 pools (`node scripts/bench-history.mjs 400 60`)

Synthetic V2 market with `MAX_CYCLES=150`. It is far busier than Base: ~314
candidates and ~17 surviving opportunities per block, and the near-miss band is
set to 1.5 so nearly every candidate is in band. Treat it as an upper bound.

| Mode | near-miss hook | size curves | total extra |
|---|---|---|---|
| `SIZE_CURVES=probe` (default) + `NEAR_MISSES=true` | 0.33 ms | 0.34 ms | **~0.7 ms/block** (under 2 ms) |
| `SIZE_CURVES=optimizer` + `NEAR_MISSES=true` | 0.29 ms | 2.18 ms | ~2.5 ms/block (over budget in this worst case; opt-in) |

On Base, with 0–3 kept opportunities per block, probe mode should cost tens of
microseconds. The first pass over the history file and each query run on the
UI side, not in the bot's loop. A query over 26k opportunities returning 50
rows takes ~0.3 ms.

## What's left

1. **Run the real build and tests** (see the top).
2. **Wiring, by you or Claude** (WIRING.md):
   - `scanner.nearMisses = nearMissesFromEnv(store)` in `main.ts`
   - `GET /api/opportunities` and `/api/opportunities/facets` in `src/ui/server.ts`
   - the sizeCurve chart in the opportunity detail view
   - optionally, a near-miss table
   - add `NEAR_MISSES`, `NEAR_MISS_BAND` and `SIZE_CURVES` to `.env.example`
     and the digest's settings table
3. Once wired, `slimOpp` could call `slimHistoryOpp` so there's one copy.
4. Nothing RPC-dependent was needed. No script was left unrun: both new scripts
   are offline and were run here.

## Decisions for Joshua

1. **Near-miss band.** I read "within 50% of MIN_PROFIT_USD" as
   net ≥ MIN_PROFIT_USD × 0.5. With that reading, a gas-negative candidate
   (`NET_NEGATIVE_AFTER_GAS`) can never count, because its net is below 0. Set
   `NEAR_MISS_BAND=1.5` to include candidates down to −0.5 × MIN_PROFIT_USD.
   Keep 0.5, or default to something above 1?
2. **Size curves on by default (probe mode).** Every recorded opportunity gets
   ~12 points, about 300–400 bytes more per line in `opportunities.jsonl`, and it
   adds tens of microseconds before verification on the live path. Keep it on,
   or default to `SIZE_CURVES=false` while running live?
3. **Probe vs optimizer as the default.** The task asked for the optimiser's own
   samples. Those are available (`SIZE_CURVES=optimizer`), but re-running the
   optimiser costs ~0.1–0.3 ms per multi-hop route. Probe mode is ~10× cheaper,
   and it shows sizing bugs more directly: if point 6 isn't the peak, the size
   is wrong. I made probe the default.
4. **`package.json` test line.** I appended the two new test files to the end of
   the `test` script. Other agent branches will edit the same line, so expect a
   trivial merge conflict there.
5. **`WIRING.md` at the repo root** (the task said "WIRING.md"). If other
   branches create the same file, merge them as sections.
