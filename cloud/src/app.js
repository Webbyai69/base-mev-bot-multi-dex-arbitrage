/**
 * Online copy of the bot's dashboard: a Cloudflare Worker plus one Durable
 * Object (BotMirror) that holds the latest data.
 *
 *   your PC (the bot) ── POST /ingest every few seconds ──► this Worker ──► BotMirror
 *   your phone / laptop ── GET / and /api/* (Cloudflare Access login) ──┘
 *
 * The bot keeps running on your PC with your keys. This Worker never connects
 * to your PC, never sees a private key or an RPC URL, and can't change the
 * bot's settings. Its one control is "stop sending": the request waits here
 * until the bot picks it up on its next push, and there is no remote resume.
 *
 * Viewers: every request except /ingest must carry a valid Cloudflare Access
 * token (Cf-Access-Jwt-Assertion), checked against your team's signing keys.
 * Until ACCESS_TEAM_DOMAIN is set the Worker shows a setup page instead of
 * data, so a missing login can never expose your bot. PUBLIC_DASHBOARD="true"
 * turns the check off (for local testing only).
 *
 * The bot: /ingest needs `Authorization: Bearer <INGEST_TOKEN>` (a Worker
 * secret). With Access turned on, the bot also sends an Access service token
 * so Access lets it through.
 *
 * Plain JavaScript with no dependencies, so it also runs under Node for tests.
 */

const WETH = "0x4200000000000000000000000000000000000006";
const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const SEL = { balanceOf: "0x70a08231", owner: "0x8da5cb5b", operator: "0x570ca735" };
const MAX_INGEST_BYTES = 2_000_000;
const MAX_INGEST_JSON = 8_000_000;
const TAPE = 90;
const EVENT_RING = 600;
const isAddress = (a) => typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a);
const word = (a) => a.toLowerCase().replace(/^0x/, "").padStart(64, "0");

const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
};

function json(status, body, extra = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...SECURITY_HEADERS, ...extra } });
}
function text(status, body) {
  return new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", ...SECURITY_HEADERS } });
}

/** Constant-time comparison (no early exit on the first differing byte). */
export function sameSecret(a, b) {
  const x = new TextEncoder().encode(String(a ?? ""));
  const y = new TextEncoder().encode(String(b ?? ""));
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

function b64urlBytes(s) {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
const b64urlJson = (s) => JSON.parse(new TextDecoder().decode(b64urlBytes(s)));

function teamHost(v) {
  const t = String(v ?? "").trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  return /^[a-z0-9-]+\.cloudflareaccess\.com$/i.test(t) ? t.toLowerCase() : "";
}

// Access signing keys, cached per isolate for an hour (refetched when a token names an unknown key).
const certCache = { team: "", at: 0, keys: [] };
async function accessKeys(team, fetchImpl, force) {
  if (!force && certCache.team === team && Date.now() - certCache.at < 3_600_000) return certCache.keys;
  const res = await fetchImpl(`https://${team}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error(`Access certs: HTTP ${res.status}`);
  const body = await res.json();
  certCache.team = team;
  certCache.at = Date.now();
  certCache.keys = Array.isArray(body.keys) ? body.keys : [];
  return certCache.keys;
}

/**
 * Who is asking? Validates the Cloudflare Access JWT: RS256 signature against
 * the team's published keys, issuer, expiry, and the application audience
 * when ACCESS_AUD is set.
 */
export async function checkViewer(request, env, fetchImpl = fetch) {
  if (env.PUBLIC_DASHBOARD === "true") return { ok: true, who: "public" };
  const team = teamHost(env.ACCESS_TEAM_DOMAIN);
  if (!team) return { ok: false, setup: true };
  const token = request.headers.get("cf-access-jwt-assertion");
  if (!token) return { ok: false, reason: "no Cloudflare Access token" };
  try {
    const [h, p, sig] = token.split(".");
    if (!h || !p || !sig) return { ok: false, reason: "malformed token" };
    const header = b64urlJson(h);
    const claims = b64urlJson(p);
    if (header.alg !== "RS256") return { ok: false, reason: "unexpected algorithm" };
    let jwk = (await accessKeys(team, fetchImpl, false)).find((k) => k.kid === header.kid);
    if (!jwk) jwk = (await accessKeys(team, fetchImpl, true)).find((k) => k.kid === header.kid);
    if (!jwk) return { ok: false, reason: "unknown signing key" };
    const key = await crypto.subtle.importKey("jwk", { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true }, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64urlBytes(sig), new TextEncoder().encode(`${h}.${p}`));
    if (!valid) return { ok: false, reason: "bad signature" };
    const now = Date.now() / 1000;
    if (typeof claims.exp !== "number" || claims.exp < now - 30) return { ok: false, reason: "expired" };
    if (typeof claims.nbf === "number" && claims.nbf > now + 30) return { ok: false, reason: "not yet valid" };
    if (claims.iss !== `https://${team}`) return { ok: false, reason: "wrong issuer" };
    if (env.ACCESS_AUD) {
      const auds = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
      if (!auds.includes(env.ACCESS_AUD)) return { ok: false, reason: "wrong audience" };
    }
    return { ok: true, who: claims.email || claims.common_name || "service" };
  } catch {
    return { ok: false, reason: "invalid token" };
  }
}

async function gunzip(buf) {
  const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream).arrayBuffer();
}

function nonce() {
  const b = crypto.getRandomValues(new Uint8Array(16));
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s);
}

/** The dashboard page (ui/dashboard.html), wrapped the same way the bot's local server wraps it. */
function page(html) {
  const n = nonce();
  const body = html.replace(/<script(?=[\s>])/g, `<script nonce="${n}"`);
  const doc =
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">` +
    `<script nonce="${n}">window.__BOT__={"mode":"cloud"};</script></head><body>${body}</body></html>`;
  return new Response(doc, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": `script-src 'nonce-${n}'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
      ...SECURITY_HEADERS,
    },
  });
}

function setupPage(origin) {
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Finish setup</title><style>
:root{--bg:#f3f5f9;--fg:#0b1530;--muted:#4b556e;--card:#fff;--line:#dde2ec;color-scheme:light}
@media (prefers-color-scheme:dark){:root{--bg:#0a0f1c;--fg:#e6ebf5;--muted:#aeb7cb;--card:#111829;--line:#1e2740;color-scheme:dark}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif;padding:40px 16px}
main{max-width:640px;margin:0 auto;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:24px 28px}
h1{font-size:20px;margin:0 0 8px}p,li{color:var(--muted)}code{font-size:13px}ol{padding-left:20px}li{margin:6px 0}
</style></head><body><main>
<h1>One more step: lock the dashboard</h1>
<p>This dashboard shows your bot's trades, so it stays locked until Cloudflare Access is on and this Worker knows your Access team.</p>
<ol>
<li>In the Cloudflare dashboard: <b>Workers &amp; Pages</b> › this Worker › <b>Settings</b> › <b>Domains &amp; Routes</b> › <code>workers.dev</code> › <b>Enable Cloudflare Access</b>. Add your own email to the policy.</li>
<li>In <b>Zero Trust</b> › <b>Settings</b>, copy your team domain (it ends in <code>.cloudflareaccess.com</code>).</li>
<li>In <b>Zero Trust</b> › <b>Access</b> › <b>Applications</b>, open this Worker's application and copy its <b>Application Audience (AUD) Tag</b>.</li>
<li>Back in this Worker: <b>Settings</b> › <b>Variables and Secrets</b>: add <code>ACCESS_TEAM_DOMAIN</code> and <code>ACCESS_AUD</code> with those values, then reload <code>${esc(origin)}</code>.</li>
</ol>
<p>The full steps, including the bot's side, are in <code>cloud/README.md</code> in the repository.</p>
</main></body></html>`;
  return new Response(html, { status: 503, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", ...SECURITY_HEADERS } });
}

function mirrorStub(env) {
  return env.MIRROR.get(env.MIRROR.idFromName("bot"));
}

/** The Worker. `html` is ui/dashboard.html (imported as text by src/worker.js). */
export function createApp({ html, fetchImpl }) {
  return {
    async fetch(request, env) {
      const f = fetchImpl ?? fetch;
      const url = new URL(request.url);
      const path = url.pathname;
      const method = request.method;

      // The bot's pushes. Bearer token, size limits, optional gzip.
      if (path === "/ingest") {
        if (method !== "POST") return text(405, "POST only");
        if (!env.INGEST_TOKEN || String(env.INGEST_TOKEN).length < 24) return json(503, { error: "Set the INGEST_TOKEN secret on this Worker (at least 24 characters)." });
        const auth = request.headers.get("authorization") || "";
        if (!auth.startsWith("Bearer ") || !sameSecret(auth.slice(7), env.INGEST_TOKEN)) return json(401, { error: "wrong or missing CLOUD_TOKEN" });
        let body = await request.arrayBuffer();
        if (body.byteLength > MAX_INGEST_BYTES) return json(413, { error: "push too large" });
        if (request.headers.get("x-body-encoding") === "gzip") body = await gunzip(body);
        if (body.byteLength > MAX_INGEST_JSON) return json(413, { error: "push too large" });
        return mirrorStub(env).fetch("https://mirror/ingest", { method: "POST", body, headers: { "content-type": "application/json" } });
      }

      const viewer = await checkViewer(request, env, f);
      if (!viewer.ok) {
        if (viewer.setup) return setupPage(url.origin);
        return text(403, "Sign in through Cloudflare Access to view this dashboard.");
      }

      if (method === "GET" && (path === "/" || path === "/index.html")) return page(html);
      if (method === "GET" && path === "/favicon.ico") return new Response(null, { status: 204 });
      if (!path.startsWith("/api/")) return text(404, "not found");

      if (method === "POST") {
        // The page sends this header; a form or script on another site can't without a preflight.
        if (request.headers.get("x-dashboard") !== "1") return json(403, { error: "missing x-dashboard header" });
        const origin = request.headers.get("origin");
        if (origin && origin !== url.origin) return json(403, { error: "bad origin" });
      }
      switch (`${method} ${path}`) {
        case "GET /api/state":
        case "GET /api/summary":
        case "GET /api/recent":
        case "GET /api/contracts":
        case "GET /api/review":
        case "GET /api/live":
        case "GET /api/wallet":
          return mirrorStub(env).fetch(`https://mirror${path}${url.search}`);
        case "POST /api/stop":
          return mirrorStub(env).fetch("https://mirror/stop", { method: "POST", body: JSON.stringify({ by: viewer.who }), headers: { "content-type": "application/json" } });
        default:
          return json(404, { error: "not found" });
      }
    },
  };
}

/**
 * Holds the latest copy of the bot's dashboard data: snapshots pushed by the
 * bot, a ring of recent live events for the pages to poll, and a pending stop
 * request. Kept in memory and saved to storage at most once a minute (the bot
 * re-sends everything if this object ever restarts empty).
 */
export class BotMirror {
  constructor(state, env, fetchImpl) {
    this.ctx = state;
    this.env = env;
    this.fetchImpl = fetchImpl ?? ((...a) => fetch(...a));
    this.m = { state: null, summary: null, recent: null, contracts: null, review: null, blocks: [], events: [], seq: 0, runId: null, lastPushAt: 0, pushes: 0, stopRequest: null };
    this.walletCache = new Map();
    this.lastSave = 0;
    this.ready = state.blockConcurrencyWhile(async () => {
      const saved = await state.storage.get(["state", "summary", "recent", "contracts", "review", "blocks", "meta"]);
      for (const k of ["state", "summary", "recent", "contracts", "review"]) if (saved.get(k)) this.m[k] = saved.get(k);
      if (Array.isArray(saved.get("blocks"))) this.m.blocks = saved.get("blocks");
      const meta = saved.get("meta");
      if (meta) Object.assign(this.m, { seq: meta.seq ?? 0, runId: meta.runId ?? null, lastPushAt: meta.lastPushAt ?? 0, pushes: meta.pushes ?? 0, stopRequest: meta.stopRequest ?? null });
    });
  }

  async fetch(request) {
    await this.ready;
    const url = new URL(request.url);
    switch (url.pathname) {
      case "/ingest":
        return this.ingest(await request.json());
      case "/stop":
        return this.requestStop(await request.json().catch(() => ({})));
      case "/api/state":
        return json(200, this.stateView());
      case "/api/summary":
        return json(200, this.m.summary ?? { day: new Date().toISOString().slice(0, 10), days: [], today: null, market: null, liq: null, generatedAt: null });
      case "/api/recent":
        return json(200, this.m.recent ?? { opps: [], mev: [], coverage: null, liq: [], live: [] });
      case "/api/contracts":
        return json(200, this.m.contracts ?? { chainId: 8453, bot: null, routeExecutor: { address: null, creationBytecode: null }, arbExecutor: { address: null }, tokens: {} });
      case "/api/review":
        return json(200, this.m.review ?? { file: null });
      case "/api/live":
        return json(200, this.live(Number(url.searchParams.get("since") || 0)));
      case "/api/wallet":
        return json(200, await this.wallet(url));
      default:
        return json(404, { error: "not found" });
    }
  }

  mirrorInfo() {
    return { lastPushAt: this.m.lastPushAt ? new Date(this.m.lastPushAt).toISOString() : null, pushes: this.m.pushes, runId: this.m.runId };
  }

  stateView() {
    const now = new Date().toISOString();
    if (!this.m.state) return { waiting: true, now, mirror: this.mirrorInfo(), stopRequest: this.m.stopRequest };
    return { ...this.m.state, blocks: this.m.blocks, now, mirror: this.mirrorInfo(), stopRequest: this.m.stopRequest };
  }

  live(since) {
    const ev = this.m.events;
    const oldest = ev.length ? ev[0].seq : this.m.seq + 1;
    // A page that fell further behind than the ring holds reloads everything instead.
    const reset = since > 0 && (since > this.m.seq || since < oldest - 1);
    return {
      seq: this.m.seq,
      reset,
      events: since > 0 && !reset ? ev.filter((e) => e.seq > since).slice(-300) : [],
      mirror: this.mirrorInfo(),
      stop: this.m.state?.stop ?? null,
      stopRequest: this.m.stopRequest,
      now: new Date().toISOString(),
    };
  }

  apply(e) {
    if (!e || typeof e.type !== "string") return;
    const m = this.m;
    m.seq++;
    m.events.push({ seq: m.seq, type: e.type, data: e.data });
    if (m.events.length > EVENT_RING) m.events.splice(0, m.events.length - EVENT_RING);
    const r = (m.recent ??= { opps: [], mev: [], coverage: null, liq: [], live: [] });
    const d = e.data ?? {};
    if (e.type === "block") {
      const last = m.blocks[m.blocks.length - 1];
      if (!last || d.n > last.n) m.blocks.push(d);
      if (m.blocks.length > TAPE) m.blocks.splice(0, m.blocks.length - TAPE);
    } else if (e.type === "opp") {
      if (!r.opps.some((o) => o.id === d.id)) r.opps.unshift({ ...d, outcome: null });
      if (r.opps.length > 40) r.opps.length = 40;
    } else if (e.type === "outcome") {
      const o = r.opps.find((x) => x.id === d.id);
      if (o) o.outcome = d;
    } else if (e.type === "mev") {
      r.mev.unshift(d);
      if (r.mev.length > 40) r.mev.length = 40;
    } else if (e.type === "liq") {
      r.liq.unshift({ ...d, outcome: null, takenBy: null });
      if (r.liq.length > 20) r.liq.length = 20;
    } else if (e.type === "liq-outcome") {
      const l = r.liq.find((x) => x.id === d.id);
      if (l) {
        l.outcome = d.status;
        l.takenBy = d.takenBy ?? null;
      }
    } else if (e.type === "live") {
      r.live.unshift(d);
      if (r.live.length > 20) r.live.length = 20;
    } else if (e.type === "stop" && m.state) {
      m.state.stop = d;
    }
  }

  async ingest(p) {
    if (!p || p.v !== 1) return json(400, { error: "unsupported push" });
    const m = this.m;
    let reset = false;
    if (p.runId && p.runId !== m.runId) {
      // The bot restarted: its block numbers and counters start over.
      m.runId = p.runId;
      m.blocks = [];
      m.events = [];
      reset = true;
    }
    for (const k of ["state", "summary", "recent", "contracts", "review"]) if (p[k] && typeof p[k] === "object") m[k] = p[k];
    if (Array.isArray(p.blocks)) m.blocks = p.blocks.slice(-TAPE);
    if (Array.isArray(p.events)) for (const e of p.events.slice(-2000)) this.apply(e);
    m.lastPushAt = Date.now();
    m.pushes++;
    let changedStop = false;
    if (p.ack && m.stopRequest && p.ack.stopId === m.stopRequest.id) {
      m.stopRequest = null;
      changedStop = true;
    }
    await this.save(changedStop || reset);
    return json(200, { ok: true, resync: !m.state || !m.contracts, commands: m.stopRequest ? [m.stopRequest] : [] });
  }

  async requestStop(body) {
    if (!this.m.stopRequest) {
      this.m.stopRequest = { id: crypto.randomUUID(), type: "stop", requestedAt: new Date().toISOString(), by: typeof body?.by === "string" ? body.by.slice(0, 120) : "dashboard" };
    }
    await this.save(true);
    return json(200, { queued: true, stopRequest: this.m.stopRequest });
  }

  async save(force) {
    if (!force && Date.now() - this.lastSave < 60_000) return;
    this.lastSave = Date.now();
    const m = this.m;
    const entries = { blocks: m.blocks, meta: { seq: m.seq, runId: m.runId, lastPushAt: m.lastPushAt, pushes: m.pushes, stopRequest: m.stopRequest } };
    for (const k of ["state", "summary", "recent", "contracts", "review"]) if (m[k]) entries[k] = m[k];
    try {
      await this.ctx.storage.put(entries);
    } catch {
      /* the bot re-sends everything if this object restarts empty */
    }
  }

  /** ETH / WETH / USDC balances and the executors' owner and operator, read from a public Base RPC. Cached 30 s. */
  async wallet(url) {
    const st = this.m.state;
    const bot = st?.addresses?.bot;
    const extra = (url.searchParams.get("addresses") || "").split(",").map((a) => a.trim().toLowerCase()).filter(isAddress).slice(0, 4);
    const accounts = [...new Set([...extra, ...(isAddress(bot) ? [bot.toLowerCase()] : [])])];
    const routeParam = url.searchParams.get("route");
    const contracts = [
      ["routeExecutor", st?.addresses?.routeExecutor || (isAddress(routeParam) ? routeParam : null)],
      ["arbExecutor", st?.addresses?.executor || (isAddress(url.searchParams.get("arb")) ? url.searchParams.get("arb") : null)],
    ].filter(([, a]) => isAddress(a));
    const key = JSON.stringify([accounts, contracts]);
    const hit = this.walletCache.get(key);
    // A fresh read right after one of your transactions, at most one every 3 s.
    const fresh = url.searchParams.get("fresh") === "1" && Date.now() - (this.lastFreshWallet ?? 0) > 3000;
    if (fresh) this.lastFreshWallet = Date.now();
    if (hit && !fresh && Date.now() - hit.at < 30_000) return hit.value;
    const calls = [];
    const push = (method, params) => calls.push({ jsonrpc: "2.0", id: calls.length + 1, method, params });
    const call = (to, data) => push("eth_call", [{ to, data }, "latest"]);
    const balances = (a) => {
      push("eth_getBalance", [a, "latest"]);
      call(WETH, SEL.balanceOf + word(a));
      call(USDC, SEL.balanceOf + word(a));
    };
    for (const a of accounts) balances(a);
    for (const [, a] of contracts) {
      balances(a);
      call(a, SEL.owner);
      call(a, SEL.operator);
    }
    let results = [];
    if (calls.length) {
      try {
        const res = await this.fetchImpl(this.env.BASE_RPC_URL || "https://mainnet.base.org", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(calls) });
        const body = await res.json();
        results = Array.isArray(body) ? body : [];
      } catch {
        return { error: "couldn't reach the Base RPC for balances; try again in a minute" };
      }
    }
    const byId = new Map(results.map((r) => [r.id, r]));
    const uint = (i) => {
      const r = byId.get(i + 1);
      return r && typeof r.result === "string" && /^0x[0-9a-f]+$/i.test(r.result) && r.result.length <= 66 ? BigInt(r.result).toString() : null;
    };
    const addr = (i) => {
      const r = byId.get(i + 1);
      return r && typeof r.result === "string" && r.result.length >= 66 ? "0x" + r.result.slice(26, 66) : null;
    };
    const out = { at: new Date().toISOString(), accounts: {}, contracts: {} };
    let i = 0;
    for (const a of accounts) {
      out.accounts[a] = { eth: uint(i), weth: uint(i + 1), usdc: uint(i + 2) };
      i += 3;
    }
    for (const [name, a] of contracts) {
      const owner = addr(i + 3);
      out.contracts[name] = { address: a, deployed: owner !== null, eth: uint(i), weth: uint(i + 1), usdc: uint(i + 2), owner, operator: addr(i + 4) };
      i += 5;
    }
    this.walletCache.set(key, { at: Date.now(), value: out });
    if (this.walletCache.size > 20) this.walletCache.delete(this.walletCache.keys().next().value);
    return out;
  }
}
