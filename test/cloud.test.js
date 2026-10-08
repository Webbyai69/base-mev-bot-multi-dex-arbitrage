/**
 * Online dashboard: the Cloudflare Worker + Durable Object in cloud/src/app.js
 * (run under Node with a stub Durable Object), and the bot's publisher in
 * src/cloud.ts. Covers the ingest token, Cloudflare Access token checks, the
 * live feed, the remote stop round trip, balance reads and the full path
 * publisher -> Worker -> page data. No network, no Cloudflare account.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { createApp, BotMirror } from "../cloud/src/app.js";
import { CloudPublisher } from "../dist/cloud.js";
import { UiServer } from "../dist/ui/server.js";
import { Store } from "../dist/store.js";

const html = readFileSync(new URL("../ui/dashboard.html", import.meta.url), "utf8");
const TOKEN = "ingest-token-for-tests-0123456789";
const BOT = "0x1111111111111111111111111111111111111111";
const ORIGIN = "https://base-arb-dashboard.example.workers.dev";

function fakeStorage() {
  const m = new Map();
  return {
    async get(keys) {
      const out = new Map();
      for (const k of keys) if (m.has(k)) out.set(k, structuredClone(m.get(k)));
      return out;
    },
    async put(obj) {
      for (const [k, v] of Object.entries(obj)) m.set(k, structuredClone(v));
    },
    _m: m,
  };
}

function makeEnv(extra = {}, rpcFetch) {
  const storage = fakeStorage();
  const env = { INGEST_TOKEN: TOKEN, PUBLIC_DASHBOARD: "true", BASE_RPC_URL: "https://rpc.example", ...extra };
  let mirror = new BotMirror({ storage, blockConcurrencyWhile: (fn) => fn() }, env, rpcFetch);
  env.MIRROR = { idFromName: () => "bot", get: () => ({ fetch: (url, init) => mirror.fetch(new Request(url, init)) }) };
  return {
    env,
    storage,
    get mirror() {
      return mirror;
    },
    /** Simulate Cloudflare evicting the object: a fresh instance over the same storage. */
    restart() {
      mirror = new BotMirror({ storage, blockConcurrencyWhile: (fn) => fn() }, env, rpcFetch);
    },
  };
}

const app = createApp({ html });
const req = (path, init = {}) => new Request(ORIGIN + path, init);
const getJson = async (env, path, headers = {}) => {
  const r = await app.fetch(req(path, { headers }), env);
  return { status: r.status, body: r.headers.get("content-type")?.includes("json") ? await r.json() : await r.text() };
};
function ingest(env, payload, token = TOKEN) {
  return app.fetch(
    req("/ingest", { method: "POST", headers: { authorization: `Bearer ${token}`, "x-body-encoding": "gzip", "content-type": "application/json" }, body: gzipSync(Buffer.from(JSON.stringify(payload))) }),
    env,
  );
}
const block = (n) => ({ type: "block", data: { n, at: Date.now(), ms: 5, opps: 0, bestNetUsd: null, mev: 0, arbs: 0, gasUsd: 0.01, ethUsd: 2000 } });
const baseState = { mode: "paper", running: true, addresses: { bot: BOT, executor: null, routeExecutor: null }, settings: { minProfitUsd: 0.25 }, stop: { present: false, reason: null } };

test("the bot's pushes need the Worker's INGEST_TOKEN", async () => {
  const { env } = makeEnv();
  assert.equal((await ingest(env, { v: 1 }, "wrong-token-wrong-token-wrong-token")).status, 401);
  const noSecret = makeEnv({ INGEST_TOKEN: "" });
  assert.equal((await ingest(noSecret.env, { v: 1 })).status, 503);
  assert.equal((await app.fetch(req("/ingest"), env)).status, 405);
});

test("pushed data is served, and events become a live feed", async () => {
  const { env } = makeEnv();
  let r = await ingest(env, { v: 1, runId: "run-1", state: baseState, contracts: { chainId: 8453 }, events: [block(1), block(2), block(3), { type: "opp", data: { id: "3-a", pair: "WETH/USDC", netUsd: 1.5 } }] });
  assert.equal(r.status, 200);
  const reply = await r.json();
  assert.equal(reply.resync, false);
  assert.deepEqual(reply.commands, []);
  const st = await getJson(env, "/api/state");
  assert.equal(st.status, 200);
  assert.equal(st.body.blocks.length, 3);
  assert.equal(st.body.mode, "paper");
  assert.ok(st.body.mirror.lastPushAt);
  const first = await getJson(env, "/api/live?since=0");
  assert.equal(first.body.seq, 4);
  assert.deepEqual(first.body.events, []);
  await ingest(env, { v: 1, runId: "run-1", events: [{ type: "outcome", data: { id: "3-a", status: "persisted", realisticNetUsd: 1.2 } }, block(4)] });
  const next = await getJson(env, "/api/live?since=4");
  assert.deepEqual(next.body.events.map((e) => e.type), ["outcome", "block"]);
  const recent = await getJson(env, "/api/recent");
  assert.equal(recent.body.opps[0].outcome.status, "persisted");
  // A page that fell behind the ring is told to reload instead of missing events.
  assert.equal((await getJson(env, "/api/live?since=999")).body.reset, true);
});

test("a bot restart starts a fresh block tape; an evicted object reloads what it saved", async () => {
  const s = makeEnv();
  await ingest(s.env, { v: 1, runId: "run-1", state: baseState, contracts: {}, events: [block(10), block(11)] });
  await ingest(s.env, { v: 1, runId: "run-2", events: [block(1)] });
  assert.deepEqual((await getJson(s.env, "/api/state")).body.blocks.map((b) => b.n), [1]);
  s.restart();
  const after = await getJson(s.env, "/api/state");
  assert.equal(after.body.mode, "paper");
  assert.deepEqual(after.body.blocks.map((b) => b.n), [1]);
});

test("before any push the page is told to wait, and the bot is asked for everything", async () => {
  const { env } = makeEnv();
  const st = await getJson(env, "/api/state");
  assert.equal(st.body.waiting, true);
  const r = await (await ingest(env, { v: 1, runId: "x", events: [] })).json();
  assert.equal(r.resync, true);
});

// --- Cloudflare Access ------------------------------------------------------

const b64url = (buf) => Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
async function accessFixture() {
  const kp = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  const jwk = { ...(await crypto.subtle.exportKey("jwk", kp.publicKey)), kid: "key-1", alg: "RS256", use: "sig" };
  let certFetches = 0;
  const certFetch = async (url) => {
    certFetches++;
    assert.equal(String(url), "https://team-test.cloudflareaccess.com/cdn-cgi/access/certs");
    return new Response(JSON.stringify({ keys: [jwk] }), { headers: { "content-type": "application/json" } });
  };
  const sign = async (claims, kid = "key-1") => {
    const h = b64url(JSON.stringify({ alg: "RS256", kid, typ: "JWT" }));
    const p = b64url(JSON.stringify(claims));
    const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", kp.privateKey, new TextEncoder().encode(`${h}.${p}`));
    return `${h}.${p}.${b64url(sig)}`;
  };
  return { certFetch, sign, certFetches: () => certFetches };
}

test("viewers need a valid Cloudflare Access token; until Access is set up, a setup page", async () => {
  const fx = await accessFixture();
  const appA = createApp({ html, fetchImpl: fx.certFetch });
  const unset = makeEnv({ PUBLIC_DASHBOARD: undefined });
  const setup = await appA.fetch(req("/"), unset.env);
  assert.equal(setup.status, 503);
  assert.match(await setup.text(), /Enable Cloudflare Access/);
  assert.equal((await appA.fetch(req("/api/state"), unset.env)).status, 503);

  const { env } = makeEnv({ PUBLIC_DASHBOARD: undefined, ACCESS_TEAM_DOMAIN: "team-test.cloudflareaccess.com", ACCESS_AUD: "aud-1" });
  const now = Math.floor(Date.now() / 1000);
  const good = { iss: "https://team-test.cloudflareaccess.com", aud: ["aud-1"], exp: now + 600, iat: now, email: "josh@example.com" };
  const as = async (token) => (await appA.fetch(req("/api/state", { headers: token ? { "cf-access-jwt-assertion": token } : {} }), env)).status;
  assert.equal(await as(null), 403);
  assert.equal(await as(await fx.sign(good)), 200);
  assert.equal(await as(await fx.sign({ ...good, aud: ["another-app"] })), 403);
  assert.equal(await as(await fx.sign({ ...good, exp: now - 3600 })), 403);
  assert.equal(await as(await fx.sign({ ...good, iss: "https://evil.cloudflareaccess.com" })), 403);
  assert.equal(await as(await fx.sign(good, "unknown-key")), 403);
  const t = await fx.sign(good);
  const [h, , s] = t.split(".");
  assert.equal(await as(`${h}.${b64url(JSON.stringify({ ...good, email: "attacker@example.com" }))}.${s}`), 403, "tampered claims fail the signature");
  // Pushes from the bot don't depend on viewer tokens.
  assert.equal((await ingest(env, { v: 1, runId: "r", events: [] })).status, 200);
});

test("the page is served in online mode with a script nonce", async () => {
  const { env } = makeEnv();
  const r = await app.fetch(req("/"), env);
  assert.equal(r.status, 200);
  const body = await r.text();
  assert.ok(body.includes('window.__BOT__={"mode":"cloud"}'));
  assert.match(r.headers.get("content-security-policy"), /script-src 'nonce-[^']+'/);
  assert.ok(!/<script(?![^>]*nonce=)/.test(body), "every script tag has the nonce");
});

test("remote stop: queued from the page, picked up by the bot, cleared by its ack", async () => {
  const { env } = makeEnv();
  await ingest(env, { v: 1, runId: "r", state: { ...baseState, mode: "live" }, contracts: {}, events: [] });
  const post = (headers) => app.fetch(req("/api/stop", { method: "POST", headers }), env);
  assert.equal((await post({})).status, 403, "needs the page's header");
  assert.equal((await post({ "x-dashboard": "1", origin: "https://evil.example" })).status, 403);
  const q = await (await post({ "x-dashboard": "1", origin: ORIGIN })).json();
  assert.equal(q.queued, true);
  const again = await (await post({ "x-dashboard": "1" })).json();
  assert.equal(again.stopRequest.id, q.stopRequest.id, "pressing twice doesn't queue twice");
  let reply = await (await ingest(env, { v: 1, runId: "r", events: [] })).json();
  assert.deepEqual(reply.commands.map((c) => c.id), [q.stopRequest.id]);
  reply = await (await ingest(env, { v: 1, runId: "r", ack: { stopId: q.stopRequest.id }, events: [{ type: "stop", data: { present: true, reason: "stopped from the online dashboard" } }] })).json();
  assert.deepEqual(reply.commands, []);
  const live = await getJson(env, "/api/live?since=0");
  assert.equal(live.body.stopRequest, null);
  assert.equal(live.body.stop.present, true);
  assert.equal((await app.fetch(req("/api/resume", { method: "POST", headers: { "x-dashboard": "1" } }), env)).status, 404, "no remote resume");
});

test("wallet balances come from the public Base RPC in one batch, cached", async () => {
  let calls = 0;
  const rpc = async (url, init) => {
    calls++;
    assert.equal(url, "https://rpc.example");
    const batch = JSON.parse(init.body);
    return new Response(JSON.stringify(batch.map((c) => ({ jsonrpc: "2.0", id: c.id, result: c.method === "eth_getBalance" ? "0x2386f26fc10000" : "0x" + "0".repeat(63) + "5" }))), { headers: { "content-type": "application/json" } });
  };
  const { env } = makeEnv({}, rpc);
  await ingest(env, { v: 1, runId: "r", state: baseState, contracts: {}, events: [] });
  const me = "0x2222222222222222222222222222222222222222";
  const a = await getJson(env, `/api/wallet?addresses=${me}`);
  const b = await getJson(env, `/api/wallet?addresses=${me}`);
  assert.equal(calls, 1);
  assert.equal(a.body.accounts[me].eth, "10000000000000000");
  assert.equal(a.body.accounts[BOT.toLowerCase()].usdc, "5");
  assert.deepEqual(a.body, b.body);
});

// --- the bot's side ---------------------------------------------------------

function botSide() {
  const dir = mkdtempSync(join(tmpdir(), "cloud-bot-"));
  const store = new Store(dir);
  const settings = { mode: "paper", minProfitUsd: 0.25, maxPools: 400, minPoolLiquidityWeth: 2, clPools: true, multiHop: true, maxHops: 3, flashSource: "morpho", flashblocks: false, liquidations: true, refreshMode: "events", fullRefreshBlocks: 150, priorityFeeGwei: 0.005, rpcFallbackUrls: ["https://base-mainnet.g.alchemy.com/v2/SuperSecretKey123"], mevFeed: true, reportDir: dir, privateKey: "0x" + "ab".repeat(32), rpcUrl: "https://base-mainnet.g.alchemy.com/v2/SuperSecretKey123", executorAddress: undefined, routeExecutorAddress: undefined };
  const ui = new UiServer(
    { version: "test", settings, store, running: true, botAddress: BOT, telegram: false, pools: () => ({ total: 1, cl: 0, pairs: 1 }), ethUsd: () => 2000, summaries: async () => ({ paperDays: [] }) },
    { port: 0 },
  );
  ui.attach();
  return { ui, store };
}

test("the bot pushes gzip'd snapshots with its tokens, and obeys a stop request", async () => {
  const { ui, store } = botSide();
  const pushes = [];
  let reply = { ok: true, resync: false, commands: [{ id: "stop-1", type: "stop", by: "josh@example.com" }] };
  const fetchImpl = async (url, init) => {
    assert.equal(url, "https://dash.example/ingest");
    assert.equal(init.headers.authorization, `Bearer ${TOKEN}`);
    assert.equal(init.headers["CF-Access-Client-Id"], "client.access");
    assert.equal(init.headers["x-body-encoding"], "gzip");
    const text = gunzipSync(init.body).toString("utf8");
    assert.ok(!text.includes("ab".repeat(32)), "never the private key");
    assert.ok(!text.includes("SuperSecretKey123"), "never an RPC key");
    pushes.push(JSON.parse(text));
    const out = reply;
    reply = { ok: true, resync: false, commands: [] };
    return new Response(JSON.stringify(out), { headers: { "content-type": "application/json" } });
  };
  const pub = new CloudPublisher(ui, { url: "https://dash.example/", token: TOKEN, accessClientId: "client.access", accessClientSecret: "secret", fetchImpl });
  ui.pushBlock({ n: 7, at: Date.now(), ms: 5, opps: 0, bestNetUsd: null, mev: 0, arbs: 0, gasUsd: 0.01, ethUsd: 2000 });
  await pub.tick();
  const p1 = pushes[0];
  assert.equal(p1.v, 1);
  assert.ok(p1.runId);
  assert.ok(p1.state && !("blocks" in p1.state), "state goes without the block ring");
  assert.ok(p1.summary && p1.recent && p1.contracts && p1.review, "the first push carries everything");
  assert.deepEqual(p1.events.map((e) => e.type), ["block"]);
  assert.ok(existsSync(store.path("STOP")), "the stop request wrote the STOP file");
  assert.match(readFileSync(store.path("STOP"), "utf8"), /online dashboard/);
  await pub.tick();
  const p2 = pushes[1];
  assert.deepEqual(p2.ack, { stopId: "stop-1" });
  assert.deepEqual(p2.events.map((e) => e.type), ["stop"]);
  assert.equal(p2.contracts, undefined, "slow-changing parts aren't re-sent every push");
  await pub.tick();
  assert.equal(pushes[2].ack, undefined, "acked once");
});

test("a failing push backs off and keeps its events for the next attempt", async () => {
  const { ui } = botSide();
  let fail = true;
  let attempts = 0;
  const seen = [];
  const fetchImpl = async (_url, init) => {
    attempts++;
    if (fail) throw new Error("network down");
    seen.push(JSON.parse(gunzipSync(init.body).toString("utf8")));
    return new Response(JSON.stringify({ ok: true, resync: false, commands: [] }), { headers: { "content-type": "application/json" } });
  };
  const pub = new CloudPublisher(ui, { url: "https://dash.example", token: TOKEN, fetchImpl });
  ui.pushBlock({ n: 1, at: Date.now(), ms: 5, opps: 0, bestNetUsd: null, mev: 0, arbs: 0, gasUsd: 0.01, ethUsd: 2000 });
  await pub.tick();
  assert.equal(pub.stats.failures, 1);
  await pub.tick();
  assert.equal(attempts, 1, "waits out the back-off");
  fail = false;
  pub["nextAt"] = 0;
  await pub.tick();
  assert.deepEqual(seen[0].events.map((e) => e.data.n), [1], "the block from the failed push arrives");
  assert.ok(seen[0].contracts, "and a full resync follows a failure");
});

test("the full path: the bot's publisher feeds the Worker, and the page reads it back", async () => {
  const { ui } = botSide();
  const { env } = makeEnv();
  const fetchImpl = (url, init) => app.fetch(new Request(url, init), env);
  const pub = new CloudPublisher(ui, { url: ORIGIN, token: TOKEN, fetchImpl });
  for (let n = 100; n < 103; n++) ui.pushBlock({ n, at: Date.now(), ms: 5, opps: n === 102 ? 1 : 0, bestNetUsd: null, mev: 0, arbs: 0, gasUsd: 0.01, ethUsd: 2000 });
  await pub.tick();
  assert.equal(pub.stats.failures, 0, pub.stats.lastError ?? "");
  const st = await getJson(env, "/api/state");
  assert.equal(st.body.version, "test");
  assert.deepEqual(st.body.blocks.map((b) => b.n), [100, 101, 102]);
  assert.equal(st.body.addresses.bot, BOT);
  const c = await getJson(env, "/api/contracts");
  assert.ok(c.body.routeExecutor.creationBytecode.startsWith("0x60"), "the deploy button gets the bytecode");
  await pub.stop();
  assert.equal((await getJson(env, "/api/state")).body.running, false, "the online page shows the bot stopped");
});
