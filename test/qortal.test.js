/**
 * The Qortal layer: the node-list format and its checks, status snapshots, the
 * Qortal Core client, the node ranking CLI, the read-only bridge, the zip
 * writer, the Qortal app build and the release build. No network and no
 * dependencies: fake servers on 127.0.0.1 stand in for the bot and Qortal Core.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { buildRegistry, checkNodeUrl, checkRegistry, isPrivateHost, isPrivateIp, keyLike, mergeRegistries, NODES_SCHEMA } from "../qortal/lib/registry.mjs";
import { checkStatus, publicStatus, STATUS_SCHEMA } from "../qortal/lib/status.mjs";
import { QortalCore } from "../qortal/lib/qdn.mjs";
import { main as nodesMain, probeNode, rank } from "../qortal/nodes/nodes.mjs";
import { checkToken, createBridge, loadConfig, READ_ROUTES } from "../qortal/bridge/bridge.mjs";
import { crc32, makeZip } from "../scripts/lib/zip.mjs";
import { splitTerminal, qappFiles } from "../qortal/qapp/build-qapp.mjs";
import { buildRelease, EXCLUDE, scanText } from "../scripts/release-qortal.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const tmp = () => mkdtempSync(join(tmpdir(), "qortal-test-"));
const listen = (server) => new Promise((ok) => server.listen(0, "127.0.0.1", () => ok(`http://127.0.0.1:${server.address().port}`)));
const close = (server) => new Promise((ok) => server.close(() => ok()));

/** Read a zip back (central directory → local entries → inflate). */
function unzip(buf) {
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buf.readUInt16LE(end + 10);
  let p = buf.readUInt32LE(end + 16);
  const out = new Map();
  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(p), 0x02014b50);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nlen).toString("utf8");
    const lnlen = buf.readUInt16LE(local + 26);
    const lxlen = buf.readUInt16LE(local + 28);
    const raw = buf.subarray(local + 30 + lnlen + lxlen, local + 30 + lnlen + lxlen + csize);
    const data = method === 8 ? inflateRawSync(raw) : raw;
    assert.equal(crc32(data), crc, `crc of ${name}`);
    out.set(name, data);
    p += 46 + nlen + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
  }
  return out;
}

// ---------------------------------------------------------------- registry

test("node URLs: public https/wss only; private hosts, credentials, queries and keyed paths refused", () => {
  assert.deepEqual(checkNodeUrl("https://mainnet.base.org/"), { ok: true, url: "https://mainnet.base.org", host: "mainnet.base.org", scheme: "https" });
  assert.equal(checkNodeUrl("wss://Base.Example.COM:8546/ws").url, "wss://base.example.com:8546/ws");
  for (const [u, why] of [
    ["http://mainnet.base.org", /https/],
    ["ws://node.example.com", /https/],
    ["https://user:pw@node.example.com", /user or password/],
    ["https://node.example.com/?key=abc", /query/],
    ["https://127.0.0.1:8545", /private/],
    ["https://10.1.2.3", /private/],
    ["https://192.168.1.1", /private/],
    ["https://172.20.0.5", /private/],
    ["https://169.254.169.254/latest", /private/],
    ["https://localhost:8545", /private/],
    ["https://router.local", /private/],
    ["https://[::1]:8545", /private/],
    ["https://intranet", /private/],
    ["https://base-mainnet.g.alchemy.com/v2/AbCdEf0123456789XyZ01", /API key/],
    ["https://x.quiknode.pro/0123456789abcdef0123456789abcdef01234567/", /API key/],
    ["not a url", /not a URL/],
  ]) {
    const r = checkNodeUrl(u);
    assert.equal(r.ok, false, u);
    assert.match(r.reason, why, u);
  }
  assert.equal(isPrivateHost("8.8.8.8"), false);
  assert.equal(isPrivateIp("10.0.0.1"), true);
  assert.equal(isPrivateIp("::ffff:192.168.0.1"), true);
  assert.equal(isPrivateIp("fd00::1"), true);
  assert.equal(isPrivateIp("1.1.1.1"), false);
  assert.equal(keyLike("base"), false);
  assert.equal(keyLike("practical-flashy-mountain"), false);
  assert.equal(keyLike("9f8e7d6c5b4a39281706f5e4"), true);
});

test("registry documents: bad entries dropped with reasons, duplicates merged, publishers kept", () => {
  const doc = {
    schema: NODES_SCHEMA,
    chainId: 8453,
    updatedAt: "2026-10-13T20:00:00Z",
    nodes: [
      { label: "Base public\u0000RPC", url: "https://mainnet.base.org", kind: "rpc", region: "Global!", measured: { p50Ms: 41.4, from: "us-east", at: "2026-10-13T19:58:00Z" } },
      { label: "dup", url: "https://mainnet.base.org/" },
      { label: "home", url: "https://192.168.0.10" },
      { label: "ws", url: "wss://ws.example.com", kind: "ws" },
      { label: "mismatch", url: "wss://ws2.example.com", kind: "rpc" },
    ],
  };
  const r = checkRegistry(JSON.stringify(doc), "alice");
  assert.equal(r.ok, true);
  assert.equal(r.nodes.length, 2);
  assert.equal(r.nodes[0].label, "Base public RPC");
  assert.equal(r.nodes[0].region, "global");
  assert.deepEqual(r.nodes[0].measured, { p50Ms: 41, from: "us-east", at: "2026-10-13T19:58:00.000Z" });
  assert.equal(r.nodes[0].publisher, "alice");
  assert.deepEqual(r.rejected.map((x) => x.label), ["home", "mismatch"]);
  assert.equal(checkRegistry({ ...doc, chainId: 1 }).ok, false);
  assert.equal(checkRegistry({ ...doc, schema: "x" }).ok, false);
  assert.equal(checkRegistry("{not json").ok, false);
  assert.equal(checkRegistry("x".repeat(70_000)).ok, false);
  const many = checkRegistry({ ...doc, nodes: Array.from({ length: 80 }, (_, i) => ({ url: `https://n${i}.example.com` })) });
  assert.equal(many.nodes.length, 50);
  const merged = mergeRegistries([r, checkRegistry(doc, "bob")]);
  assert.deepEqual(merged.find((n) => n.url === "https://mainnet.base.org").publishers, ["alice", "bob"]);
  const built = buildRegistry([{ label: "mine", url: "https://base.example.com", region: "eu-west" }], Date.parse("2026-10-13T00:00:00Z"));
  assert.deepEqual(built, { schema: NODES_SCHEMA, chainId: 8453, updatedAt: "2026-10-13T00:00:00.000Z", nodes: [{ label: "mine", url: "https://base.example.com", kind: "rpc", region: "eu-west" }] });
  assert.throws(() => buildRegistry([{ url: "https://localhost" }]), /private/);
  assert.throws(() => buildRegistry([]), /no nodes/);
});

// ---------------------------------------------------------------- status

const BRIEF = {
  at: "2026-10-13T20:00:00.000Z",
  version: "0.8.0",
  chainId: 8453,
  mode: "live",
  running: true,
  stop: { present: false, reason: "secret reason text" },
  latestBlock: 52600000,
  ethUsd: 2500,
  health: { overall: "warn", systems: [{ id: "rpc", name: "RPC", status: "ok", detail: "base-mainnet.g.alchemy.com/…" }, { id: "BAD ID", status: "ok" }], issues: [{ id: "rpc-errors", detail: "host x" }] },
  latency: { detectP50: 868, detectP90: 1200, sendP50: 698, sendP90: 900, landBlocksP50: 2, samples: {} },
  leaks: { captured: { n: 1, usd: 2.345 }, persisted: { n: 3, usd: 1 }, lostRace: { n: 5, usd: 7, liveReverts: 4 }, closed: { n: 2, usd: 0 }, topTakers: [{ bot: "0x0fc2d30ee1596f2171b680409e2a77089139cc99" }] },
  racers: [{ bot: "0x0fc2d30ee1596f2171b680409e2a77089139cc99" }],
  routes: [{ pair: "USDC>XDP>USDC" }],
  fleet: [{ id: "morpho-liquidator", name: "Morpho", state: "running", mode: "detect", pnlUsd: 9 }, { id: "../evil", state: "running" }],
};

test("public status: counts and timings only, never addresses, pairs, hosts or free text", () => {
  const s = publicStatus(BRIEF, Date.parse("2026-10-13T20:01:00Z"));
  assert.equal(s.schema, STATUS_SCHEMA);
  assert.equal(s.mode, "live");
  assert.equal(s.paused, false);
  assert.equal(s.health.issues, 1);
  assert.deepEqual(s.health.systems, [{ id: "rpc", status: "ok" }]);
  assert.equal(s.results6h.captured.usd, 2.35);
  assert.deepEqual(s.fleet, [{ id: "morpho-liquidator", state: "running", mode: "detect" }]);
  const text = JSON.stringify(s);
  for (const leak of ["0x0fc2", "XDP", "alchemy", "secret reason", "host x", "2500", "pnl"]) assert.ok(!text.includes(leak), leak);
  const back = checkStatus(JSON.stringify(s));
  assert.equal(back.ok, true);
  assert.deepEqual(back.status, s);
  const forged = checkStatus({ ...s, mode: "<img src=x onerror=alert(1)>", health: { overall: "pwned", issues: 3, systems: [{ id: "x", status: "<b>" }] }, extra: "drop me" });
  assert.equal(forged.status.mode, null);
  assert.equal(forged.status.health.overall, null);
  assert.equal(forged.status.health.systems[0].status, null);
  assert.ok(!("extra" in forged.status));
  assert.equal(checkStatus({ schema: "nope" }).ok, false);
});

// ---------------------------------------------------------------- Qortal Core client

test("Qortal Core client: search keeps exact matches, fetch returns the data, odd names refused", async () => {
  const seen = [];
  const core = createServer((req, res) => {
    seen.push(req.url);
    if (req.url.startsWith("/arbitrary/resources/search")) {
      res.end(JSON.stringify([{ name: "alice", service: "JSON", identifier: "base-arb-nodes-v1", updated: 5 }, { name: "mallory", service: "JSON", identifier: "base-arb-nodes-v1-evil" }]));
    } else if (req.url === "/arbitrary/JSON/alice/base-arb-nodes-v1") res.end('{"hello":1}');
    else {
      res.statusCode = 404;
      res.end("no");
    }
  });
  const url = await listen(core);
  try {
    const c = new QortalCore(url);
    const rows = await c.search("JSON", "base-arb-nodes-v1");
    assert.deepEqual(rows, [{ name: "alice", service: "JSON", identifier: "base-arb-nodes-v1", updated: 5 }]);
    assert.match(seen[0], /service=JSON&identifier=base-arb-nodes-v1/);
    assert.equal(await c.fetchText("JSON", "alice", "base-arb-nodes-v1"), '{"hello":1}');
    await assert.rejects(c.fetchText("JSON", "../admin", "x"), /unusual name/);
    await assert.rejects(c.fetchText("JSON", "bob", "base-arb-nodes-v1"), /HTTP 404/);
    await assert.rejects(new QortalCore("http://127.0.0.1:1", { timeoutMs: 500 }).status(), /not reachable/);
  } finally {
    await close(core);
  }
});

// ---------------------------------------------------------------- node ranking

test("node ranking: times Base nodes, refuses private DNS answers, skips wss, ranks by p50", async () => {
  const dir = tmp();
  const file = join(dir, "nodes.json");
  writeFileSync(
    file,
    JSON.stringify({
      schema: NODES_SCHEMA,
      chainId: 8453,
      nodes: [
        { label: "slow", url: "https://slow.example.com" },
        { label: "fast", url: "https://fast.example.com" },
        { label: "other chain", url: "https://eth.example.com" },
        { label: "rebind", url: "https://rebind.example.com" },
        { label: "socket", url: "wss://ws.example.com", kind: "ws" },
      ],
    }),
  );
  const delay = { "slow.example.com": 30, "fast.example.com": 1, "eth.example.com": 1 };
  const fetchImpl = async (url, init) => {
    const host = new URL(url).hostname;
    await new Promise((r) => setTimeout(r, delay[host] ?? 0));
    const { method } = JSON.parse(init.body);
    const result = method === "eth_chainId" ? (host === "eth.example.com" ? "0x1" : "0x2105") : host === "slow.example.com" ? "0x64" : "0x66";
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), { status: 200 });
  };
  const resolver = async (host) => [{ address: host === "rebind.example.com" ? "192.168.1.5" : "93.184.216.34" }];
  const lines = [];
  const code = await nodesMain(["--file", file, "--samples", "2", "--out", join(dir, "out.json")], { log: (l) => lines.push(l), fetchImpl, resolver });
  assert.equal(code, 0);
  const out = JSON.parse(readFileSync(join(dir, "out.json"), "utf8"));
  assert.deepEqual(out.nodes.map((n) => n.label), ["fast", "slow", "other chain", "rebind", "socket"]);
  assert.equal(out.nodes[0].lagBlocks, 0);
  assert.equal(out.nodes[1].lagBlocks, 2, "slow is two blocks behind the freshest Base node");
  assert.equal(out.nodes[2].chainOk, false);
  assert.match(out.nodes[3].error, /private address/);
  assert.match(out.nodes[4].skipped, /wss/);
  assert.match(lines.join("\n"), /never|trust/i);
  // A node is never probed when its name resolves privately, even once.
  let hits = 0;
  await probeNode({ url: "https://rebind.example.com", host: "rebind.example.com", kind: "rpc" }, { fetchImpl: async () => (hits++, new Response("{}")), resolver });
  assert.equal(hits, 0);
  assert.deepEqual(rank([{ probe: { ok: false } }, { probe: { ok: true, chainOk: true, p50Ms: 5, block: 10 } }]).map((r) => r.probe.ok), [true, false]);
  // --check for a file you plan to publish
  const checkLines = [];
  assert.equal(await nodesMain(["--check", file], { log: (l) => checkLines.push(l) }), 0);
  assert.match(checkLines[0], /5 node\(s\) pass/);
});

// ---------------------------------------------------------------- bridge

async function fakeBot(scopes = ["read"]) {
  const calls = [];
  const bot = createServer((req, res) => {
    calls.push({ url: req.url, method: req.method, token: req.headers["x-bot-token"] });
    if (req.headers["x-bot-token"] !== "agt_bridgetoken_0123456789abcdef") {
      res.statusCode = 401;
      return res.end('{"error":"no"}');
    }
    if (req.url === "/api/agents/me") return res.end(JSON.stringify({ who: "agent", agent: { id: "a1", scopes } }));
    if (req.url === "/api/brief") return res.end(JSON.stringify(BRIEF));
    if (req.url.startsWith("/api/latency")) return res.end('{"windowHours":24}');
    if (req.url === "/api/simulate") return res.end('{"result":{}}');
    if (req.url === "/api/stream") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("event: block\ndata: {\"n\":1}\n\n");
      return setTimeout(() => res.end(), 50);
    }
    res.statusCode = 404;
    res.end("{}");
  });
  return { bot, url: await listen(bot), calls };
}

test("bridge: read routes only, its own token upstream, CORS for Qortal origins, sanitized snapshots", async () => {
  const { bot, url: botUrl, calls } = await fakeBot();
  const cfg = { botUrl, token: "agt_bridgetoken_0123456789abcdef", host: "127.0.0.1", port: 0, origins: ["http://127.0.0.1:12391"] };
  const logs = [];
  const bridge = createBridge(cfg, { log: (l) => logs.push(l) });
  const b = await listen(bridge);
  const QO = { origin: "http://127.0.0.1:12391" };
  try {
    assert.deepEqual(await checkToken(cfg), ["read"]);
    // health
    const h = await (await fetch(b + "/bridge/health", { headers: QO })).json();
    assert.equal(h.ok, true);
    assert.equal(h.readOnly, true);
    assert.equal(h.bot.reachable, true);
    // a read route, with the caller's own token ignored and the bridge's used
    const r = await fetch(b + "/api/latency?hours=24", { headers: { ...QO, "x-bot-token": "agt_attacker_supplied_token_xx" } });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("access-control-allow-origin"), "http://127.0.0.1:12391");
    assert.deepEqual(await r.json(), { windowHours: 24 });
    assert.equal(calls.at(-1).url, "/api/latency?hours=24");
    assert.equal(calls.at(-1).token, cfg.token);
    // preflight
    const pf = await fetch(b + "/api/brief", { method: "OPTIONS", headers: { ...QO, "access-control-request-method": "GET", "access-control-request-private-network": "true" } });
    assert.equal(pf.status, 204);
    assert.equal(pf.headers.get("access-control-allow-private-network"), "true");
    // writes refused, and never forwarded
    const before = calls.length;
    for (const [method, path] of [["POST", "/api/sending"], ["POST", "/api/stop"], ["POST", "/api/tuning"], ["POST", "/api/agents"], ["POST", "/api/fleet/morpho-liquidator/control"], ["POST", "/api/nodes/test"], ["GET", "/api/agents"], ["GET", "/api/wallet"], ["GET", "/"]]) {
      const w = await fetch(b + path, { method, headers: { ...QO, "content-type": "application/json" }, body: method === "POST" ? "{}" : undefined });
      assert.equal(w.status, 403, `${method} ${path}`);
    }
    assert.equal(calls.length, before, "refused requests never reach the bot");
    // the simulator is a read
    assert.equal((await fetch(b + "/api/simulate", { method: "POST", headers: { ...QO, "content-type": "application/json" }, body: '{"gasX":1}' })).status, 200);
    // other origins are refused, and logged once
    assert.equal((await fetch(b + "/api/brief", { headers: { origin: "https://evil.example" } })).status, 403);
    await fetch(b + "/api/brief", { headers: { origin: "https://evil.example" } });
    assert.equal(logs.filter((l) => l.includes("evil.example")).length, 1);
    // snapshot: aggregate numbers only
    const snap = await (await fetch(b + "/bridge/snapshot", { headers: QO })).json();
    assert.equal(snap.schema, STATUS_SCHEMA);
    assert.ok(!JSON.stringify(snap).includes("0x0fc2"));
    // the event stream passes through
    const s = await fetch(b + "/api/stream", { headers: QO });
    assert.match(await s.text(), /event: block/);
    // no response ever echoes the token
    for (const c of calls) assert.ok(c.url.indexOf("agt_") < 0);
    assert.ok([...READ_ROUTES].every((p) => p.startsWith("/api/")));
  } finally {
    await close(bridge);
    await close(bot);
  }
});

test("bridge: refuses to start with a token that can do more than read, or that isn't an agent token", async () => {
  const { bot, url } = await fakeBot(["read", "pause"]);
  try {
    await assert.rejects(checkToken({ botUrl: url, token: "agt_bridgetoken_0123456789abcdef" }), /also has pause/);
    await assert.rejects(checkToken({ botUrl: url, token: "owner-page-token" }), /agent token/);
    await assert.rejects(checkToken({ botUrl: "http://127.0.0.1:1", token: "agt_bridgetoken_0123456789abcdef" }), /not reachable/);
  } finally {
    await close(bot);
  }
  const dir = tmp();
  writeFileSync(join(dir, "bridge.env"), "BOT_AGENT_TOKEN='agt_from_file_0123456789'\n# QAPP_ORIGINS=http://x\nBRIDGE_PORT=8799\n");
  const cfg = loadConfig({}, join(dir, "bridge.env"));
  assert.equal(cfg.token, "agt_from_file_0123456789");
  assert.equal(cfg.port, 8799);
  assert.equal(cfg.host, "127.0.0.1");
  assert.ok(cfg.origins.includes("http://127.0.0.1:12391"));
});

// ---------------------------------------------------------------- zip, app, release

test("zip writer: archives read back byte for byte, bad paths refused", () => {
  const big = Buffer.from("abc".repeat(5000));
  const zip = makeZip([{ name: "a/b.txt", data: "hello" }, { name: "big.bin", data: big }, { name: "run.sh", data: "#!/bin/sh\n", executable: true }], new Date(2026, 9, 13, 12, 0, 0));
  const files = unzip(zip);
  assert.equal(files.get("a/b.txt").toString(), "hello");
  assert.ok(files.get("big.bin").equals(big));
  assert.ok(zip.length < big.length, "compressed");
  assert.throws(() => makeZip([{ name: "../x", data: "" }]), /bad archive path/);
  assert.throws(() => makeZip([{ name: "x", data: "" }, { name: "x", data: "" }]), /duplicate/);
  assert.equal(crc32(Buffer.from("123456789")), 0xcbf43926);
});

test("Qortal app: the terminal is split into a page and a script started by boot.js", () => {
  const html = readFileSync(join(ROOT, "ui", "terminal.html"), "utf8");
  const { index, terminalJs } = splitTerminal(html);
  assert.match(index, /^<!doctype html>/);
  assert.match(index, /<script src="boot\.js"><\/script>/);
  assert.equal((index.match(/<script>/g) || []).length, 0, "no inline script left");
  assert.match(terminalJs, /var BASE=/);
  assert.doesNotThrow(() => new Function(terminalJs), "terminal.js parses");
  const files = qappFiles((rel) => readFileSync(join(ROOT, rel), "utf8"));
  assert.deepEqual(files.map((f) => f.name), ["index.html", "terminal.js", "boot.js", "network.html", "network.js", "lib/registry.mjs", "lib/status.mjs"]);
  const net = files.find((f) => f.name === "network.js").data;
  assert.doesNotMatch(net, /innerHTML/, "network.js renders untrusted data with textContent only");
  assert.match(net, /from "\.\/lib\/registry\.mjs"/);
});

test("release: secret checks catch keys, tokens and private text; placeholders pass", () => {
  assert.equal(scanText("src/a.ts", 'const url = "https://base-mainnet.g.alchemy.com/v2/AbCdEfGh0123456789";').length, 1);
  assert.equal(scanText("docs/a.md", "PRIVATE_KEY=0x59c6995e998f97a5a0044966f0945389dc9e86da\n").length, 1);
  assert.equal(scanText(".env.example", "PRIVATE_KEY=\nCLOUD_TOKEN=\n").length, 0);
  assert.equal(scanText("deploy/x.example", "PRIVATE_KEY=0xYOUR_KEY_HERE\n").length, 0);
  assert.equal(scanText("src/b.ts", "const privateKey = '0x" + "ab".repeat(32) + "';").length, 1);
  assert.equal(scanText("test/w.test.js", "const pk = new Wallet('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');").length, 0, "public dev key");
  assert.equal(scanText("test/alerts.test.js", 'const TOKEN = "123456789:AAEexampleexampleexampleexampleexample";').length, 0);
  assert.equal(scanText("src/c.ts", "agt_0123456789abcdefghijklmnop").length, 1);
  assert.equal(scanText("docs/d.md", "Hello Alice", ["alice"]).length, 1);
  const excluded = (p) => EXCLUDE.some((re) => re.test(p));
  assert.ok(excluded("release.private.json") && excluded("release.private.local.json") && excluded("docs/FLEET-PLAN.md"));
  assert.ok(!excluded("release.private.example.json") && !excluded("docs/RELEASE-NOTES.md"));
});

test("release: built from what git tracks, private text replaced, Qortal app included, under the size limit", { skip: spawnSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: ROOT }).status !== 0 && "needs a git checkout" }, () => {
  const dir = tmp();
  const priv = join(dir, "private.json");
  writeFileSync(priv, JSON.stringify({ replaceRegex: [["Night watch", "g", "Night-watch"]], replace: [["COMMAND-CENTER", "COMMAND_CENTER"]], mustNotContain: [] }));
  const r = buildRelease({ ref: "HEAD", outDir: dir, privateFile: priv, name: "test-release", cwd: ROOT, log: () => {} });
  assert.ok(r.bytes < 45 * 1024 * 1024);
  const files = unzip(readFileSync(r.zipPath));
  const names = [...files.keys()];
  assert.ok(names.every((n) => n.startsWith("test-release/")));
  for (const must of ["RELEASE.md", "package.json", "bots/upstream/PINS.json", "qortal/README.md", "qortal/qapp/app/index.html", "qortal/qapp/app/terminal.js", "qortal/qapp/arb-terminal-qapp.zip"]) assert.ok(files.has(`test-release/${must}`), must);
  for (const never of ["docs/FLEET-PLAN.md", "docs/AGENT_TASKS.md", ".env", "data/learned.json", "node_modules", "release.private.json"]) assert.ok(!names.some((n) => n === `test-release/${never}` || n.startsWith(`test-release/${never}/`)), never);
  assert.ok(files.has("test-release/release.private.example.json"), "the example rules file ships");
  assert.ok(!names.some((n) => n.includes("bots/upstream/") && !n.endsWith("PINS.json")), "upstream code is not shipped");
  const readme = files.get("test-release/tools/night-watch/README.md");
  if (readme) assert.match(readme.toString(), /Night-watch/);
  const pins = JSON.parse(files.get("test-release/bots/upstream/PINS.json").toString());
  assert.ok(pins.pins.every((p) => /^[0-9a-f]{40}$/.test(p.commit)));
  const app = unzip(files.get("test-release/qortal/qapp/arb-terminal-qapp.zip"));
  assert.ok(app.has("index.html") && app.has("network.html") && app.has("lib/registry.mjs"));
  assert.match(readFileSync(r.zipPath.replace(/\.zip$/, ".sha256"), "utf8"), new RegExp(r.sha256));
  // A private string that remains stops the build.
  writeFileSync(priv, JSON.stringify({ mustNotContain: ["backrun"] }));
  assert.throws(() => buildRelease({ ref: "HEAD", outDir: dir, privateFile: priv, cwd: ROOT, log: () => {} }), /release refused/);
});
