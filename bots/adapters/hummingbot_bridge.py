#!/usr/bin/env python3
"""
Hummingbot -> fleet metrics bridge (standard library only).

Reads what a Hummingbot container writes to its mounted folders and writes the
metrics file the fleet wrapper turns into the heartbeat (bots/CONTRACT.md):

    python bots/adapters/hummingbot_bridge.py --root bots/compose/hummingbot \
        --metrics bots/compose/state/hummingbot/fleet-metrics.json

Sources, all read-only, all under --root (the compose volumes):
    conf/scripts/<config>.yml      which connector and pair (must be *_paper_trade)
    data/bot/meta.json             the hbot CLI's record of the running bot (name, start time)
    data/<name>.sqlite             Hummingbot's trades DB: table TradeFill
    logs/logs_<name>.log           Hummingbot's structured log: freshness and ERROR lines

It never opens conf/connectors/ (encrypted exchange keys) or the keystore.
Hummingbot is Apache-2.0; this bridge contains no Hummingbot code. It only reads
the documented file layout (bots/upstream/hummingbot/hummingbot/cli/README.md).

Paper P&L is an estimate: fills today are marked to the last fill price
(cash flow + net base position x last price, minus fees in quote).
"""
from __future__ import annotations

import argparse
import json
import re
import sqlite3
import sys
import time
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from fleet_metrics import USD_LIKE, num, shape, short, write_metrics  # noqa: E402

DEFAULT_CONFIG = "conf_simple_pmm"
PRICE_SCALE = 10 ** 6   # Hummingbot stores price/amount as SqliteDecimal(6): integer x 1e6
QUIET_LOG_S = 180       # simple_pmm refreshes orders every 15 s; a log this quiet means trouble
TAIL_BYTES = 256 * 1024


def read_simple_yaml(path: Path) -> dict[str, str]:
    """Top-level `key: value` lines only (enough for a script config). No YAML library needed."""
    out: dict[str, str] = {}
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return out
    for line in text.splitlines():
        m = re.match(r"^([A-Za-z_][A-Za-z0-9_]*):\s*(.*?)\s*(#.*)?$", line)
        if m:
            out[m.group(1)] = m.group(2).strip().strip("'\"")
    return out


def is_paper_connector(name: str) -> bool:
    return bool(name) and name.endswith("_paper_trade")


def read_json(path: Path) -> dict:
    try:
        v = json.loads(path.read_text(encoding="utf-8"))
        return v if isinstance(v, dict) else {}
    except (OSError, ValueError):
        return {}


def tail_errors(log: Path) -> tuple[int, str, float | None]:
    """(ERROR/CRITICAL lines in the tail, last error message, seconds since last write)."""
    try:
        st = log.stat()
    except OSError:
        return 0, "", None
    with open(log, "rb") as f:
        f.seek(max(0, st.st_size - TAIL_BYTES))
        lines = f.read().decode("utf-8", "replace").splitlines()
    errs = [ln for ln in lines if " - ERROR - " in ln or " - CRITICAL - " in ln]
    last = errs[-1].split(" - ", 4)[-1] if errs else ""
    return len(errs), short(last, 120), max(0.0, time.time() - st.st_mtime)


def ts_seconds(ts: float) -> float:
    return ts / 1000.0 if ts > 1e11 else ts   # TradeFill.timestamp is in ms


def read_fills(db: Path) -> list[dict]:
    if not db.exists():
        return []
    con = sqlite3.connect(f"file:{db.as_posix()}?mode=ro", uri=True, timeout=2)
    try:
        cur = con.execute(
            "SELECT market, symbol, quote_asset, trade_type, price, amount, timestamp, trade_fee_in_quote FROM TradeFill"
        )
        rows = cur.fetchall()
    except sqlite3.Error:
        return []
    finally:
        con.close()
    out = []
    for market, symbol, quote, side, price, amount, ts, fee in rows:
        out.append({
            "market": str(market), "symbol": str(symbol), "quote": str(quote or ""),
            "side": str(side).upper(), "price": num(price) / PRICE_SCALE, "amount": num(amount) / PRICE_SCALE,
            "t": ts_seconds(num(ts)), "fee": num(fee) / PRICE_SCALE,
        })
    return out


def mark_to_market(fills: list[dict]) -> float:
    """Cash flow + net base x last price - fees, per symbol, summed (quote units)."""
    by_sym: dict[str, list[dict]] = defaultdict(list)
    for f in sorted(fills, key=lambda x: x["t"]):
        by_sym[f["symbol"]].append(f)
    total = 0.0
    for fs in by_sym.values():
        cash = base = fees = 0.0
        for f in fs:
            sign = 1.0 if f["side"] == "BUY" else -1.0
            base += sign * f["amount"]
            cash -= sign * f["amount"] * f["price"]
            fees += f["fee"]
        total += cash + base * fs[-1]["price"] - fees
    return total


def collect(root: Path, config: str = DEFAULT_CONFIG, now: float | None = None) -> dict:
    now = now or time.time()
    root = Path(root)
    conf = read_simple_yaml(root / "conf" / "scripts" / f"{config}.yml")
    exchange, pair = conf.get("exchange", ""), conf.get("trading_pair", "?")
    if not is_paper_connector(exchange):
        return shape(0, 0, f"LIVE CONNECTOR in {config}.yml ({short(exchange, 40) or 'none'}): paper only, refusing",
                     metrics={"paper": 0}, liveDetected=True)

    meta = read_json(root / "data" / "bot" / "meta.json")
    name = str(meta.get("name") or config)
    if not re.fullmatch(r"[A-Za-z0-9_.-]{1,80}", name):
        name = config
    fills = read_fills(root / "data" / f"{name}.sqlite")
    live_fills = [f for f in fills if not is_paper_connector(f["market"])]
    if live_fills:
        return shape(0, 0, f"LIVE FILLS in the trades DB ({short(live_fills[-1]['market'], 40)}): paper only, stopping",
                     metrics={"paper": 0}, liveDetected=True)

    day0 = datetime.fromtimestamp(now, timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0).timestamp()
    today = [f for f in fills if f["t"] >= day0]
    quote = (today or fills or [{"quote": pair.split("-")[-1]}])[-1]["quote"].upper()
    usd = 1.0 if quote in USD_LIKE else None
    pnl_today_q = mark_to_market(today)
    pnl_all_q = mark_to_market(fills)
    vol_today_q = sum(f["amount"] * f["price"] for f in today)

    n_err, last_err, log_age = tail_errors(root / "logs" / f"logs_{name}.log")
    started = num(meta.get("started_at"))
    routes = []
    by_sym: dict[str, list[dict]] = defaultdict(list)
    for f in today:
        by_sym[f["symbol"]].append(f)
    for sym, fs in sorted(by_sym.items(), key=lambda kv: -len(kv[1]))[:12]:
        routes.append({"pair": short(sym, 40), "venues": [short(exchange, 40)], "count": len(fs),
                       "usd": round(mark_to_market(fs) * (usd or 0), 4)})

    to_usd = (lambda q: q * usd) if usd else (lambda q: 0.0)
    metrics = {
        "paper": 1,
        "fillsToday": len(today),
        "buysToday": sum(1 for f in today if f["side"] == "BUY"),
        "sellsToday": sum(1 for f in today if f["side"] == "SELL"),
        "volumeTodayUsd": to_usd(vol_today_q),
        "pnlAllUsd": to_usd(pnl_all_q),
        "fillsAll": len(fills),
        "logErrors": n_err,
        "logAgeS": log_age if log_age is not None else -1,
        "uptimeS": max(0.0, now - started) if started else 0,
    }
    if log_age is None:
        state = "no log yet (first start builds the image; can take 10-20 min)"
    elif log_age > QUIET_LOG_S:
        state = f"log quiet for {log_age:.0f}s"
    else:
        state = "running"
    err = f"; {n_err} errors, last: {last_err}" if n_err else ""
    note = "" if usd else f" ({quote} has no USD rate: $ shown as 0)"
    detail = (f"simple_pmm paper {pair} on {exchange}: {state}, {len(today)} fills today, "
              f"est {to_usd(pnl_today_q):+.2f} USD{note}{err}")
    return shape(to_usd(pnl_today_q), len(today), detail, routes, metrics, liveDetected=False)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Hummingbot files -> fleet metrics file (bots/CONTRACT.md)")
    ap.add_argument("--root", default=str(Path(__file__).resolve().parents[1] / "compose" / "hummingbot"))
    ap.add_argument("--config", default=DEFAULT_CONFIG, help="script config stem in conf/scripts/")
    ap.add_argument("--metrics", required=True)
    ap.add_argument("--interval", type=float, default=10.0)
    ap.add_argument("--once", action="store_true")
    args = ap.parse_args(argv)
    while True:
        m = collect(Path(args.root), args.config)
        write_metrics(Path(args.metrics), m)
        if args.once:
            print(m["detail"])
            return 3 if m.get("liveDetected") else 0
        time.sleep(max(2.0, args.interval))


if __name__ == "__main__":
    raise SystemExit(main())
