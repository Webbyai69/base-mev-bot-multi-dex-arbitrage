// Search recorded opportunities and near misses from the command line (offline; reads data/ only).
//
//   npm run build
//   node scripts/history-query.mjs [--data data] [--pair WETH/USDC] [--dex aerodrome] [--kind classic|cl|triangular]
//        [--status pending|persisted|taken|closed] [--sim executor-ok] [--min-net 0.25]
//        [--from 2026-10-01] [--to 2026-10-14] [--limit 20] [--offset 0] [--asc] [--json]
//   node scripts/history-query.mjs --near-misses [--data data] [--limit 20]
//
// Never writes anything and never touches the chain.
import { Store } from "../dist/store.js";
import { OpportunityIndex } from "../dist/history.js";
import { NEAR_MISSES_FILE } from "../dist/nearmiss.js";

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const num = (v) => (v === undefined ? undefined : Number(v));

const store = new Store(opt("data") ?? "data");
const limit = num(opt("limit")) ?? 20;

if (flag("near-misses")) {
  const rows = store.tail(NEAR_MISSES_FILE, 4 * 1024 * 1024).slice(-limit).reverse();
  if (flag("json")) console.log(JSON.stringify(rows, null, 2));
  else for (const r of rows) console.log(`${r.at}  #${r.block}  ${r.code.padEnd(22)}  ${r.pairSymbols.padEnd(28)} ${r.dexes.join(">").padEnd(36)} net $${r.netUsd.toFixed(3)} (short $${(r.shortUsd ?? 0).toFixed(3)}) gas $${r.gasUsd.toFixed(3)}`);
  process.exit(0);
}

const idx = new OpportunityIndex(store);
await idx.start();
const res = idx.query({
  pair: opt("pair"),
  dex: opt("dex"),
  kind: opt("kind"),
  status: opt("status"),
  sim: opt("sim"),
  minNetUsd: num(opt("min-net")),
  from: opt("from"),
  to: opt("to"),
  limit,
  offset: num(opt("offset")) ?? 0,
  order: flag("asc") ? "asc" : "desc",
});
idx.stop();
if (flag("json")) {
  console.log(JSON.stringify(res, null, 2));
} else {
  console.log(`${res.total} matching of ${idx.count} opportunities (${idx.stats().bytesPerOpportunity} bytes/opportunity in the index)`);
  for (const r of res.rows) {
    const curve = Array.isArray(r.sizeCurve) ? `  curve peak $${Math.max(...r.sizeCurve.map(([, u]) => u)).toFixed(3)}` : "";
    console.log(`${r.foundAt}  #${r.block}  ${String(r.kind).padEnd(10)} ${String(r.pair).padEnd(28)} ${r.via.join(">").padEnd(36)} net $${Number(r.netUsd).toFixed(3)}  ${String(r.sim).padEnd(15)} ${r.status}${curve}`);
  }
}
