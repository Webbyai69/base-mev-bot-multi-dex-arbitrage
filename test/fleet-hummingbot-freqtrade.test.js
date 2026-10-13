/**
 * Phase 2: Hummingbot + Freqtrade in paper mode (bots/compose, bots/adapters).
 * Bridges and launcher are Python (standard library); these tests drive them as
 * separate processes, against a fake Freqtrade REST API and a fake Hummingbot
 * data folder. Nothing here needs Docker, network access or dist/.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = (p) => fileURLToPath(new URL(`../${p}`, import.meta.url));
const ADAPTERS = root("bots/adapters");
const FT_BRIDGE = join(ADAPTERS, "freqtrade_bridge.py");
const HB_BRIDGE = join(ADAPTERS, "hummingbot_bridge.py");
const LAUNCHER = join(ADAPTERS, "compose_paper.py");
const WRAPPER = root("bots/wrapper/fleet_wrapper.py");
const tmp = () => mkdtempSync(join(tmpdir(), "fleet-p2-"));
const hasPython = (() => {
  try {
    execFileSync("python3", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();
const py = { skip: !hasPython };
// Async on purpose: the fake API lives in this process and must keep answering.
const run = (args, env = {}) =>
  new Promise((resolve) => {
    execFile("python3", args, { env: { ...process.env, ...env }, encoding: "utf8", timeout: 30_000 }, (err, stdout, stderr) =>
      resolve({ code: err ? err.code : 0, stdout, stderr }),
    );
  });
const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- Freqtrade bridge

const USER = "fleet-test-user";
const PASS = "pw-must-never-leak-123";
const today = new Date().toISOString().slice(0, 10);

function fakeFreqtrade({ dryRun = true } = {}) {
  const auth = "Basic " + Buffer.from(`${USER}:${PASS}`).toString("base64");
  const routes = {
    "/api/v1/show_config": { dry_run: dryRun, stake_currency: "USDT", exchange: "binance", strategy: "SampleStrategy", state: "running" },
    "/api/v1/daily?timescale=1": {
      data: [{ date: today, abs_profit: 1.25, rel_profit: 0.001, starting_balance: 1000, fiat_value: 1.25, trade_count: 4 }],
      fiat_display_currency: "USD",
      stake_currency: "USDT",
    },
    "/api/v1/profit": { profit_closed_coin: 3.5, profit_all_coin: 4.0, closed_trade_count: 9, winning_trades: 6, losing_trades: 3 },
    "/api/v1/status": [{ pair: "ETH/USDT", total_profit_abs: 0.5 }],
    "/api/v1/balance": { total: 1004, total_bot: 1004, starting_capital: 1000 },
    "/api/v1/performance": [
      { pair: "ETH/USDT", profit_abs: 2.5, count: 5 },
      { pair: "BTC/USDT", profit_abs: 1.0, count: 4 },
    ],
  };
  const seen = [];
  const server = createServer((req, res) => {
    seen.push(req.url);
    if (req.url === "/api/v1/ping") return res.end(JSON.stringify({ status: "pong" }));
    if (req.headers.authorization !== auth) {
      res.statusCode = 401;
      return res.end(JSON.stringify({ detail: "Unauthorized" }));
    }
    const body = routes[req.url];
    if (!body) {
      res.statusCode = 404;
      return res.end("{}");
    }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(body));
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, seen, url: `http://127.0.0.1:${server.address().port}` })));
}

test("freqtrade bridge: REST status, profit and balance become the wrapper's metrics file", py, async () => {
  const { server, url, seen } = await fakeFreqtrade();
  const out = join(tmp(), "fleet-metrics.json");
  try {
    const r = await run([FT_BRIDGE, "--api-url", url, "--metrics", out, "--once"], {
      FREQTRADE_API_USERNAME: USER,
      FREQTRADE_API_PASSWORD: PASS,
    });
    assert.equal(r.code, 0, r.stderr);
    const m = readJson(out);
    assert.equal(m.pnlUsd, 1.25, "today's realised dry-run profit, USDT valued 1:1");
    assert.equal(m.sends, 4, "trades closed today");
    assert.equal(m.gasUsd, 0);
    assert.equal(m.liveDetected, false);
    assert.match(m.detail, /dry-run SampleStrategy on binance/);
    assert.equal(m.metrics.openTrades, 1);
    assert.equal(m.metrics.unrealisedUsd, 0.5);
    assert.ok(Math.abs(m.metrics.winRatePct - (100 * 6) / 9) < 1e-5);
    assert.equal(m.metrics.paperBalanceUsd, 1004);
    assert.ok(Object.keys(m.metrics).length <= 12);
    assert.deepEqual(m.routes[0], { pair: "ETH/USDT", venues: ["binance-paper"], count: 5, usd: 2.5 });
    for (const p of ["/api/v1/status", "/api/v1/profit", "/api/v1/balance"]) assert.ok(seen.includes(p), `polled ${p}`);
    const all = readFileSync(out, "utf8") + r.stdout + r.stderr;
    assert.ok(!all.includes(PASS) && !all.includes(USER), "credentials never reach the file or the output");
  } finally {
    server.close();
  }
});

test("freqtrade bridge: dry_run=false is reported as live and exits 3", py, async () => {
  const { server, url } = await fakeFreqtrade({ dryRun: false });
  const out = join(tmp(), "m.json");
  try {
    const r = await run([FT_BRIDGE, "--api-url", url, "--metrics", out, "--once"], {
      FREQTRADE_API_USERNAME: USER,
      FREQTRADE_API_PASSWORD: PASS,
    });
    assert.equal(r.code, 3);
    const m = readJson(out);
    assert.equal(m.liveDetected, true);
    assert.match(m.detail, /LIVE MODE DETECTED/);
    assert.equal(m.pnlUsd, 0);
  } finally {
    server.close();
  }
});

test("freqtrade bridge: wrong credentials and a stopped API are reported, not crashed on", py, async () => {
  const { server, url } = await fakeFreqtrade();
  const out = join(tmp(), "m.json");
  try {
    const r = await run([FT_BRIDGE, "--api-url", url, "--metrics", out, "--once"], {
      FREQTRADE_API_USERNAME: USER,
      FREQTRADE_API_PASSWORD: "wrong",
    });
    assert.equal(r.code, 0);
    assert.match(readJson(out).detail, /HTTP 401/);
  } finally {
    server.close();
  }
  const r2 = await run([FT_BRIDGE, "--api-url", "http://127.0.0.1:9", "--metrics", out, "--once"]);
  assert.equal(r2.code, 0);
  const m = readJson(out);
  assert.equal(m.metrics.apiUp, 0);
  assert.match(m.detail, /not reachable at 127\.0\.0\.1:9/);
});

// ---------------------------------------------------------------- Hummingbot bridge

function fakeHummingbot({ exchange = "binance_paper_trade", fills = [] } = {}) {
  const dir = tmp();
  mkdirSync(join(dir, "conf", "scripts"), { recursive: true });
  mkdirSync(join(dir, "data", "bot"), { recursive: true });
  mkdirSync(join(dir, "logs"), { recursive: true });
  writeFileSync(
    join(dir, "conf", "scripts", "conf_simple_pmm.yml"),
    `script_file_name: simple_pmm.py\nexchange: ${exchange}  # paper\ntrading_pair: ETH-USDT\norder_amount: 0.01\n`,
  );
  writeFileSync(join(dir, "data", "bot", "meta.json"), JSON.stringify({ name: "conf_simple_pmm", started_at: Date.now() / 1000 - 60 }));
  writeFileSync(
    join(dir, "logs", "logs_conf_simple_pmm.log"),
    "2026-10-12 10:00:00 - 1 - hummingbot.strategy - INFO - Created LIMIT BUY order\n" +
      "2026-10-12 10:00:05 - 1 - hummingbot.connector - ERROR - order book stream reconnecting\n",
  );
  // TradeFill with Hummingbot's storage: price/amount/fee as integers x 1e6, timestamp in ms.
  const rows = JSON.stringify(fills);
  execFileSync("python3", [
    "-c",
    `import sqlite3,json,sys
con=sqlite3.connect(sys.argv[1])
con.execute("CREATE TABLE TradeFill (config_file_path TEXT, strategy TEXT, market TEXT, symbol TEXT, base_asset TEXT, quote_asset TEXT, timestamp INTEGER, order_id TEXT, trade_type TEXT, order_type TEXT, price INTEGER, amount INTEGER, leverage INTEGER, trade_fee TEXT, trade_fee_in_quote INTEGER, exchange_trade_id TEXT, position TEXT)")
for i,f in enumerate(json.loads(sys.argv[2])):
    con.execute("INSERT INTO TradeFill VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",("conf_simple_pmm.yml","simple_pmm",f["market"],"ETH-USDT","ETH","USDT",f["ts"],"o%d"%i,f["side"],"LIMIT",round(f["price"]*1e6),round(f["amount"]*1e6),1,"{}",round(f["fee"]*1e6),"x%d"%i,"NIL"))
con.commit()`,
    join(dir, "data", "conf_simple_pmm.sqlite"),
    rows,
  ]);
  return dir;
}

test("hummingbot bridge: paper fills today become pnl, sends, routes and metrics", py, async () => {
  const now = Date.now();
  const dir = fakeHummingbot({
    fills: [
      { market: "binance_paper_trade", side: "BUY", price: 2000, amount: 0.01, fee: 0.01, ts: now - 30_000 },
      { market: "binance_paper_trade", side: "SELL", price: 2004, amount: 0.01, fee: 0.01, ts: now - 10_000 },
      { market: "binance_paper_trade", side: "BUY", price: 1990, amount: 0.01, fee: 0, ts: now - 3 * 86_400_000 },
    ],
  });
  const out = join(tmp(), "m.json");
  const r = await run([HB_BRIDGE, "--root", dir, "--metrics", out, "--once"]);
  assert.equal(r.code, 0, r.stderr);
  const m = readJson(out);
  assert.equal(m.sends, 2, "only today's fills count");
  assert.ok(Math.abs(m.pnlUsd - 0.02) < 1e-9, `0.04 spread - 0.02 fees, got ${m.pnlUsd}`);
  assert.equal(m.metrics.fillsAll, 3);
  assert.equal(m.metrics.buysToday, 1);
  assert.equal(m.metrics.logErrors, 1);
  assert.equal(m.metrics.paper, 1);
  assert.equal(m.liveDetected, false);
  assert.deepEqual(m.routes[0].venues, ["binance_paper_trade"]);
  assert.match(m.detail, /simple_pmm paper ETH-USDT on binance_paper_trade: running, 2 fills today/);
  assert.match(m.detail, /order book stream reconnecting/);
});

test("hummingbot bridge: a live connector or a live fill is refused (exit 3)", py, async () => {
  const out = join(tmp(), "m.json");
  const r1 = await run([HB_BRIDGE, "--root", fakeHummingbot({ exchange: "binance" }), "--metrics", out, "--once"]);
  assert.equal(r1.code, 3);
  assert.match(readJson(out).detail, /LIVE CONNECTOR/);
  const dir = fakeHummingbot({ fills: [{ market: "binance", side: "BUY", price: 1, amount: 1, fee: 0, ts: Date.now() }] });
  const r2 = await run([HB_BRIDGE, "--root", dir, "--metrics", out, "--once"]);
  assert.equal(r2.code, 3);
  assert.equal(readJson(out).liveDetected, true);
});

test("hummingbot bridge: an empty folder (first start) reports, does not crash", py, async () => {
  const dir = tmp();
  mkdirSync(join(dir, "conf", "scripts"), { recursive: true });
  writeFileSync(join(dir, "conf", "scripts", "conf_simple_pmm.yml"), "exchange: binance_paper_trade\ntrading_pair: ETH-USDT\n");
  const out = join(tmp(), "m.json");
  const r = await run([HB_BRIDGE, "--root", dir, "--metrics", out, "--once"]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(readJson(out).detail, /no log yet/);
});

// ---------------------------------------------------------------- launcher + wrapper

function composeCopy() {
  const dir = tmp();
  cpSync(root("bots/compose"), dir, { recursive: true, filter: (s) => !/[\\/](state|user_data|data|logs|conf)$/.test(s) });
  return dir;
}

test("launcher: paper only, needs the env names, and copies example configs on first run", py, async () => {
  const dir = composeCopy();
  const metrics = join(dir, "m.json");
  const live = await run([LAUNCHER, "--service", "freqtrade", "--compose-dir", dir, "--metrics", metrics, "--check"], { FLEET_MODE: "live" });
  assert.equal(live.code, 2);
  assert.match(readJson(metrics).detail, /paper mode only/);

  const noEnv = { FREQTRADE_API_USERNAME: "", FREQTRADE_API_PASSWORD: "", FREQTRADE_JWT_SECRET: "", FLEET_MODE: "paper" };
  const missing = await run([LAUNCHER, "--service", "freqtrade", "--compose-dir", dir, "--metrics", metrics, "--check"], noEnv);
  assert.equal(missing.code, 2);
  assert.match(missing.stderr, /FREQTRADE_API_USERNAME, FREQTRADE_API_PASSWORD, FREQTRADE_JWT_SECRET/);
  assert.ok(existsSync(join(dir, "freqtrade", "config.json")), "config.json created from the example");
  assert.ok(existsSync(join(dir, "hummingbot", "conf", "scripts", "conf_simple_pmm.yml")));

  const ok = await run([LAUNCHER, "--service", "freqtrade", "--compose-dir", dir, "--metrics", metrics, "--check"], {
    FREQTRADE_API_USERNAME: USER,
    FREQTRADE_API_PASSWORD: PASS,
    FREQTRADE_JWT_SECRET: "jwt",
  });
  assert.equal(ok.code, 0, ok.stderr);
  assert.ok(!(ok.stdout + ok.stderr).includes(PASS));

  writeFileSync(join(dir, "hummingbot", "conf", "scripts", "conf_simple_pmm.yml"), "exchange: kucoin\n");
  const hb = await run([LAUNCHER, "--service", "hummingbot", "--compose-dir", dir, "--metrics", metrics, "--check"], {
    HUMMINGBOT_PASSWORD: "x",
  });
  assert.equal(hb.code, 2);
  assert.match(hb.stderr, /_paper_trade/);
});

test("wrapper: {python} runs this interpreter and the stop command runs after the bot stops", py, async () => {
  const work = tmp();
  const fleet = join(work, "fleet");
  mkdirSync(fleet);
  const cfg = join(work, "cfg.json");
  writeFileSync(
    cfg,
    JSON.stringify({
      id: "freqtrade",
      cwd: work,
      commands: { paper: ["{python}", "-c", "import time; time.sleep(30)"] },
      stop: { paper: ["{python}", "-c", "open('stopped.txt','w').write('ok')"] },
      logFile: join(work, "w.log"),
    }),
  );
  writeFileSync(join(fleet, "freqtrade.control.json"), JSON.stringify({ id: "freqtrade", desired: "running", mode: "paper" }));
  const w = spawn("python3", [WRAPPER, "--config", cfg, "--fleet-dir", fleet, "--env-file", join(work, "none.env")], { stdio: "ignore" });
  const hb = join(fleet, "freqtrade.heartbeat.json");
  for (let i = 0; i < 50 && !(existsSync(hb) && readJson(hb).status === "running"); i++) await sleep(100);
  assert.equal(readJson(hb).status, "running");
  assert.equal(readJson(hb).mode, "paper");
  w.kill("SIGTERM");
  await new Promise((r) => w.on("exit", r));
  assert.equal(readFileSync(join(work, "stopped.txt"), "utf8"), "ok");
  assert.equal(readJson(hb).status, "stopped");
});

// ---------------------------------------------------------------- static safety checks

test("compose, configs and adapters keep paper only, keys out and GPL code out", () => {
  const compose = readFileSync(root("bots/compose/docker-compose.yml"), "utf8");
  assert.match(compose, /exec freqtrade trade --dry-run/, "dry-run is forced on the command line");
  assert.match(compose, /FREQTRADE__DRY_RUN: "true"/);
  assert.doesNotMatch(compose, /^\s*FREQTRADE__EXCHANGE__(KEY|SECRET)\s*:/m, "no exchange keys passed in");
  assert.doesNotMatch(compose, /^\s*gateway:/m, "no Gateway (DEX) service");
  for (const m of compose.matchAll(/^\s*-\s*"([^"]*:\d+)"\s*$/gm)) assert.match(m[1], /^127\.0\.0\.1:/, "ports bound to this PC only");
  assert.match(compose, /restart: "no"/);

  const ft = readJson(root("bots/compose/freqtrade/config.example.json"));
  assert.equal(ft.dry_run, true);
  assert.equal(ft.exchange.key, "");
  assert.equal(ft.exchange.secret, "");
  assert.match(readFileSync(root("bots/compose/hummingbot/conf_simple_pmm.example.yml"), "utf8"), /^exchange: \w+_paper_trade$/m);

  for (const id of ["freqtrade", "hummingbot"]) {
    const c = readJson(root(`bots/wrapper/configs/${id}.json`));
    assert.equal(c.id, id);
    assert.deepEqual(c.commands.live, [], "live stays empty");
    assert.deepEqual(c.commands.detect, [], "no detect mode for exchange bots");
    assert.ok(c.commands.paper.includes(id) && c.stop.paper.includes(id));
    assert.match(c.metricsFile, new RegExp(`^state/${id}/fleet-metrics\\.json$`));
  }

  for (const f of ["freqtrade_bridge.py", "hummingbot_bridge.py", "compose_paper.py", "fleet_metrics.py"]) {
    const src = readFileSync(join(ADAPTERS, f), "utf8");
    assert.doesNotMatch(src, /^\s*(from|import)\s+(freqtrade|hummingbot)(\.|\s|$)/m, `${f} imports no upstream code`);
    assert.doesNotMatch(src, /^\s*(from|import)\s+(requests|yaml|aiohttp)\b/m, `${f} is standard library only`);
    assert.doesNotMatch(src, /["']connectors["']|password_verification/, `${f} never opens key stores`);
  }

  // Only meaningful in a git checkout (a release zip has no .git).
  let inGit = false;
  try {
    inGit = execFileSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: root("."), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() === "true";
  } catch {
    /* git missing or not a checkout */
  }
  if (inGit) {
    const ignored = execFileSync(
      "git",
      ["check-ignore", "bots/compose/freqtrade/config.json", "bots/compose/hummingbot/conf/scripts/x.yml", "bots/compose/state/a.json", "bots/compose/.env"],
      { cwd: root("."), encoding: "utf8" },
    );
    assert.equal(ignored.trim().split("\n").length, 4, "real configs, bot data and .env stay out of git");
  }
});
