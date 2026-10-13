/**
 * Public status snapshots on QDN: a bot's health and results as aggregate
 * numbers, published by its operator (opt-in) so it can be watched from any
 * Qortal node without opening the bot to the internet.
 *
 * A snapshot never contains addresses, routes, pairs, rival bots, hostnames,
 * RPC URLs, tokens or free text from the bot: only the counts and timings
 * below. publicStatus() builds one from the bot's /api/brief; checkStatus()
 * reads one somebody else published, keeping only known numeric fields.
 *
 * No imports: runs in Node and in the Qortal app.
 */

export const STATUS_IDENTIFIER = "base-arb-status-v1";
export const STATUS_SCHEMA = "base-arb-status/1";

const n = (v, max = 1e12) => {
  const x = Number(v);
  return Number.isFinite(x) && Math.abs(x) <= max ? x : null;
};
const round = (v, d = 2) => (v == null ? null : Math.round(v * 10 ** d) / 10 ** d);
const word = (v, allowed) => (allowed.includes(v) ? v : null);
const MODES = ["paper", "live"];
const LEVELS = ["ok", "warn", "down", "off", "critical", "warning", "info"];
const STATES = ["running", "stopped", "stale", "error", "not-installed", "in-process"];
const FLEET_MODES = ["detect", "paper", "live"];
const ID = /^[a-z0-9-]{1,40}$/;

/** Build a public snapshot from the bot's /api/brief. */
export function publicStatus(brief, now = Date.now()) {
  const b = brief && typeof brief === "object" ? brief : {};
  const h = b.health && typeof b.health === "object" ? b.health : {};
  const lat = b.latency && typeof b.latency === "object" ? b.latency : {};
  const lk = b.leaks && typeof b.leaks === "object" ? b.leaks : {};
  const pair = (o) => (o && typeof o === "object" ? { n: n(o.n, 1e9), usd: round(n(o.usd, 1e9)) } : { n: null, usd: null });
  return {
    schema: STATUS_SCHEMA,
    publishedAt: new Date(now).toISOString(),
    briefAt: Number.isFinite(Date.parse(b.at)) ? new Date(Date.parse(b.at)).toISOString() : null,
    chainId: n(b.chainId, 1e7),
    mode: word(b.mode, MODES),
    running: b.running === true,
    paused: !!(b.stop && b.stop.present),
    latestBlock: n(b.latestBlock, 1e12),
    health: {
      overall: word(h.overall, LEVELS),
      issues: Array.isArray(h.issues) ? h.issues.length : null,
      systems: Array.isArray(h.systems)
        ? h.systems.slice(0, 20).filter((s) => s && ID.test(String(s.id))).map((s) => ({ id: String(s.id), status: word(s.status, LEVELS) }))
        : [],
    },
    latency: {
      detectP50Ms: n(lat.detectP50, 1e6),
      detectP90Ms: n(lat.detectP90, 1e6),
      sendP50Ms: n(lat.sendP50, 1e6),
      landBlocksP50: n(lat.landBlocksP50, 1e6),
    },
    results6h: {
      captured: pair(lk.captured),
      stillThere: pair(lk.persisted),
      lostRace: pair(lk.lostRace),
      closed: pair(lk.closed),
    },
    fleet: Array.isArray(b.fleet)
      ? b.fleet.slice(0, 20).filter((f) => f && ID.test(String(f.id))).map((f) => ({ id: String(f.id), state: word(f.state, STATES), mode: word(f.mode, FLEET_MODES) }))
      : [],
  };
}

/** Read a snapshot somebody published: unknown fields dropped, strings checked against fixed lists. */
export function checkStatus(doc) {
  let d = doc;
  if (typeof d === "string") {
    if (d.length > 32 * 1024) return { ok: false, reason: "larger than 32 KB" };
    try {
      d = JSON.parse(d);
    } catch {
      return { ok: false, reason: "not JSON" };
    }
  }
  if (!d || typeof d !== "object" || d.schema !== STATUS_SCHEMA) return { ok: false, reason: `schema is not ${STATUS_SCHEMA}` };
  const at = Date.parse(d.publishedAt);
  if (!Number.isFinite(at)) return { ok: false, reason: "no publishedAt" };
  // Re-run the builder over the published numbers so only known fields survive.
  const s = publicStatus(
    {
      at: d.briefAt,
      chainId: d.chainId,
      mode: d.mode,
      running: d.running,
      stop: { present: d.paused === true },
      latestBlock: d.latestBlock,
      health: {
        overall: d.health && d.health.overall,
        issues: d.health && Number.isFinite(Number(d.health.issues)) && d.health.issues !== null ? Array(Math.min(500, Math.max(0, Math.floor(Number(d.health.issues))))).fill(0) : undefined,
        systems: d.health && d.health.systems,
      },
      latency: { detectP50: d.latency && d.latency.detectP50Ms, detectP90: d.latency && d.latency.detectP90Ms, sendP50: d.latency && d.latency.sendP50Ms, landBlocksP50: d.latency && d.latency.landBlocksP50 },
      leaks: d.results6h && { captured: d.results6h.captured, persisted: d.results6h.stillThere, lostRace: d.results6h.lostRace, closed: d.results6h.closed },
      fleet: d.fleet,
    },
    at,
  );
  return { ok: true, status: s };
}
