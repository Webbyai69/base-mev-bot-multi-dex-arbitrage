/**
 * Cross-chain spread monitor (bots/xchain-monitor): selectors, pool resolution and verification,
 * price maths, cost model, window counting, the summary shape, the read-only transport, and one
 * end-to-end --once run against a local mock JSON-RPC server. No network: every RPC is mocked.
 * Imports the monitor's .ts files directly (Node >= 22.18 strips types).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { keccak256, selector } from "../bots/xchain-monitor/keccak.ts";
import { httpTransport, redact, RpcError } from "../bots/xchain-monitor/rpc.ts";
import { SEL, priceFromSqrtX96, resolvePools, readPrices, checkChainId } from "../bots/xchain-monitor/pools.ts";
import { chainPairs, computeChecks, costBps } from "../bots/xchain-monitor/spreads.ts";
import { summarize, parseRecord, loadRecords } from "../bots/xchain-monitor/summary.ts";
import { Monitor, loadConfig } from "../bots/xchain-monitor/monitor.ts";

const DIR = fileURLToPath(new URL("../bots/xchain-monitor/", import.meta.url));
const CFG = JSON.parse(readFileSync(join(DIR, "config.json"), "utf8"));

// ---------------------------------------------------------------- mock chain ---------------------
const pad = (h) => h.replace(/^0x/, "").toLowerCase().padStart(64, "0");
const hexWord = (n) => "0x" + BigInt(n).toString(16).padStart(64, "0");
const addrWord = (a) => "0x" + pad(a);
const ZERO = "0x" + "0".repeat(40);
let nextPool = 1;
const fakeAddr = () => "0x" + (0xa000 + nextPool++).toString(16).padStart(40, "0");

/** sqrtPriceX96 for "1 base = price quote", given which token sorts first. */
function sqrtX96(price, baseIsToken0, dec0, dec1) {
  const oneIn0 = baseIsToken0 ? price : 1 / price; // token1 per token0, human
  const raw = oneIn0 * 10 ** (dec1 - dec0);
  return BigInt(Math.round(Math.sqrt(raw) * 2 ** 64)) * 2n ** 32n;
}

/**
 * A fake chain for one config chain id. prices: {"WETH/USDC": 2500, ...}. Each asset gets a deep
 * pool at the first factory's second tier and a shallow one at its third; Slipstream factories
 * return a pool whose tokens don't match (must be rejected).
 */
function mockChain(chainKey, prices, opts = {}) {
  const chain = CFG.chains[chainKey];
  const pools = new Map(); // addr -> {token0, token1, fee, L, sqrt}
  const getPool = new Map(); // `${factory}|${tier}|${tA}|${tB}` -> addr
  for (const asset of CFG.assets) {
    const tb = chain.tokens[asset.base];
    const tq = chain.tokens[asset.quote];
    const [lo, hi] = BigInt(tb.address) < BigInt(tq.address) ? [tb, tq] : [tq, tb];
    const baseIs0 = lo === tb;
    const price = prices[asset.id];
    if (price === undefined) continue;
    chain.factories.forEach((f, fi) => {
      if (f.kind === "v3-tickspacing") {
        const a = fakeAddr();
        pools.set(a, { token0: lo.address, token1: hi.address.replace(/.$/, "0"), fee: 100, L: 10n ** 30n, sqrt: 1n });
        getPool.set(`${f.address}|${f.tiers[0]}`.toLowerCase() + `|${asset.id}`, a);
        return;
      }
      if (fi !== 0) return;
      const deep = opts.expectedAsDeep && chain.expected?.[asset.id] ? chain.expected[asset.id] : fakeAddr();
      const shallow = fakeAddr();
      const s = sqrtX96(price, baseIs0, lo.decimals, hi.decimals);
      pools.set(deep.toLowerCase(), { token0: lo.address, token1: hi.address, fee: f.tiers[1], L: 10n ** 20n, sqrt: s });
      // the shallow pool is 2% off: if it were picked, the price tests would fail
      pools.set(shallow, { token0: lo.address, token1: hi.address, fee: f.tiers[2], L: 10n ** 12n, sqrt: sqrtX96(price * 1.02, baseIs0, lo.decimals, hi.decimals) });
      getPool.set(`${f.address}|${f.tiers[1]}`.toLowerCase() + `|${asset.id}`, deep.toLowerCase());
      getPool.set(`${f.address}|${f.tiers[2]}`.toLowerCase() + `|${asset.id}`, shallow);
    });
  }
  const tokenByAddr = new Map(Object.values(chain.tokens).map((t) => [t.address.toLowerCase(), t]));
  const assetOf = (a, b) => {
    for (const asset of CFG.assets) {
      const x = chain.tokens[asset.base].address.toLowerCase();
      const y = chain.tokens[asset.quote].address.toLowerCase();
      if ((a === x && b === y) || (a === y && b === x)) return asset.id;
    }
    return null;
  };
  const calls = [];
  const answer = ({ method, params }) => {
    calls.push(method);
    if (method === "eth_chainId") return "0x" + (opts.wrongChainId ?? chain.chainId).toString(16);
    if (method === "eth_getCode") return pools.has(params[0].toLowerCase()) ? "0x6080" : "0x";
    if (method !== "eth_call") throw new Error("unexpected method " + method);
    const to = params[0].to.toLowerCase();
    const data = params[0].data.toLowerCase();
    const sel = data.slice(0, 10);
    if (sel === SEL.decimals) {
      const t = tokenByAddr.get(to);
      if (!t) throw new Error("revert");
      return hexWord(opts.badDecimals === to ? 8 : t.decimals);
    }
    if (sel === SEL.getPoolFee || sel === SEL.getPoolTick) {
      const a = "0x" + data.slice(10 + 24, 10 + 64);
      const b = "0x" + data.slice(10 + 64 + 24, 10 + 128);
      let tier = BigInt("0x" + data.slice(10 + 128, 10 + 192));
      if (tier >= 2n ** 255n) tier -= 2n ** 256n;
      const asset = assetOf(a, b);
      return addrWord(getPool.get(`${to}|${tier}|${asset}`) ?? ZERO);
    }
    const p = pools.get(to);
    if (!p) throw new Error("revert");
    if (sel === SEL.token0) return addrWord(p.token0);
    if (sel === SEL.token1) return addrWord(p.token1);
    if (sel === SEL.fee) return hexWord(p.fee);
    if (sel === SEL.liquidity) return hexWord(p.L);
    if (sel === SEL.slot0) return "0x" + pad(p.sqrt.toString(16)) + pad("1") + pad("0");
    throw new Error("revert");
  };
  /** in-process transport (same contract as httpTransport) */
  const transport = async (cs) =>
    cs.map((c) => {
      try {
        return answer(c);
      } catch (e) {
        return new RpcError(e.message);
      }
    });
  return { transport, answer, calls, pools };
}

const PRICES = {
  base: { "WETH/USDC": 2500, "USDC/USDT": 1.0002 },
  arb: { "WETH/USDC": 2510, "USDC/USDT": 1.0001 },
  op: { "WETH/USDC": 2501, "USDC/USDT": 1.0 },
  eth: { "WETH/USDC": 2500.5, "USDC/USDT": 0.9999 },
};

// ---------------------------------------------------------------- tests --------------------------

test("keccak256 and the selectors match the known Ethereum values", () => {
  assert.equal(keccak256(""), "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470");
  assert.equal(selector("transfer(address,uint256)"), "0xa9059cbb");
  assert.deepEqual(SEL, {
    token0: "0x0dfe1681",
    token1: "0xd21220a7",
    fee: "0xddca3f43",
    slot0: "0x3850c7bd",
    liquidity: "0x1a686502",
    decimals: "0x313ce567",
    getPoolFee: "0x1698ee82",
    getPoolTick: "0x28af8d0b",
  });
});

test("priceFromSqrtX96 handles both token orders and decimals", () => {
  // Ethereum USDC/WETH 0.05%: token0 USDC (6), token1 WETH (18); base = WETH
  const s = sqrtX96(2500, false, 6, 18);
  assert.ok(Math.abs(priceFromSqrtX96(s, { baseIsToken0: false, dec0: 6, dec1: 18 }) - 2500) < 1e-6);
  const s2 = sqrtX96(2500, true, 18, 6);
  assert.ok(Math.abs(priceFromSqrtX96(s2, { baseIsToken0: true, dec0: 18, dec1: 6 }) - 2500) < 1e-6);
  assert.ok(Number.isNaN(priceFromSqrtX96(0n, { baseIsToken0: true, dec0: 18, dec1: 6 })));
});

test("resolvePools keeps the deepest verified pool and rejects token mismatches", async () => {
  const m = mockChain("base", PRICES.base);
  await checkChainId(m.transport, 8453);
  const { pools, notes } = await resolvePools(m.transport, "base", CFG.chains.base, CFG.assets);
  assert.equal(pools.length, 2);
  for (const p of pools) {
    assert.equal(p.venue, "uniswap-v3");
    assert.equal(p.tier, 500);
    assert.equal(p.feeBps, 5);
  }
  assert.ok(notes.some((n) => /aerodrome-slipstream\/1 rejected \(token mismatch\)/.test(n)), notes.join("\n"));
  const px = await readPrices(m.transport, pools);
  assert.ok(Math.abs(px[0] - 2500) < 1e-6);
  assert.ok(Math.abs(px[1] - 1.0002) < 1e-9);
  assert.ok(m.calls.every((c) => ["eth_chainId", "eth_call", "eth_getCode"].includes(c)));
});

test("resolvePools flags the expected pool and refuses a token with the wrong decimals", async () => {
  const m = mockChain("eth", PRICES.eth, { expectedAsDeep: true });
  const { pools } = await resolvePools(m.transport, "eth", CFG.chains.eth, CFG.assets);
  assert.equal(pools.length, 2);
  assert.ok(pools.every((p) => p.matchesExpected === true));

  const usdt = CFG.chains.arb.tokens.USDT.address.toLowerCase();
  const bad = mockChain("arb", PRICES.arb, { badDecimals: usdt });
  const r = await resolvePools(bad.transport, "arb", CFG.chains.arb, CFG.assets);
  assert.deepEqual(r.pools.map((p) => p.asset), ["WETH/USDC"]);
  assert.ok(r.notes.some((n) => /USDT decimals 8, expected 6/.test(n)));
});

test("checkChainId refuses an endpoint on the wrong chain", async () => {
  const m = mockChain("arb", PRICES.arb, { wrongChainId: 1 });
  await assert.rejects(checkChainId(m.transport, 42161), /chain 1, expected 42161/);
});

test("cost model: bridge bps + both swap fees + gas and fixed USD over the notional", () => {
  const weth = CFG.assets[0];
  // base-arb: across l2 4bps + 5 + 5 + (0.02+0.03+0.1)/10000*1e4 = 14.15
  assert.equal(Math.round(costBps(CFG.costs, weth, "base", "arb", 5, 5, 10_000) * 100) / 100, 14.15);
  // base-eth: across eth 6bps + 5 + 5 + (0.02+2.5+3)/10000*1e4 = 21.52
  assert.equal(Math.round(costBps(CFG.costs, weth, "base", "eth", 5, 5, 10_000) * 100) / 100, 21.52);
  const ov = { ...CFG.costs, pairOverrides: { "base-arb": { bridgeBps: 0, fixedUsd: 0 } } };
  assert.equal(Math.round(costBps(ov, weth, "base", "arb", 1, 1, 10_000) * 100) / 100, 2.05);
  assert.deepEqual(chainPairs(["base", "arb", "op", "eth"]).map((p) => p.join("-")), ["base-arb", "base-op", "base-eth", "arb-op", "arb-eth", "op-eth"]);
});

test("computeChecks: gap, direction, net and the open flag", () => {
  const pool = (chain, asset) => ({ chain, asset, venue: "uniswap-v3", feeBps: 5 });
  const pools = new Map();
  const prices = new Map();
  for (const c of ["base", "arb"]) {
    pools.set(`${c}|WETH/USDC`, pool(c, "WETH/USDC"));
  }
  prices.set("base|WETH/USDC", 2500);
  prices.set("arb|WETH/USDC", 2510); // 40 bps gap
  const now = new Date("2026-10-13T12:00:00Z");
  const recs = computeChecks(CFG, pools, prices, now);
  assert.equal(recs.length, 1);
  const r = recs[0];
  assert.equal(r.a, "base");
  assert.equal(r.b, "arb");
  assert.equal(r.buyOn, "base");
  assert.equal(r.sellOn, "arb");
  assert.equal(r.gapBps, 40);
  assert.equal(r.costBps, 14.15);
  assert.equal(r.netBps, 25.85);
  assert.equal(r.open, true);
  assert.equal(r.estUsd, 25.85);
  prices.set("arb|WETH/USDC", 2501); // 4 bps: closed
  const c2 = computeChecks(CFG, pools, prices, now)[0];
  assert.equal(c2.open, false);
  assert.equal(c2.estUsd, 0);
  prices.set("arb|WETH/USDC", NaN);
  assert.equal(computeChecks(CFG, pools, prices, now).length, 0);
});

function rec(ts, net, extra = {}) {
  return { ts, asset: "WETH/USDC", a: "base", b: "arb", pa: 1, pb: 1, buyOn: "base", sellOn: "arb", gapBps: net + 14, costBps: 14, netBps: net, open: net > 0, notionalUsd: 10000, estUsd: Math.max(0, net), venues: ["uniswap-v3", "uniswap-v3"], ...extra };
}

test("summarize counts windows as runs of open checks, today and over 24 h", () => {
  const now = new Date("2026-10-13T12:00:00Z");
  const recs = [
    rec("2026-10-12T20:00:00Z", 3), // yesterday: a window in the last 24 h, not today
    rec("2026-10-12T20:00:15Z", 1),
    rec("2026-10-13T10:00:00Z", -2),
    rec("2026-10-13T10:00:15Z", 5), // window 2 (today)
    rec("2026-10-13T10:00:30Z", 8),
    rec("2026-10-13T10:00:45Z", -1),
    rec("2026-10-13T11:00:00Z", 2), // window 3 (today)
    rec("2026-10-13T11:59:45Z", -4),
    rec("2026-10-11T11:00:00Z", 50), // older than 24 h: ignored
  ];
  const s = summarize(recs, now, 15_000);
  assert.equal(s.rows.length, 1);
  const r = s.rows[0];
  assert.equal(r.windows24h, 3);
  assert.equal(r.windowsToday, 2);
  assert.deepEqual(r.bestWindow, { netBps: 8, gapBps: 22, at: "2026-10-13T10:00:30Z" });
  assert.equal(r.estUsdPer10k, 8);
  assert.equal(r.estUsdPer10kNow, 0);
  assert.equal(r.netBps, -4);
  assert.equal(r.open, false);
  assert.equal(r.route, "base↔arb");
  assert.equal(r.hist24h.length, 24);
  assert.equal(r.hist24h[23], 10); // 11:59:45 -> last hour, gap -4+14
  assert.equal(r.checks24h, 8);
  assert.equal(s.totals.openWindows24h, 3);
  assert.equal(s.totals.bestNetBps, 8);
});

test("summarize: a long silence ends a window; a stale open check is not 'open now'", () => {
  const now = new Date("2026-10-13T12:00:00Z");
  const s = summarize([rec("2026-10-13T11:00:00Z", 5), rec("2026-10-13T11:10:00Z", 5)], now, 15_000);
  assert.equal(s.rows[0].windows24h, 2);
  assert.equal(s.rows[0].open, false);
  assert.equal(s.totals.openNow, 0);
});

test("parseRecord drops malformed lines; loadRecords reads a JSONL file", async () => {
  assert.equal(parseRecord("not json"), null);
  assert.equal(parseRecord(JSON.stringify({ asset: "x" })), null);
  assert.equal(parseRecord(JSON.stringify(rec("bad", 1))), null);
  const dir = mkdtempSync(join(tmpdir(), "xchain-"));
  const f = join(dir, "s.jsonl");
  const { writeFileSync } = await import("node:fs");
  writeFileSync(f, [JSON.stringify(rec("2026-10-13T11:00:00Z", 1)), "garbage", JSON.stringify(rec("2026-10-01T11:00:00Z", 1)), ""].join("\n"));
  const got = await loadRecords(f, Date.parse("2026-10-12T12:00:00Z"));
  assert.equal(got.length, 1);
  assert.deepEqual(await loadRecords(join(dir, "missing.jsonl"), 0), []);
});

test("Monitor.tick over four mocked chains writes JSONL and the wrapper metrics", async () => {
  const dir = mkdtempSync(join(tmpdir(), "xchain-"));
  const cfg = { ...loadConfig({}), outDir: dir };
  const mocks = Object.fromEntries(Object.keys(PRICES).map((c) => [c, mockChain(c, PRICES[c])]));
  const transports = Object.fromEntries(Object.entries(mocks).map(([c, m]) => [c, m.transport]));
  const logs = [];
  const mon = new Monitor(cfg, transports, { log: (s) => logs.push(s) });
  const t0 = new Date("2026-10-13T12:00:00Z");
  const recs = await mon.tick(t0);
  assert.equal(recs.length, 12); // 2 assets x 6 pairs
  const ba = recs.find((r) => r.asset === "WETH/USDC" && r.a === "base" && r.b === "arb");
  assert.equal(ba.gapBps, 40);
  assert.equal(ba.open, true);
  const lines = readFileSync(join(dir, "xchain-spreads.jsonl"), "utf8").trim().split("\n");
  assert.equal(lines.length, 12);
  for (const l of lines) assert.ok(parseRecord(l));
  const m = JSON.parse(readFileSync(join(dir, "xchain-monitor.fleet-metrics.json"), "utf8"));
  assert.equal(m.pnlUsd, 0);
  assert.equal(m.sends, 0);
  assert.equal(m.gasUsd, 0);
  assert.ok(m.routes.length <= 12 && m.routes.length > 0);
  assert.deepEqual(Object.keys(m.routes[0]).sort(), ["count", "gapBps", "netBps", "pair", "usd", "venues"]);
  assert.equal(m.routes[0].pair, "WETH/USDC");
  assert.ok(Object.keys(m.metrics).length <= 12);
  assert.equal(m.metrics.openWindows24h, recs.filter((r) => r.open).length);
  assert.equal(m.metrics.bestNetBps, Math.max(...recs.map((r) => r.netBps)));
  assert.equal(m.metrics.chainsLive, 4);
  assert.equal(m.metrics.poolsVerified, 8);
  assert.ok(m.detail.length <= 300);
  // a second check 15 s later continues the same windows rather than opening new ones
  await mon.tick(new Date(t0.getTime() + 15_000));
  const m2 = JSON.parse(readFileSync(join(dir, "xchain-monitor.fleet-metrics.json"), "utf8"));
  assert.equal(m2.metrics.openWindows24h, m.metrics.openWindows24h);
  assert.equal(m2.metrics.checks24h, 24);
});

test("Monitor: a chain without an RPC URL or on the wrong chain id is reported, the rest keep working", async () => {
  const dir = mkdtempSync(join(tmpdir(), "xchain-"));
  const cfg = { ...loadConfig({}), outDir: dir };
  const mon = new Monitor(cfg, {
    base: mockChain("base", PRICES.base).transport,
    arb: mockChain("arb", PRICES.arb, { wrongChainId: 10 }).transport,
    op: mockChain("op", PRICES.op).transport,
    eth: null,
  }, { log: () => {} });
  const recs = await mon.tick(new Date("2026-10-13T12:00:00Z"));
  assert.deepEqual([...new Set(recs.map((r) => `${r.a}-${r.b}`))], ["base-op"]);
  const m = JSON.parse(readFileSync(join(dir, "xchain-monitor.fleet-metrics.json"), "utf8"));
  assert.equal(m.metrics.chainsLive, 2);
  assert.equal(m.metrics.chainsConfigured, 3);
  assert.match(m.detail, /eth: ETH_RPC_URL not set/);
  assert.match(m.detail, /arb: endpoint is chain 10, expected 42161/);
});

test("loadConfig applies bounded env overrides and transportsFromEnv ignores non-http values", () => {
  const c = loadConfig({ XCHAIN_INTERVAL_MS: "10", XCHAIN_NOTIONAL_USD: "25000", XCHAIN_MIN_NET_BPS: "2", XCHAIN_OUT_DIR: "/x" });
  assert.equal(c.intervalMs, 5000);
  assert.equal(c.notionalUsd, 25000);
  assert.equal(c.minNetBps, 2);
  assert.equal(c.outDir, "/x");
  const t = Monitor.transportsFromEnv(c, { BASE_RPC_URL: "https://example.invalid/k", ARB_RPC_URL: "file:///etc/passwd" });
  assert.equal(typeof t.base, "function");
  assert.equal(t.arb, null);
  assert.equal(t.eth, null);
});

// ---------------------------------------------------------------- HTTP transport ----------------

function rpcServer({ batch = true, failPath = null } = {}) {
  const chains = Object.fromEntries(Object.keys(PRICES).map((c) => [c, mockChain(c, PRICES[c])]));
  const seen = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const chain = req.url.split("/")[1];
      const m = chains[chain];
      const msg = JSON.parse(body);
      seen.push({ url: req.url, batch: Array.isArray(msg) });
      if (failPath && req.url.startsWith(failPath)) {
        res.writeHead(500);
        return res.end(`boom at http://127.0.0.1${req.url}`);
      }
      if (Array.isArray(msg) && !batch) {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "batch not supported" } }));
      }
      const one = (c) => {
        try {
          return { jsonrpc: "2.0", id: c.id, result: m.answer(c) };
        } catch (e) {
          return { jsonrpc: "2.0", id: c.id, error: { code: 3, message: "execution reverted" } };
        }
      };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(Array.isArray(msg) ? msg.map(one).reverse() : one(msg)));
    });
  });
  return new Promise((ok) => server.listen(0, "127.0.0.1", () => ok({ server, seen, port: server.address().port })));
}

test("httpTransport: batches, re-orders by id, falls back to single calls, refuses writes", async () => {
  const { server, seen, port } = await rpcServer({ batch: false });
  try {
    const t = httpTransport(`http://127.0.0.1:${port}/base/SECRET-KEY-123`);
    const [cid, dec] = await t([
      { method: "eth_chainId", params: [] },
      { method: "eth_call", params: [{ to: CFG.chains.base.tokens.USDC.address, data: SEL.decimals }, "latest"] },
    ]);
    assert.equal(cid, "0x2105");
    assert.equal(BigInt(dec), 6n);
    assert.ok(seen.some((s) => s.batch) && seen.some((s) => !s.batch));
    await assert.rejects(t([{ method: "eth_sendRawTransaction", params: ["0x00"] }]), /refused non-read method/);
    await assert.rejects(t([{ method: "eth_sendTransaction", params: [{}] }]), /refused/);
  } finally {
    server.close();
  }
  const b = await rpcServer({ batch: true });
  try {
    const t = httpTransport(`http://127.0.0.1:${b.port}/eth`);
    const r = await t([
      { method: "eth_chainId", params: [] },
      { method: "eth_call", params: [{ to: "0x0000000000000000000000000000000000000001", data: SEL.decimals }, "latest"] },
    ]);
    assert.equal(r[0], "0x1"); // response came back reversed; ids put it right
    assert.ok(r[1] instanceof RpcError);
    assert.equal(b.seen.length, 1);
  } finally {
    b.server.close();
  }
});

test("errors never carry the RPC URL", async () => {
  const { server, port } = await rpcServer({ failPath: "/op" });
  try {
    const url = `http://127.0.0.1:${port}/op/SECRET-KEY-123?apikey=abc`;
    const t = httpTransport(url);
    await assert.rejects(t([{ method: "eth_chainId", params: [] }]), (e) => !e.message.includes("SECRET") && !e.message.includes("127.0.0.1"));
    const dead = httpTransport("http://127.0.0.1:1/x/SECRET-KEY-123", 2000);
    await assert.rejects(dead([{ method: "eth_chainId", params: [] }]), (e) => !e.message.includes("SECRET"));
  } finally {
    server.close();
  }
  assert.equal(redact("fetch failed for https://rpc.example/v2/abcdef timeout"), "fetch failed for <rpc> timeout");
  assert.equal(redact("bad key abc123 at host", ["abc123"]), "bad key <rpc> at host");
});

test("monitor.ts --once end to end against a local JSON-RPC server (four chains)", async () => {
  const { server, port } = await rpcServer();
  const dir = mkdtempSync(join(tmpdir(), "xchain-"));
  try {
    const base = `http://127.0.0.1:${port}`;
    const env = {
      PATH: process.env.PATH,
      BASE_RPC_URL: `${base}/base/SECRET-KEY-123`,
      ARB_RPC_URL: `${base}/arb`,
      OP_RPC_URL: `${base}/op`,
      ETH_RPC_URL: `${base}/eth`,
      XCHAIN_OUT_DIR: dir,
    };
    const out = await new Promise((ok, bad) => {
      const p = spawn(process.execPath, [join(DIR, "monitor.ts"), "--once"], { env });
      let s = "";
      p.stdout.on("data", (d) => (s += d));
      p.stderr.on("data", (d) => (s += d));
      p.on("exit", (code) => (code === 0 ? ok(s) : bad(new Error(`exit ${code}: ${s}`))));
    });
    assert.match(out, /detect only, never trades or bridges/);
    assert.match(out, /WETH\/USDC base↔arb gap 40bps cost 14\.15bps net 25\.85bps OPEN/);
    assert.ok(!out.includes("SECRET"), "the RPC URL must never be printed");
    const lines = readFileSync(join(dir, "xchain-spreads.jsonl"), "utf8").trim().split("\n");
    assert.equal(lines.length, 12);
    assert.ok(!lines.join("").includes("SECRET"));
    assert.ok(existsSync(join(dir, "xchain-monitor.fleet-metrics.json")));
    // the summary CLI reads the same file
    const sum = await new Promise((ok, bad) => {
      const p = spawn(process.execPath, [join(DIR, "summary.ts"), join(dir, "xchain-spreads.jsonl")], { env: { PATH: process.env.PATH } });
      let s = "";
      p.stdout.on("data", (d) => (s += d));
      p.on("exit", (code) => (code === 0 ? ok(s) : bad(new Error(`exit ${code}`))));
    });
    const j = JSON.parse(sum);
    assert.equal(j.rows.length, 12);
    assert.ok(j.rows[0].netBps >= j.rows[11].netBps);
  } finally {
    server.close();
  }
});

test("the monitor's source never sends, signs or bridges", () => {
  for (const f of ["monitor.ts", "pools.ts", "rpc.ts", "spreads.ts", "summary.ts"]) {
    const src = readFileSync(join(DIR, f), "utf8");
    assert.ok(!/sendRawTransaction|sendTransaction|eth_sign|signTransaction|privateKey|PRIVATE_KEY|Wallet\(/.test(src.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "")), f);
  }
  const wrapper = JSON.parse(readFileSync(new URL("../bots/wrapper/configs/xchain-monitor.json", import.meta.url), "utf8"));
  assert.equal(wrapper.id, "xchain-monitor");
  assert.deepEqual(wrapper.commands.paper, []);
  assert.deepEqual(wrapper.commands.live, []);
  assert.deepEqual(wrapper.commands.detect, ["node", "bots/xchain-monitor/monitor.ts"]);
  assert.equal(wrapper.metricsFile, "data/fleet/xchain-monitor.fleet-metrics.json");
});
