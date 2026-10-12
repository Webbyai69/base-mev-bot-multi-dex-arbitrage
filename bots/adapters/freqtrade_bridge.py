#!/usr/bin/env python3
"""
Freqtrade -> fleet metrics bridge (standard library only).

Polls a running Freqtrade's REST API and writes the metrics file the fleet
wrapper turns into the heartbeat (bots/CONTRACT.md):

    python bots/adapters/freqtrade_bridge.py --metrics bots/compose/state/freqtrade/fleet-metrics.json

Licence boundary: Freqtrade is GPL-3.0. This file never imports or copies its
code; it only speaks HTTP to the separate Freqtrade process (bots/README.md).

Credentials come from environment variables FREQTRADE_API_USERNAME and
FREQTRADE_API_PASSWORD (set by Joshua in bots/wrapper/.env, passed in by the
wrapper). They are sent only as an HTTP Basic header to the local API and are
never printed, logged or written to the metrics file.

Paper only: if the API reports dry_run = false, the result carries
liveDetected = true and the launcher (compose_paper.py) stops the container.
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parent))
from fleet_metrics import USD_LIKE, num, shape, short, write_metrics  # noqa: E402

ENV_USER = "FREQTRADE_API_USERNAME"
ENV_PASS = "FREQTRADE_API_PASSWORD"


def default_api_url() -> str:
    return os.environ.get("FREQTRADE_API_URL") or f"http://127.0.0.1:{os.environ.get('FREQTRADE_API_PORT') or 8080}"


class ApiError(Exception):
    """A failed call. The message never contains credentials."""


class FreqtradeApi:
    def __init__(self, base_url: str, username: str | None, password: str | None, timeout: float = 5.0) -> None:
        self.base = base_url.rstrip("/") + "/api/v1"
        u = urlsplit(base_url)
        if u.scheme not in ("http", "https") or not u.hostname:
            raise ValueError("FREQTRADE_API_URL must be http(s)://host:port")
        self.where = f"{u.hostname}:{u.port or (443 if u.scheme == 'https' else 80)}"  # no user info, ever
        self._auth = None
        if username and password:
            self._auth = "Basic " + base64.b64encode(f"{username}:{password}".encode()).decode()
        self.timeout = timeout

    def get(self, path: str) -> object:
        req = urllib.request.Request(self.base + path, headers={"Accept": "application/json"})
        if self._auth:
            req.add_header("Authorization", self._auth)
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as r:  # noqa: S310 (local API URL)
                body = r.read(2_000_000)
        except urllib.error.HTTPError as e:
            raise ApiError(f"{path} -> HTTP {e.code}") from None
        except (urllib.error.URLError, OSError, TimeoutError) as e:
            reason = getattr(e, "reason", e)
            raise ApiError(f"{path} -> {type(reason).__name__}") from None
        try:
            return json.loads(body)
        except ValueError:
            raise ApiError(f"{path} -> not JSON") from None


def usd_rate(stake: str, fiat_currency: str, fiat_value: float, abs_profit: float) -> float | None:
    """USD per unit of stake currency, or None when it can't be known honestly."""
    if stake.upper() in USD_LIKE:
        return 1.0
    if fiat_currency.upper() == "USD" and abs_profit:
        return fiat_value / abs_profit
    return None


def collect(api: FreqtradeApi, today: str | None = None) -> dict:
    """One poll -> the metrics-file dict. Never raises for API trouble: it reports it."""
    today = today or datetime.now(timezone.utc).date().isoformat()
    try:
        api.get("/ping")
    except ApiError:
        return shape(0, 0, f"freqtrade API not reachable at {api.where} (container starting or stopped)",
                     metrics={"apiUp": 0}, liveDetected=False)
    try:
        cfg = api.get("/show_config")
        if not isinstance(cfg, dict):
            raise ApiError("/show_config -> unexpected shape")
        if cfg.get("dry_run") is not True:
            return shape(0, 0, "LIVE MODE DETECTED: freqtrade reports dry_run=false; the launcher stops it",
                         metrics={"apiUp": 1, "dryRun": 0}, liveDetected=True)
        stake = str(cfg.get("stake_currency") or "USDT")
        exchange = str(cfg.get("exchange") or "?")
        strategy = str(cfg.get("strategy") or "?")
        state = str(cfg.get("state") or "?")

        daily = api.get("/daily?timescale=1")
        rows = daily.get("data", []) if isinstance(daily, dict) else []
        fiat_cur = str(daily.get("fiat_display_currency") or "") if isinstance(daily, dict) else ""
        row = next((r for r in rows if isinstance(r, dict) and str(r.get("date", ""))[:10] == today), {})
        today_abs = num(row.get("abs_profit"))
        today_trades = int(num(row.get("trade_count")))

        profit = api.get("/profit")
        profit = profit if isinstance(profit, dict) else {}
        open_trades = api.get("/status")
        open_trades = open_trades if isinstance(open_trades, list) else []
        balance = api.get("/balance")
        balance = balance if isinstance(balance, dict) else {}
        perf = api.get("/performance")
        perf = perf if isinstance(perf, list) else []
    except ApiError as e:
        return shape(0, 0, f"freqtrade API error: {e}", metrics={"apiUp": 1}, liveDetected=False)

    rate = usd_rate(stake, fiat_cur, num(row.get("fiat_value")), today_abs)
    to_usd = (lambda v: num(v) * rate) if rate is not None else (lambda v: 0.0)
    unrealised = sum(num(t.get("total_profit_abs", t.get("profit_abs"))) for t in open_trades if isinstance(t, dict))

    routes = []
    for p in sorted((x for x in perf if isinstance(x, dict)), key=lambda x: -int(num(x.get("count"))))[:12]:
        routes.append({
            "pair": short(p.get("pair", "?"), 40),
            "venues": [f"{exchange}-paper"],
            "count": int(num(p.get("count"))),
            "usd": round(to_usd(p.get("profit_abs")), 4),
        })

    wins, losses = int(num(profit.get("winning_trades"))), int(num(profit.get("losing_trades")))
    metrics = {
        "apiUp": 1,
        "dryRun": 1,
        "openTrades": len(open_trades),
        "unrealisedUsd": to_usd(unrealised),
        "closedTrades": int(num(profit.get("closed_trade_count"))),
        "profitClosedUsd": to_usd(profit.get("profit_closed_coin")),
        "profitAllUsd": to_usd(profit.get("profit_all_coin")),
        "winRatePct": (100.0 * wins / (wins + losses)) if wins + losses else 0,
        "paperBalanceUsd": to_usd(balance.get("total_bot", balance.get("total"))),
        "startingCapitalUsd": to_usd(balance.get("starting_capital")),
    }
    note = "" if rate is not None else f" ({stake} has no USD rate: $ figures shown as 0)"
    detail = (f"dry-run {strategy} on {exchange} ({state}): {len(open_trades)} open, "
              f"{today_trades} closed today, {to_usd(today_abs):+.2f} USD today{note}")
    return shape(to_usd(today_abs), today_trades, detail, routes, metrics, liveDetected=False)


def api_from_env(url: str | None = None) -> FreqtradeApi:
    return FreqtradeApi(url or default_api_url(), os.environ.get(ENV_USER), os.environ.get(ENV_PASS))


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Freqtrade REST -> fleet metrics file (bots/CONTRACT.md)")
    ap.add_argument("--api-url", default=None, help="default: $FREQTRADE_API_URL or http://127.0.0.1:$FREQTRADE_API_PORT (8080)")
    ap.add_argument("--metrics", required=True, help="metrics file the wrapper reads")
    ap.add_argument("--interval", type=float, default=10.0)
    ap.add_argument("--once", action="store_true")
    args = ap.parse_args(argv)
    if not os.environ.get(ENV_USER) or not os.environ.get(ENV_PASS):
        print(f"note: {ENV_USER} / {ENV_PASS} are not set; the API will answer 401", file=sys.stderr)
    api = api_from_env(args.api_url)
    while True:
        m = collect(api)
        write_metrics(Path(args.metrics), m)
        if args.once:
            print(m["detail"])
            return 3 if m.get("liveDetected") else 0
        time.sleep(max(2.0, args.interval))


if __name__ == "__main__":
    raise SystemExit(main())
