/**
 * Opportunity history index (src/history.ts) against a generated 50k-line
 * opportunities.jsonl: totals per filter vs brute force, paging, offsets
 * stable while records are appended, memory per record under budget.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Store } from "../dist/store.js";
import { OpportunityIndex, toSeconds } from "../dist/history.js";

const PAIRS = ["WETH/USDC", "WETH/AERO", "cbBTC/WETH", "WETH>USDC>AERO>WETH", "WETH>DEGEN>USDC>WETH", "WETH/BRETT"];
const DEXES = ["uniswap-v2", "aerodrome", "uniswap-v3", "slipstream", "pancakev3", "baseswap", "sushiswap"];
const SIMS = ["local", "quoter-ok", "quoter-mismatch", "executor-ok", "executor-revert"];
const STATUSES = ["persisted", "taken", "closed"];
const DAY0 = Date.parse("2026-10-01T00:00:00Z");

/** Deterministic PRNG so failures reproduce. */
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/** One opportunity record shaped like paper.ts writes it (bigints as strings). */
function makeOpp(i, rand) {
  const pairSymbols = PAIRS[Math.floor(rand() * PAIRS.length)];
  const tri = pairSymbols.includes(">");
  const cl = !tri && rand() < 0.3;
  const d = () => DEXES[Math.floor(rand() * DEXES.length)];
  const netUsd = Math.round((rand() * 4 - 0.5) * 100) / 100;
  const foundAt = new Date(DAY0 + i * 30_000).toISOString(); // 30 s apart -> ~2880/day
  const base = {
    kind: "opportunity",
    mode: "paper",
    id: `${30_000_000 + i}-${i.toString(16).padStart(8, "0")}`,
    block: 30_000_000 + i,
    foundAt,
    pair: "0xaaa-0xbbb",
    pairSymbols,
    buyPool: "0x" + "1".repeat(40),
    sellPool: "0x" + "2".repeat(40),
    tokenIn: "0x4200000000000000000000000000000000000006",
    tokenInSymbol: "WETH",
    tokenMid: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    amountIn: "1234567890123456789",
    amountMid: "4000000000",
    amountOut: "1234999990123456789",
    profit: "432100000000000",
    profitUsd: netUsd + 0.05,
    gasUsd: 0.05,
    netUsd,
    sim: SIMS[Math.floor(rand() * SIMS.length)],
    hops: tri ? 3 : 2,
    stage: rand() < 0.2 ? "flashblock" : "block",
    sizeCurve: [["100", 0.1], ["200", 0.15]],
  };
  if (tri || cl) {
    const dexes = tri ? [d(), d(), d()] : [d(), d()];
    base.route = {
      tokens: tri ? ["0xa", "0xb", "0xc", "0xa"] : ["0xa", "0xb", "0xa"],
      pools: dexes.map((_, k) => "0x" + String(k + 3).repeat(40)),
      dexes,
      amounts: dexes.map(() => "1000").concat(["1001"]),
      label: pairSymbols,
      executorHops: dexes.map(() => ({ pool: "0x0", kind: 2, feePpm: 500 })),
    };
    base.buyDex = dexes[0];
    base.sellDex = dexes[dexes.length - 1];
  } else {
    base.buyDex = d();
    base.sellDex = d();
  }
  return base;
}

function kindOf(o) {
  return !o.route ? "classic" : o.hops >= 3 ? "triangular" : "cl";
}

let dir;
let store;
const truth = []; // { opp, status }

before(() => {
  dir = mkdtempSync(join(tmpdir(), "history-"));
  store = new Store(dir);
  const rand = rng(42);
  const lines = [];
  const waiting = [];
  let i = 0;
  // 50k lines: ~29k opportunities and their outcomes, outcomes 1-3 lines later; some never get one.
  while (lines.length < 50_000) {
    const o = makeOpp(i++, rand);
    lines.push(JSON.stringify(o));
    const t = { opp: o, status: "pending" };
    truth.push(t);
    if (rand() < 0.95) waiting.push(t);
    while (waiting.length > 2 || (waiting.length && rand() < 0.4)) {
      const w = waiting.shift();
      w.status = STATUSES[Math.floor(rand() * STATUSES.length)];
      lines.push(JSON.stringify({ kind: "outcome", id: w.opp.id, block: w.opp.block, finalizedAt: w.opp.foundAt, status: w.status, profitAtN1Usd: 0.1, profitAtN2Usd: null, realisticNetUsd: w.status === "persisted" ? 0.4 : 0, ...(w.status === "taken" ? { takenBy: "0xrival", takenTx: "0xtx" } : {}) }));
    }
  }
  lines.length = 50_000;
  // Make the truth table agree with what's actually in the (truncated) file.
  const outcomeIds = new Map();
  const oppIds = new Set();
  for (const l of lines) {
    const r = JSON.parse(l);
    if (r.kind === "outcome") outcomeIds.set(r.id, r.status);
    else oppIds.add(r.id);
  }
  for (let k = truth.length - 1; k >= 0; k--) {
    if (!oppIds.has(truth[k].opp.id)) truth.splice(k, 1);
    else truth[k].status = outcomeIds.get(truth[k].opp.id) ?? "pending";
  }
  // A torn line in the middle (interrupted write) must be skipped, not break offsets.
  lines.splice(1000, 0, '{"kind":"opportunity","id":"torn');
  writeFileSync(store.path("opportunities.jsonl"), lines.join("\n") + "\n");
});

after(() => rmSync(dir, { recursive: true, force: true }));

function brute(f) {
  const from = f.from !== undefined ? toSeconds(f.from, false) : -Infinity;
  const to = f.to !== undefined ? toSeconds(f.to, true) : Infinity;
  return truth.filter(({ opp, status }) => {
    const ts = Math.floor(Date.parse(opp.foundAt) / 1000);
    if (ts < from || ts > to) return false;
    if (f.pair && opp.pairSymbols.toLowerCase() !== f.pair.toLowerCase()) return false;
    if (f.dex && !(opp.route?.dexes ?? [opp.buyDex, opp.sellDex]).includes(f.dex)) return false;
    if (f.kind && kindOf(opp) !== f.kind) return false;
    if (f.status && status !== f.status) return false;
    if (f.sim && opp.sim !== f.sim) return false;
    if (f.minNetUsd !== undefined && !(Math.fround(opp.netUsd) >= Math.fround(f.minNetUsd))) return false;
    return true;
  });
}

test("builds the index over 50k lines and counts every opportunity", async () => {
  const idx = new OpportunityIndex(store, { chunkBytes: 256 * 1024 });
  await idx.start();
  assert.equal(idx.count, truth.length);
  assert.ok(truth.length > 25_000, `generated ${truth.length} opportunities`);
  console.log(`history: ${truth.length} opportunities in 50k lines, ${truth.filter((t) => t.status === "pending").length} without an outcome`);
  assert.equal(idx.query({ limit: 0 }).total, truth.length);
  idx.stop();
});

test("totals per filter match brute force", async () => {
  const idx = new OpportunityIndex(store);
  await idx.start();
  const filters = [
    {},
    { pair: "WETH/USDC" },
    { pair: "weth>usdc>aero>weth" },
    { dex: "aerodrome" },
    { dex: "pancakev3", kind: "cl" },
    { kind: "classic" },
    { kind: "triangular", minNetUsd: 1 },
    { status: "persisted" },
    { status: "taken", pair: "WETH/AERO" },
    { status: "pending" },
    { sim: "executor-ok" },
    { sim: "quoter-mismatch", dex: "slipstream" },
    { minNetUsd: 0.25 },
    { minNetUsd: -0.2, kind: "classic", status: "closed" },
    { from: "2026-10-03" },
    { from: "2026-10-02", to: "2026-10-02" },
    { from: "2026-10-04T06:00:00Z", to: "2026-10-05T18:30:00Z", dex: "uniswap-v3" },
    { from: DAY0 + 86_400_000, to: DAY0 + 2 * 86_400_000 - 1 },
  ];
  for (const f of filters) {
    const want = brute(f);
    const got = idx.query({ ...f, limit: 5 });
    assert.equal(got.total, want.length, `total for ${JSON.stringify(f)}`);
    // newest first: the first rows are the last matching records
    assert.deepEqual(
      got.rows.map((r) => r.id),
      want.slice(-5).reverse().map((t) => t.opp.id),
      `rows for ${JSON.stringify(f)}`,
    );
  }
  // Unknown values match nothing rather than everything.
  assert.equal(idx.query({ pair: "NOPE/NOPE" }).total, 0);
  assert.equal(idx.query({ dex: "nope" }).total, 0);
  assert.equal(idx.query({ sim: "nope" }).total, 0);
  idx.stop();
});

test("rows are slimmed like the dashboard (no bigints, legs, outcome, sizeCurve)", async () => {
  const idx = new OpportunityIndex(store, { symbol: (a) => (a === "0xa" ? "WETH" : a.slice(0, 4)) });
  await idx.start();
  const { rows } = idx.query({ kind: "triangular", status: "taken", limit: 1 });
  const r = rows[0];
  assert.ok(r);
  assert.equal(r.kind, "triangular");
  assert.equal(r.legs.length, 3);
  assert.equal(r.legs[0].from.symbol, "WETH");
  assert.equal(typeof r.legs[0].amountIn, "string");
  assert.equal(r.status, "taken");
  assert.equal(r.outcome.status, "taken");
  assert.equal(r.outcome.takenBy, "0xrival");
  assert.deepEqual(r.sizeCurve, [["100", 0.1], ["200", 0.15]]);
  assert.doesNotThrow(() => JSON.stringify(r));
  const classic = idx.query({ kind: "classic", limit: 1 }).rows[0];
  assert.equal(classic.legs.length, 2);
  assert.equal(classic.amountIn, "1234567890123456789");
  idx.stop();
});

test("paging walks every match exactly once, both orders", async () => {
  const idx = new OpportunityIndex(store);
  await idx.start();
  const f = { dex: "aerodrome", minNetUsd: 0 };
  const want = brute(f).map((t) => t.opp.id);
  for (const order of ["desc", "asc"]) {
    const seen = [];
    for (let offset = 0; ; offset += 500) {
      const page = idx.query({ ...f, order, offset, limit: 500 });
      assert.equal(page.total, want.length);
      if (!page.rows.length) break;
      seen.push(...page.rows.map((r) => r.id));
    }
    assert.deepEqual(seen, order === "asc" ? want : [...want].reverse());
  }
  assert.equal(idx.query({ limit: 10_000 }).rows.length, 500, "limit is capped at 500");
  idx.stop();
});

test("offsets stay stable (asOf) while new records are appended; new records are followed", async () => {
  const idx = new OpportunityIndex(store);
  await idx.start();
  const first = idx.query({ pair: "WETH/USDC", offset: 100, limit: 20 });
  const rand = rng(7);
  const added = [];
  for (let k = 0; k < 300; k++) {
    const o = makeOpp(1_000_000 + k, rand);
    o.pairSymbols = "WETH/USDC";
    store.append("opportunities.jsonl", o);
    added.push(o);
  }
  // Same snapshot -> same page.
  const again = idx.query({ pair: "WETH/USDC", offset: 100, limit: 20, asOf: first.asOf });
  assert.equal(again.total, first.total);
  assert.deepEqual(again.rows.map((r) => r.id), first.rows.map((r) => r.id));
  // Without asOf the new records are there, newest first.
  const fresh = idx.query({ pair: "WETH/USDC", limit: 3 });
  assert.equal(fresh.total, first.total + 300);
  assert.deepEqual(fresh.rows.map((r) => r.id), added.slice(-3).reverse().map((o) => o.id));
  // An outcome for an appended record updates its status.
  store.append("opportunities.jsonl", { kind: "outcome", id: added[299].id, block: added[299].block, status: "persisted", realisticNetUsd: 1.5 });
  const top = idx.query({ pair: "WETH/USDC", limit: 1 }).rows[0];
  assert.equal(top.status, "persisted");
  assert.equal(top.outcome.realisticNetUsd, 1.5);
  idx.stop();
});

test("a second process's writes are seen at query time (dashboard-only mode)", async () => {
  const d2 = mkdtempSync(join(tmpdir(), "history2-"));
  try {
    const s2 = new Store(d2);
    const idx = new OpportunityIndex(s2);
    await idx.start(); // no file yet
    assert.equal(idx.query().total, 0);
    const rand = rng(9);
    const file = s2.path("opportunities.jsonl");
    // Written behind the Store's back (another process), including a torn tail.
    appendFileSync(file, JSON.stringify(makeOpp(1, rand)) + "\n" + JSON.stringify(makeOpp(2, rand)) + "\n");
    appendFileSync(file, JSON.stringify(makeOpp(3, rand)).slice(0, 50));
    assert.equal(idx.query().total, 2);
    appendFileSync(file, JSON.stringify(makeOpp(3, rand)).slice(50) + "\n");
    assert.equal(idx.query().total, 3);
    // Truncation (file replaced) triggers a rebuild.
    writeFileSync(file, JSON.stringify(makeOpp(4, rand)) + "\n");
    idx.query();
    await idx.ready;
    assert.equal(idx.query().total, 1);
    idx.stop();
  } finally {
    rmSync(d2, { recursive: true, force: true });
  }
});

test("memory per opportunity is under 200 bytes (self-accounting and measured heap)", async () => {
  const idx = new OpportunityIndex(store);
  await idx.start();
  const per = idx.memoryBytes() / idx.count;
  assert.ok(per < 200, `index self-accounting ${per.toFixed(1)} bytes/opportunity`);
  idx.stop();

  // Measured: a fresh process with --expose-gc builds the index; heap + array buffers before/after.
  const script = `
    import { Store } from ${JSON.stringify(new URL("../dist/store.js", import.meta.url).href)};
    import { OpportunityIndex } from ${JSON.stringify(new URL("../dist/history.js", import.meta.url).href)};
    const store = new Store(${JSON.stringify(dir)});
    const m = () => { gc(); gc(); const u = process.memoryUsage(); return u.heapUsed + u.arrayBuffers; };
    const before = m();
    const idx = new OpportunityIndex(store);
    await idx.start();
    const after = m();
    console.log(JSON.stringify({ n: idx.count, bytes: after - before, est: idx.memoryBytes() }));
    globalThis.keep = idx;
  `;
  const res = spawnSync(process.execPath, ["--expose-gc", "--input-type=module", "-e", script], { encoding: "utf8", cwd: fileURLToPath(new URL("..", import.meta.url)) });
  assert.equal(res.status, 0, res.stderr);
  const { n, bytes } = JSON.parse(res.stdout.trim().split("\n").pop());
  const measured = bytes / n;
  // The index module itself and V8 bookkeeping are included, so this over-counts slightly.
  console.log(`history memory: self-accounting ${per.toFixed(1)} B/opp, measured ${measured.toFixed(1)} B/opp over ${n}`);
  assert.ok(measured < 200, `measured ${measured.toFixed(1)} bytes/opportunity over ${n}`);
});
