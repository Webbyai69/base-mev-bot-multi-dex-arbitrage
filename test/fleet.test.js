/**
 * Fleet registry, desired-state control and heartbeats (src/fleet/*), plus the
 * reference Python wrapper's side of the contract (bots/CONTRACT.md).
 * Runs against the compiled dist/; the wrapper tests skip without python3.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { FLEET, botById, liveFlag } from "../dist/fleet/registry.js";
import { FleetControl, STALE_MS } from "../dist/fleet/control.js";

const WRAPPER = fileURLToPath(new URL("../bots/wrapper/fleet_wrapper.py", import.meta.url));
const tmp = () => mkdtempSync(join(tmpdir(), "fleet-test-"));
const hasPython = (() => {
  try {
    execFileSync("python3", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

test("the registry holds the flagship plus the ten, each pinned and licensed", () => {
  assert.equal(FLEET.length, 11);
  assert.equal(new Set(FLEET.map((b) => b.id)).size, 11, "ids are unique");
  assert.equal(FLEET.filter((b) => b.kind === "in-process").length, 1);
  for (const b of FLEET.filter((x) => x.kind === "external")) {
    assert.match(b.id, /^[a-z0-9-]{1,40}$/);
    assert.ok(b.upstream, `${b.id} names its upstream`);
    assert.match(b.upstream.commit, /^[0-9a-f]{40}$/, `${b.id} is pinned to a full commit`);
    assert.ok(b.upstream.license.length > 2 && b.upstream.obligations.length > 10, `${b.id} records licence and obligations`);
    assert.ok(!b.modes.includes("live") || b.modes.length > 1, "live is never a bot's only mode");
  }
  assert.match(botById("jito-searcher").excluded, /sandwich/);
  assert.equal(liveFlag("morpho-liquidator"), "FLEET_LIVE_MORPHO_LIQUIDATOR");
  // GPL code is run over its API only, never vendored as a library we import.
  assert.match(botById("freqtrade").upstream.obligations, /REST API only/);
  assert.equal(botById("triangular").upstream.path, undefined, "no-licence code is not a submodule");
});

test("control requests: detect/paper only, never live, never the in-process bot", () => {
  const fc = new FleetControl(tmp());
  assert.throws(() => fc.request("morpho-liquidator", "running", { mode: "live" }, "agent:x"), /FLEET_LIVE_MORPHO_LIQUIDATOR=1/);
  assert.throws(() => fc.request("base-arb-bot", "running", { mode: "paper" }, "owner"), /STOP file/);
  assert.throws(() => fc.request("nope", "running", {}, "owner"), /unknown bot/);
  assert.throws(() => fc.request("hummingbot", "running", { mode: "detect" }, "owner"), /no detect mode/);
  assert.throws(() => fc.request("morpho-liquidator", "running", { gasCapUsd: 6 }, "owner"), /gas cap/);
  assert.throws(() => fc.request("morpho-liquidator", "running", { mode: "turbo" }, "owner"), /detect or paper/);
  const c = fc.request("morpho-liquidator", "running", { target: "base:morpho-blue", gasCapUsd: 1 }, "agent:ops-1");
  assert.equal(c.mode, "detect", "defaults to detect when the bot offers it");
  assert.equal(c.requestedBy, "agent:ops-1");
  const onDisk = JSON.parse(readFileSync(join(fc.dir, "morpho-liquidator.control.json"), "utf8"));
  assert.deepEqual(onDisk, c);
  assert.equal(fc.request("hummingbot", "stopped", {}, "owner").mode, "paper");
});

test("heartbeats are untrusted: fields are bounded, cut and dropped", () => {
  const dir = tmp();
  const fc = new FleetControl(dir);
  const write = (id, v) => writeFileSync(join(dir, `${id}.heartbeat.json`), typeof v === "string" ? v : JSON.stringify(v));
  write("morpho-liquidator", {
    status: "hacked",
    mode: "god",
    pnlUsd: 1e99,
    sends: -5,
    gasUsd: "12",
    lastError: "x".repeat(5000),
    updatedAt: new Date().toISOString(),
    extra: "<script>",
    routes: [...Array(20)].map((_, i) => ({ pair: "A/B".repeat(50), venues: ["v1", 2, null, "v4", "v5"], count: i, usd: 1.5 })),
    metrics: { ok: 1, "bad key": 2, nested: { a: 1 }, str: "9", ...Object.fromEntries([...Array(20)].map((_, i) => [`m${i}`, i])) },
  });
  const hb = fc.heartbeat("morpho-liquidator");
  assert.equal(hb.status, "error");
  assert.equal(hb.mode, "detect");
  assert.equal(hb.pnlUsd, 1e9);
  assert.equal(hb.sends, 0);
  assert.equal(hb.gasUsd, 12);
  assert.equal(hb.lastError.length, 300);
  assert.equal("extra" in hb, false);
  assert.equal(hb.routes.length, 12);
  assert.equal(hb.routes[0].pair.length, 40);
  assert.equal(hb.routes[0].venues.length, 4);
  assert.equal(hb.metrics.ok, 1);
  assert.equal("bad key" in hb.metrics, false);
  assert.equal("nested" in hb.metrics, false);
  assert.equal("str" in hb.metrics, false);
  assert.ok(Object.keys(hb.metrics).length <= 12);
  write("artemis", { status: "running" }); // no updatedAt
  assert.equal(fc.heartbeat("artemis"), undefined);
  write("passivbot", "{" + " ".repeat(70 * 1024) + "}"); // oversize
  assert.equal(fc.heartbeat("passivbot"), undefined);
  write("freqtrade", "not json");
  assert.equal(fc.heartbeat("freqtrade"), undefined);
  assert.throws(() => fc.heartbeat("../../etc/passwd"), /bad bot id/);
});

test("rows: not installed, running, stale after 90 s, and the in-process flagship", () => {
  const dir = tmp();
  const fc = new FleetControl(dir);
  const now = Date.now();
  writeFileSync(join(dir, "morpho-liquidator.heartbeat.json"), JSON.stringify({ status: "running", mode: "detect", updatedAt: new Date(now - 5_000).toISOString() }));
  writeFileSync(join(dir, "hummingbot.heartbeat.json"), JSON.stringify({ status: "running", mode: "paper", updatedAt: new Date(now - STALE_MS - 1_000).toISOString() }));
  const rows = fc.rows({ mode: "paper", pnlUsd: 1.5, sends: 0, gasUsd: 0, detail: "paper", running: true }, now);
  const by = Object.fromEntries(rows.map((r) => [r.id, r]));
  assert.equal(by["base-arb-bot"].state, "in-process");
  assert.equal(by["base-arb-bot"].liveFlag, null);
  assert.equal(by["morpho-liquidator"].state, "running");
  assert.equal(by["morpho-liquidator"].heartbeatAgeS, 5);
  assert.equal(by["hummingbot"].state, "stale");
  assert.equal(by["passivbot"].state, "not-installed");
  assert.equal(by["passivbot"].liveFlag, "FLEET_LIVE_PASSIVBOT");
  assert.equal(fc.rows({ mode: "paper", pnlUsd: 0, sends: 0, gasUsd: 0, detail: null, running: false }, now)[0].state, "stopped");
});

function wrapperRun(dir, cfg, control, { live = false, env = "", stop = false } = {}) {
  const fleetDir = join(dir, "data", "fleet");
  mkdirSync(fleetDir, { recursive: true });
  const cfgPath = join(dir, "cfg.json");
  writeFileSync(cfgPath, JSON.stringify({ cwd: ".", logFile: join(dir, "w.log"), ...cfg }));
  if (control) writeFileSync(join(fleetDir, `${cfg.id}.control.json`), JSON.stringify(control));
  const envPath = join(dir, "w.env");
  writeFileSync(envPath, env);
  if (stop) writeFileSync(join(dir, "data", "STOP"), "test\n");
  const args = [WRAPPER, "--config", cfgPath, "--fleet-dir", fleetDir, "--env-file", envPath, "--once"];
  if (live) args.push("--live");
  const r = spawnSync("python3", args, { encoding: "utf8", timeout: 20_000 });
  assert.equal(r.status, 0, r.stderr);
  return new FleetControl(fleetDir);
}

const SLEEP = ["python3", "-c", "import time; time.sleep(2)"];

test("python wrapper: runs the requested mode and reports through the heartbeat", { skip: !hasPython }, () => {
  const dir = tmp();
  const fc = wrapperRun(dir, { id: "morpho-liquidator", commands: { detect: SLEEP } }, { desired: "running", mode: "detect", requestedAt: new Date().toISOString() });
  const hb = fc.heartbeat("morpho-liquidator");
  assert.equal(hb.status, "running");
  assert.equal(hb.mode, "detect");
  assert.equal(hb.lastError, null);
  const row = fc.rows({ mode: "paper", pnlUsd: 0, sends: 0, gasUsd: 0, detail: null, running: true }).find((r) => r.id === "morpho-liquidator");
  assert.equal(row.state, "running");
});

test("python wrapper: a mode without a command is an error, not a guess", { skip: !hasPython }, () => {
  const dir = tmp();
  const fc = wrapperRun(dir, { id: "morpho-liquidator", commands: { detect: SLEEP } }, { desired: "running", mode: "paper", requestedAt: new Date().toISOString() });
  const hb = fc.heartbeat("morpho-liquidator");
  assert.equal(hb.status, "error");
  assert.match(hb.lastError, /no paper command/);
});

test("python wrapper: --live without the owner's flag stays off live", { skip: !hasPython }, () => {
  const dir = tmp();
  const fc = wrapperRun(dir, { id: "morpho-liquidator", commands: { detect: SLEEP, live: SLEEP } }, { desired: "running", mode: "detect", requestedAt: new Date().toISOString() }, { live: true });
  const hb = fc.heartbeat("morpho-liquidator");
  assert.equal(hb.mode, "detect");
  assert.match(hb.lastError, /FLEET_LIVE_MORPHO_LIQUIDATOR=1 is not set/);
});

test("python wrapper: the STOP file stops a live run", { skip: !hasPython }, () => {
  const dir = tmp();
  const fc = wrapperRun(dir, { id: "morpho-liquidator", commands: { live: SLEEP } }, null, { live: true, env: "FLEET_LIVE_MORPHO_LIQUIDATOR=1\n", stop: true });
  const hb = fc.heartbeat("morpho-liquidator");
  assert.equal(hb.status, "stopped");
  assert.match(hb.detail, /STOP file/);
  assert.ok(existsSync(join(dir, "data", "STOP")), "the wrapper never removes STOP");
});

test("python wrapper: owner-armed live runs live; a newer dashboard stop still stops it", { skip: !hasPython }, () => {
  const dir = tmp();
  const env = "FLEET_LIVE_MORPHO_LIQUIDATOR=1\nSECRET_KEY=0xdeadbeef\n";
  let fc = wrapperRun(dir, { id: "morpho-liquidator", commands: { live: SLEEP } }, null, { live: true, env });
  let hb = fc.heartbeat("morpho-liquidator");
  assert.equal(hb.status, "running");
  assert.equal(hb.mode, "live");
  const raw = readFileSync(join(dir, "data", "fleet", "morpho-liquidator.heartbeat.json"), "utf8");
  assert.ok(!raw.includes("deadbeef"), "nothing from the .env reaches the heartbeat");
  fc = wrapperRun(dir, { id: "morpho-liquidator", commands: { live: SLEEP } }, { desired: "stopped", mode: "detect", requestedAt: new Date(Date.now() + 60_000).toISOString() }, { live: true, env });
  hb = fc.heartbeat("morpho-liquidator");
  assert.notEqual(hb.status, "running");
});
