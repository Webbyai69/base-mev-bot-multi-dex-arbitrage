/**
 * Command-center API: the routes behind ui/terminal.html and the AI agents.
 *
 * UiServer authenticates the caller (the page's owner token or an agent
 * token, src/command/agents.ts), checks the route's scope, then hands any
 * route it doesn't serve itself to `handle()` here.
 *
 * Nothing here signs, holds a key, edits .env, starts a process or resumes
 * live sending. The strongest things it can do are: write the STOP file,
 * write a fleet desired-state file (detect/paper only), apply a learned
 * tuning suggestion (via UiServer), and record agent claims on issues.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { CHAIN_ID } from "../config.js";
import { bigintReplacer } from "../log.js";
import type { BlockEvent, UiSources } from "../ui/server.js";
import { FleetControl, type FleetRow } from "../fleet/control.js";
import type { BotMode, Network } from "../fleet/registry.js";
import { AgentRegistry, SCOPES, requiredScope, type Auth } from "./agents.js";
import { health, IssueBoard, type Health } from "./health.js";
import { NodeBook, configuredNodes, probe, publicNodes, redactHost } from "./nodes.js";
import { Records } from "./records.js";
import { atlasBase, finalLives, hourly, latency, leaks, racers, routeScores, simulate, type SimConfig } from "./telemetry.js";

export interface CommandHost {
  src: UiSources;
  startedAt: number;
  blocks(): BlockEvent[];
  stopState(): { present: boolean; reason: string | null };
  writeStop(reason: string): { present: boolean; reason: string | null };
  onEvent(fn: (type: string, data: unknown) => void): () => void;
  publish(type: string, data: unknown): void;
}

const HOUR = 3_600_000;
const NETWORKS: readonly Network[] = ["base", "eth", "arb", "op", "sol", "hl", "cex"];
const MAX_STREAMS = 8;

/** Every route, its scope and what it does: served at GET /api/help so an agent can discover the API. */
export const ROUTES: ReadonlyArray<{ method: "GET" | "POST"; path: string; does: string }> = [
  { method: "GET", path: "/api/help", does: "this list, with the scopes your token has" },
  { method: "GET", path: "/api/brief", does: "one call for an agent: health, issues, latency, leaks, racers, top routes, fleet" },
  { method: "GET", path: "/api/stream", does: "server-sent events: block, opp, outcome, mev, live, stop, fleet, plus a brief every 30 s" },
  { method: "GET", path: "/api/state", does: "the bot's full state (mode, blocks, RPC, safety, learning, settings)" },
  { method: "GET", path: "/api/recent", does: "last 40 opportunities, rival trades, liquidations and live sends" },
  { method: "GET", path: "/api/summary", does: "daily paper results, market and liquidation summaries" },
  { method: "GET", path: "/api/health", does: "systems matrix and open issues" },
  { method: "GET", path: "/api/issues", does: "open issues with who has claimed each" },
  { method: "POST", path: "/api/issues/:id/assign", does: "claim an open issue {note}, or release it {release:true}; the owner can pass {agentId}" },
  { method: "GET", path: "/api/latency?hours=24", does: "detect / send / land latency percentiles and the hourly trend" },
  { method: "GET", path: "/api/leaks?hours=6", does: "where found profit went: captured, lost race, closed, gas wall, below minimum" },
  { method: "GET", path: "/api/racers?hours=1", does: "rival bots: trades, $/h, share, priority fee, block position, takes from us" },
  { method: "GET", path: "/api/analytics?hours=24", does: "hourly buckets: finds by outcome, paper and live net, sends, gas, detect latency, rival activity" },
  { method: "GET", path: "/api/routes/scores", does: "pairs ranked by recoverable profit, win rate and gas share over 24 h" },
  { method: "GET", path: "/api/targets", does: "today's targeting brief: where to point the bots, and rival pairs we don't cover" },
  { method: "GET", path: "/api/market?chain=base", does: "route atlas for a network: venues, pairs, our routes, rival routes, fleet bots there" },
  { method: "POST", path: "/api/simulate", does: "replay recent finds under other settings {minProfitUsd, gasX, latencyCutMs, gapMs, excludeDexes, hours}" },
  { method: "GET", path: "/api/fleet", does: "every bot with its live state from its heartbeat" },
  { method: "POST", path: "/api/fleet/:id/control", does: "ask an external bot to run or stop {desired, mode: detect|paper, target, gasCapUsd}" },
  { method: "GET", path: "/api/nodes", does: "configured RPC endpoints (host only), RPC usage and candidate timings" },
  { method: "POST", path: "/api/tuning", does: "apply, dismiss, unblock or reset a learned suggestion {action, id}" },
  { method: "POST", path: "/api/sending", does: "{paused:true} writes the STOP file; resuming is manual (the owner deletes data/STOP)" },
  { method: "POST", path: "/api/stop", does: "write the STOP file" },
  { method: "GET", path: "/api/agents/me", does: "your agent record and scopes" },
  { method: "GET", path: "/api/agents", does: "owner: every agent token (never the tokens themselves)" },
  { method: "POST", path: "/api/agents", does: "owner: issue a token {name, source, scopes}; shown once" },
  { method: "POST", path: "/api/agents/:id/pause", does: "owner: pause or unpause an agent {paused}" },
  { method: "POST", path: "/api/agents/:id/revoke", does: "owner: revoke an agent's token" },
  { method: "POST", path: "/api/nodes/test", does: "owner: probe a node URL {url, label, save, candidateId}; the URL is never stored" },
  { method: "POST", path: "/api/nodes/probe", does: "owner: probe the configured endpoints" },
  { method: "POST", path: "/api/nodes/:id/remove", does: "owner: forget a candidate node" },
];

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const clamp = (v: unknown, lo: number, hi: number, def: number): number => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def;
};
const r2 = (n: number): number => Math.round(n * 100) / 100;

export class CommandApi {
  readonly agents: AgentRegistry;
  readonly fleet: FleetControl;
  readonly issues: IssueBoard;
  readonly nodes: NodeBook;
  readonly records: Records;
  private cache = new Map<string, { at: number; value: unknown }>();
  private streams = new Map<ServerResponse, string | null>();
  private unsubscribe: (() => void) | undefined;
  private briefTimer: NodeJS.Timeout | undefined;
  private readonly flushTimer: NodeJS.Timeout;
  private probing = false;

  constructor(private readonly host: CommandHost) {
    const dir = host.src.store.dir;
    this.agents = new AgentRegistry(join(dir, "agents.json"));
    this.fleet = new FleetControl(join(dir, "fleet"));
    this.issues = new IssueBoard(join(dir, "issues.json"));
    this.nodes = new NodeBook(join(dir, "nodes.json"));
    this.records = new Records(host.src.store);
    // Agent activity counters are saved at most every 10 s, not on every request.
    this.flushTimer = setInterval(() => this.agents.flushIfDirty(), 10_000);
    this.flushTimer.unref();
  }

  close(): void {
    clearInterval(this.flushTimer);
    this.stopFan();
    for (const r of this.streams.keys()) r.end();
    this.streams.clear();
    this.records.close();
    try {
      this.agents.flushIfDirty();
    } catch {
      /* best effort */
    }
  }

  /**
   * Serve a command-center route. Returns false when the route isn't one of
   * ours (UiServer then answers 404). Auth and scope are already checked.
   */
  async handle(req: IncomingMessage, res: ServerResponse, url: URL, method: string, auth: Auth): Promise<boolean> {
    try {
      const done = method === "GET" ? this.get(req, res, url, auth) : method === "POST" ? await this.post(req, res, url, auth) : false;
      return done;
    } catch (e) {
      if (e instanceof HttpError) {
        send(res, e.status, { error: e.message });
        return true;
      }
      throw e;
    }
  }

  private get(req: IncomingMessage, res: ServerResponse, url: URL, auth: Auth): boolean {
    const q = url.searchParams;
    const now = Date.now();
    switch (url.pathname) {
      case "/api/help":
        send(res, 200, this.help(auth));
        return true;
      case "/api/brief":
        send(res, 200, this.brief());
        return true;
      case "/api/stream":
        this.stream(req, res, auth);
        return true;
      case "/api/health":
        send(res, 200, this.healthNow());
        return true;
      case "/api/issues":
        send(res, 200, { issues: this.healthNow().issues, claims: this.issues.all() });
        return true;
      case "/api/latency": {
        const h = clamp(q.get("hours"), 1, 168, 24);
        send(res, 200, this.memo(`latency:${h}`, 5000, () => latency(this.r().opps, this.r().lives, now, h)));
        return true;
      }
      case "/api/leaks": {
        const h = clamp(q.get("hours"), 1, 168, 6);
        send(res, 200, this.memo(`leaks:${h}`, 5000, () => leaks(this.r().opps, this.r().outcomes, this.r().lives, this.host.src.extras?.()?.funnel, now, h)));
        return true;
      }
      case "/api/racers": {
        const h = clamp(q.get("hours"), 1, 168, 1);
        send(res, 200, this.memo(`racers:${h}`, 5000, () => racers(this.r().mev, this.r().outcomes, this.r().lives, this.self(), now, h)));
        return true;
      }
      case "/api/analytics": {
        const h = clamp(q.get("hours"), 1, 72, 24);
        send(res, 200, this.memo(`analytics:${h}`, 15_000, () => ({ hours: h, mode: this.host.src.settings.mode, buckets: hourly(this.r().opps, this.r().outcomes, this.r().lives, this.r().mev, this.self(), now, h) })));
        return true;
      }
      case "/api/routes/scores":
        send(res, 200, this.memo("scores", 10_000, () => ({ generatedAt: new Date(now).toISOString(), rows: routeScores(this.r().opps, this.r().outcomes, now).slice(0, 40) })));
        return true;
      case "/api/targets":
        send(res, 200, this.memo("targets", 30_000, () => this.targets(now)));
        return true;
      case "/api/market": {
        const chain = (q.get("chain") ?? "base").toLowerCase();
        send(res, 200, this.memo(`market:${chain}`, 5000, () => this.market(chain, now)));
        return true;
      }
      case "/api/fleet":
        send(res, 200, { rows: this.fleetRows(now), contract: "bots/CONTRACT.md" });
        return true;
      case "/api/nodes":
        send(res, 200, this.nodesView());
        return true;
      case "/api/agents":
        send(res, 200, { agents: this.agents.list(), scopes: SCOPES });
        return true;
      case "/api/agents/me":
        send(res, 200, auth.who === "owner" ? { who: "owner", scopes: [...SCOPES, "owner"] } : { who: "agent", agent: this.agents.list().find((a) => a.id === auth.agent.id) ?? null });
        return true;
      default:
        return false;
    }
  }

  private async post(req: IncomingMessage, res: ServerResponse, url: URL, auth: Auth): Promise<boolean> {
    const p = url.pathname;
    const by = auth.who === "owner" ? "owner" : `agent:${auth.agent.name}`;
    let m: RegExpMatchArray | null;

    if (p === "/api/simulate") {
      send(res, 200, this.simulate(await body(req)));
      return true;
    }
    if (p === "/api/sending") {
      const b = await body(req);
      if (b.paused !== true) throw new HttpError(409, "resuming is manual: the owner deletes data/STOP after reading why it was written");
      const st = this.host.writeStop(`paused by ${by} from the command center${typeof b.reason === "string" ? ": " + b.reason.replace(/[\r\n]/g, " ").slice(0, 160) : ""}`);
      send(res, 200, { ok: true, stop: st });
      return true;
    }
    if ((m = p.match(/^\/api\/fleet\/([a-z0-9-]{1,40})\/control$/))) {
      const b = await body(req);
      if (b.desired !== "running" && b.desired !== "stopped") throw new HttpError(400, "desired must be running or stopped");
      try {
        const c = this.fleet.request(m[1]!, b.desired, { mode: b.mode, target: b.target, gasCapUsd: b.gasCapUsd }, by);
        this.host.publish("fleet", { id: c.id, control: c });
        send(res, 200, { ok: true, control: c });
      } catch (e) {
        throw new HttpError(400, (e as Error).message);
      }
      return true;
    }
    if ((m = p.match(/^\/api\/issues\/([a-z0-9-]{1,60})\/assign$/))) {
      const b = await body(req);
      const id = m[1]!;
      const release = b.release === true;
      if (!release && !this.healthNow().issues.some((i) => i.id === id)) throw new HttpError(404, "no open issue with that id");
      // The owner can hand an issue to a named agent; an agent can only claim it for itself.
      let who: { agentId: string | null; agentName: string } = auth.who === "owner" ? { agentId: null, agentName: "owner" } : { agentId: auth.agent.id, agentName: auth.agent.name };
      if (auth.who === "owner" && typeof b.agentId === "string") {
        const a = this.agents.list().find((x) => x.id === b.agentId);
        if (!a) throw new HttpError(404, "no such agent");
        who = { agentId: a.id, agentName: a.name };
      }
      const claim = this.issues.assign(id, who, typeof b.note === "string" ? b.note : "", release);
      this.cache.delete("health");
      this.host.publish("issue", { id, claim });
      send(res, 200, { ok: true, id, claim });
      return true;
    }
    if (p === "/api/agents") {
      const b = await body(req);
      try {
        const out = this.agents.create(String(b.name ?? ""), String(b.source ?? ""), b.scopes);
        send(res, 200, { ...out, note: "Copy the token now: it is shown once and stored only as a hash." });
      } catch (e) {
        throw new HttpError(400, (e as Error).message);
      }
      return true;
    }
    if ((m = p.match(/^\/api\/agents\/(agt-[a-z0-9]{6,20})\/(pause|revoke)$/))) {
      const b = await body(req);
      const id = m[1]!;
      if (m[2] === "revoke") {
        const ok = this.agents.revoke(id);
        this.dropStreams(id);
        send(res, ok ? 200 : 404, ok ? { ok } : { error: "no such agent" });
      } else {
        try {
          const a = this.agents.setPaused(id, b.paused !== false);
          if (a.paused) this.dropStreams(id);
          send(res, 200, { ok: true, agent: a });
        } catch (e) {
          throw new HttpError(404, (e as Error).message);
        }
      }
      return true;
    }
    if (p === "/api/nodes/test") {
      const b = await body(req);
      if (typeof b.url !== "string" || b.url.length > 500) throw new HttpError(400, "url required");
      const result = await this.oneProbe(() => probe(b.url as string, { ourBlock: this.host.blocks().at(-1)?.n ?? null }));
      let candidate = null;
      try {
        if (typeof b.candidateId === "string") candidate = this.nodes.updateCandidate(b.candidateId, result);
        else if (b.save === true) candidate = this.nodes.addCandidate(typeof b.label === "string" ? b.label : "", result);
      } catch (e) {
        throw new HttpError(400, (e as Error).message);
      }
      send(res, 200, { probe: result, candidate });
      return true;
    }
    if (p === "/api/nodes/probe") {
      const list = configuredNodes(this.host.src.settings).slice(0, 6);
      const ourBlock = this.host.blocks().at(-1)?.n ?? null;
      const out = await this.oneProbe(async () => {
        const results = [];
        for (const n of list) {
          const r = await probe(n.url, { ourBlock });
          this.nodes.recordConfigured(n.id, r);
          results.push({ id: n.id, role: n.role, probe: r });
        }
        return results;
      });
      send(res, 200, { results: out });
      return true;
    }
    if ((m = p.match(/^\/api\/nodes\/(node-[0-9a-f]{8})\/remove$/))) {
      const ok = this.nodes.removeCandidate(m[1]!);
      send(res, ok ? 200 : 404, ok ? { ok } : { error: "no such candidate" });
      return true;
    }
    return false;
  }

  // -------------------------------------------------------------------------

  private r(): Records {
    return this.records.ensure();
  }

  private memo<T>(key: string, ttlMs: number, fn: () => T): T {
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < ttlMs) return hit.value as T;
    const value = fn();
    this.cache.set(key, { at: Date.now(), value });
    if (this.cache.size > 64) this.cache.delete(this.cache.keys().next().value as string);
    return value;
  }

  /** Addresses that are us: the bot wallet and our executors. */
  private self(): string[] {
    const s = this.host.src.settings;
    return [this.host.src.botAddress, s.executorAddress, s.routeExecutorAddress, s.liqExecutorAddress].filter((a): a is string => typeof a === "string" && a.length > 0);
  }

  private async oneProbe<T>(fn: () => Promise<T>): Promise<T> {
    if (this.probing) throw new HttpError(429, "a probe is already running");
    this.probing = true;
    try {
      return await fn();
    } finally {
      this.probing = false;
    }
  }

  private help(auth: Auth): Record<string, unknown> {
    const scopes = auth.who === "owner" ? [...SCOPES, "owner"] : auth.agent.scopes;
    return {
      you: auth.who === "owner" ? "owner (the dashboard page)" : `${auth.agent.name} (${auth.agent.id})`,
      scopes,
      auth: "send your token as `Authorization: Bearer agt_…` or `x-bot-token`; for EventSource use ?t=",
      limits: "120 requests a minute per agent; at most 8 open streams",
      rules: [
        "Nothing here signs or moves funds; there is no sign or withdraw scope.",
        "Live trading, gas caps, keys and RPC URLs live in .env, which only the owner edits.",
        "Pausing (STOP file) is allowed with the pause scope; resuming is manual.",
        "Fleet bots can be asked for detect or paper mode only.",
      ],
      routes: ROUTES.map((r) => {
        const need = requiredScope(r.method, r.path.replace(/\?.*$/, "").replace(":id", "x"));
        return { ...r, scope: need, allowed: auth.who === "owner" || (need !== "owner" && scopes.includes(need)) };
      }),
    };
  }

  healthNow(): Health {
    return this.memo("health", 3000, () => {
      const s = this.host.src.settings;
      const x = this.host.src.extras?.() ?? {};
      const u = this.host.src.usage?.() ?? null;
      const cutoff = Date.now() - 10 * 60_000;
      const agents = this.agents.list();
      return health(
        {
          now: Date.now(),
          startedAt: this.host.startedAt,
          running: this.host.src.running,
          mode: s.mode,
          blocks: this.host.blocks().map((b) => ({ n: b.n, at: b.at, ms: b.ms })),
          rpc: u
            ? { requests: u.requests, transientErrors: u.transientErrors, rateLimited: u.rateLimited, failovers: u.failovers, onPrimary: u.onPrimary, activeEndpoint: redactHost(u.activeEndpoint)?.host ?? "?" }
            : null,
          live: x.live ?? null,
          flashblocksOn: !!s.flashblocks,
          flashblocks: x.flashblocks ?? null,
          liquidationsOn: !!s.liquidations,
          liquidations: x.liquidations ?? null,
          stop: this.host.stopState(),
          cloud: this.host.src.cloud?.() ?? null,
          learning: !!this.host.src.learning?.(),
          hasSigner: s.mode === "live" && !!s.privateKey,
          funnel: x.funnel ?? null,
          fleet: this.fleetRows(),
          agents: { total: agents.length, active: agents.filter((a) => a.lastSeenAt && Date.parse(a.lastSeenAt) > cutoff).length },
        },
        this.issues.all(),
      );
    });
  }

  private flagship(): { mode: BotMode; pnlUsd: number; sends: number; gasUsd: number; detail: string | null; running: boolean } {
    const s = this.host.src.settings;
    const today = new Date().toISOString().slice(0, 10);
    const lives = finalLives(this.r().lives).filter((l) => l.sentAt.startsWith(today));
    const won = lives.filter((l) => l.status === "success");
    const gas = lives.reduce((a, l) => a + (l.gasUsd ?? 0), 0);
    return {
      mode: s.mode === "live" ? "live" : "paper",
      pnlUsd: r2(won.reduce((a, l) => a + l.expectedProfitUsd, 0) - gas),
      sends: lives.length,
      gasUsd: r2(gas),
      detail: s.mode === "live" ? `${won.length} of ${lives.length} sends landed today (profit expected at send time, minus gas)` : "paper mode: finds are recorded, nothing is sent",
      running: this.host.src.running,
    };
  }

  private fleetRows(now = Date.now()): FleetRow[] {
    return this.memo("fleet", 2000, () => this.fleet.rows(this.flagship(), now));
  }

  brief(): Record<string, unknown> {
    return this.memo("brief", 5000, () => {
      const r = this.r();
      const now = Date.now();
      const s = this.host.src.settings;
      const h = this.healthNow();
      const lat = latency(r.opps, r.lives, now, 24);
      return {
        at: new Date(now).toISOString(),
        version: this.host.src.version,
        chainId: CHAIN_ID,
        mode: s.mode,
        running: this.host.src.running,
        stop: this.host.stopState(),
        latestBlock: this.host.blocks().at(-1)?.n ?? null,
        ethUsd: this.host.src.ethUsd(),
        health: { overall: h.overall, systems: h.systems.map(({ id, name, status, detail }) => ({ id, name, status, detail })), issues: h.issues },
        latency: { windowHours: lat.windowHours, detectP50: lat.detectP50, detectP90: lat.detectP90, sendP50: lat.sendP50, sendP90: lat.sendP90, landBlocksP50: lat.landBlocksP50, samples: lat.samples },
        leaks: leaks(r.opps, r.outcomes, r.lives, this.host.src.extras?.()?.funnel, now, 6),
        racers: racers(r.mev, r.outcomes, r.lives, this.self(), now, 1).rows.slice(0, 6),
        routes: routeScores(r.opps, r.outcomes, now).slice(0, 5),
        fleet: this.fleetRows(now).map((f) => ({ id: f.id, name: f.name, networks: f.networks, state: f.state, mode: f.mode, pnlUsd: f.pnlUsd, heartbeatAgeS: f.heartbeatAgeS })),
        records: { opps: r.opps.length, outcomes: r.outcomes.length, mev: r.mev.length, lives: r.lives.length },
        help: "/api/help",
      };
    });
  }

  private targets(now: number): Record<string, unknown> {
    const r = this.r();
    const scores = routeScores(r.opps, r.outcomes, now);
    const atlas = atlasBase(r.opps, r.mev, this.host.src.symbol ?? ((a: string) => a.slice(0, 8)), this.self(), now);
    const ourPairs = new Set(scores.map((x) => x.pair));
    const verdict = (x: (typeof scores)[number]): { verdict: string; why: string } => {
      if (x.winRate === null) return { verdict: "watch", why: "no decided outcomes yet" };
      if (x.winRate < 0.2 && x.recoverableUsd > 0) return { verdict: "contested", why: "we see it but rivals land first: speed or a higher bid wins it back, more coverage won't" };
      if (x.gasShare > 0.7) return { verdict: "gas-bound", why: "gas eats most of the edge: only worth it on a cheaper route or at a bigger size" };
      return { verdict: "ours", why: "still there when we look: keep the bot on it" };
    };
    return {
      day: new Date(now).toISOString().slice(0, 10),
      generatedAt: new Date(now).toISOString(),
      recommendations: scores.slice(0, 6).map((x) => ({ pair: x.pair, route: x.bestRoute, score: x.score, finds: x.finds, recoverableUsd: x.recoverableUsd, winRate: x.winRate, gasShare: x.gasShare, ...verdict(x) })),
      uncovered: atlas.routes
        .filter((x) => x.owner === "rival" && !ourPairs.has(x.pair))
        .slice(0, 6)
        .map((x) => ({ pair: x.pair, venues: x.venues, bot: x.bot, trades: x.count, rivalUsd24h: x.usd })),
      method:
        "score = recoverable USD x (0.25 + win rate) x (1.3 - gas share) x 10 over the last 24 h. " +
        "Uncovered = pairs rival bots arbitraged in 24 h where we recorded no find (widen MAX_POOLS or add the venue).",
    };
  }

  private market(chain: string, now: number): Record<string, unknown> {
    const net = (NETWORKS as readonly string[]).includes(chain) ? (chain as Network) : "base";
    const rows = this.fleetRows(now).filter((f) => f.networks.includes(net));
    const bots = rows.map((f) => ({ id: f.id, name: f.name, state: f.state, strategy: f.strategy, phase: f.phase }));
    if (net !== "base") {
      // Other networks are mapped from what fleet bots there report in their heartbeats.
      const reporting = rows.filter((f) => f.kind === "external" && (f.state === "running" || f.state === "stale"));
      const routes = reporting.flatMap((f) =>
        f.routes.map((x) => ({ id: `f:${f.id}:${x.pair}:${x.venues.join("|")}`, label: `${x.pair} · ${x.venues.join(" ↔ ")}`, owner: "ours" as const, bot: f.id, network: net, venues: x.venues, pair: x.pair, count: x.count, usd: r2(x.usd) })),
      );
      return {
        chain: net,
        live: routes.length > 0,
        note: routes.length ? `${reporting.length} fleet bot(s) reporting on ${net}` : `No collector on ${net} yet: its routes appear here once a fleet bot on ${net} reports routes in its heartbeat.`,
        venues: [...new Set(routes.flatMap((x) => x.venues))],
        pairs: [...new Set(routes.map((x) => x.pair))],
        routes,
        bots,
      };
    }
    const r = this.r();
    const atlas = atlasBase(r.opps, r.mev, this.host.src.symbol ?? ((a: string) => a.slice(0, 8)), this.self(), now);
    const day = r.mev.filter((d) => d.type === "arbitrage" && now - Date.parse(d.timestamp) <= 24 * HOUR);
    const ours = r.opps.filter((o) => now - Date.parse(o.foundAt) <= 24 * HOUR);
    return {
      chain: "base",
      live: true,
      ...atlas,
      bots,
      flow: {
        rivalTrades24h: day.length,
        rivalUsd24h: r2(day.reduce((a, d) => a + (d.profitUsd ?? 0), 0)),
        ourFinds24h: ours.length,
        ourNetUsd24h: r2(ours.reduce((a, o) => a + Math.max(0, o.netUsd), 0)),
      },
    };
  }

  private simulate(b: Record<string, unknown>): Record<string, unknown> {
    const s = this.host.src.settings;
    const r = this.r();
    const cfg: SimConfig = {
      minProfitUsd: clamp(b.minProfitUsd, 0, 1000, s.minProfitUsd),
      gasX: clamp(b.gasX, 0.1, 10, 1),
      latencyCutMs: clamp(b.latencyCutMs, 0, 2000, 0),
      gapMs: clamp(b.gapMs, 1, 5000, 250),
      excludeDexes: Array.isArray(b.excludeDexes) ? b.excludeDexes.slice(0, 20).map((x) => String(x).slice(0, 40)) : [],
    };
    const hours = clamp(b.hours, 1, 168, 24);
    const since = Date.now() - hours * HOUR;
    const opps = r.opps.filter((o) => Date.parse(o.foundAt) >= since);
    return {
      hours,
      result: simulate(opps, r.outcomes, cfg),
      // Today's settings over the same finds, so the page can show the difference.
      baseline: simulate(opps, r.outcomes, { minProfitUsd: s.minProfitUsd, gasX: 1, latencyCutMs: 0, gapMs: cfg.gapMs, excludeDexes: [] }),
    };
  }

  private nodesView(): Record<string, unknown> {
    const book = this.nodes.list();
    const u = this.host.src.usage?.() ?? null;
    return {
      configured: publicNodes(configuredNodes(this.host.src.settings)).map((n) => ({ ...n, lastProbe: book.configured[n.id] ?? null })),
      candidates: book.candidates,
      rpc: u ? { ...u, activeEndpoint: redactHost(u.activeEndpoint)?.host ?? null } : null,
      latestBlock: this.host.blocks().at(-1)?.n ?? null,
      howToSwitch:
        "Switching is an .env edit you make yourself (RPC_URL, WS_URL, RPC_FALLBACK_URLS, FLASHBLOCKS_RPC_URL), " +
        "then restart run-24h.ps1 in your own PowerShell window. The dashboard never edits .env.",
    };
  }

  // -------------------------------------------------------------------------
  // Agent stream
  // -------------------------------------------------------------------------

  private stream(req: IncomingMessage, res: ServerResponse, auth: Auth): void {
    if (this.streams.size >= MAX_STREAMS) {
      const oldest = this.streams.keys().next().value as ServerResponse | undefined;
      oldest?.end();
      if (oldest) this.streams.delete(oldest);
    }
    res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    res.write(`retry: 5000\n\nevent: brief\ndata: ${JSON.stringify(this.brief(), bigintReplacer)}\n\n`);
    this.streams.set(res, auth.who === "agent" ? auth.agent.id : null);
    if (!this.unsubscribe) this.unsubscribe = this.host.onEvent((type, data) => this.fan(type, data));
    if (!this.briefTimer) {
      this.briefTimer = setInterval(() => this.fan("brief", this.brief()), 30_000);
      this.briefTimer.unref();
    }
    req.on("close", () => {
      this.streams.delete(res);
      if (this.streams.size === 0) this.stopFan();
    });
  }

  private fan(type: string, data: unknown): void {
    if (this.streams.size === 0) return;
    const chunk = `event: ${type}\ndata: ${JSON.stringify(data, bigintReplacer)}\n\n`;
    for (const r of [...this.streams.keys()]) {
      if (r.writableLength > 512 * 1024) {
        r.destroy();
        this.streams.delete(r);
        continue;
      }
      try {
        r.write(chunk);
      } catch {
        this.streams.delete(r);
      }
    }
  }

  private stopFan(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    if (this.briefTimer) clearInterval(this.briefTimer);
    this.briefTimer = undefined;
  }

  /** A paused or revoked agent loses its open streams at once. */
  private dropStreams(agentId: string): void {
    for (const [r, id] of [...this.streams.entries()])
      if (id === agentId) {
        r.end();
        this.streams.delete(r);
      }
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body, bigintReplacer));
}

/** A small JSON object body (4 KB max). */
function body(req: IncomingMessage, max = 4096): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > max) {
        reject(new HttpError(413, "request too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8").trim();
      if (!text) return resolve({});
      try {
        const v = JSON.parse(text) as unknown;
        if (!v || typeof v !== "object" || Array.isArray(v)) return reject(new HttpError(400, "body must be a JSON object"));
        resolve(v as Record<string, unknown>);
      } catch {
        reject(new HttpError(400, "body must be JSON"));
      }
    });
    req.on("error", reject);
  });
}
