/**
 * Telegram alerts: your phone buzzes when something worth knowing happens.
 *
 * Setup (about two minutes):
 *   1. In Telegram, message @BotFather, send /newbot and pick a name. It replies
 *      with a token like 123456789:AAE…  ->  TELEGRAM_BOT_TOKEN in .env
 *   2. Send any message to your new bot, then run   node dist/main.js telegram
 *      It prints your chat id  ->  TELEGRAM_CHAT_ID in .env
 *   3. Run   node dist/main.js telegram   again: you should get a test message.
 *
 * What sends an alert:
 *   - the bot starting, stopping or crashing
 *   - no new block processed for 3 minutes (RPC down or rate-limited), and the recovery
 *   - the RPC client switching to a backup endpoint
 *   - a verified opportunity worth at least ALERT_MIN_PROFIT_USD (paper or live)
 *   - a liquidatable Aave position worth at least ALERT_MIN_LIQ_PROFIT_USD
 *   - every live transaction result, and the circuit breaker tripping (live mode)
 *   - a summary of the previous day when the UTC day rolls over
 *
 * Each kind of alert has a cooldown and at most ALERT_MAX_PER_HOUR messages go
 * out per hour, so a bug can never flood your phone. Messages are scrubbed of
 * secrets (the bot token, PRIVATE_KEY, API keys in RPC URLs) before sending,
 * because RPC error messages can contain the full URL with its key.
 */
import { log } from "./log.js";
import type { Store } from "./store.js";

export interface AlertOptions {
  token?: string | undefined;
  chatId?: string | undefined;
  mode: "paper" | "live";
  minOppUsd: number;
  minLiqUsd: number;
  maxPerHour?: number;
  /** Exact strings that must never leave this machine (private key, RPC URLs). */
  secrets?: string[];
  /** For tests. */
  apiBase?: string;
  fetchImpl?: typeof fetch;
}

const esc = (s: unknown): string => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const usd = (n: unknown): string => {
  const x = Number(n);
  if (!Number.isFinite(x)) return "?";
  return (x < 0 ? "-$" : "$") + Math.abs(x).toFixed(Math.abs(x) >= 100 ? 0 : 2);
};
const short = (a: unknown): string => {
  const s = String(a ?? "");
  return /^0x[0-9a-fA-F]{40}$/.test(s) ? `${s.slice(0, 6)}…${s.slice(-4)}` : s;
};

/** Same idea as redactUrl() in rpc.ts: keep the host, hide key-bearing paths and query parameters. */
export function scrubUrls(text: string): string {
  return text.replace(/\b(?:https?|wss?):\/\/[^\s"'<>)]+/gi, (url) =>
    url.replace(/\/v2\/.*|\/v3\/.*|\/[0-9a-f]{20,}.*|([?&][a-z_-]*(?:key|token|secret)[a-z_-]*=)[^&]+/gi, (_m: string, keyParam?: string) => (keyParam ? `${keyParam}…` : "/…")),
  );
}

export class Alerts {
  readonly enabled: boolean;
  private sentTimes: number[] = [];
  private lastByKey = new Map<string, number>();
  private queue: Promise<unknown> = Promise.resolve();
  private stalled = false;
  readonly stats = { sent: 0, failed: 0, suppressed: 0 };

  constructor(readonly opts: AlertOptions) {
    this.enabled = !!(opts.token && opts.chatId);
  }

  /** Remove anything secret from a message. */
  scrub(text: string): string {
    let out = scrubUrls(text);
    for (const s of [this.opts.token, ...(this.opts.secrets ?? [])]) {
      if (!s || s.length < 8) continue;
      out = out.split(s).join("…");
      if (s.startsWith("0x")) out = out.split(s.slice(2)).join("…");
    }
    return out;
  }

  /**
   * Queue a message unless its key is cooling down or the hourly cap is hit.
   * Never throws; resolves true when Telegram accepted it.
   */
  send(html: string, key?: string, cooldownMs = 0): Promise<boolean> {
    if (!this.enabled) return Promise.resolve(false);
    const now = Date.now();
    if (key && cooldownMs > 0) {
      const last = this.lastByKey.get(key);
      if (last !== undefined && now - last < cooldownMs) {
        this.stats.suppressed++;
        return Promise.resolve(false);
      }
    }
    this.sentTimes = this.sentTimes.filter((t) => now - t < 3_600_000);
    if (this.sentTimes.length >= (this.opts.maxPerHour ?? 20)) {
      this.stats.suppressed++;
      return Promise.resolve(false);
    }
    if (key) this.lastByKey.set(key, now);
    this.sentTimes.push(now);
    const text = this.scrub(html).slice(0, 4000);
    // One at a time, so messages arrive in order.
    const p = this.queue.then(() => this.post(text));
    this.queue = p.catch(() => undefined);
    return p;
  }

  private async post(text: string): Promise<boolean> {
    const f = this.opts.fetchImpl ?? fetch;
    try {
      const res = await f(`${this.opts.apiBase ?? "https://api.telegram.org"}/bot${this.opts.token}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: this.opts.chatId, text, parse_mode: "HTML", disable_web_page_preview: true }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        log.warn(`telegram alert failed: HTTP ${res.status} ${this.scrub(body).slice(0, 160)}`);
        this.stats.failed++;
        return false;
      }
      this.stats.sent++;
      return true;
    } catch (err) {
      // Never print the request URL: it contains the bot token.
      log.warn(`telegram alert failed: ${this.scrub(String((err as Error).message ?? err)).slice(0, 160)}`);
      this.stats.failed++;
      return false;
    }
  }

  /** Wait for queued messages (used before the process exits), at most `ms`. */
  async flush(ms = 4000): Promise<void> {
    await Promise.race([this.queue, new Promise((r) => setTimeout(r, ms).unref())]);
  }

  // -------------------------------------------------------------------------
  // Messages
  // -------------------------------------------------------------------------

  private get modeTag(): string {
    return this.opts.mode === "live" ? "LIVE" : "paper";
  }

  started(info: { version: string; pools: number; clPools: number; dashboard?: string | undefined }): Promise<boolean> {
    return this.send(
      `🟢 <b>Base arb bot started</b> (${this.modeTag} mode, v${esc(info.version)})\n` +
        `${info.pools} pools watched, ${info.clPools} of them concentrated-liquidity.` +
        (info.dashboard ? `\nDashboard on your PC: ${esc(info.dashboard)}` : ""),
    );
  }

  stopped(reason: string): Promise<boolean> {
    return this.send(`🔴 <b>Bot stopped</b>: ${esc(reason)}`);
  }

  crashed(err: unknown): Promise<boolean> {
    const msg = err instanceof Error ? err.message : String(err);
    return this.send(`💥 <b>Bot crashed</b>: ${esc(msg.slice(0, 600))}\nIt is not running now. Check the console window, then start it again.`);
  }

  /** Call every ~30s with the time the last block was processed. */
  watchdog(lastBlock: number, lastBlockAt: number, stallMs = 180_000): void {
    if (!lastBlockAt) return;
    const silent = Date.now() - lastBlockAt;
    if (silent > stallMs && !this.stalled) {
      this.stalled = true;
      void this.send(
        `⚠️ <b>No new blocks for ${Math.round(silent / 60_000)} minutes</b> (${lastBlock ? `last processed: #${lastBlock}` : "none since the bot started"}). The RPC endpoint may be down or rate-limiting the bot; it keeps retrying.`,
        "stall",
        30 * 60_000,
      );
    }
  }

  blockProcessed(n: number): void {
    if (!this.stalled) return;
    this.stalled = false;
    void this.send(`✅ Blocks are flowing again (#${n}).`, "stall-recovered", 5 * 60_000);
  }

  failover(endpoint: string): Promise<boolean> {
    return this.send(`↪️ RPC switched to a backup endpoint: ${esc(endpoint)}. The main one kept failing; the bot retries it after 5 minutes.`, "failover", 30 * 60_000);
  }

  circuitBreaker(reason: string): Promise<boolean> {
    return this.send(`🛑 <b>Circuit breaker tripped</b>: ${esc(reason)}`);
  }

  daily(d: { day: string; found: number; persisted: number; taken: number; closed: number; realisticNetUsd: number; optimisticNetUsd: number; topRival?: string | undefined; liqFound?: number | undefined }): Promise<boolean> {
    const decided = d.persisted + d.taken + d.closed;
    return this.send(
      `📊 <b>${esc(d.day)} (UTC)</b>, ${this.modeTag}\n` +
        `Found ${d.found} opportunities: ${d.persisted} still there one block later, ${d.taken} taken by other bots, ${d.closed} closed.` +
        (decided ? ` Win rate ${Math.round((d.persisted / decided) * 100)}%.` : "") +
        `\nRealistic profit ${usd(d.realisticNetUsd)} (if every find had landed: ${usd(d.optimisticNetUsd)}).` +
        (d.topRival ? `\nMost active rival: ${esc(short(d.topRival))}` : "") +
        (d.liqFound ? `\nLiquidatable Aave positions seen: ${d.liqFound}` : ""),
      `daily:${d.day}`,
      24 * 3_600_000,
    );
  }

  /** Alerts driven by what the bot records: opportunities, liquidations, live transactions. */
  watch(store: Store): () => void {
    return store.onAppend((file, rec) => {
      const r = rec as Record<string, unknown>;
      if (file === "opportunities.jsonl" && r.kind === "opportunity") this.onOpportunity(r);
      else if (file === "liquidations.jsonl" && r.kind === "liq-opportunity") this.onLiquidation(r);
      else if (file === "live.jsonl" && r.status !== "pending") this.onLive(r);
    });
  }

  private onOpportunity(r: Record<string, unknown>): void {
    const net = Number(r.netUsd);
    const verified = r.sim === "executor-ok" || r.sim === "quoter-ok";
    if (!verified || !(net >= this.opts.minOppUsd)) return;
    const route = r.route as { dexes?: string[]; pools?: string[] } | undefined;
    const via = (route?.dexes ?? [r.buyDex, r.sellDex]).map(esc).join(" › ");
    const key = `opp:${route?.pools?.join(">") ?? `${r.buyPool}-${r.sellPool}`}`;
    // Per-route cooldown, and at most one opportunity alert a minute overall.
    if (!this.cooled("opp-any", 60_000)) return;
    void this.send(
      `💰 <b>${usd(net)} opportunity</b> (${this.modeTag})\n${esc(r.pairSymbols)} via ${via}\n` +
        `Gross ${usd(r.profitUsd)}, gas ${usd(r.gasUsd)}; checked on-chain (${esc(r.sim)}) at block #${esc(r.block)}` +
        (r.stage === "flashblock" ? " from a Flashblock" : "") +
        `.\nWhether it would have landed shows up in the dashboard a block later.`,
      key,
      10 * 60_000,
    );
  }

  private onLiquidation(r: Record<string, unknown>): void {
    const est = Number(r.estProfitUsd);
    if (!(est >= this.opts.minLiqUsd)) return;
    void this.send(
      `🏦 <b>Liquidatable Aave position</b> (${this.modeTag})\n` +
        `Repay ${usd(r.repayUsd)} of ${esc(r.debtSymbol)}, seize ${esc(r.collateralSymbol)} at +${Number(r.bonusPct).toFixed(1)}%. ` +
        `Health factor ${Number(r.healthFactor).toFixed(3)}, estimated profit ${usd(est)}.`,
      `liq:${String(r.user)}`,
      30 * 60_000,
    );
  }

  private onLive(r: Record<string, unknown>): void {
    const ok = r.status === "success";
    void this.send(
      `${ok ? "✅" : "❌"} <b>Live transaction ${esc(r.status)}</b>\n${esc(r.txHash)}\nExpected net ${usd(r.expectedProfitUsd)}` + (r.minedBlock ? ` · block #${esc(r.minedBlock)}` : ""),
      `live:${String(r.txHash)}:${String(r.status)}`,
      60 * 60_000,
    );
  }

  private cooled(key: string, ms: number): boolean {
    const last = this.lastByKey.get(key);
    if (last !== undefined && Date.now() - last < ms) return false;
    this.lastByKey.set(key, Date.now());
    return true;
  }
}

// ---------------------------------------------------------------------------
// `node dist/main.js telegram`: find your chat id, then send a test message.
// ---------------------------------------------------------------------------

export async function telegramSetup(token: string | undefined, chatId: string | undefined, fetchImpl: typeof fetch = fetch): Promise<number> {
  if (!token) {
    console.log(
      [
        "TELEGRAM_BOT_TOKEN is not set.",
        "1. In Telegram, message @BotFather and send /newbot. Pick any name.",
        "2. Put the token it gives you in .env:   TELEGRAM_BOT_TOKEN=123456789:AA…",
        "3. Send any message to your new bot, then run this command again.",
      ].join("\n"),
    );
    return 1;
  }
  if (!/^\d+:[A-Za-z0-9_-]{30,}$/.test(token)) {
    console.log("TELEGRAM_BOT_TOKEN doesn't look like a BotFather token (digits, a colon, then ~35 letters). Copy it again from @BotFather.");
    return 1;
  }
  const api = `https://api.telegram.org/bot${token}`;
  if (!chatId) {
    let data: { ok: boolean; result?: Array<{ message?: { chat?: { id: number; type: string; username?: string; first_name?: string; title?: string } } }>; description?: string };
    try {
      const res = await fetchImpl(`${api}/getUpdates`, { signal: AbortSignal.timeout(10_000) });
      data = (await res.json()) as typeof data;
    } catch (err) {
      console.log(`Could not reach Telegram: ${String((err as Error).message).split(token).join("…")}`);
      return 1;
    }
    if (!data.ok) {
      console.log(`Telegram said: ${data.description ?? "error"}. Check TELEGRAM_BOT_TOKEN.`);
      return 1;
    }
    const chats = new Map<number, string>();
    for (const u of data.result ?? []) {
      const c = u.message?.chat;
      if (c) chats.set(c.id, c.title ?? (c.username ? `@${c.username}` : c.first_name ?? c.type));
    }
    if (chats.size === 0) {
      console.log("No messages yet. Open your bot in Telegram, send it any message (for example: hi), then run this command again.");
      return 1;
    }
    console.log("Found these chats. Add the one that's you to .env, then run this command again for a test message:\n");
    for (const [id, name] of chats) console.log(`  TELEGRAM_CHAT_ID=${id}    (${name})`);
    return 0;
  }
  const alerts = new Alerts({ token, chatId, mode: "paper", minOppUsd: 0, minLiqUsd: 0, fetchImpl });
  const ok = await alerts.send("👋 Test message from your Base arb bot. Alerts are working.");
  console.log(ok ? "Sent. Check Telegram." : "Telegram refused the message: check TELEGRAM_CHAT_ID (and that you've messaged the bot at least once).");
  return ok ? 0 : 1;
}
