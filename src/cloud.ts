/**
 * Online copy of the dashboard: pushes what the local dashboard shows to the
 * Cloudflare Worker in cloud/ (CLOUD_URL), so you can open it from your phone.
 *
 * What leaves this PC: the same data the dashboard page shows (opportunities,
 * outcomes, rival trades, settings that aren't secret, public addresses).
 * Never PRIVATE_KEY, never RPC URLs (they're redacted before they reach the
 * dashboard state), never .env.
 *
 * Every CLOUD_PUSH_MS (default 4 s) one gzip'd POST to CLOUD_URL/ingest carries
 * the new live events (blocks, opportunities, outcomes...), plus the dashboard
 * state every 15 s, the summaries every minute (15 s while new opportunities
 * come in), and the slow-changing parts
 * (recent lists, contracts, AI review) every few minutes. Pushes are
 * outbound only: the Worker can't connect to this PC.
 *
 * The Worker's only command is "stop": when you press "Stop sending" online,
 * the next push's reply asks for it and this writes the STOP file, exactly
 * like the local button. There is no remote resume.
 */
import { gzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { bigintReplacer, log } from "./log.js";
import type { UiServer } from "./ui/server.js";

export interface CloudOptions {
  url: string;
  token: string;
  /** Cloudflare Access service token, so Access lets the bot's pushes through. */
  accessClientId?: string | undefined;
  accessClientSecret?: string | undefined;
  intervalMs?: number;
  fetchImpl?: typeof fetch;
}

type Event = { type: string; data: unknown };

const MAX_QUEUED = 3000;

export class CloudPublisher {
  readonly runId = new Date().toISOString();
  private events: Event[] = [];
  private timer: NodeJS.Timeout | undefined;
  private busy = false;
  private resync = true;
  private last = { state: 0, summary: 0, recent: 0, contracts: 0, review: 0 };
  private reviewHash = "";
  /** New opportunities or outcomes since the summaries were last sent: send them sooner. */
  private summaryDirty = false;
  private nextAt = 0;
  private lastWarnAt = 0;
  private ackStopId: string | null = null;
  private handledStops = new Set<string>();
  private unsubscribe: () => void;
  readonly stats = { pushes: 0, failures: 0, lastOkAt: 0, lastError: null as string | null, bytes: 0 };

  constructor(
    private ui: UiServer,
    readonly opts: CloudOptions,
  ) {
    this.unsubscribe = ui.onEvent((type, data) => {
      this.events.push({ type, data });
      if (type === "opp" || type === "outcome" || type === "liq" || type === "liq-outcome") this.summaryDirty = true;
      if (this.events.length > MAX_QUEUED) {
        // Long outage: keep the newest events; the page resyncs from the full snapshots anyway.
        this.events.splice(0, this.events.length - MAX_QUEUED);
        this.resync = true;
      }
    });
  }

  get ingestUrl(): string {
    return this.opts.url.replace(/\/+$/, "") + "/ingest";
  }

  start(): void {
    this.timer = setInterval(() => void this.tick(), this.opts.intervalMs ?? 4000);
    this.timer.unref();
    void this.tick();
  }

  /** Stop pushing; send a last state so the online page shows the bot stopped (best effort, ~3 s). */
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.unsubscribe();
    const st: Record<string, unknown> = { ...this.ui.state(), running: false };
    delete st.blocks;
    await this.post({ v: 1, runId: this.runId, sentAt: new Date().toISOString(), state: st, events: this.events.splice(0) }, 3000).catch(() => undefined);
  }

  /** For the local dashboard's System panel. */
  status(): { url: string; lastOkAt: number; pushes: number; failures: number; lastError: string | null } {
    return { url: this.opts.url, lastOkAt: this.stats.lastOkAt, pushes: this.stats.pushes, failures: this.stats.failures, lastError: this.stats.lastError };
  }

  async tick(): Promise<void> {
    if (this.busy || Date.now() < this.nextAt) return;
    this.busy = true;
    try {
      await this.push();
    } finally {
      this.busy = false;
    }
  }

  private async push(): Promise<void> {
    const now = Date.now();
    const full = this.resync;
    const payload: Record<string, unknown> = { v: 1, runId: this.runId, sentAt: new Date(now).toISOString(), events: this.events.splice(0) };
    const sent: Array<keyof CloudPublisher["last"]> = [];
    if (full || now - this.last.state > 15_000) {
      const st = { ...(this.ui.state() as Record<string, unknown>) };
      if (full) payload.blocks = st.blocks;
      delete st.blocks;
      payload.state = st;
      sent.push("state");
    }
    if (full || now - this.last.summary > (this.summaryDirty ? 15_000 : 60_000)) {
      this.summaryDirty = false;
      payload.summary = await this.ui.summary().catch(() => undefined);
      sent.push("summary");
    }
    if (full || now - this.last.recent > 300_000) {
      payload.recent = this.ui.recent();
      sent.push("recent");
    }
    if (full || now - this.last.contracts > 1_800_000) {
      payload.contracts = this.ui.contracts();
      sent.push("contracts");
    }
    if (full || now - this.last.review > 600_000) {
      const review = this.ui.review();
      const h = createHash("sha1").update(JSON.stringify(review)).digest("hex");
      if (full || h !== this.reviewHash) payload.review = review;
      this.reviewHash = h;
      sent.push("review");
    }
    const ackId = this.ackStopId;
    if (ackId) payload.ack = { stopId: ackId };

    let reply: { ok?: boolean; resync?: boolean; commands?: Array<{ id: string; type: string; by?: string }> };
    try {
      reply = await this.post(payload, 10_000);
    } catch (err) {
      this.fail((err as Error).message, payload.events as Event[]);
      return;
    }
    for (const k of sent) this.last[k] = now;
    this.resync = !!reply.resync;
    if (ackId && this.ackStopId === ackId) this.ackStopId = null;
    this.stats.pushes++;
    this.stats.lastOkAt = Date.now();
    this.stats.lastError = null;
    if (this.stats.failures) log.info(`online dashboard: pushes work again (${this.ingestUrl})`);
    this.stats.failures = 0;
    for (const c of reply.commands ?? []) if (c.type === "stop") this.handleStop(c);
  }

  private async post(payload: Record<string, unknown>, timeoutMs: number): Promise<{ ok?: boolean; resync?: boolean; commands?: Array<{ id: string; type: string; by?: string }> }> {
    const body = gzipSync(Buffer.from(JSON.stringify(payload, bigintReplacer)));
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-body-encoding": "gzip",
      authorization: `Bearer ${this.opts.token}`,
    };
    if (this.opts.accessClientId && this.opts.accessClientSecret) {
      headers["CF-Access-Client-Id"] = this.opts.accessClientId;
      headers["CF-Access-Client-Secret"] = this.opts.accessClientSecret;
    }
    const f = this.opts.fetchImpl ?? fetch;
    const res = await f(this.ingestUrl, { method: "POST", headers, body, redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
    this.stats.bytes += body.length;
    if (res.status >= 300 && res.status < 400) {
      throw new Error("Cloudflare Access sent the bot to its login page: add an Access service token (CLOUD_ACCESS_CLIENT_ID / CLOUD_ACCESS_CLIENT_SECRET) and a Service Auth policy; see cloud/README.md");
    }
    if (res.status === 401) throw new Error("the Worker refused CLOUD_TOKEN: it must equal the Worker's INGEST_TOKEN secret");
    if (res.status === 403) throw new Error("Cloudflare Access refused the bot: check the service token and the Service Auth policy (cloud/README.md)");
    if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text().catch(() => "")).slice(0, 120)}`);
    const type = res.headers.get("content-type") ?? "";
    if (!type.includes("application/json")) throw new Error("the reply wasn't from the dashboard Worker (is CLOUD_URL right?)");
    return (await res.json()) as { ok?: boolean; resync?: boolean; commands?: Array<{ id: string; type: string; by?: string }> };
  }

  private fail(reason: string, events: Event[]): void {
    // Keep the events for the next attempt (bounded), and re-send full snapshots once it works.
    this.events.unshift(...events);
    if (this.events.length > MAX_QUEUED) this.events.splice(0, this.events.length - MAX_QUEUED);
    this.resync = true;
    this.stats.failures++;
    this.stats.lastError = reason.slice(0, 300);
    const backoff = Math.min(60_000, 4_000 * 2 ** Math.min(this.stats.failures - 1, 4));
    this.nextAt = Date.now() + backoff;
    if (Date.now() - this.lastWarnAt > 300_000) {
      this.lastWarnAt = Date.now();
      log.warn(`online dashboard: push failed (${reason.slice(0, 200)}); retrying in ${Math.round(backoff / 1000)} s. The bot itself is unaffected.`);
    }
  }

  private handleStop(c: { id: string; by?: string }): void {
    this.ackStopId = c.id;
    if (this.handledStops.has(c.id)) return;
    this.handledStops.add(c.id);
    this.ui.writeStop(`stopped from the online dashboard${c.by ? ` by ${String(c.by).slice(0, 80)}` : ""}`);
  }
}
