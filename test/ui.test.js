/**
 * Dashboard server (src/ui/server.ts): local-only access, per-run token,
 * no secrets in any response, live feed, cached balance reads, STOP control.
 * Runs against the compiled dist/ (npm run build first); needs no chain.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import { UiServer } from "../dist/ui/server.js";
import { Store } from "../dist/store.js";

const PRIVATE_KEY = "0x" + "ab".repeat(32);
const KEYED_RPC = "https://base-mainnet.g.alchemy.com/v2/SuperSecretKey123";
const BOT = "0x1111111111111111111111111111111111111111";

function setup(over = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ui-test-"));
  const store = new Store(dir);
  let multicalls = 0;
  const settings = {
    mode: "paper", minProfitUsd: 0.25, maxPools: 400, minPoolLiquidityWeth: 2, clPools: true, multiHop: true, maxHops: 3,
    flashSource: "morpho", flashblocks: false, liquidations: true, refreshMode: "events", fullRefreshBlocks: 150, priorityFeeGwei: 0.005,
    rpcFallbackUrls: [KEYED_RPC], mevFeed: true, reportDir: dir, privateKey: PRIVATE_KEY, rpcUrl: KEYED_RPC, wsUrl: "wss://base-mainnet.g.alchemy.com/v2/SuperSecretKey123",
    executorAddress: undefined, routeExecutorAddress: "0x7777777777777777777777777777777777777777",
  };
  const ui = new UiServer(
    {
      version: "test", settings, store, running: true, botAddress: BOT, telegram: false,
      usage: () => ({ since: new Date().toISOString(), requests: 1, byMethod: {}, alchemyCu: 0, alchemyCuPerDay: 0, activeEndpoint: "https://base-mainnet.g.alchemy.com/…", onPrimary: true, failovers: 0, transientErrors: 0, rateLimited: 0 }),
      pools: () => ({ total: 1, cl: 0, pairs: 1 }),
      ethUsd: () => 2000,
      summaries: async () => ({ paperDays: [] }),
      multicall: async (calls) => {
        multicalls++;
        return calls.map(() => ({ success: true, returnData: "0x" + "0".repeat(63) + "1" }));
      },
      symbol: () => "TKN",
      ...over,
    },
    { port: 0 },
  );
  return { ui, store, dir, multicalls: () => multicalls };
}

/** Raw HTTP so the Host header can be set (fetch refuses to). */
function http(port, path, { method = "GET", headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method, headers: { host: `localhost:${port}`, ...headers } }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on("error", reject);
    req.end();
  });
}
const portOf = (ui) => Number(new URL(ui.url).port);

test("serves the page with a per-run token and a script nonce", async (t) => {
  const { ui } = setup();
  assert.equal(await ui.start(), true);
  t.after(() => ui.close());
  const r = await http(portOf(ui), "/");
  assert.equal(r.status, 200);
  assert.match(r.headers["content-security-policy"], /script-src 'nonce-[^']+'/);
  assert.match(r.headers["content-security-policy"], /frame-ancestors 'none'/);
  assert.ok(r.body.includes(ui.token), "the page carries the token");
  assert.ok(!/<script(?![^>]*nonce=)/.test(r.body), "every script tag has the nonce");
});

test("refuses requests whose Host isn't localhost (DNS rebinding)", async (t) => {
  const { ui } = setup();
  await ui.start();
  t.after(() => ui.close());
  const r = await http(portOf(ui), "/api/state", { headers: { host: `evil.example:${portOf(ui)}`, "x-bot-token": ui.token } });
  assert.equal(r.status, 421);
});

test("every API call needs the page's token", async (t) => {
  const { ui } = setup();
  await ui.start();
  t.after(() => ui.close());
  const port = portOf(ui);
  assert.equal((await http(port, "/api/state")).status, 401);
  assert.equal((await http(port, "/api/state", { headers: { "x-bot-token": "wrong-token-wrong-token-wrong-1" } })).status, 401);
  assert.equal((await http(port, "/api/state", { headers: { "x-bot-token": ui.token } })).status, 200);
});

test("no response contains the private key or RPC keys", async (t) => {
  const { ui, store } = setup();
  await ui.start();
  t.after(() => ui.close());
  store.append("opportunities.jsonl", { kind: "opportunity", id: "1-a", block: 1, foundAt: new Date().toISOString(), pairSymbols: "WETH/USDC", buyPool: BOT, sellPool: BOT, buyDex: "aerodrome", sellDex: "uniswap-v2", tokenIn: BOT, tokenMid: BOT, amountIn: 1n, amountMid: 1n, amountOut: 2n, netUsd: 1, profitUsd: 1.1, gasUsd: 0.1, sim: "executor-ok", hops: 2 });
  const port = portOf(ui);
  for (const path of ["/", "/api/state", "/api/summary", "/api/recent", "/api/contracts", `/api/wallet?addresses=${BOT}`, "/api/review"]) {
    const r = await http(port, path, { headers: { "x-bot-token": ui.token } });
    assert.equal(r.status, 200, path);
    assert.ok(!r.body.includes("ab".repeat(32)), `${path} leaks the private key`);
    assert.ok(!r.body.includes("SuperSecretKey123"), `${path} leaks an RPC key`);
  }
});

test("live events reach the page, and a closed tab doesn't affect the bot", async (t) => {
  const { ui, store } = setup();
  await ui.start();
  t.after(() => ui.close());
  const port = portOf(ui);
  const events = [];
  const req = request({ host: "127.0.0.1", port, path: `/api/events?t=${encodeURIComponent(ui.token)}`, headers: { host: `localhost:${port}` } });
  const got = new Promise((resolve) => {
    req.on("response", (res) => {
      res.setEncoding("utf8");
      let buf = "";
      res.on("data", (chunk) => {
        buf += chunk;
        for (const m of buf.matchAll(/event: (\w[\w-]*)\n/g)) if (!events.includes(m[1])) events.push(m[1]);
        if (events.includes("hello") && events.includes("block") && events.includes("opp")) resolve();
      });
      // Push once the stream is open.
      setTimeout(() => {
        ui.pushBlock({ n: 10, at: Date.now(), ms: 5, opps: 1, bestNetUsd: 1, mev: 0, arbs: 0, gasUsd: 0.01, ethUsd: 2000 });
        store.append("opportunities.jsonl", { kind: "opportunity", id: "10-x", block: 10, foundAt: new Date().toISOString(), pairSymbols: "WETH/USDC", netUsd: 1, sim: "executor-ok", hops: 2, amountIn: 5n });
      }, 50);
    });
  });
  req.end();
  await got;
  assert.deepEqual(events.slice(0, 3), ["hello", "block", "opp"]);
  req.destroy();
  await new Promise((r) => setTimeout(r, 50));
  // The bot keeps publishing after the tab went away.
  ui.pushBlock({ n: 11, at: Date.now(), ms: 5, opps: 0, bestNetUsd: null, mev: 0, arbs: 0, gasUsd: 0.01, ethUsd: 2000 });
  store.append("opportunities.jsonl", { kind: "outcome", id: "10-x", status: "closed", realisticNetUsd: 0 });
});

test("balance reads are cached, so more tabs never mean more RPC calls", async (t) => {
  const s = setup();
  await s.ui.start();
  t.after(() => s.ui.close());
  const port = portOf(s.ui);
  for (let i = 0; i < 3; i++) {
    const r = await http(port, `/api/wallet?addresses=${BOT}`, { headers: { "x-bot-token": s.ui.token } });
    assert.equal(r.status, 200);
  }
  assert.equal(s.multicalls(), 1);
  // Pages that never ask for balances cause no RPC calls at all.
  await http(port, "/api/state", { headers: { "x-bot-token": s.ui.token } });
  await http(port, "/api/recent", { headers: { "x-bot-token": s.ui.token } });
  await http(port, "/api/summary", { headers: { "x-bot-token": s.ui.token } });
  assert.equal(s.multicalls(), 1);
});

test("the stop button writes the STOP file; resuming is never possible from the page", async (t) => {
  const { ui, store } = setup();
  await ui.start();
  t.after(() => ui.close());
  const port = portOf(ui);
  const evil = await http(port, "/api/stop", { method: "POST", headers: { "x-bot-token": ui.token, origin: "http://evil.example" } });
  assert.equal(evil.status, 403);
  assert.equal(existsSync(store.path("STOP")), false);
  const r = await http(port, "/api/stop", { method: "POST", headers: { "x-bot-token": ui.token, origin: `http://localhost:${port}` } });
  assert.equal(r.status, 200);
  assert.equal(existsSync(store.path("STOP")), true);
  assert.equal((await http(port, "/api/resume", { method: "POST", headers: { "x-bot-token": ui.token } })).status, 404);
  assert.equal(existsSync(store.path("STOP")), true);
});

test("a busy port leaves the bot running without a dashboard", async (t) => {
  const a = setup();
  await a.ui.start();
  t.after(() => a.ui.close());
  const b = setup();
  const second = new UiServer(b.ui.src, { port: portOf(a.ui) });
  assert.equal(await second.start(), false);
});

test("opportunity details carry hop-by-hop amounts with token decimals", async (t) => {
  const { ui, store } = setup({ token: (a) => (a === BOT ? { symbol: "WETH", decimals: 18 } : undefined) });
  await ui.start();
  t.after(() => ui.close());
  store.append("opportunities.jsonl", {
    kind: "opportunity", id: "5-r", block: 5, foundAt: new Date().toISOString(), pairSymbols: "WETH > USDC > WETH", netUsd: 2, profitUsd: 2.1, gasUsd: 0.1, sim: "quoter-ok", hops: 2,
    route: { tokens: [BOT, "0x2222222222222222222222222222222222222222", BOT], pools: ["0xaa00000000000000000000000000000000000001", "0xbb00000000000000000000000000000000000002"], dexes: ["uniswap-v3", "aerodrome"], amounts: ["1000000000000000000", "2450000000", "1001000000000000000"], executorHops: [{ feePpm: 500 }, { feePpm: 3000 }] },
  });
  const r = JSON.parse((await http(portOf(ui), "/api/recent", { headers: { "x-bot-token": ui.token } })).body);
  const legs = r.opps[0].legs;
  assert.equal(legs.length, 2);
  assert.deepEqual([legs[0].from.symbol, legs[0].from.decimals, legs[0].amountIn, legs[0].feePpm], ["WETH", 18, "1000000000000000000", 500]);
  assert.equal(legs[1].amountOut, "1001000000000000000");
});
