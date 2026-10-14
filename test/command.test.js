/**
 * Command center (src/command/*): agent tokens and scopes, telemetry maths,
 * health rules, node redaction/probing, and the HTTP routes as an agent sees
 * them. Runs against the compiled dist/; needs no chain and no network.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, request } from "node:http";
import { AgentRegistry, permits, requiredScope } from "../dist/command/agents.js";
import { health, IssueBoard } from "../dist/command/health.js";
import { configuredNodes, probe, publicNodes, redactHost, NodeBook } from "../dist/command/nodes.js";
import { Records } from "../dist/command/records.js";
import { hourly, latency, leaks, racers, routeScores, simulate } from "../dist/command/telemetry.js";
import { UiServer } from "../dist/ui/server.js";
import { Store } from "../dist/store.js";

const tmp = () => mkdtempSync(join(tmpdir(), "cmd-test-"));
const NOW = Date.parse("2026-10-11T12:00:00Z");
const ago = (ms) => new Date(NOW - ms).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

test("agent tokens: shown once, stored as a hash, scoped, and nothing can sign", () => {
  const path = join(tmp(), "agents.json");
  const reg = new AgentRegistry(path);
  const { agent, token } = reg.create("ops-1", "Claude Code", ["tune"]);
  assert.match(token, /^agt_[\w-]{32}$/);
  assert.deepEqual(agent.scopes, ["read", "tune"], "read is always granted");
  assert.equal("tokenHash" in agent, false);
  const disk = readFileSync(path, "utf8");
  assert.ok(!disk.includes(token), "the token never reaches disk");
  assert.match(disk, /"tokenHash": "[0-9a-f]{64}"/);
  assert.equal(new AgentRegistry(path).verify(token).id, agent.id, "survives a restart");
  assert.equal(reg.verify(token.slice(0, -1) + "x"), undefined);
  assert.equal(reg.verify(undefined), undefined);
  assert.throws(() => reg.create("evil", "", ["sign"]), /nothing can sign/);
  assert.throws(() => reg.create("evil", "", ["withdraw"]), /unknown scope/);
  reg.setPaused(agent.id, true);
  assert.equal(permits({ who: "agent", agent: reg.verify(token) }, "read"), false, "a paused agent can do nothing");
  assert.equal(reg.revoke(agent.id), true);
  assert.equal(reg.verify(token), undefined);
});

test("agent rate limit: 120 a minute, refilling over time", () => {
  const reg = new AgentRegistry(join(tmp(), "agents.json"));
  const { token } = reg.create("loop", "", ["read"]);
  const a = reg.verify(token);
  let ok = 0;
  for (let i = 0; i < 200; i++) if (reg.allow(a, NOW)) ok++;
  assert.equal(ok, 120);
  assert.equal(reg.allow(a, NOW + 1_000), true, "two tokens back after a second");
});

test("route scopes: owner-only management, deploy for the fleet, pause for STOP", () => {
  const cases = [
    ["GET", "/api/state", "read"],
    ["GET", "/api/brief", "read"],
    ["GET", "/api/stream", "read"],
    ["GET", "/api/agents/me", "read"],
    ["GET", "/api/agents", "owner"],
    ["POST", "/api/agents", "owner"],
    ["POST", "/api/agents/agt-abc123/revoke", "owner"],
    ["GET", "/api/nodes", "read"],
    ["POST", "/api/nodes/test", "owner"],
    ["POST", "/api/nodes/probe", "owner"],
    ["POST", "/api/tuning", "tune"],
    ["POST", "/api/stop", "pause"],
    ["POST", "/api/sending", "pause"],
    ["POST", "/api/fleet/morpho-liquidator/control", "deploy"],
    ["POST", "/api/simulate", "read"],
    ["POST", "/api/issues/rpc-errors/assign", "read"],
    ["POST", "/api/resume", "owner"],
    ["DELETE", "/api/state", "owner"],
  ];
  for (const [m, p, need] of cases) assert.equal(requiredScope(m, p), need, `${m} ${p}`);
  const agent = { id: "agt-x", scopes: ["read", "pause"], paused: false };
  assert.equal(permits({ who: "owner" }, "owner"), true);
  assert.equal(permits({ who: "agent", agent }, "owner"), false);
  assert.equal(permits({ who: "agent", agent }, "pause"), true);
  assert.equal(permits({ who: "agent", agent }, "deploy"), false);
});

// ---------------------------------------------------------------------------
// Telemetry
// ---------------------------------------------------------------------------

const opp = (id, minsAgo, o = {}) => ({ id, block: 100, foundAt: ago(minsAgo * MIN), pairSymbols: "WETH/USDC", buyDex: "uniswap-v3", sellDex: "aerodrome", netUsd: 1, profitUsd: 1.2, gasUsd: 0.2, msIntoBlock: 500, ...o });

test("latency: detect from msIntoBlock, send from live sentAt, land in blocks", () => {
  const opps = [opp("a", 10, { msIntoBlock: 300 }), opp("b", 20, { msIntoBlock: 500 }), opp("c", 30, { msIntoBlock: 900 }), opp("old", 26 * 60, { msIntoBlock: 50 })];
  const lives = [
    { id: "a", block: 100, sentAt: new Date(Date.parse(opps[0].foundAt) + 40).toISOString(), status: "pending", priorityFeeGwei: 0.01, expectedProfitUsd: 1 },
    { id: "a", block: 100, sentAt: new Date(Date.parse(opps[0].foundAt) + 40).toISOString(), status: "success", priorityFeeGwei: 0.01, expectedProfitUsd: 1, minedBlock: 101 },
  ];
  const l = latency(opps, lives, NOW, 24);
  assert.equal(l.detectP50, 500);
  assert.equal(l.samples.detect, 3, "only the window counts");
  assert.equal(l.sendP50, 40);
  assert.equal(l.landBlocksP50, 1);
  assert.equal(l.toSendP50, 540);
  assert.equal(l.hourly.length, 24);
});

test("leaks: where found profit went, by outcome, plus the scanner's walls", () => {
  const opps = [opp("p", 10, { netUsd: 2 }), opp("t", 20, { netUsd: 3 }), opp("c", 30, { netUsd: 1 })];
  const outcomes = [
    { id: "p", block: 101, status: "persisted", realisticNetUsd: 1.8 },
    { id: "t", block: 101, status: "taken", realisticNetUsd: 0, takenBy: "0xrival" },
    { id: "c", block: 101, status: "closed", realisticNetUsd: 0 },
  ];
  const k = leaks(opps, outcomes, [], { gasAteIt: 70, belowMin: 9 }, NOW, 6);
  assert.deepEqual([k.persisted.usd, k.lostRace.usd, k.closed.usd], [1.8, 3, 1]);
  assert.deepEqual([k.gasWall.n, k.belowMin.n], [70, 9]);
  assert.deepEqual(k.topTakers, [{ bot: "0xrival", n: 1, usd: 3 }]);
});

test("racers: rivals ranked by $/hour, our own trades excluded and shown as ours", () => {
  const SELF = "0x1111111111111111111111111111111111111111";
  const mev = [
    { block: 1, timestamp: ago(5 * MIN), txIndex: 3, bot: "0xaaa", sender: "0xs1", dexes: ["uniswap-v3", "aerodrome"], tokens: [], profitUsd: 4, priorityGwei: 0.02, type: "arbitrage" },
    { block: 2, timestamp: ago(6 * MIN), txIndex: 9, bot: "0xbbb", sender: "0xs2", dexes: ["aerodrome"], tokens: [], profitUsd: 1, priorityGwei: 0.01, type: "arbitrage" },
    { block: 3, timestamp: ago(7 * MIN), txIndex: 1, bot: SELF, sender: SELF, dexes: ["aerodrome"], tokens: [], profitUsd: 9, type: "arbitrage" },
    { block: 4, timestamp: ago(8 * MIN), txIndex: 1, bot: "0xccc", sender: "0xs3", dexes: [], tokens: [], profitUsd: 50, type: "sandwich" },
    { block: 5, timestamp: ago(3 * HOUR), txIndex: 1, bot: "0xddd", sender: "0xs4", dexes: [], tokens: [], profitUsd: 50, type: "arbitrage" },
  ];
  const r = racers(mev, [{ id: "x", block: 1, status: "taken", realisticNetUsd: 0, takenBy: "0xAAA" }], [], [SELF], NOW, 1);
  assert.deepEqual(r.rows.map((x) => x.bot), ["0xaaa", "0xbbb", SELF.toLowerCase()]);
  assert.equal(r.rows[0].takesFromUs, 1);
  assert.equal(r.rows[0].share, 0.8);
  assert.equal(r.rows.at(-1).you, true);
  assert.equal(r.totalProfitUsd, 5, "sandwiches and old trades are not counted");
});

test("route scores rank recoverable, winnable, gas-light pairs first", () => {
  const opps = [
    opp("1", 10, { pairSymbols: "A/B", profitUsd: 2, gasUsd: 0.1, netUsd: 1.9 }),
    opp("2", 20, { pairSymbols: "A/B", profitUsd: 2, gasUsd: 0.1, netUsd: 1.9 }),
    opp("3", 30, { pairSymbols: "C/D", profitUsd: 1, gasUsd: 0.9, netUsd: 0.1 }),
  ];
  const outcomes = [
    { id: "1", block: 1, status: "persisted", realisticNetUsd: 1.9 },
    { id: "2", block: 1, status: "taken", realisticNetUsd: 0 },
    { id: "3", block: 1, status: "persisted", realisticNetUsd: 0.1 },
  ];
  const s = routeScores(opps, outcomes, NOW);
  assert.deepEqual(s.map((x) => x.pair), ["A/B", "C/D"]);
  assert.equal(s[0].winRate, 0.5);
  assert.equal(s[0].recoverableUsd, 3.8);
  assert.equal(s[1].gasShare, 0.9);
});

test("simulate replays gas, minimum and venues exactly and labels the race model", () => {
  const opps = [opp("a", 1, { profitUsd: 1, gasUsd: 0.2 }), opp("b", 2, { profitUsd: 1, gasUsd: 0.2 }), opp("c", 3, { profitUsd: 0.3, gasUsd: 0.2 }), opp("d", 4, { profitUsd: 1, gasUsd: 0.2, buyDex: "uniswap-v2" })];
  const outcomes = [
    { id: "a", block: 1, status: "persisted", realisticNetUsd: 0.8 },
    { id: "b", block: 1, status: "taken", realisticNetUsd: 0 },
    { id: "c", block: 1, status: "persisted", realisticNetUsd: 0.1 },
  ];
  const r = simulate(opps, outcomes, { minProfitUsd: 0.25, gasX: 1, latencyCutMs: 150, gapMs: 300, excludeDexes: ["uniswap-v2"] });
  assert.equal(r.excluded, 1);
  assert.equal(r.belowMin, 1, "c nets 0.10 < 0.25");
  assert.equal(r.bankedUsd, 0.8);
  assert.equal(r.wonBackUsd, 0.4, "half the taken find at a 50% modelled win");
  assert.match(r.model, /modelled/);
  assert.equal(simulate(opps, outcomes, { minProfitUsd: 0, gasX: 6, latencyCutMs: 0, gapMs: 300, excludeDexes: [] }).gasWall, 4);
});

test("hourly buckets for the analytics charts", () => {
  const opps = [opp("a", 30), opp("b", 90)];
  const outcomes = [{ id: "a", block: 1, status: "persisted", realisticNetUsd: 0.5 }, { id: "b", block: 1, status: "taken", realisticNetUsd: 0 }];
  const lives = [{ id: "a", block: 1, sentAt: ago(29 * MIN), status: "success", priorityFeeGwei: 0.01, expectedProfitUsd: 0.6, gasUsd: 0.1 }];
  const b = hourly(opps, outcomes, lives, [], [], NOW, 24);
  assert.equal(b.length, 24);
  const last = b[23];
  assert.deepEqual([last.finds, last.persisted, last.paperNetUsd, last.landed, last.liveNetUsd], [1, 1, 0.5, 1, 0.5]);
  assert.equal(b[22].taken, 1);
});

test("records: tails once, follows appends, keeps memory bounded", () => {
  const store = new Store(tmp());
  store.append("opportunities.jsonl", { kind: "opportunity", id: "1", block: 1, foundAt: ago(0), pairSymbols: "A/B", buyDex: "x", sellDex: "y", netUsd: 1, profitUsd: 1, gasUsd: 0 });
  const r = new Records(store).ensure();
  assert.equal(r.opps.length, 1);
  store.append("opportunities.jsonl", { kind: "outcome", id: "1", status: "taken", realisticNetUsd: 0, takenBy: "0xr" });
  store.append("mev.jsonl", { kind: "mev", type: "arbitrage", block: 1, timestamp: ago(0), txIndex: 0, bot: "0xR", sender: "0xS", dexes: ["a"], tokens: [], profitUsd: 1 });
  store.append("live.jsonl", { id: "1", block: 1, sentAt: ago(0), status: "pending", priorityFeeGwei: 0, expectedProfitUsd: 1 });
  store.append("mev.jsonl", { kind: "mev", type: "mystery" });
  assert.deepEqual([r.outcomes.length, r.mev.length, r.lives.length], [1, 1, 1]);
  assert.equal(r.mev[0].bot, "0xr", "addresses are normalised");
  for (let i = 0; i < 25_000; i++) r.ingest("opportunities.jsonl", { kind: "opportunity", id: String(i), foundAt: ago(0) });
  assert.ok(r.opps.length <= 22_000);
  r.close();
});

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

const baseHealth = (over = {}) => ({
  now: NOW,
  startedAt: NOW - HOUR,
  running: true,
  mode: "live",
  blocks: [{ n: 10, at: NOW - 2_000, ms: 300 }],
  rpc: { requests: 1000, transientErrors: 1, rateLimited: 0, failovers: 0, onPrimary: true, activeEndpoint: "host" },
  live: { consecutiveFailures: 0, limit: 5, gasSpentTodayUsd: 0.1, maxDailyGasUsd: 1 },
  flashblocksOn: true,
  flashblocks: { ticks: 100, scans: 50, opps: 2, errors: 0, maxMs: 90 },
  liquidationsOn: false,
  liquidations: null,
  stop: { present: false, reason: null },
  cloud: null,
  learning: true,
  hasSigner: true,
  funnel: { candidates: 10 },
  fleet: [],
  agents: { total: 0, active: 0 },
  ...over,
});

test("health is green when everything is", () => {
  const h = health(baseHealth());
  assert.equal(h.overall, "ok");
  assert.deepEqual(h.issues, []);
});

test("health rules fire with stable ids and the numbers they fired on", () => {
  const h = health(
    baseHealth({
      blocks: [{ n: 10, at: NOW - 45_000, ms: 300 }],
      rpc: { requests: 1000, transientErrors: 90, rateLimited: 40, failovers: 2, onPrimary: false, activeEndpoint: "fallback-host" },
      live: { consecutiveFailures: 5, limit: 5, gasSpentTodayUsd: 0.9, maxDailyGasUsd: 1 },
      stop: { present: true, reason: "breaker" },
      cloud: { url: "x", lastOkAt: NOW - 10 * MIN, pushes: 3, failures: 4, lastError: "500" },
      flashblocks: { ticks: 0 },
      fleet: [{ id: "hummingbot", name: "Hummingbot", kind: "external", state: "stale", heartbeatAgeS: 200, lastError: null }],
    }),
    { "gas-budget": { agentId: "agt-1", agentName: "ops-1", note: "on it", at: ago(0) } },
  );
  const ids = h.issues.map((i) => i.id);
  for (const id of ["blocks-stalled", "rpc-on-fallback", "rpc-errors", "live-failures", "gas-budget", "stop-file", "cloud-stale", "flashblocks-silent", "fleet-hummingbot"]) assert.ok(ids.includes(id), id);
  assert.equal(h.issues[0].severity, "critical", "critical first");
  assert.equal(h.overall, "down");
  assert.equal(h.issues.find((i) => i.id === "gas-budget").assignee.agentName, "ops-1");
  assert.equal(h.issues.find((i) => i.id === "rpc-errors").evidence.rateLimited, 40);
});

test("issue claims persist and reject odd ids", () => {
  const path = join(tmp(), "issues.json");
  const b = new IssueBoard(path);
  b.assign("rpc-errors", { agentId: "agt-1", agentName: "ops-1" }, "checking\nthe provider");
  assert.equal(new IssueBoard(path).all()["rpc-errors"].note, "checking the provider");
  b.assign("rpc-errors", { agentId: null, agentName: "owner" }, "", true);
  assert.equal(new IssueBoard(path).all()["rpc-errors"], undefined);
  assert.throws(() => b.assign("../x", { agentId: null, agentName: "o" }, ""), /bad issue id/);
});

// ---------------------------------------------------------------------------
// Nodes
// ---------------------------------------------------------------------------

test("node URLs are reduced to a host with key-like labels masked", () => {
  assert.deepEqual(redactHost("https://base-mainnet.g.alchemy.com/v2/SuperSecretKey123"), { host: "base-mainnet.g.alchemy.com", protocol: "https" });
  assert.equal(redactHost("https://nameless-hidden-sea.base-mainnet.quiknode.pro/abc123token/").host, "•••.base-mainnet.quiknode.pro");
  assert.equal(redactHost("https://user:pass@node.example.com:8545/?apikey=zzz").host, "node.example.com:8545");
  assert.equal(redactHost("wss://a1b2c3d4e5f6a7b8c9d0.ws.example.org").host, "•••.ws.example.org");
  assert.equal(redactHost("not a url"), null);
  const list = configuredNodes({ rpcUrl: "https://x.example.com/v2/KEY1", wsUrl: undefined, rpcFallbackUrls: ["https://y.example.com/KEY2"], flashblocksRpcUrl: "https://z.example.com" });
  assert.deepEqual(list.map((n) => n.id), ["primary", "fallback-1", "flashblocks"]);
  const pub = JSON.stringify(publicNodes(list));
  assert.ok(!pub.includes("KEY1") && !pub.includes("KEY2") && !pub.includes('"url"'));
});

function rpcServer(handler) {
  return new Promise((resolve) => {
    const srv = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => handler(JSON.parse(body || "{}"), res));
    });
    srv.listen(0, "127.0.0.1", () => resolve(srv));
  });
}

test("probe: chain id, timings, lag against our block; errors never echo the URL", async (t) => {
  const srv = await rpcServer((msg, res) => {
    const result = msg.method === "eth_chainId" ? "0x2105" : "0x64"; // block 100
    res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
  });
  t.after(() => srv.close());
  const url = `http://127.0.0.1:${srv.address().port}/secret-path-KEY`;
  const p = await probe(url, { samples: 3, ourBlock: 103 });
  assert.equal(p.ok, true);
  assert.equal(p.chainOk, true);
  assert.equal(p.block, 100);
  assert.equal(p.lagBlocks, 3);
  assert.equal(p.samplesMs.length, 3);
  assert.ok(!JSON.stringify(p).includes("secret-path-KEY"));

  const bad = await rpcServer((msg, res) => {
    res.statusCode = 500;
    res.end("boom");
  });
  t.after(() => bad.close());
  const e = await probe(`http://127.0.0.1:${bad.address().port}/KEY-in-path?token=abc`, { samples: 1 });
  assert.equal(e.ok, false);
  assert.match(e.error, /HTTP 500/);
  assert.ok(!JSON.stringify(e).includes("KEY-in-path") && !JSON.stringify(e).includes("abc"));
  assert.equal((await probe("file:///etc/passwd")).error, "only http(s) and ws(s) node URLs");
});

test("the node book keeps label, host and timings, never the URL", () => {
  const path = join(tmp(), "nodes.json");
  const book = new NodeBook(path);
  const c = book.addCandidate("dRPC Ashburn", { host: "lb.drpc.org", protocol: "https", ok: true, chainId: 8453, chainOk: true, block: 1, lagBlocks: 0, samplesMs: [9], p50Ms: 9, minMs: 9, error: null, at: ago(0) });
  assert.match(c.id, /^node-[0-9a-f]{8}$/);
  assert.equal(new NodeBook(path).list().candidates[0].label, "dRPC Ashburn");
  assert.equal(book.removeCandidate(c.id), true);
});

// ---------------------------------------------------------------------------
// HTTP: the routes as an agent and as the owner see them
// ---------------------------------------------------------------------------

const KEYED_RPC = "https://base-mainnet.g.alchemy.com/v2/SuperSecretKey123";
const PRIVATE_KEY = "0x" + "ab".repeat(32);

function boot(over = {}) {
  const dir = tmp();
  const store = new Store(dir);
  const settings = {
    mode: "live", minProfitUsd: 0.25, maxPools: 400, minPoolLiquidityWeth: 2, clPools: true, multiHop: true, maxHops: 3, flashSource: "morpho",
    flashblocks: false, liquidations: false, refreshMode: "events", fullRefreshBlocks: 150, priorityFeeGwei: 0.005, rpcFallbackUrls: [KEYED_RPC], mevFeed: true,
    reportDir: dir, privateKey: PRIVATE_KEY, rpcUrl: KEYED_RPC, wsUrl: KEYED_RPC.replace("https", "wss"), flashblocksRpcUrl: KEYED_RPC,
    routeExecutorAddress: "0x7777777777777777777777777777777777777777",
  };
  const ui = new UiServer(
    {
      version: "test", settings, store, running: true, botAddress: "0x1111111111111111111111111111111111111111", telegram: false,
      usage: () => ({ since: ago(0), requests: 10, byMethod: {}, alchemyCu: 0, alchemyCuPerDay: 0, activeEndpoint: "https://base-mainnet.g.alchemy.com/…", onPrimary: true, failovers: 0, transientErrors: 0, rateLimited: 0 }),
      pools: () => ({ total: 1, cl: 0, pairs: 1 }),
      ethUsd: () => 2000,
      summaries: async () => ({ paperDays: [] }),
      symbol: () => "TKN",
      extras: () => ({ live: { consecutiveFailures: 0, limit: 5, gasSpentTodayUsd: 0.9, maxDailyGasUsd: 1 } }),
      ...over,
    },
    { port: 0 },
  );
  return { ui, store, dir };
}

function call(ui, path, { method = "GET", token, body, origin, bearer = true } = {}) {
  const port = Number(new URL(ui.url).port);
  const headers = { host: `localhost:${port}` };
  if (token) headers[bearer && token.startsWith("agt_") ? "authorization" : "x-bot-token"] = bearer && token.startsWith("agt_") ? `Bearer ${token}` : token;
  if (body !== undefined) headers["content-type"] = "application/json";
  if (origin) headers.origin = origin;
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method, headers }, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        let json = null;
        try {
          json = JSON.parse(data);
        } catch {
          /* html */
        }
        resolve({ status: res.statusCode, headers: res.headers, body: data, json });
      });
    });
    req.on("error", reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

test("an agent token reads, but only within its scopes", async (t) => {
  const { ui } = boot();
  await ui.start();
  t.after(() => ui.close());
  const { token } = ui.command.agents.create("ops-1", "test", ["read"]);
  for (const p of ["/api/help", "/api/brief", "/api/health", "/api/racers", "/api/leaks", "/api/latency", "/api/routes/scores", "/api/targets", "/api/market?chain=base", "/api/market?chain=sol", "/api/fleet", "/api/nodes", "/api/analytics", "/api/agents/me", "/api/state", "/api/recent"]) {
    const r = await call(ui, p, { token });
    assert.equal(r.status, 200, p);
    assert.ok(!r.body.includes("SuperSecretKey123"), `${p} leaks an RPC key`);
    assert.ok(!r.body.includes("ab".repeat(32)), `${p} leaks the private key`);
  }
  assert.equal((await call(ui, "/api/agents", { token })).status, 403);
  assert.equal((await call(ui, "/api/nodes/test", { method: "POST", token, body: { url: "http://127.0.0.1:1" } })).status, 403);
  assert.equal((await call(ui, "/api/stop", { method: "POST", token })).status, 403);
  assert.equal((await call(ui, "/api/fleet/morpho-liquidator/control", { method: "POST", token, body: { desired: "running" } })).status, 403);
  assert.equal((await call(ui, "/api/state", { token: "agt_" + "x".repeat(32) })).status, 401);
  const help = (await call(ui, "/api/help", { token })).json;
  assert.equal(help.routes.find((r) => r.path === "/api/sending").allowed, false);
  assert.equal(help.routes.find((r) => r.path === "/api/brief").allowed, true);
});

test("pause scope writes STOP; nothing can resume from the API", async (t) => {
  const { ui, store } = boot();
  await ui.start();
  t.after(() => ui.close());
  const { token } = ui.command.agents.create("guard", "test", ["pause"]);
  const r = await call(ui, "/api/sending", { method: "POST", token, body: { paused: true, reason: "reverts" } });
  assert.equal(r.status, 200);
  assert.ok(existsSync(store.path("STOP")));
  assert.match(readFileSync(store.path("STOP"), "utf8"), /agent:guard.*reverts/);
  assert.equal((await call(ui, "/api/sending", { method: "POST", token, body: { paused: false } })).status, 409);
  assert.equal((await call(ui, "/api/sending", { method: "POST", token: ui.token, body: { paused: false } })).status, 409, "not even the owner page");
  assert.ok(existsSync(store.path("STOP")));
});

test("deploy scope can ask for detect or paper, never live", async (t) => {
  const { ui, dir } = boot();
  await ui.start();
  t.after(() => ui.close());
  const { token } = ui.command.agents.create("fleet-op", "test", ["deploy"]);
  const ok = await call(ui, "/api/fleet/morpho-liquidator/control", { method: "POST", token, body: { desired: "running", mode: "detect", gasCapUsd: 0.5 } });
  assert.equal(ok.status, 200);
  const ctl = JSON.parse(readFileSync(join(dir, "fleet", "morpho-liquidator.control.json"), "utf8"));
  assert.deepEqual([ctl.desired, ctl.mode, ctl.gasCapUsd, ctl.requestedBy], ["running", "detect", 0.5, "agent:fleet-op"]);
  const live = await call(ui, "/api/fleet/morpho-liquidator/control", { method: "POST", token, body: { desired: "running", mode: "live" } });
  assert.equal(live.status, 400);
  assert.match(live.json.error, /FLEET_LIVE_MORPHO_LIQUIDATOR/);
  assert.equal((await call(ui, "/api/fleet/base-arb-bot/control", { method: "POST", token, body: { desired: "stopped" } })).status, 400);
  assert.equal((await call(ui, "/api/fleet/morpho-liquidator/control", { method: "POST", token, body: { desired: "running" }, origin: "http://evil.example" })).status, 403);
});

test("issues: agents claim open ones; the owner hands them out", async (t) => {
  const { ui } = boot();
  await ui.start();
  t.after(() => ui.close());
  const a = ui.command.agents.create("ops-1", "test", ["read"]);
  const h = (await call(ui, "/api/health", { token: a.token })).json;
  const gas = h.issues.find((i) => i.id === "gas-budget");
  assert.ok(gas, "90% of the gas cap raises an issue");
  assert.equal((await call(ui, "/api/issues/not-an-issue/assign", { method: "POST", token: a.token, body: {} })).status, 404);
  const claim = await call(ui, "/api/issues/gas-budget/assign", { method: "POST", token: a.token, body: { note: "checking reverts" } });
  assert.equal(claim.json.claim.agentName, "ops-1");
  const b = ui.command.agents.create("ops-2", "test", ["read"]);
  const handed = await call(ui, "/api/issues/gas-budget/assign", { method: "POST", token: ui.token, body: { agentId: b.agent.id } });
  assert.equal(handed.json.claim.agentName, "ops-2");
  const forged = await call(ui, "/api/issues/gas-budget/assign", { method: "POST", token: a.token, body: { agentId: b.agent.id } });
  assert.equal(forged.json.claim.agentName, "ops-1", "an agent can only claim for itself");
});

test("owner manages tokens; paused and revoked agents are shut out at once", async (t) => {
  const { ui } = boot();
  await ui.start();
  t.after(() => ui.close());
  const made = await call(ui, "/api/agents", { method: "POST", token: ui.token, body: { name: "scout", scopes: ["read", "tune"] } });
  assert.equal(made.status, 200);
  const tok = made.json.token;
  assert.equal((await call(ui, "/api/agents", { token: ui.token })).json.agents[0].name, "scout");
  assert.ok(!(await call(ui, "/api/agents", { token: ui.token })).body.includes(tok), "listings never show tokens");
  assert.equal((await call(ui, "/api/agents", { method: "POST", token: ui.token, body: { name: "x", scopes: ["sign"] } })).status, 400);
  const id = made.json.agent.id;
  await call(ui, `/api/agents/${id}/pause`, { method: "POST", token: ui.token, body: { paused: true } });
  const paused = await call(ui, "/api/brief", { token: tok });
  assert.equal(paused.status, 403);
  assert.match(paused.json.error, /paused/);
  await call(ui, `/api/agents/${id}/revoke`, { method: "POST", token: ui.token, body: {} });
  assert.equal((await call(ui, "/api/brief", { token: tok })).status, 401);
});

test("simulate replays recorded finds under new settings", async (t) => {
  const { ui, store } = boot();
  await ui.start();
  t.after(() => ui.close());
  store.append("opportunities.jsonl", { kind: "opportunity", id: "s1", block: 1, foundAt: new Date().toISOString(), pairSymbols: "WETH/USDC", buyDex: "uniswap-v3", sellDex: "aerodrome", netUsd: 0.8, profitUsd: 1, gasUsd: 0.2 });
  store.append("opportunities.jsonl", { kind: "outcome", id: "s1", status: "persisted", realisticNetUsd: 0.8 });
  const { token } = ui.command.agents.create("sim", "test", ["read"]);
  const r = await call(ui, "/api/simulate", { method: "POST", token, body: { gasX: 10, minProfitUsd: 0 } });
  assert.equal(r.status, 200);
  assert.equal(r.json.result.gasWall, 1);
  assert.equal(r.json.baseline.bankedUsd, 0.8);
  assert.equal((await call(ui, "/api/simulate", { method: "POST", token, body: "[1]" })).status, 400);
});

test("the terminal page carries the owner token, a nonce on every script, and no secrets", async (t) => {
  const { ui } = boot();
  await ui.start();
  t.after(() => ui.close());
  const r = await call(ui, "/terminal");
  assert.equal(r.status, 200);
  assert.ok(r.body.includes(ui.token));
  assert.ok(!/<script(?![^>]*nonce=)/.test(r.body), "every script tag has the nonce");
  assert.match(r.headers["content-security-policy"], /script-src 'nonce-/);
  assert.ok(!r.body.includes("SuperSecretKey123"));
});

test("the agent stream opens with a brief and forwards live events", async (t) => {
  const { ui, store } = boot();
  await ui.start();
  t.after(() => ui.close());
  const { token } = ui.command.agents.create("watcher", "test", ["read"]);
  const port = Number(new URL(ui.url).port);
  const seen = await new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path: `/api/stream?t=${encodeURIComponent(token)}`, headers: { host: `localhost:${port}` } }, (res) => {
      const events = new Set();
      let buf = "";
      res.setEncoding("utf8");
      res.on("data", (c) => {
        buf += c;
        for (const m of buf.matchAll(/event: ([\w-]+)\n/g)) events.add(m[1]);
        if (events.has("brief") && events.has("opp")) {
          req.destroy();
          resolve([...events]);
        }
      });
      setTimeout(() => store.append("opportunities.jsonl", { kind: "opportunity", id: "e1", block: 2, foundAt: new Date().toISOString(), pairSymbols: "WETH/USDC", netUsd: 1 }), 50);
    });
    req.on("error", (e) => (e.code === "ECONNRESET" ? null : reject(e)));
    req.end();
  });
  assert.ok(seen.includes("brief") && seen.includes("opp"));
});
