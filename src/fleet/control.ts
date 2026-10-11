/**
 * Desired-state control + heartbeats for the external bots (bots/CONTRACT.md).
 *
 *   data/fleet/<id>.control.json    written here: what the owner/agents WANT
 *   data/fleet/<id>.heartbeat.json  written by the bot's wrapper: what IS
 *
 * The trading process never starts, stops or signals another process. A
 * wrapper polls its control file and reports back through its heartbeat.
 * Heartbeats come from other programs, so every field is treated as
 * untrusted: numbers are coerced and bounded, strings are trimmed.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FLEET, botById, liveFlag, type BotDef, type BotMode, type Network } from "./registry.js";

export interface Heartbeat {
  id: string;
  status: "running" | "stopped" | "error";
  mode: BotMode;
  pnlUsd: number;
  sends: number;
  gasUsd: number;
  lastError: string | null;
  detail: string | null;
  version: string | null;
  updatedAt: string;
  /** The bot's busiest routes, for the market atlas on its network (optional, at most 12). */
  routes: HeartbeatRoute[];
  /** Up to 12 named numbers the bot wants on its card (e.g. detectMs, positionsWatched). */
  metrics: Record<string, number>;
}

export interface HeartbeatRoute {
  pair: string;
  venues: string[];
  count: number;
  usd: number;
}

export interface Control {
  id: string;
  desired: "running" | "stopped";
  /** The dashboard can only ask for these two; live comes from the owner's FLEET_LIVE_<ID> flag. */
  mode: "detect" | "paper";
  target: string | null;
  gasCapUsd: number | null;
  requestedAt: string;
  requestedBy: string;
}

export type FleetState = "in-process" | "running" | "stopped" | "stale" | "error" | "not-installed";

export interface FleetRow {
  id: string;
  name: string;
  networks: Network[];
  kind: BotDef["kind"];
  language: BotDef["language"];
  strategy: string;
  description: string;
  capital: BotDef["capital"];
  phase: number;
  firstStep: string;
  modes: BotMode[];
  edge: string;
  excluded: string | null;
  upstream: { repo: string; commit: string; license: string; obligations: string } | null;
  liveFlag: string | null;
  state: FleetState;
  mode: BotMode | null;
  pnlUsd: number;
  sends: number;
  gasUsd: number;
  heartbeatAgeS: number | null;
  lastError: string | null;
  detail: string | null;
  control: Control | null;
  routes: HeartbeatRoute[];
  metrics: Record<string, number>;
}

/** A heartbeat older than this is "stale": the wrapper stopped reporting. */
export const STALE_MS = 90_000;
const MAX_GAS_CAP_USD = 5;

const str = (v: unknown, max: number): string | null => (typeof v === "string" && v.length > 0 ? v.slice(0, max) : null);
const num = (v: unknown, lo: number, hi: number): number => {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : 0;
};

export class FleetControl {
  constructor(readonly dir: string) {}

  private file(id: string, kind: "control" | "heartbeat"): string {
    if (!/^[a-z0-9-]{1,40}$/.test(id)) throw new Error("bad bot id");
    return join(this.dir, `${id}.${kind}.json`);
  }

  private readJson(path: string): Record<string, unknown> | undefined {
    if (!existsSync(path)) return undefined;
    try {
      const raw = readFileSync(path, "utf8");
      if (raw.length > 64 * 1024) return undefined;
      const v = JSON.parse(raw) as unknown;
      return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
    } catch {
      return undefined;
    }
  }

  heartbeat(id: string): Heartbeat | undefined {
    const r = this.readJson(this.file(id, "heartbeat"));
    if (!r) return undefined;
    const status = r.status === "running" || r.status === "stopped" || r.status === "error" ? r.status : "error";
    const mode: BotMode = r.mode === "live" || r.mode === "paper" || r.mode === "detect" ? r.mode : "detect";
    const updatedAt = str(r.updatedAt, 40);
    if (!updatedAt || Number.isNaN(Date.parse(updatedAt))) return undefined;
    return {
      id,
      status,
      mode,
      pnlUsd: num(r.pnlUsd, -1e9, 1e9),
      sends: Math.round(num(r.sends, 0, 1e9)),
      gasUsd: num(r.gasUsd, 0, 1e9),
      lastError: str(r.lastError, 300),
      detail: str(r.detail, 300),
      version: str(r.version, 60),
      updatedAt,
      routes: (Array.isArray(r.routes) ? r.routes : [])
        .filter((x): x is Record<string, unknown> => !!x && typeof x === "object")
        .slice(0, 12)
        .map((x) => ({
          pair: str(x.pair, 40) ?? "?",
          venues: (Array.isArray(x.venues) ? x.venues : []).slice(0, 4).map((v) => str(v, 30) ?? "?"),
          count: Math.round(num(x.count, 0, 1e9)),
          usd: num(x.usd, -1e9, 1e9),
        })),
      metrics: Object.fromEntries(
        Object.entries(r.metrics && typeof r.metrics === "object" && !Array.isArray(r.metrics) ? (r.metrics as Record<string, unknown>) : {})
          .filter(([k, v]) => /^[a-zA-Z][\w.-]{0,30}$/.test(k) && typeof v === "number" && Number.isFinite(v))
          .slice(0, 12)
          .map(([k, v]) => [k, num(v, -1e12, 1e12)]),
      ),
    };
  }

  control(id: string): Control | undefined {
    const r = this.readJson(this.file(id, "control"));
    if (!r) return undefined;
    return {
      id,
      desired: r.desired === "running" ? "running" : "stopped",
      mode: r.mode === "detect" ? "detect" : "paper",
      target: str(r.target, 120),
      gasCapUsd: r.gasCapUsd === null || r.gasCapUsd === undefined ? null : num(r.gasCapUsd, 0, MAX_GAS_CAP_USD),
      requestedAt: str(r.requestedAt, 40) ?? new Date(0).toISOString(),
      requestedBy: str(r.requestedBy, 60) ?? "unknown",
    };
  }

  /**
   * Record what the owner or an agent wants an external bot to do. Throws on
   * anything outside the contract: unknown or in-process bot, a mode the bot
   * doesn't offer, or "live" (never requestable from here).
   */
  request(
    id: string,
    desired: "running" | "stopped",
    opts: { mode?: unknown; target?: unknown; gasCapUsd?: unknown },
    by: string,
  ): Control {
    const bot = botById(id);
    if (!bot) throw new Error("unknown bot");
    if (bot.kind !== "external") throw new Error("base-arb-bot is controlled by .env and the STOP file, not the fleet");
    const mode = opts.mode === undefined ? (bot.modes.includes("detect") ? "detect" : "paper") : opts.mode;
    if (mode === "live") throw new Error(`live is switched on by the owner (${liveFlag(id)}=1 in the wrapper's .env), not from the dashboard`);
    if (mode !== "detect" && mode !== "paper") throw new Error("mode must be detect or paper");
    if (!bot.modes.includes(mode)) throw new Error(`${bot.name} has no ${mode} mode`);
    const gas = opts.gasCapUsd === undefined || opts.gasCapUsd === null ? null : Number(opts.gasCapUsd);
    if (gas !== null && (!Number.isFinite(gas) || gas < 0 || gas > MAX_GAS_CAP_USD)) throw new Error(`gas cap must be 0-${MAX_GAS_CAP_USD} USD/day`);
    const c: Control = {
      id,
      desired,
      mode,
      target: str(opts.target, 120),
      gasCapUsd: gas,
      requestedAt: new Date().toISOString(),
      requestedBy: by.slice(0, 60),
    };
    mkdirSync(this.dir, { recursive: true });
    const path = this.file(id, "control");
    const tmp = path + ".tmp";
    writeFileSync(tmp, JSON.stringify(c, null, 2) + "\n");
    renameSync(tmp, path);
    return c;
  }

  /** Every bot with its live state. `flagship` describes the in-process bot. */
  rows(flagship: { mode: BotMode; pnlUsd: number; sends: number; gasUsd: number; detail: string | null; running: boolean }, now = Date.now()): FleetRow[] {
    return FLEET.map((b) => {
      const base = {
        id: b.id,
        name: b.name,
        networks: [...b.networks],
        kind: b.kind,
        language: b.language,
        strategy: b.strategy,
        description: b.description,
        capital: b.capital,
        phase: b.phase,
        firstStep: b.firstStep,
        modes: [...b.modes],
        edge: b.edge,
        excluded: b.excluded ?? null,
        upstream: b.upstream ? { repo: b.upstream.repo, commit: b.upstream.commit, license: b.upstream.license, obligations: b.upstream.obligations } : null,
        liveFlag: b.kind === "external" ? liveFlag(b.id) : null,
      };
      if (b.kind === "in-process") {
        return {
          ...base,
          state: flagship.running ? "in-process" : "stopped",
          mode: flagship.mode,
          pnlUsd: flagship.pnlUsd,
          sends: flagship.sends,
          gasUsd: flagship.gasUsd,
          heartbeatAgeS: 0,
          lastError: null,
          detail: flagship.detail,
          control: null,
          routes: [],
          metrics: {},
        } satisfies FleetRow;
      }
      const hb = this.heartbeat(b.id);
      const ctl = this.control(b.id) ?? null;
      if (!hb) {
        return {
          ...base,
          state: "not-installed",
          mode: null,
          pnlUsd: 0,
          sends: 0,
          gasUsd: 0,
          heartbeatAgeS: null,
          lastError: null,
          detail: null,
          control: ctl,
          routes: [],
          metrics: {},
        } satisfies FleetRow;
      }
      const age = Math.max(0, now - Date.parse(hb.updatedAt));
      const state: FleetState = age > STALE_MS ? "stale" : hb.status;
      return {
        ...base,
        state,
        mode: hb.mode,
        pnlUsd: hb.pnlUsd,
        sends: hb.sends,
        gasUsd: hb.gasUsd,
        heartbeatAgeS: Math.round(age / 1000),
        lastError: hb.lastError,
        detail: hb.detail,
        control: ctl,
        routes: hb.routes,
        metrics: hb.metrics,
      } satisfies FleetRow;
    });
  }
}
