/**
 * Node manager: which RPC endpoints the bot uses, how fast they answer, and
 * candidate nodes the owner is comparing before switching.
 *
 * Secrets: RPC URLs often carry an API key in the path, query or a random
 * subdomain. Nothing here returns, stores or logs a full URL. The API shows a
 * redacted host only; candidate URLs are typed by the owner, probed once and
 * forgotten (data/nodes.json keeps the label, host and timings). Switching
 * nodes stays an .env edit the owner makes: the page only composes the line.
 *
 * Probing is owner-only (an agent could otherwise make this process fetch
 * arbitrary URLs) and limited to http(s) and ws(s) with short timeouts.
 */
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type NodeRole = "primary" | "ws" | "fallback" | "flashblocks";

export interface NodeView {
  id: string;
  role: NodeRole;
  host: string;
  protocol: string;
}

export interface ProbeResult {
  host: string;
  protocol: string;
  ok: boolean;
  chainId: number | null;
  /** True when the node answers for Base (8453). */
  chainOk: boolean;
  block: number | null;
  /** Blocks behind (+) or ahead (-) of the bot's latest block, when known. */
  lagBlocks: number | null;
  samplesMs: number[];
  p50Ms: number | null;
  minMs: number | null;
  error: string | null;
  at: string;
}

export interface Candidate {
  id: string;
  label: string;
  host: string;
  protocol: string;
  addedAt: string;
  lastProbe: ProbeResult | null;
}

/**
 * Host only, with any label that looks like a key (long or random) masked:
 * "abc-def-ghi123.base-mainnet.quiknode.pro" -> "•••.base-mainnet.quiknode.pro".
 * Never the path, query, user or password.
 */
export function redactHost(url: string): { host: string; protocol: string } | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const labels = u.hostname.split(".");
  const masked = labels.map((l, i) => {
    if (i >= labels.length - 2) return l;
    if (l.length >= 16 || /[0-9a-f]{10,}/i.test(l) || (/\d/.test(l) && /[a-z]/i.test(l) && l.length >= 10)) return "•••";
    return l;
  });
  return { host: masked.join(".") + (u.port ? `:${u.port}` : ""), protocol: u.protocol.replace(/:$/, "") };
}

export function configuredNodes(s: { rpcUrl: string; wsUrl?: string | undefined; rpcFallbackUrls: string[]; flashblocksRpcUrl: string }): Array<NodeView & { url: string }> {
  const out: Array<NodeView & { url: string }> = [];
  const push = (id: string, role: NodeRole, url: string | undefined) => {
    if (!url) return;
    const r = redactHost(url);
    if (r) out.push({ id, role, url, ...r });
  };
  push("primary", "primary", s.rpcUrl);
  push("ws", "ws", s.wsUrl);
  s.rpcFallbackUrls.forEach((u, i) => push(`fallback-${i + 1}`, "fallback", u));
  push("flashblocks", "flashblocks", s.flashblocksRpcUrl);
  return out;
}

/** The public view: the `url` field is dropped. */
export function publicNodes(list: Array<NodeView & { url: string }>): NodeView[] {
  return list.map(({ url: _url, ...v }) => v);
}

function scrub(msg: string, url: string, host: string): string {
  let m = msg.split(url).join(host);
  try {
    const u = new URL(url);
    if (u.pathname.length > 1) m = m.split(u.pathname).join("/…");
    if (u.search) m = m.split(u.search).join("?…");
    m = m.split(u.hostname).join(host.replace(/:\d+$/, ""));
  } catch {
    /* already checked */
  }
  return m.slice(0, 160);
}

const median = (v: number[]): number | null => {
  if (!v.length) return null;
  const s = [...v].sort((a, b) => a - b);
  return s[Math.floor((s.length - 1) / 2)]!;
};

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

/**
 * eth_chainId once, then `samples` timed eth_blockNumber calls. Over
 * WebSocket when the URL is ws(s) and this Node has a WebSocket client.
 */
export async function probe(url: string, opts: { samples?: number; timeoutMs?: number; ourBlock?: number | null; fetchImpl?: FetchLike } = {}): Promise<ProbeResult> {
  const r = redactHost(url);
  const at = new Date().toISOString();
  const fail = (error: string): ProbeResult => ({
    host: r?.host ?? "?",
    protocol: r?.protocol ?? "?",
    ok: false,
    chainId: null,
    chainOk: false,
    block: null,
    lagBlocks: null,
    samplesMs: [],
    p50Ms: null,
    minMs: null,
    error,
    at,
  });
  if (!r) return fail("not a URL");
  if (!["http", "https", "ws", "wss"].includes(r.protocol)) return fail("only http(s) and ws(s) node URLs");
  const samples = Math.min(10, Math.max(1, opts.samples ?? 3));
  const timeoutMs = Math.min(10_000, Math.max(500, opts.timeoutMs ?? 4000));
  try {
    const call = r.protocol.startsWith("ws") ? await wsCaller(url, timeoutMs) : httpCaller(url, timeoutMs, opts.fetchImpl);
    try {
      const chainHex = await call("eth_chainId");
      const chainId = typeof chainHex === "string" ? Number.parseInt(chainHex, 16) : null;
      const times: number[] = [];
      let block: number | null = null;
      for (let i = 0; i < samples; i++) {
        const t0 = performance.now();
        const b = await call("eth_blockNumber");
        times.push(Math.round(performance.now() - t0));
        if (typeof b === "string") block = Number.parseInt(b, 16);
      }
      const lag = block !== null && typeof opts.ourBlock === "number" ? opts.ourBlock - block : null;
      return { host: r.host, protocol: r.protocol, ok: true, chainId, chainOk: chainId === 8453, block, lagBlocks: lag, samplesMs: times, p50Ms: median(times), minMs: times.length ? Math.min(...times) : null, error: null, at };
    } finally {
      call.close?.();
    }
  } catch (e) {
    return fail(scrub((e as Error).message || "probe failed", url, r.host));
  }
}

type Caller = ((method: string) => Promise<unknown>) & { close?: () => void };

function httpCaller(url: string, timeoutMs: number, fetchImpl?: FetchLike): Caller {
  const f: FetchLike = fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  let id = 0;
  return async (method: string) => {
    const res = await f(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params: [] }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = (await res.text()).slice(0, 64 * 1024);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = JSON.parse(text) as { result?: unknown; error?: { message?: string } };
    if (body.error) throw new Error(`RPC error: ${String(body.error.message ?? "unknown").slice(0, 100)}`);
    return body.result;
  };
}

async function wsCaller(url: string, timeoutMs: number): Promise<Caller> {
  const WS = (globalThis as { WebSocket?: new (u: string) => WebSocketLike }).WebSocket;
  if (!WS) throw new Error("WebSocket probes need Node 22 or newer");
  const ws = new WS(url);
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("WebSocket connect timed out")), timeoutMs);
    ws.onopen = () => {
      clearTimeout(t);
      resolve();
    };
    ws.onerror = () => {
      clearTimeout(t);
      reject(new Error("WebSocket connect failed"));
    };
  });
  ws.onmessage = (ev: { data: unknown }) => {
    try {
      const msg = JSON.parse(String(ev.data)) as { id?: number; result?: unknown; error?: { message?: string } };
      const p = msg.id !== undefined ? pending.get(msg.id) : undefined;
      if (!p) return;
      pending.delete(msg.id!);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(`RPC error: ${String(msg.error.message ?? "unknown").slice(0, 100)}`));
      else p.resolve(msg.result);
    } catch {
      /* not ours */
    }
  };
  let id = 0;
  const call: Caller = (method: string) =>
    new Promise((resolve, reject) => {
      const n = ++id;
      const timer = setTimeout(() => {
        pending.delete(n);
        reject(new Error("timed out"));
      }, timeoutMs);
      pending.set(n, { resolve, reject, timer });
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: n, method, params: [] }));
    });
  call.close = () => {
    for (const p of pending.values()) clearTimeout(p.timer);
    try {
      ws.close();
    } catch {
      /* closed */
    }
  };
  return call;
}

interface WebSocketLike {
  onopen: (() => void) | null;
  onerror: (() => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  send(data: string): void;
  close(): void;
}

/** data/nodes.json: candidates (label + redacted host + last probe) and the last probe of each configured node. */
export class NodeBook {
  private candidates: Candidate[] = [];
  private configured: Record<string, ProbeResult> = {};

  constructor(readonly path: string) {
    if (!existsSync(path)) return;
    try {
      const v = JSON.parse(readFileSync(path, "utf8")) as { candidates?: unknown; configured?: unknown };
      if (Array.isArray(v.candidates))
        this.candidates = v.candidates
          .filter((c): c is Candidate => !!c && typeof c === "object" && typeof (c as Candidate).id === "string" && typeof (c as Candidate).host === "string")
          .slice(0, 12);
      if (v.configured && typeof v.configured === "object") this.configured = v.configured as Record<string, ProbeResult>;
    } catch {
      /* start empty */
    }
  }

  private save(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = this.path + ".tmp";
    writeFileSync(tmp, JSON.stringify({ v: 1, candidates: this.candidates, configured: this.configured }, null, 2) + "\n");
    renameSync(tmp, this.path);
  }

  list(): { candidates: Candidate[]; configured: Record<string, ProbeResult> } {
    return { candidates: this.candidates.map((c) => ({ ...c })), configured: { ...this.configured } };
  }

  recordConfigured(id: string, p: ProbeResult): void {
    this.configured[id] = p;
    this.save();
  }

  /** Keep a probed candidate (label, host and timings: never the URL). */
  addCandidate(label: string, p: ProbeResult): Candidate {
    if (this.candidates.length >= 12) throw new Error("at most 12 candidate nodes");
    const c: Candidate = {
      id: "node-" + randomBytes(4).toString("hex"),
      label: (label || p.host).replace(/[^\w .:/@()-]/g, "").slice(0, 40) || p.host,
      host: p.host,
      protocol: p.protocol,
      addedAt: new Date().toISOString(),
      lastProbe: p,
    };
    this.candidates.push(c);
    this.save();
    return c;
  }

  updateCandidate(id: string, p: ProbeResult): Candidate {
    const c = this.candidates.find((x) => x.id === id);
    if (!c) throw new Error("no such candidate");
    c.lastProbe = p;
    this.save();
    return { ...c };
  }

  removeCandidate(id: string): boolean {
    const n = this.candidates.length;
    this.candidates = this.candidates.filter((c) => c.id !== id);
    if (this.candidates.length !== n) this.save();
    return this.candidates.length !== n;
  }
}
