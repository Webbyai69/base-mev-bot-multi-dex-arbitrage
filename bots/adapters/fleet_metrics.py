"""
Shared helpers for fleet adapters (standard library only).

An adapter turns a bot's own status into the metrics file the fleet wrapper
reads (bots/CONTRACT.md): {pnlUsd, sends, gasUsd, detail, routes, metrics}.
The wrapper copies those fields into the heartbeat; nothing secret goes in.
"""
from __future__ import annotations

import json
import math
import os
from datetime import datetime, timezone
from pathlib import Path

# Stablecoins we value 1:1 with USD for paper P&L. Anything else needs a fiat rate from the bot.
USD_LIKE = {"USD", "USDT", "USDC", "FDUSD", "DAI", "USDE", "TUSD", "PYUSD"}
MAX_ROUTES = 12
MAX_METRICS = 12


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def num(v: object, default: float = 0.0) -> float:
    """A finite float, or the default (the command center bounds numbers too)."""
    try:
        f = float(v)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return default
    return f if math.isfinite(f) else default


def short(text: object, n: int = 300) -> str:
    return " ".join(str(text).split())[:n]


def shape(pnl_usd: float, sends: int, detail: str, routes: list | None = None,
          metrics: dict | None = None, **extra: object) -> dict:
    """The metrics-file shape, already cut to the contract's limits."""
    m = {k: round(num(v), 6) for k, v in (metrics or {}).items()}
    out = {
        "pnlUsd": round(num(pnl_usd), 6),
        "sends": int(max(0, num(sends))),
        "gasUsd": 0,  # paper trading on an exchange: no gas
        "detail": short(detail),
        "routes": (routes or [])[:MAX_ROUTES],
        "metrics": dict(list(m.items())[:MAX_METRICS]),
        "updatedAt": now_iso(),
    }
    out.update(extra)
    return out


def write_metrics(path: Path, value: dict) -> None:
    """Atomic write (temp file + rename), like the wrapper's own files."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")
    os.replace(tmp, path)
