#!/usr/bin/env python3
"""Passivbot backtest harness for the fleet (registry id: passivbot). Backtests only: no keys, no orders.

    python bots/passivbot/run_backtest.py                 build the config, run the backtest, write the summary
    python bots/passivbot/run_backtest.py --dry-run       only build and print the merged config path
    python bots/passivbot/run_backtest.py --summarize DIR summarize an existing backtest result folder
    python bots/passivbot/run_backtest.py --report        keep the fleet metrics file fresh from the last summary

Run it with the Python of Passivbot's own virtualenv (bots/upstream/passivbot/venv), see
docs/fleet/passivbot.md. Standard library only in this file; Passivbot itself does the work.

Steps:
  1. merge bots/passivbot/backtest-hyperliquid.override.json over the upstream maintained
     default (configs/examples/default_trailing_martingale_long.json) into
     bots/passivbot/out/config.generated.json (keys starting with "_" are dropped);
  2. run `<python> src/backtest.py <config>` inside bots/upstream/passivbot;
  3. find the newest analysis.json under backtests/ written after the start, read it and fills.csv;
  4. write bots/passivbot/out/summary.json: period, trades, net, max drawdown;
  5. write the fleet metrics file the wrapper reads (pnlUsd 0: a backtest is not trading).
"""
from __future__ import annotations

import argparse
import csv
import json
import os
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
UPSTREAM = REPO / "bots" / "upstream" / "passivbot"
BASE_CONFIG = UPSTREAM / "configs" / "examples" / "default_trailing_martingale_long.json"
OVERRIDE = HERE / "backtest-hyperliquid.override.json"
OUT = HERE / "out"
METRICS = REPO / "data" / "fleet" / "passivbot.fleet-metrics.json"


def strip_notes(obj):
    if isinstance(obj, dict):
        return {k: strip_notes(v) for k, v in obj.items() if not str(k).startswith("_")}
    return obj


def deep_merge(base: dict, over: dict) -> dict:
    out = dict(base)
    for k, v in over.items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = deep_merge(out[k], v)
        else:
            out[k] = v
    return out


def build_config(base_path: Path = BASE_CONFIG, override_path: Path = OVERRIDE, out_dir: Path = OUT) -> Path:
    if not base_path.exists():
        raise SystemExit(f"missing {base_path}: run  git submodule update --init --depth 1 bots/upstream/passivbot")
    base = json.loads(base_path.read_text(encoding="utf-8"))
    over = strip_notes(json.loads(override_path.read_text(encoding="utf-8")))
    cfg = deep_merge(base, over)
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / "config.generated.json"
    path.write_text(json.dumps(cfg, indent=2), encoding="utf-8")
    return path


def pick(analysis: dict, name: str):
    """Passivbot writes currency metrics as <name>_usd / <name>_btc; older versions without a suffix."""
    for k in (f"{name}_usd", name):
        v = analysis.get(k)
        if isinstance(v, (int, float)):
            return float(v)
    return None


def summarize(result_dir: Path, starting_balance: float, coins: list[str] | None = None) -> dict:
    analysis = json.loads((result_dir / "analysis.json").read_text(encoding="utf-8"))
    trades = 0
    pnl = 0.0
    fees = 0.0
    by_coin: dict[str, int] = {}
    fills = result_dir / "fills.csv"
    if fills.exists():
        with fills.open(newline="", encoding="utf-8") as f:
            for row in csv.DictReader(f):
                trades += 1
                by_coin[row.get("coin", "?")] = by_coin.get(row.get("coin", "?"), 0) + 1
                try:
                    pnl += float(row.get("pnl") or 0)
                    fees += float(row.get("fee_paid") or 0)
                except ValueError:
                    pass
    gain = pick(analysis, "gain")
    dd = pick(analysis, "drawdown_worst")
    cfg_path = result_dir / "config.json"
    period = {"start": analysis.get("effective_start_date"), "end": analysis.get("effective_end_date")}
    if cfg_path.exists() and not period["start"]:
        bt = json.loads(cfg_path.read_text(encoding="utf-8")).get("backtest", {})
        period = {"start": bt.get("start_date"), "end": bt.get("end_date")}
    return {
        "bot": "passivbot",
        "kind": "backtest",
        "resultDir": str(result_dir),
        "period": period,
        "coins": coins or sorted(by_coin),
        "startingBalanceUsd": starting_balance,
        "trades": trades,
        "tradesByCoin": by_coin,
        # fee_paid is negative in Passivbot's fills; realised pnl + fees is the net of the fills
        "realisedPnlUsd": round(pnl, 4),
        "feesUsd": round(fees, 4),
        "netUsd": round(starting_balance * (gain - 1), 2) if gain is not None else round(pnl + fees, 2),
        "gainPct": round((gain - 1) * 100, 2) if gain is not None else None,
        "maxDrawdownPct": round(dd * 100, 2) if dd is not None else None,
        "summarizedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }


def metrics_from_summary(s: dict | None) -> dict:
    if not s:
        return {"pnlUsd": 0, "sends": 0, "gasUsd": 0, "detail": "no backtest yet: run bots/passivbot/run_backtest.py", "routes": [], "metrics": {}}
    p = s.get("period") or {}
    detail = (
        f"backtest {','.join(s.get('coins') or [])} on hyperliquid {p.get('start')}..{p.get('end')}: "
        f"{s.get('trades')} fills, net ${s.get('netUsd')} on ${s.get('startingBalanceUsd')}, max DD {s.get('maxDrawdownPct')}%"
    )
    routes = [
        {"pair": f"{c}/USDC", "venues": ["hyperliquid", "passivbot-backtest"], "count": n, "usd": 0}
        for c, n in sorted((s.get("tradesByCoin") or {}).items(), key=lambda kv: -kv[1])
    ][:12]
    m = {"trades": s.get("trades") or 0, "netUsd": s.get("netUsd") or 0}
    if s.get("gainPct") is not None:
        m["gainPct"] = s["gainPct"]
    if s.get("maxDrawdownPct") is not None:
        m["maxDrawdownPct"] = s["maxDrawdownPct"]
    # pnlUsd stays 0: a backtest is not today's trading (bots/CONTRACT.md)
    return {"pnlUsd": 0, "sends": 0, "gasUsd": 0, "detail": detail[:300], "routes": routes, "metrics": m}


def write_json_atomic(path: Path, obj) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + f".{os.getpid()}.tmp")
    tmp.write_text(json.dumps(obj, indent=2), encoding="utf-8")
    os.replace(tmp, path)


def newest_result(after: float, root: Path) -> Path | None:
    best = None
    for p in root.rglob("analysis.json"):
        t = p.stat().st_mtime
        if t >= after and (best is None or t > best[0]):
            best = (t, p.parent)
    return best[1] if best else None


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--summarize", metavar="DIR")
    ap.add_argument("--report", action="store_true", help="refresh the fleet metrics file every 20 s from out/summary.json")
    ap.add_argument("--once", action="store_true", help="with --report: write once and exit")
    ap.add_argument("--metrics", default=os.environ.get("FLEET_METRICS_FILE", str(METRICS)))
    ap.add_argument("--out", default=str(OUT))
    a = ap.parse_args(argv)
    out = Path(a.out)
    metrics_path = Path(a.metrics)

    if a.report:
        while True:
            s = None
            try:
                s = json.loads((out / "summary.json").read_text(encoding="utf-8"))
            except (OSError, ValueError):
                pass
            write_json_atomic(metrics_path, metrics_from_summary(s))
            if a.once:
                return 0
            time.sleep(20)

    override = strip_notes(json.loads(OVERRIDE.read_text(encoding="utf-8")))
    start_bal = float(override.get("backtest", {}).get("starting_balance", 1000))
    coins = override.get("live", {}).get("approved_coins", {}).get("long", [])

    if a.summarize:
        s = summarize(Path(a.summarize), start_bal, coins)
    else:
        cfg = build_config(out_dir=out)
        print(f"config: {cfg}")
        if a.dry_run:
            return 0
        t0 = time.time()
        cmd = [sys.executable, "src/backtest.py", str(cfg)]
        print("running:", " ".join(cmd), f"(in {UPSTREAM})", flush=True)
        rc = subprocess.call(cmd, cwd=UPSTREAM)
        if rc != 0:
            print(f"backtest exited with {rc}", file=sys.stderr)
            return rc
        res = newest_result(t0 - 1, UPSTREAM / "backtests")
        if res is None:
            print("backtest finished but no analysis.json was found under backtests/", file=sys.stderr)
            return 1
        s = summarize(res, start_bal, coins)
    write_json_atomic(out / "summary.json", s)
    write_json_atomic(metrics_path, metrics_from_summary(s))
    print(json.dumps(s, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
