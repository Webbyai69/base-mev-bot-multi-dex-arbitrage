# Wiring notes for helper-agent branches

## Opportunity history, near misses and size curves (`agent/opportunity-history`)

New files: `src/history.ts`, `src/nearmiss.ts`, `src/sizecurve.ts`. Hooks in
existing files are marked `// history:` (a few lines in `src/scanner.ts`, one
optional parameter on `optimizeRoute` in `src/routes.ts`). Nothing here sends
a transaction or touches keys.

### 1. Turn on the near-miss log (src/main.ts)

The scanner only writes near misses when `scanner.nearMisses` is set. After the
`Scanner` is constructed and the `Store` exists:

```ts
import { nearMissesFromEnv } from "./nearmiss.js";
scanner.nearMisses = nearMissesFromEnv(store); // undefined unless NEAR_MISSES=true
```

Env: `NEAR_MISSES=true` (default off), `NEAR_MISS_BAND=0.5` (fraction of
MIN_PROFIT_USD; a candidate counts when net >= MIN_PROFIT_USD x (1 - band), so
a band above 1 also admits gas-negative ones). Records go to
`data/near-misses.jsonl` (already covered by `.gitignore`'s `data/*.jsonl`),
at most 5 per block, written when the next block's first candidate arrives.
`scanner.nearMisses.stats` has `{ offered, inBand, written }` for the funnel
panel if wanted. Add the two env vars to `.env.example` and the settings table.

### 2. Size curves

On by default (`SIZE_CURVES=probe`): every opportunity the scanner keeps gets
`sizeCurve: Array<[amountIn: string, profitUsd: number]>` (12 points at 1/6 ..
12/6 of the chosen size; point 6 is the chosen size). `SIZE_CURVES=optimizer`
re-runs multi-hop routes through `optimizeRoute(route, undefined, onSample)`
and keeps 12 points spread over what the optimiser evaluated (diagnostic,
~0.1-0.3 ms per route). `SIZE_CURVES=false` turns it off. No wiring needed;
`scanner.sizeCurves` can also be set at runtime.

### 3. GET /api/opportunities (src/ui/server.ts)

Build one index per process, next to the other `UiSources` plumbing:

```ts
import { OpportunityIndex, type HistoryQuery } from "./history.js";

// in the UiServer constructor (or start()):
this.history = new OpportunityIndex(src.store, { token: src.token, symbol: src.symbol, pool: src.pool });
void this.history.start(); // streams the file in the background; queries work meanwhile (building: true)

// in handle(), inside the token-checked `switch (`${method} ${url.pathname}`)`:
case "GET /api/opportunities": {
  const p = url.searchParams;
  const str = (k: string) => p.get(k) ?? undefined;
  const n = (k: string) => (p.has(k) ? Number(p.get(k)) : undefined);
  const q: HistoryQuery = {
    from: str("from"), to: str("to"),      // ISO or YYYY-MM-DD (UTC day of foundAt)
    pair: str("pair"),                     // pairSymbols, case-insensitive exact
    dex: str("dex"),
    kind: str("kind") as HistoryQuery["kind"],
    status: str("status") as HistoryQuery["status"],
    sim: str("sim"),
    minNetUsd: n("minNetUsd"),
    limit: n("limit"), offset: n("offset"), asOf: n("asOf"),
    order: p.get("order") === "asc" ? "asc" : "desc",
  };
  return this.json(res, 200, this.history.query(q)); // { total, asOf, building, rows }
}
case "GET /api/opportunities/facets":
  return this.json(res, 200, this.history.facets());
```

Rows have the same shape as `slimOpp` (`id, block, foundAt, pair, via, kind,
hops, netUsd, profitUsd, gasUsd, sim, simDetail, stage, msIntoBlock, legs`)
plus `status`, `outcome` (same as `slimOutcome`), `mode`, `tokenIn`,
`amountIn` and `sizeCurve`. `slimHistoryOpp` in `src/history.ts` mirrors
`slimOpp`; once wired, `slimOpp` could call it instead of keeping two copies.

Paging: send back the `asOf` from the first page so offsets don't shift while
the bot keeps recording. Drop `asOf` (or send the new one) on "refresh".

The index also works in the dashboard-only process (`node dist/main.js ui`):
it catches up on new lines at every query. Memory is ~55 bytes per
opportunity (1M opportunities ~ 55 MB); the first pass over a 300 MB file
takes a few seconds and yields between 4 MB chunks.

### 4. Drawing sizeCurve in the opportunity detail (ui/dashboard.html)

`sizeCurve` is a short array of `[amountIn, profitUsd]`; `amountIn` is an
integer string in `tokenIn` units (decimals from `legs[0].from.decimals`).
Suggested: a small inline SVG line chart, x = amountIn / 10^decimals, y =
profitUsd, a zero line, a dot at the recorded `amountIn` (probe mode: point
index 5), and a hint when the peak is not at the recorded size ("sized
below/above the best point") or when the curve stops early ("larger sizes are
infeasible: CL range"). Hide the chart when `sizeCurve` is null (older
records).

### 5. Near misses on the dashboard (optional)

`store.tail("near-misses.jsonl")` gives the latest; a "Near misses" table next
to the funnel with `code`, `pairSymbols`, `dexes`, `netUsd`, `shortUsd`
answers "what would MIN_PROFIT_USD = x have bought". The same file is easy to
summarise in the daily digest (count per code, sum of `netUsd`).

### Command line

`node scripts/history-query.mjs --pair WETH/USDC --status taken --limit 20`
and `node scripts/history-query.mjs --near-misses` read `data/` offline.
`node scripts/bench-history.mjs` measures the per-block cost of the hooks.
