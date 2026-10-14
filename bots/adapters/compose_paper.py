#!/usr/bin/env python3
"""
Paper-mode launcher for the containerised fleet bots (standard library only).

The fleet wrapper runs this as the bot's "paper" command, from bots/compose:

    python ../adapters/compose_paper.py --service freqtrade
    python ../adapters/compose_paper.py --service hummingbot
    python ../adapters/compose_paper.py --service freqtrade --down     # stop + remove that container

It
  1. refuses anything but paper mode (FLEET_MODE from the wrapper; there is no live path here),
  2. copies the example configs into place on first run (never overwrites yours),
  3. checks the paper-only guards (Hummingbot connector must be *_paper_trade),
  4. runs `docker compose up <service>` in the FOREGROUND, so the wrapper's stop ends it,
  5. runs that bot's bridge every few seconds to write the metrics file the wrapper reads,
  6. stops the container if the bridge ever sees live trading, and on SIGTERM / Ctrl-C.

On Windows the wrapper's stop is a hard kill that skips step 6, so the wrapper config
also names a `stop` command (docker compose stop <service>) that the wrapper runs after.
By hand: `docker compose --env-file ../wrapper/.env down` from bots/compose.

It never reads .env files: compose itself is pointed at bots/wrapper/.env, and the
bridge gets FREQTRADE_API_USERNAME / FREQTRADE_API_PASSWORD from the environment
the wrapper passes in. Values are never printed.
"""
from __future__ import annotations

import argparse
import os
import shutil
import signal
import subprocess
import sys
import threading
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import freqtrade_bridge  # noqa: E402
import hummingbot_bridge  # noqa: E402
from fleet_metrics import shape, write_metrics  # noqa: E402

COMPOSE_DIR = HERE.parent / "compose"
WRAPPER_ENV = HERE.parent / "wrapper" / ".env"
SERVICES = ("freqtrade", "hummingbot")
REQUIRED_ENV = {
    "freqtrade": ("FREQTRADE_API_USERNAME", "FREQTRADE_API_PASSWORD", "FREQTRADE_JWT_SECRET"),
    "hummingbot": ("HUMMINGBOT_PASSWORD",),
}


def compose_cmd(compose_dir: Path, *args: str) -> list[str]:
    cmd = ["docker", "compose", "-f", str(compose_dir / "docker-compose.yml")]
    if WRAPPER_ENV.exists():
        cmd += ["--env-file", str(WRAPPER_ENV)]  # compose reads it; this script never does
    return cmd + list(args)


def init_configs(compose_dir: Path) -> list[str]:
    """Copy each example into place if missing. Returns what was created."""
    made = []
    pairs = [
        (compose_dir / "freqtrade" / "config.example.json", compose_dir / "freqtrade" / "config.json"),
        (compose_dir / "hummingbot" / "conf_simple_pmm.example.yml",
         compose_dir / "hummingbot" / "conf" / "scripts" / "conf_simple_pmm.yml"),
    ]
    for src, dst in pairs:
        if not dst.exists() and src.exists():
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(src, dst)
            made.append(str(dst.relative_to(compose_dir)))
    for d in ("freqtrade/user_data", "hummingbot/data", "hummingbot/logs", "state"):
        (compose_dir / d).mkdir(parents=True, exist_ok=True)
    return made


def preflight(service: str, compose_dir: Path, env: dict[str, str]) -> str | None:
    """None when it is safe to start; otherwise the reason (no secret values in it)."""
    mode = env.get("FLEET_MODE", "paper")
    if mode != "paper":
        return f"{service} runs in paper mode only (asked for {mode!r}); live and detect are not offered"
    missing = [k for k in REQUIRED_ENV[service] if not env.get(k)]
    if missing:
        return f"set {', '.join(missing)} in bots/wrapper/.env (names in bots/compose/.env.example)"
    if service == "hummingbot":
        conf = hummingbot_bridge.read_simple_yaml(compose_dir / "hummingbot" / "conf" / "scripts" / "conf_simple_pmm.yml")
        if not hummingbot_bridge.is_paper_connector(conf.get("exchange", "")):
            return "conf_simple_pmm.yml must use a *_paper_trade exchange (paper only)"
    return None


def bridge_once(service: str, compose_dir: Path) -> dict:
    if service == "freqtrade":
        return freqtrade_bridge.collect(freqtrade_bridge.api_from_env())
    return hummingbot_bridge.collect(compose_dir / "hummingbot")


class Runner:
    def __init__(self, service: str, compose_dir: Path, metrics: Path, interval: float) -> None:
        self.service, self.compose_dir, self.metrics, self.interval = service, compose_dir, metrics, interval
        self.child: subprocess.Popen | None = None
        self.done = threading.Event()
        self.live_seen = False

    def stop_container(self) -> None:
        subprocess.run(compose_cmd(self.compose_dir, "stop", self.service), cwd=self.compose_dir, timeout=90, check=False)

    def bridge_loop(self) -> None:
        while not self.done.wait(self.interval):
            try:
                m = bridge_once(self.service, self.compose_dir)
            except Exception as e:  # keep reporting; never crash the launcher over a status read
                m = shape(0, 0, f"bridge error: {type(e).__name__}")
            write_metrics(self.metrics, m)
            if m.get("liveDetected"):
                self.live_seen = True
                print(f"compose_paper: {m['detail']}", flush=True)
                self.stop_container()
                self.done.set()

    def shutdown(self, *_: object) -> None:
        self.done.set()
        self.stop_container()

    def run(self) -> int:
        write_metrics(self.metrics, shape(0, 0, f"{self.service}: starting container (paper)"))
        self.child = subprocess.Popen(compose_cmd(self.compose_dir, "up", "--no-log-prefix", self.service),
                                      cwd=self.compose_dir)
        t = threading.Thread(target=self.bridge_loop, daemon=True)
        t.start()
        code = self.child.wait()
        self.done.set()
        final = shape(0, 0, f"{self.service}: container stopped (exit {code})")
        write_metrics(self.metrics, final)
        return 3 if self.live_seen else code


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Run one containerised fleet bot in paper mode (bots/CONTRACT.md)")
    ap.add_argument("--service", required=True, choices=SERVICES)
    ap.add_argument("--compose-dir", default=str(COMPOSE_DIR))
    ap.add_argument("--metrics", default=None, help="default: <compose-dir>/state/<service>/fleet-metrics.json")
    ap.add_argument("--interval", type=float, default=10.0)
    ap.add_argument("--down", action="store_true", help="stop and remove this service's container, then exit")
    ap.add_argument("--check", action="store_true", help="init configs and run the preflight only")
    args = ap.parse_args(argv)
    compose_dir = Path(args.compose_dir).resolve()
    metrics = Path(args.metrics) if args.metrics else compose_dir / "state" / args.service / "fleet-metrics.json"

    if args.down:
        return subprocess.run(compose_cmd(compose_dir, "rm", "--stop", "--force", args.service),
                              cwd=compose_dir, check=False).returncode

    made = init_configs(compose_dir)
    for f in made:
        print(f"compose_paper: created {f} from its example (edit it if you like; it is gitignored)", flush=True)
    why = preflight(args.service, compose_dir, dict(os.environ))
    if why:
        print(f"compose_paper: not starting: {why}", file=sys.stderr, flush=True)
        write_metrics(metrics, shape(0, 0, f"not started: {why}"))
        return 2
    if args.check:
        print("compose_paper: preflight ok", flush=True)
        return 0
    if shutil.which("docker") is None:
        msg = "docker not found: install Docker Desktop and start it"
        print(f"compose_paper: {msg}", file=sys.stderr, flush=True)
        write_metrics(metrics, shape(0, 0, msg))
        return 2

    r = Runner(args.service, compose_dir, metrics, max(2.0, args.interval))
    for sig in ("SIGTERM", "SIGINT", "SIGBREAK"):
        if hasattr(signal, sig):
            signal.signal(getattr(signal, sig), r.shutdown)
    return r.run()


if __name__ == "__main__":
    raise SystemExit(main())
