#!/usr/bin/env python3
"""
Reference fleet wrapper (bots/CONTRACT.md). Standard library only.

Runs ONE external bot as a child process and connects it to the command
center through two files in the base bot's data directory:

    data/fleet/<id>.control.json    read:  what the owner or an agent wants
    data/fleet/<id>.heartbeat.json  write: what is actually happening

    python bots/wrapper/fleet_wrapper.py --config bots/wrapper/configs/morpho-liquidator.json
    python bots/wrapper/fleet_wrapper.py --config ... --live      # owner only, see below

Safety rules this wrapper enforces (do not weaken them in a copy):
  * The dashboard can ask for "detect" or "paper" only. A live run needs the
    owner to type --live AND set FLEET_LIVE_<ID>=1 in this wrapper's .env.
  * data/STOP (the main bot's kill switch) stops a live run within one poll.
  * A control-file gas cap can only LOWER the owner's cap (FLEET_GAS_CAP_USD_MAX).
  * Nothing from the .env (keys, URLs) is ever written to the heartbeat.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import signal
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

VERSION = "fleet-wrapper 0.1"
REPO = Path(__file__).resolve().parents[2]
POLL_S = 5
RESTARTS_PER_10_MIN = 5
MAX_GAS_CAP_USD = 5.0


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def live_flag(bot_id: str) -> str:
    return "FLEET_LIVE_" + re.sub(r"[^A-Z0-9]", "_", bot_id.upper())


def load_env_file(path: Path) -> dict[str, str]:
    """KEY=VALUE lines; # comments; optional quotes. Values are never logged."""
    out: dict[str, str] = {}
    if not path.exists():
        return out
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        v = v.strip()
        if len(v) >= 2 and v[0] == v[-1] and v[0] in "\"'":
            v = v[1:-1]
        out[k.strip()] = v
    return out


def read_json(path: Path) -> dict | None:
    try:
        if not path.exists() or path.stat().st_size > 64 * 1024:
            return None
        v = json.loads(path.read_text(encoding="utf-8"))
        return v if isinstance(v, dict) else None
    except (OSError, ValueError):
        return None


def write_json_atomic(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")
    os.replace(tmp, path)


def parse_iso(s: object) -> float:
    try:
        return datetime.fromisoformat(str(s).replace("Z", "+00:00")).timestamp()
    except ValueError:
        return 0.0


class Wrapper:
    def __init__(self, cfg: dict, fleet_dir: Path, env: dict[str, str], live: bool) -> None:
        self.cfg = cfg
        self.id: str = cfg["id"]
        if not re.fullmatch(r"[a-z0-9-]{1,40}", self.id):
            raise SystemExit("config id must match [a-z0-9-]{1,40}")
        self.fleet_dir = fleet_dir
        self.stop_file = fleet_dir.parent / "STOP"
        self.env = env
        self.cwd = (REPO / cfg.get("cwd", ".")).resolve()
        self.commands: dict[str, list[str]] = cfg.get("commands", {})
        self.mode_env: dict[str, dict[str, str]] = cfg.get("env", {})
        self.metrics_file = (self.cwd / cfg["metricsFile"]) if cfg.get("metricsFile") else None
        self.log_path = (REPO / cfg.get("logFile", f"data/fleet/{self.id}.log")).resolve()
        self.started_at = time.time()
        self.live_requested = live
        self.live_allowed = live and env.get(live_flag(self.id)) == "1"
        self.child: subprocess.Popen | None = None
        self.child_mode: str | None = None
        self.restarts: list[float] = []
        self.last_error: str | None = None
        self.detail: str | None = None
        if live and not self.live_allowed:
            self.last_error = f"--live given but {live_flag(self.id)}=1 is not set in the wrapper .env: running detect/paper only"

    # -- what the owner and the command center want ---------------------------------

    def wanted(self) -> tuple[str, str, float | None]:
        """(desired, mode, gas cap) after applying every rule in the module docstring."""
        ctl = read_json(self.fleet_dir / f"{self.id}.control.json") or {}
        desired = "running" if ctl.get("desired") == "running" else "stopped"
        mode = "detect" if ctl.get("mode") == "detect" else "paper"
        cap = ctl.get("gasCapUsd")
        owner_cap = float(self.env.get("FLEET_GAS_CAP_USD_MAX", MAX_GAS_CAP_USD))
        gas = min(owner_cap, float(cap)) if isinstance(cap, (int, float)) and cap >= 0 else owner_cap
        if self.live_allowed:
            # The owner started this run live from their own terminal. The dashboard can still
            # stop it with a request made after this start; it cannot change the mode.
            fresh_stop = desired == "stopped" and parse_iso(ctl.get("requestedAt")) > self.started_at
            if self.stop_file.exists():
                self.detail = "STOP file present: live run stopped (resume is manual)"
                return "stopped", "live", gas
            return ("stopped" if fresh_stop else "running"), "live", gas
        return desired, mode, gas

    # -- child process ------------------------------------------------------------------

    def start(self, mode: str, gas: float | None) -> None:
        cmd = self.commands.get(mode)
        if not cmd:
            self.last_error = f"no {mode} command configured in the wrapper config"
            return
        recent = [t for t in self.restarts if time.time() - t < 600]
        if len(recent) >= RESTARTS_PER_10_MIN:
            self.last_error = f"crashed {len(recent)} times in 10 min: not restarting until the config is fixed"
            return
        self.restarts = recent + [time.time()]
        child_env = {**os.environ, **self.env, **self.mode_env.get(mode, {}), "FLEET_ID": self.id, "FLEET_MODE": mode}
        if gas is not None:
            child_env["FLEET_GAS_CAP_USD"] = f"{gas:.4f}"
        self.log_path.parent.mkdir(parents=True, exist_ok=True)
        log = open(self.log_path, "ab")
        log.write(f"\n--- {now_iso()} starting {self.id} in {mode} mode ---\n".encode())
        log.flush()
        # A list of arguments, never a shell string: config values can't inject commands.
        self.child = subprocess.Popen(cmd, cwd=self.cwd, env=child_env, stdout=log, stderr=subprocess.STDOUT)
        self.child_mode = mode
        self.last_error = None if not self.last_error or "--live" not in self.last_error else self.last_error

    def stop(self) -> None:
        if not self.child:
            return
        if self.child.poll() is None:
            self.child.terminate()
            try:
                self.child.wait(timeout=10)
            except subprocess.TimeoutExpired:
                self.child.kill()
                self.child.wait(timeout=5)
        self.child = None
        self.child_mode = None

    def step(self) -> None:
        desired, mode, gas = self.wanted()
        alive = self.child is not None and self.child.poll() is None
        if self.child is not None and not alive:
            code = self.child.returncode
            self.last_error = f"bot exited with code {code}"
            self.child = None
            self.child_mode = None
        if desired == "stopped":
            self.stop()
        elif not alive or self.child_mode != mode:
            self.stop()
            self.start(mode, gas)
        self.heartbeat()

    # -- heartbeat ------------------------------------------------------------------------

    def heartbeat(self, final: bool = False) -> None:
        running = not final and self.child is not None and self.child.poll() is None
        m = read_json(self.metrics_file) if self.metrics_file else None
        m = m or {}
        hb = {
            "id": self.id,
            "status": "running" if running else ("error" if self.last_error and not final else "stopped"),
            "mode": self.child_mode or ("live" if self.live_allowed else "detect"),
            "pnlUsd": m.get("pnlUsd", 0),
            "sends": m.get("sends", 0),
            "gasUsd": m.get("gasUsd", 0),
            "lastError": self.last_error,
            "detail": str(m.get("detail") or self.detail or "")[:300] or None,
            "version": f"{self.cfg.get('upstream', self.id)} / {VERSION}",
            "updatedAt": now_iso(),
            "routes": m.get("routes", [])[:12] if isinstance(m.get("routes"), list) else [],
            "metrics": m.get("metrics", {}) if isinstance(m.get("metrics"), dict) else {},
        }
        write_json_atomic(self.fleet_dir / f"{self.id}.heartbeat.json", hb)


def main() -> int:
    ap = argparse.ArgumentParser(description="Run one fleet bot under the command-center contract (bots/CONTRACT.md).")
    ap.add_argument("--config", required=True, help="bots/wrapper/configs/<id>.json")
    ap.add_argument("--fleet-dir", default=os.environ.get("FLEET_DIR", str(REPO / "data" / "fleet")))
    ap.add_argument("--env-file", default=str(Path(__file__).resolve().parent / ".env"))
    ap.add_argument("--live", action="store_true", help="owner only: run live (needs FLEET_LIVE_<ID>=1 in the .env)")
    ap.add_argument("--once", action="store_true", help="one poll then exit (for tests)")
    args = ap.parse_args()

    cfg = json.loads(Path(args.config).read_text(encoding="utf-8"))
    w = Wrapper(cfg, Path(args.fleet_dir).resolve(), load_env_file(Path(args.env_file)), args.live)

    def shutdown(*_: object) -> None:
        w.stop()
        w.heartbeat(final=True)
        sys.exit(0)

    signal.signal(signal.SIGINT, shutdown)
    signal.signal(signal.SIGTERM, shutdown)
    print(f"{VERSION}: {w.id} (live {'armed' if w.live_allowed else 'off'}); heartbeat -> {w.fleet_dir}", flush=True)
    while True:
        try:
            w.step()
        except Exception as e:  # keep reporting even when something odd happens
            w.last_error = f"wrapper error: {type(e).__name__}: {str(e)[:200]}"
            w.heartbeat()
        if args.once:
            return 0
        time.sleep(POLL_S)


if __name__ == "__main__":
    raise SystemExit(main())
