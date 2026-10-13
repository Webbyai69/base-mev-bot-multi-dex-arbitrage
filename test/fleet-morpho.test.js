/**
 * Morpho Blue liquidator adapter (bots/adapters/morpho): log parser, bonus maths, market lookup
 * parsing, the detect-only environment, and one launcher run against a stub bundle that replays
 * recorded log lines. Imports the adapter's .ts files directly (Node >= 22.18 strips types).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { MorphoDetectState, bonusUsd, lifFromLltv, parseLine, parseMarketsResponse } from "../bots/adapters/morpho/parser.ts";
import { detectEnv, VENUE_VARS } from "../bots/adapters/morpho/run.ts";

const DIR = fileURLToPath(new URL("../bots/adapters/morpho/", import.meta.url));
const SAMPLE = readFileSync(join(DIR, "fixtures/detect-sample.jsonl"), "utf8").split("\n");
const MARKETS = JSON.parse(readFileSync(join(DIR, "fixtures/markets-response.json"), "utf8"));
const T0 = Date.parse("2026-10-12T07:41:00Z");

function fed() {
  const s = new MorphoDetectState(T0);
  for (const l of SAMPLE) s.feed(l, T0);
  return s;
}

test("parseLine keeps upstream JSON events and ignores everything else", () => {
  assert.equal(parseLine("> blue-liquidation@0.1.0 build"), null);
  assert.equal(parseLine(""), null);
  assert.equal(parseLine("{not json"), null);
  assert.equal(parseLine('{"level":"info"}'), null, "no event field");
  assert.equal(parseLine('{"event":"tick.end","pairs":1}').event, "tick.end");
});

test("LIF and bonus follow Morpho Blue's formula", () => {
  // 86% LLTV: 1 / (1 - 0.3 * 0.14) = 1.0438...
  assert.ok(Math.abs(lifFromLltv(0.86) - 1 / 0.958) < 1e-12);
  assert.equal(lifFromLltv(0.2), 1.15, "capped at 1.15");
  const info = { pair: "cbBTC/USDC", collateralDecimals: 8, collateralPriceUsd: 60000, lltv: 0.86 };
  // 0.5 cbBTC = $30,000 seized; bonus = 30000 * (1 - 0.958) = $1,260
  assert.ok(Math.abs(bonusUsd("50000000", info) - 1260) < 1e-6);
  assert.equal(bonusUsd(null, info), null);
  assert.equal(bonusUsd("12abc", info), null);
  assert.equal(bonusUsd("1", { ...info, collateralPriceUsd: null }), null);
});

test("recorded detect-mode lines become positions watched, liquidatable and routes", () => {
  const s = fed();
  const m = s.toMetricsFile();
  assert.equal(s.started, true);
  assert.equal(s.detectionOnly, true);
  assert.equal(m.metrics.positionsWatched, 0, "last tick.end wins (the discover.error tick had 0 pairs)");
  assert.equal(m.metrics.liquidatable, 0);
  assert.equal(m.metrics.liquidatableToday, 3, "3 distinct positions were liquidatable earlier");
  assert.equal(m.metrics.ticks, 2);
  assert.equal(m.metrics.discoverErrors, 1);
  assert.equal(m.metrics.lastBlock, 36500001);
  assert.equal(m.sends, 0);
  assert.equal(m.pnlUsd, 0);
  assert.equal(m.gasUsd, 0);
  assert.ok(Object.keys(m.metrics).length <= 12);
  // Unknown markets: routes fall back to the market id, bonus 0.
  assert.deepEqual(s.unknownMarkets().sort(), [
    "0xaaaa000000000000000000000000000000000000000000000000000000000001",
    "0xbbbb000000000000000000000000000000000000000000000000000000000002",
  ]);
  assert.equal(m.routes.length, 2);
  assert.match(m.routes[0].pair, /^market 0x/);
  assert.deepEqual(m.routes[0].venues, ["morpho-blue"]);
  assert.equal(m.metrics.bestBonusUsd, 0);
  assert.match(m.detail, /^detect only: watching 0 positions/);
});

test("market lookup adds pairs and the best bonus", () => {
  const s = fed();
  const markets = parseMarketsResponse(MARKETS);
  assert.equal(markets.size, 2, "the malformed item is dropped");
  for (const [k, v] of markets) s.markets.set(k, v);
  assert.deepEqual(s.unknownMarkets(), []);
  const m = s.toMetricsFile();
  // cbBTC: 0.5 BTC * 60000 * (1 - 0.958) = 1260; wstETH: 2 * 3000 * (1 - (1 - 0.3*0.055)) = 99
  assert.equal(m.metrics.bestBonusUsd, 1260);
  assert.deepEqual(
    m.routes.map((r) => [r.pair, r.count, r.usd]),
    [
      ["cbBTC/USDC", 1, 1260],
      ["wstETH/WETH", 2, 99],
    ],
  );
  assert.match(m.detail, /best bonus ~\$1260\.00/);
});

test("a tx.sent in detect mode is surfaced, and counters reset at UTC midnight", () => {
  const s = fed();
  s.feed('{"event":"tx.sent","id":"x"}', T0);
  assert.equal(s.toMetricsFile().sends, 1);
  assert.match(s.detail(), /WARNING 1 tx sent/);
  s.feed('{"event":"tick.end","pairs":5,"liquidatable":0,"complete":true}', T0 + 24 * 3600 * 1000);
  const m = s.toMetricsFile();
  assert.equal(m.sends, 0);
  assert.equal(m.metrics.liquidatableToday, 0);
  assert.equal(m.metrics.ticks, 1);
  assert.equal(m.metrics.positionsWatched, 5);
});

test("startup.error becomes the detail; strings are bounded", () => {
  const s = new MorphoDetectState(T0);
  s.feed(JSON.stringify({ level: "error", event: "startup.error", error: "EXECUTOOOR_ADDRESS holds no code ".repeat(20) }), T0);
  const d = s.toMetricsFile().detail;
  assert.match(d, /^startup failed: EXECUTOOOR_ADDRESS/);
  assert.ok(d.length <= 300);
});

test("detect env: venue keys never pass, detection-only is forced, values are mapped by name", () => {
  const src = {
    PATH: "/bin",
    BASE_RPC_URL: "https://rpc.example",
    MORPHO_DETECT_PRIVATE_KEY: "0xkey",
    ZEROX_API_KEY: "z",
    ONEINCH_API_KEY: "o",
    LIFI_API_KEY: "l",
    ENABLE_LIFI: "true",
    ALLOW_DETECTION_ONLY: "false",
    FLEET_LIVE_MORPHO_LIQUIDATOR: "1",
    OTHER_BOT_SECRET: "s",
  };
  const { env, missing } = detectEnv(src);
  assert.deepEqual(missing, []);
  for (const v of VENUE_VARS.filter((n) => n !== "ENABLE_LIFI")) assert.equal(env[v], undefined, `${v} dropped`);
  assert.equal(env.ENABLE_LIFI, "false");
  assert.equal(env.ALLOW_DETECTION_ONLY, "true");
  assert.equal(env.CHAIN_ID, "8453");
  assert.equal(env.RPC_URL, "https://rpc.example");
  assert.equal(env.LIQUIDATOR_PRIVATE_KEY, "0xkey");
  assert.equal(env.OTHER_BOT_SECRET, undefined);
  assert.equal(env.FLEET_LIVE_MORPHO_LIQUIDATOR, undefined);
  assert.deepEqual(detectEnv({ PATH: "/bin" }).missing, ["BASE_RPC_URL (or MORPHO_RPC_URL)", "MORPHO_DETECT_PRIVATE_KEY"]);
});

function runAdapter(args, env) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [join(DIR, "run.ts"), ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    p.on("close", (code) => resolve({ code, out }));
  });
}

test("launcher: runs a stub bundle in-process, scrubs env, writes the metrics file", async () => {
  const server = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(MARKETS));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const dir = mkdtempSync(join(tmpdir(), "fleet-morpho-"));
  const metrics = join(dir, "fleet-metrics.json");
  try {
    const { code, out } = await runAdapter(
      ["--mode", "detect", "--metrics", metrics, "--bundle", join(DIR, "fixtures/stub-bundle.mjs")],
      {
        PATH: process.env.PATH,
        BASE_RPC_URL: "https://rpc.example",
        MORPHO_DETECT_PRIVATE_KEY: "0xnot-a-real-key",
        ZEROX_API_KEY: "zzz",
        OTHER_BOT_SECRET: "sss",
        MORPHO_API_URL: `http://127.0.0.1:${port}/graphql`,
      },
    );
    assert.equal(code, 0, out);
    const stub = out.split("\n").map((l) => parseLine(l)).find((e) => e?.event === "stub.env");
    assert.ok(stub, out);
    assert.equal(stub.detection, "true");
    assert.equal(stub.lifi, "false");
    assert.equal(stub.chain, "8453");
    assert.ok(!stub.names.includes("ZEROX_API_KEY"));
    assert.ok(!stub.names.includes("OTHER_BOT_SECRET"));
    assert.ok(!out.includes("0xnot-a-real-key") && !out.includes("rpc.example"), "no values in the log");
    const m = JSON.parse(readFileSync(metrics, "utf8"));
    assert.equal(m.metrics.liquidatableToday, 3);
    assert.equal(m.metrics.bestBonusUsd, 1260);
    assert.equal(m.routes[0].pair, "cbBTC/USDC");
    assert.ok(!JSON.stringify(m).includes("0xnot-a-real-key"));
  } finally {
    server.close();
  }
});

test("launcher: refuses paper/live and reports missing settings by name", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fleet-morpho-"));
  const metrics = join(dir, "m.json");
  const stubArgs = ["--metrics", metrics, "--bundle", join(DIR, "fixtures/stub-bundle.mjs")];
  const paper = await runAdapter(["--mode", "paper", ...stubArgs], { PATH: process.env.PATH });
  assert.equal(paper.code, 1);
  assert.match(JSON.parse(readFileSync(metrics, "utf8")).detail, /not offered/);
  const live = await runAdapter(["--mode", "live", ...stubArgs], { PATH: process.env.PATH });
  assert.equal(live.code, 1);
  const missing = await runAdapter(["--mode", "detect", ...stubArgs], { PATH: process.env.PATH });
  assert.equal(missing.code, 1);
  assert.match(JSON.parse(readFileSync(metrics, "utf8")).detail, /set BASE_RPC_URL .* and MORPHO_DETECT_PRIVATE_KEY/);
});

test("wrapper config: detect only, paper and live empty, no keys in it", () => {
  const cfg = JSON.parse(readFileSync(new URL("../bots/wrapper/configs/morpho-liquidator.json", import.meta.url), "utf8"));
  assert.equal(cfg.id, "morpho-liquidator");
  assert.deepEqual(cfg.commands.detect, ["node", "bots/adapters/morpho/run.ts", "--mode", "detect"]);
  assert.deepEqual(cfg.commands.paper, []);
  assert.deepEqual(cfg.commands.live, []);
  assert.equal(cfg.env.detect.ALLOW_DETECTION_ONLY, "true");
  assert.equal(cfg.env.detect.CHAIN_ID, "8453");
  for (const k of ["ZEROX_API_KEY", "ONEINCH_API_KEY", "LIFI_API_KEY"]) assert.equal(cfg.env.detect[k], "");
  assert.deepEqual(cfg.env.live, {});
  assert.doesNotMatch(JSON.stringify(cfg), /0x[0-9a-fA-F]{64}|https?:\/\//);
});
