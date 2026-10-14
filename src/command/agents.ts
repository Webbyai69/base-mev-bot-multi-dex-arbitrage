/**
 * Scoped API tokens for AI agents (data/agents.json).
 *
 * The page token (one per start, held only by the dashboard tab) is the
 * OWNER: every scope plus owner-only routes (issuing tokens, testing node
 * URLs). Agents get their own long-lived tokens with a subset of:
 *
 *   read    every GET: state, market, health, stream, fleet, telemetry
 *   tune    POST /api/tuning (learned suggestions, within their bounds)
 *   pause   POST /api/stop, POST /api/sending {paused:true}
 *   deploy  POST /api/fleet/... (detect/paper only, see src/fleet/control.ts)
 *
 * There is no "sign" or "withdraw" scope, and no route that signs: the
 * server never holds a signer. Tokens are stored as SHA-256 hashes and shown
 * once at creation. Each agent is rate-limited so a looping agent can't
 * starve the bot.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type Scope = "read" | "tune" | "pause" | "deploy";
export const SCOPES: readonly Scope[] = ["read", "tune", "pause", "deploy"];

export interface AgentRec {
  id: string;
  name: string;
  source: string;
  scopes: Scope[];
  tokenHash: string;
  createdAt: string;
  paused: boolean;
  lastSeenAt: string | null;
  lastAction: string | null;
  requests: number;
}

export type AgentView = Omit<AgentRec, "tokenHash">;

export type Auth = { who: "owner" } | { who: "agent"; agent: AgentRec };

const PER_MINUTE = 120;
const MAX_AGENTS = 24;

const sha = (s: string): string => createHash("sha256").update(s).digest("hex");

export class AgentRegistry {
  private agents: AgentRec[] = [];
  private buckets = new Map<string, { tokens: number; at: number }>();
  private dirty = false;

  constructor(readonly path: string) {
    this.load();
  }

  private load(): void {
    if (!existsSync(this.path)) return;
    try {
      const v = JSON.parse(readFileSync(this.path, "utf8")) as { agents?: unknown };
      if (!Array.isArray(v.agents)) return;
      this.agents = v.agents
        .filter((a): a is Record<string, unknown> => !!a && typeof a === "object")
        .map((a) => ({
          id: String(a.id ?? ""),
          name: String(a.name ?? "agent").slice(0, 40),
          source: String(a.source ?? "").slice(0, 80),
          scopes: (Array.isArray(a.scopes) ? a.scopes : []).filter((s): s is Scope => SCOPES.includes(s as Scope)),
          tokenHash: String(a.tokenHash ?? ""),
          createdAt: String(a.createdAt ?? new Date(0).toISOString()),
          paused: a.paused === true,
          lastSeenAt: typeof a.lastSeenAt === "string" ? a.lastSeenAt : null,
          lastAction: typeof a.lastAction === "string" ? a.lastAction.slice(0, 120) : null,
          requests: Number(a.requests) || 0,
        }))
        .filter((a) => /^agt-[a-z0-9]{6,}$/.test(a.id) && /^[0-9a-f]{64}$/.test(a.tokenHash));
    } catch {
      this.agents = [];
    }
  }

  /** Persist (atomic). Called on changes and, for activity counters, at most every few seconds by the caller. */
  save(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = this.path + ".tmp";
    writeFileSync(tmp, JSON.stringify({ v: 1, agents: this.agents }, null, 2) + "\n");
    renameSync(tmp, this.path);
    this.dirty = false;
  }

  flushIfDirty(): void {
    if (this.dirty) this.save();
  }

  /** Issue a token. The plaintext is returned once and never stored. */
  create(name: string, source: string, scopes: unknown): { agent: AgentView; token: string } {
    if (this.agents.length >= MAX_AGENTS) throw new Error(`at most ${MAX_AGENTS} agents`);
    const list = (Array.isArray(scopes) ? scopes : ["read"]).map(String);
    const bad = list.filter((s) => !SCOPES.includes(s as Scope));
    if (bad.length) throw new Error(`unknown scope: ${bad.join(", ")} (agents can have ${SCOPES.join(", ")}; nothing can sign)`);
    const clean = [...new Set(list as Scope[])];
    if (!clean.includes("read")) clean.unshift("read");
    const token = "agt_" + randomBytes(24).toString("base64url");
    const rec: AgentRec = {
      id: "agt-" + randomBytes(5).toString("hex"),
      name: (name || "agent").replace(/[^\w .-]/g, "").slice(0, 40) || "agent",
      source: (source || "").replace(/[^\w .:/@-]/g, "").slice(0, 80),
      scopes: clean,
      tokenHash: sha(token),
      createdAt: new Date().toISOString(),
      paused: false,
      lastSeenAt: null,
      lastAction: null,
      requests: 0,
    };
    this.agents.push(rec);
    this.save();
    return { agent: view(rec), token };
  }

  /** The agent a token belongs to, or undefined. Constant-time over the hash. */
  verify(token: string | null | undefined): AgentRec | undefined {
    if (!token || !token.startsWith("agt_") || token.length > 100) return undefined;
    const h = Buffer.from(sha(token));
    for (const a of this.agents) {
      const b = Buffer.from(a.tokenHash);
      if (b.length === h.length && timingSafeEqual(b, h)) return a;
    }
    return undefined;
  }

  /** Token-bucket rate limit: true when this request may proceed. */
  allow(a: AgentRec, now = Date.now()): boolean {
    const b = this.buckets.get(a.id) ?? { tokens: PER_MINUTE, at: now };
    b.tokens = Math.min(PER_MINUTE, b.tokens + ((now - b.at) / 60_000) * PER_MINUTE);
    b.at = now;
    if (b.tokens < 1) {
      this.buckets.set(a.id, b);
      return false;
    }
    b.tokens -= 1;
    this.buckets.set(a.id, b);
    return true;
  }

  touch(a: AgentRec, action: string): void {
    a.lastSeenAt = new Date().toISOString();
    a.lastAction = action.slice(0, 120);
    a.requests++;
    this.dirty = true;
  }

  setPaused(id: string, paused: boolean): AgentView {
    const a = this.agents.find((x) => x.id === id);
    if (!a) throw new Error("no such agent");
    a.paused = paused;
    this.save();
    return view(a);
  }

  revoke(id: string): boolean {
    const n = this.agents.length;
    this.agents = this.agents.filter((x) => x.id !== id);
    this.buckets.delete(id);
    if (this.agents.length !== n) this.save();
    return this.agents.length !== n;
  }

  list(): AgentView[] {
    return this.agents.map(view);
  }
}

function view(a: AgentRec): AgentView {
  const { tokenHash: _omit, ...rest } = a;
  return { ...rest, scopes: [...a.scopes] };
}

/** The scope a request needs, or "owner" for owner-only routes. */
export function requiredScope(method: string, path: string): Scope | "owner" {
  if (path.startsWith("/api/agents") && method !== "GET") return "owner";
  if (path === "/api/agents") return "owner";
  if (path.startsWith("/api/nodes/")) return "owner";
  if (method === "GET") return "read";
  if (path === "/api/tuning") return "tune";
  if (path === "/api/stop" || path === "/api/sending") return "pause";
  if (path.startsWith("/api/fleet")) return "deploy";
  if (path === "/api/simulate") return "read";
  if (path.startsWith("/api/issues/")) return "read";
  return "owner";
}

export function permits(auth: Auth, need: Scope | "owner"): boolean {
  if (auth.who === "owner") return true;
  if (need === "owner") return false;
  return !auth.agent.paused && auth.agent.scopes.includes(need);
}
