/**
 * Passivbot backtest harness (bots/passivbot/run_backtest.py): config merge over the upstream
 * default, the summary from a recorded result folder, and the fleet metrics it publishes.
 * Spawns Python 3 (python3, then python); skipped when neither is installed.
 * The upstream submodule is only needed for the config-merge test (skipped when not fetched).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const SCRIPT = join(ROOT, "bots/passivbot/run_backtest.py");
const PY = ["python3", "python"].find((p) => spawnSync(p, ["--version"]).status === 0);
const UPSTREAM_DEFAULT = join(ROOT, "bots/upstream/passivbot/configs/examples/default_trailing_martingale_long.json");

function run(args) {
  const r = spawnSync(PY, ["-I", SCRIPT, ...args], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return r;
}

test("summary from a recorded backtest: period, trades, net, max drawdown", { skip: !PY && "no python" }, () => {
  const out = mkdtempSync(join(tmpdir(), "pb-"));
  const metrics = join(out, "metrics.json");
  run(["--summarize", join(ROOT, "bots/passivbot/fixtures/backtest-sample"), "--out", out, "--metrics", metrics]);
  const s = JSON.parse(readFileSync(join(out, "summary.json"), "utf8"));
  assert.deepEqual(s.period, { start: "2026-04-01", end: "2026-10-01" });
  assert.equal(s.trades, 3);
  assert.deepEqual(s.tradesByCoin, { BTC: 2, ETH: 1 });
  assert.equal(s.startingBalanceUsd, 1000);
  assert.equal(s.netUsd, 221.5, "from gain_usd 1.2215 on $1,000");
  assert.equal(s.gainPct, 22.15);
  assert.equal(s.maxDrawdownPct, 18.34, "the USD drawdown, not the BTC one");
  assert.equal(s.realisedPnlUsd, 0.7);
  assert.equal(s.feesUsd, -0.034);
  assert.deepEqual(s.coins, ["BTC", "ETH"]);

  const m = JSON.parse(readFileSync(metrics, "utf8"));
  assert.equal(m.pnlUsd, 0, "a backtest is never reported as today's pnl");
  assert.equal(m.sends, 0);
  assert.equal(m.metrics.trades, 3);
  assert.equal(m.metrics.maxDrawdownPct, 18.34);
  assert.match(m.detail, /BTC,ETH on hyperliquid 2026-04-01\.\.2026-10-01: 3 fills, net \$221\.5/);
  assert.equal(m.routes[0].pair, "BTC/USDC");
});

test("--report publishes an empty card before the first backtest", { skip: !PY && "no python" }, () => {
  const out = mkdtempSync(join(tmpdir(), "pb-"));
  const metrics = join(out, "metrics.json");
  run(["--report", "--once", "--out", out, "--metrics", metrics]);
  const m = JSON.parse(readFileSync(metrics, "utf8"));
  assert.match(m.detail, /no backtest yet/);
  assert.deepEqual(m.routes, []);
});

test("config merge keeps the upstream default and applies our Hyperliquid override", { skip: (!PY && "no python") || (!existsSync(UPSTREAM_DEFAULT) && "passivbot submodule not fetched") }, () => {
  const out = mkdtempSync(join(tmpdir(), "pb-"));
  run(["--dry-run", "--out", out]);
  const cfg = JSON.parse(readFileSync(join(out, "config.generated.json"), "utf8"));
  const base = JSON.parse(readFileSync(UPSTREAM_DEFAULT, "utf8"));
  assert.deepEqual(cfg.backtest.exchanges, ["binance", "hyperliquid"]);
  assert.deepEqual(cfg.backtest.market_settings_sources, { BTC: "hyperliquid", ETH: "hyperliquid" });
  assert.equal(cfg.backtest.starting_balance, 1000);
  assert.deepEqual(cfg.live.approved_coins, { long: ["BTC", "ETH"], short: [] });
  assert.equal(cfg.bot.long.risk.n_positions, 2);
  assert.equal(cfg.bot.short.risk.total_wallet_exposure_limit, 0);
  assert.deepEqual(cfg.bot.long.strategy, base.bot.long.strategy, "strategy parameters stay the upstream default");
  assert.equal(JSON.stringify(cfg).includes('"_notes"'), false);
});

test("wrapper config: report-only detect, no paper or live", () => {
  const cfg = JSON.parse(readFileSync(join(ROOT, "bots/wrapper/configs/passivbot.json"), "utf8"));
  assert.equal(cfg.id, "passivbot");
  assert.deepEqual(cfg.commands.live, []);
  assert.deepEqual(cfg.commands.paper, []);
  assert.ok(cfg.commands.detect.includes("--report"));
  assert.equal(cfg.metricsFile, "data/fleet/passivbot.fleet-metrics.json");
});
