/**
 * Systems health and the issue list the AI agents work from.
 *
 * `health()` is pure: it takes what the running process already knows (the
 * block tape, RPC usage, live-sender safety, STOP file, cloud mirror, fleet
 * heartbeats) and returns a systems matrix plus issues. Each issue has a
 * stable id (the same problem keeps the same id while it lasts), so an agent
 * can claim one with POST /api/issues/:id/assign and the claim survives
 * refreshes. Claims live in data/issues.json; they never change the bot.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { FleetRow } from "../fleet/control.js";

export type SystemStatus = "ok" | "warn" | "down" | "off";
export type Severity = "critical" | "warning" | "info";

export interface SystemRow {
  id: string;
  name: string;
  status: SystemStatus;
  detail: string;
  /** One headline number the page and agents can trend, when there is one. */
  metric: number | null;
  unit: string | null;
}

export interface Issue {
  id: string;
  severity: Severity;
  system: string;
  title: string;
  detail: string;
  /** The numbers the rule fired on, so an agent can check them itself. */
  evidence: Record<string, number | string | boolean | null>;
  /** Where to look first. Never an action the dashboard takes by itself. */
  nextStep: string;
  assignee: Assignment | null;
}

export interface Assignment {
  agentId: string | null;
  agentName: string;
  note: string;
  at: string;
}

export interface HealthInput {
  now: number;
  startedAt: number;
  running: boolean;
  mode: string;
  /** Wall-clock ms each recent block finished processing, and how long it took. */
  blocks: Array<{ n: number; at: number; ms: number }>;
  rpc: { requests: number; transientErrors: number; rateLimited: number; failovers: number; onPrimary: boolean; activeEndpoint: string } | null;
  live: { consecutiveFailures: number; limit: number; gasSpentTodayUsd: number; maxDailyGasUsd: number } | null;
  flashblocksOn: boolean;
  flashblocks: Record<string, number> | null;
  liquidationsOn: boolean;
  liquidations: { watched: number; stats: Record<string, number> } | null;
  stop: { present: boolean; reason: string | null };
  cloud: { url: string; lastOkAt: number; pushes: number; failures: number; lastError: string | null } | null;
  learning: boolean;
  hasSigner: boolean;
  funnel: Record<string, number> | null;
  fleet: FleetRow[];
  agents: { total: number; active: number };
}

export interface Health {
  at: string;
  /** Worst status across systems, for one badge. */
  overall: SystemStatus;
  systems: SystemRow[];
  issues: Issue[];
}

const SEC = 1000;
const MIN = 60 * SEC;

function quant(values: number[], q: number): number | null {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  return v[Math.min(v.length - 1, Math.max(0, Math.ceil(q * v.length) - 1))]!;
}

export function health(x: HealthInput, assignments: Record<string, Assignment> = {}): Health {
  const systems: SystemRow[] = [];
  const issues: Issue[] = [];
  const add = (i: Omit<Issue, "assignee">) => issues.push({ ...i, assignee: assignments[i.id] ?? null });
  const uptime = x.now - x.startedAt;

  // Block feed -----------------------------------------------------------
  const last = x.blocks.at(-1);
  const sinceLast = last ? x.now - last.at : null;
  const procP90 = quant(
    x.blocks.slice(-60).map((b) => b.ms),
    0.9,
  );
  if (!x.running) {
    systems.push({ id: "loop", name: "Bot loop", status: "off", detail: "dashboard only: the bot isn't running in this process", metric: null, unit: null });
  } else {
    const stalled = sinceLast === null ? uptime > 30 * SEC : sinceLast > 30 * SEC;
    systems.push({
      id: "loop",
      name: "Block feed",
      status: stalled ? "down" : procP90 !== null && procP90 > 2000 ? "warn" : "ok",
      detail: last ? `block ${last.n}, ${Math.round((sinceLast ?? 0) / SEC)} s ago; p90 processing ${procP90 ?? "?"} ms` : "waiting for the first block",
      metric: procP90,
      unit: "ms p90",
    });
    if (stalled)
      add({
        id: "blocks-stalled",
        severity: "critical",
        system: "loop",
        title: last ? `No new block for ${Math.round((sinceLast ?? 0) / SEC)} s` : "No block processed since start",
        detail: "Base makes a block every 2 s. The RPC or WebSocket feed has stopped delivering, or the loop is stuck.",
        evidence: { lastBlock: last?.n ?? null, secondsSinceLast: sinceLast === null ? null : Math.round(sinceLast / SEC) },
        nextStep: "Check the bot's PowerShell window for RPC errors; compare the node on the Nodes panel.",
      });
    else if (procP90 !== null && procP90 > 2000)
      add({
        id: "block-processing-slow",
        severity: "warning",
        system: "loop",
        title: `Block processing p90 is ${procP90} ms (over the 2 s block time)`,
        detail: "The loop falls behind the chain, so every find is late. Usually RPC latency or too many pools re-scored per block.",
        evidence: { p90Ms: procP90, sample: Math.min(60, x.blocks.length) },
        nextStep: "Compare RPC latency on the Nodes panel; check the refresh stats for full-refresh storms.",
      });
  }

  // RPC --------------------------------------------------------------------
  if (x.rpc) {
    const errRate = x.rpc.requests ? x.rpc.transientErrors / x.rpc.requests : 0;
    const status: SystemStatus = !x.rpc.onPrimary || (x.rpc.requests >= 200 && errRate > 0.05) ? "warn" : "ok";
    systems.push({
      id: "rpc",
      name: "RPC",
      status,
      detail: `${x.rpc.onPrimary ? "primary" : "FALLBACK"} endpoint, ${x.rpc.requests} requests, ${(errRate * 100).toFixed(1)}% transient errors, ${x.rpc.rateLimited} rate-limited`,
      metric: Math.round(errRate * 1000) / 10,
      unit: "% errors",
    });
    if (!x.rpc.onPrimary)
      add({
        id: "rpc-on-fallback",
        severity: "warning",
        system: "rpc",
        title: "Running on a fallback RPC endpoint",
        detail: "The primary failed and the bot switched over. Fallbacks are usually slower, so finds arrive later.",
        evidence: { failovers: x.rpc.failovers, active: x.rpc.activeEndpoint },
        nextStep: "Test the primary on the Nodes panel. The owner changes RPC_URL in .env if it stays down.",
      });
    if (x.rpc.requests >= 200 && errRate > 0.05)
      add({
        id: "rpc-errors",
        severity: "warning",
        system: "rpc",
        title: `RPC error rate ${(errRate * 100).toFixed(1)}%`,
        detail: x.rpc.rateLimited ? `${x.rpc.rateLimited} answers were rate limits: the plan's throughput is the bottleneck.` : "Timeouts and resets, not rate limits.",
        evidence: { requests: x.rpc.requests, transientErrors: x.rpc.transientErrors, rateLimited: x.rpc.rateLimited },
        nextStep: "Check the provider's dashboard for the plan limit; compare a candidate node on the Nodes panel.",
      });
  }

  // Live sender + gas budget ------------------------------------------------
  if (x.mode !== "live") {
    systems.push({ id: "sender", name: "Live sender", status: "off", detail: `MODE=${x.mode}: nothing is sent`, metric: null, unit: null });
  } else if (x.live) {
    const half = Math.ceil(x.live.limit / 2);
    const halted = x.live.consecutiveFailures >= x.live.limit;
    systems.push({
      id: "sender",
      name: "Live sender",
      status: halted || x.stop.present ? "down" : x.live.consecutiveFailures >= half ? "warn" : "ok",
      detail: x.stop.present
        ? "paused by the STOP file"
        : `${x.live.consecutiveFailures}/${x.live.limit} consecutive failures${x.hasSigner ? "" : "; no signer loaded"}`,
      metric: x.live.consecutiveFailures,
      unit: "failures in a row",
    });
    if (x.live.consecutiveFailures >= half)
      add({
        id: "live-failures",
        severity: halted ? "critical" : "warning",
        system: "sender",
        title: halted ? `Live sending halted after ${x.live.consecutiveFailures} failures in a row` : `${x.live.consecutiveFailures} live sends failed in a row`,
        detail: "Reverts mean a rival landed first or the price moved between find and inclusion. The breaker stops sending at the limit.",
        evidence: { consecutiveFailures: x.live.consecutiveFailures, limit: x.live.limit },
        nextStep: "Read the newest reverted rows in data/live.jsonl and who took each opportunity (outcomes, takenBy).",
      });
    const share = x.live.maxDailyGasUsd > 0 ? x.live.gasSpentTodayUsd / x.live.maxDailyGasUsd : 0;
    systems.push({
      id: "gas",
      name: "Gas budget",
      status: share >= 1 ? "down" : share >= 0.8 ? "warn" : "ok",
      detail: `$${x.live.gasSpentTodayUsd.toFixed(3)} of $${x.live.maxDailyGasUsd.toFixed(2)} today`,
      metric: Math.round(share * 1000) / 10,
      unit: "% of cap",
    });
    if (share >= 0.8)
      add({
        id: "gas-budget",
        severity: share >= 1 ? "critical" : "warning",
        system: "gas",
        title: share >= 1 ? "Daily gas cap reached: sending paused until midnight UTC" : `Gas spend at ${(share * 100).toFixed(0)}% of the daily cap`,
        detail: "MAX_DAILY_GAS_USD caps what failed sends can cost. Only the owner changes it, in .env.",
        evidence: { spentUsd: Math.round(x.live.gasSpentTodayUsd * 1000) / 1000, capUsd: x.live.maxDailyGasUsd },
        nextStep: "Check whether the spend went on reverts (wasted) or landed trades; raise the bid floor before raising the cap.",
      });
  }

  // Kill switch -------------------------------------------------------------
  systems.push({
    id: "stop",
    name: "Kill switch",
    status: x.stop.present ? "warn" : "ok",
    detail: x.stop.present ? `STOP file present${x.stop.reason ? `: ${x.stop.reason}` : ""}` : "armed (no STOP file)",
    metric: null,
    unit: null,
  });
  if (x.stop.present)
    add({
      id: "stop-file",
      severity: "warning",
      system: "stop",
      title: "Live sending is paused by the STOP file",
      detail: x.stop.reason ?? "no reason recorded",
      evidence: { reason: x.stop.reason },
      nextStep: "Resume is manual: the owner deletes data/STOP after reading why it was written.",
    });

  // Flashblocks ---------------------------------------------------------------
  if (!x.flashblocksOn) {
    systems.push({ id: "flashblocks", name: "Flashblocks", status: "off", detail: "FLASHBLOCKS is off", metric: null, unit: null });
  } else {
    const fb = x.flashblocks ?? {};
    const ticks = fb.ticks ?? 0;
    const errors = fb.errors ?? 0;
    const silent = x.running && uptime > 2 * MIN && ticks === 0;
    const erroring = ticks >= 20 && errors / ticks > 0.25;
    systems.push({
      id: "flashblocks",
      name: "Flashblocks",
      status: silent ? "down" : erroring ? "warn" : "ok",
      detail: `${ticks} ticks, ${fb.scans ?? 0} scans, ${fb.opps ?? 0} finds, ${errors} errors, max ${fb.maxMs ?? 0} ms`,
      metric: fb.opps ?? 0,
      unit: "finds",
    });
    if (silent || erroring)
      add({
        id: "flashblocks-silent",
        severity: "warning",
        system: "flashblocks",
        title: silent ? "Flashblocks is on but has not ticked" : `Flashblocks errors on ${Math.round((errors / ticks) * 100)}% of ticks`,
        detail: "Pre-confirmation reaction is where same-block backruns come from. Without it the bot only sees confirmed blocks.",
        evidence: { ticks, errors, uptimeS: Math.round(uptime / SEC) },
        nextStep: "Check FLASHBLOCKS_RPC_URL answers the pending tag (the Nodes panel shows its host).",
      });
  }

  // Liquidations -------------------------------------------------------------
  systems.push(
    x.liquidationsOn
      ? { id: "liquidations", name: "Liquidation monitor", status: "ok", detail: `${x.liquidations?.watched ?? 0} borrowers watched`, metric: x.liquidations?.watched ?? 0, unit: "borrowers" }
      : { id: "liquidations", name: "Liquidation monitor", status: "off", detail: "LIQUIDATIONS is off", metric: null, unit: null },
  );

  // Learning -----------------------------------------------------------------
  systems.push({ id: "learning", name: "Learning engine", status: x.learning ? "ok" : "off", detail: x.learning ? "scoring routes and pools" : "off", metric: null, unit: null });

  // Online copy ----------------------------------------------------------------
  if (!x.cloud) {
    systems.push({ id: "cloud", name: "Online copy", status: "off", detail: "CLOUD_URL not set", metric: null, unit: null });
  } else {
    const age = x.cloud.lastOkAt ? x.now - x.cloud.lastOkAt : null;
    const stale = age === null ? uptime > 5 * MIN : age > 5 * MIN;
    systems.push({
      id: "cloud",
      name: "Online copy",
      status: stale ? "warn" : "ok",
      detail: age === null ? "no successful push yet" : `last push ${Math.round(age / SEC)} s ago, ${x.cloud.failures} failures`,
      metric: age === null ? null : Math.round(age / SEC),
      unit: "s since push",
    });
    if (stale)
      add({
        id: "cloud-stale",
        severity: "warning",
        system: "cloud",
        title: "The online copy has not updated for over 5 minutes",
        detail: x.cloud.lastError ?? "no error recorded",
        evidence: { failures: x.cloud.failures, pushes: x.cloud.pushes, secondsSinceOk: age === null ? null : Math.round(age / SEC) },
        nextStep: "Check the Worker in the Cloudflare dashboard (the owner deploys it from the browser).",
      });
  }

  // Scanner: running a while but never a candidate --------------------------------
  if (x.running && uptime > 30 * MIN && x.funnel && (x.funnel.candidates ?? 0) === 0)
    add({
      id: "no-candidates",
      severity: "info",
      system: "loop",
      title: "No candidate gaps in 30 minutes",
      detail: "Either the market is unusually quiet or the pool set is too narrow.",
      evidence: { uptimeMin: Math.round(uptime / MIN) },
      nextStep: "Compare against rival arbitrages on the Market page: if rivals trade pools we don't watch, widen MAX_POOLS.",
    });

  // Fleet ------------------------------------------------------------------------
  const external = x.fleet.filter((f) => f.kind === "external");
  const installed = external.filter((f) => f.state !== "not-installed");
  const unhealthy = installed.filter((f) => f.state === "stale" || f.state === "error");
  systems.push({
    id: "fleet",
    name: "Fleet",
    status: unhealthy.length ? "warn" : installed.length ? "ok" : "off",
    detail: installed.length ? `${installed.filter((f) => f.state === "running").length} of ${installed.length} installed bots running` : "no external bot installed yet",
    metric: installed.length,
    unit: "installed",
  });
  for (const f of unhealthy)
    add({
      id: `fleet-${f.id}`,
      severity: "warning",
      system: "fleet",
      title: f.state === "stale" ? `${f.name} stopped reporting (${f.heartbeatAgeS ?? "?"} s)` : `${f.name} reports an error`,
      detail: f.lastError ?? "its wrapper's heartbeat went quiet",
      evidence: { bot: f.id, state: f.state, heartbeatAgeS: f.heartbeatAgeS },
      nextStep: "Read the wrapper's log on the machine that runs it; see bots/CONTRACT.md for the heartbeat format.",
    });

  // Agents -------------------------------------------------------------------------
  systems.push({
    id: "agents",
    name: "AI agents",
    status: x.agents.total ? "ok" : "off",
    detail: x.agents.total ? `${x.agents.active} of ${x.agents.total} active in the last 10 min` : "no agent tokens issued",
    metric: x.agents.active,
    unit: "active",
  });

  const order: Record<SystemStatus, number> = { down: 3, warn: 2, ok: 1, off: 0 };
  const overall = systems.reduce<SystemStatus>((w, s) => (order[s.status] > order[w] ? s.status : w), "off");
  const sev: Record<Severity, number> = { critical: 0, warning: 1, info: 2 };
  issues.sort((a, b) => sev[a.severity] - sev[b.severity]);
  return { at: new Date(x.now).toISOString(), overall: overall === "off" ? "ok" : overall, systems, issues };
}

/** Agent claims on issues (data/issues.json). */
export class IssueBoard {
  private claims: Record<string, Assignment> = {};

  constructor(readonly path: string) {
    if (!existsSync(path)) return;
    try {
      const v = JSON.parse(readFileSync(path, "utf8")) as { claims?: Record<string, unknown> };
      for (const [id, c] of Object.entries(v.claims ?? {})) {
        if (!/^[a-z0-9-]{1,60}$/.test(id) || !c || typeof c !== "object") continue;
        const r = c as Record<string, unknown>;
        this.claims[id] = {
          agentId: typeof r.agentId === "string" ? r.agentId.slice(0, 40) : null,
          agentName: String(r.agentName ?? "owner").slice(0, 40),
          note: String(r.note ?? "").slice(0, 300),
          at: String(r.at ?? new Date(0).toISOString()).slice(0, 40),
        };
      }
    } catch {
      this.claims = {};
    }
  }

  all(): Record<string, Assignment> {
    return { ...this.claims };
  }

  /** Claim (or with `release`, drop) an issue. */
  assign(id: string, who: { agentId: string | null; agentName: string }, note: string, release = false): Assignment | null {
    if (!/^[a-z0-9-]{1,60}$/.test(id)) throw new Error("bad issue id");
    if (release) delete this.claims[id];
    else this.claims[id] = { agentId: who.agentId, agentName: who.agentName.slice(0, 40), note: note.replace(/[\u0000-\u001f]/g, " ").slice(0, 300), at: new Date().toISOString() };
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = this.path + ".tmp";
    writeFileSync(tmp, JSON.stringify({ v: 1, claims: this.claims }, null, 2) + "\n");
    renameSync(tmp, this.path);
    return this.claims[id] ?? null;
  }
}
