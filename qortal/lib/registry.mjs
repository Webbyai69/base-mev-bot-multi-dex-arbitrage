/**
 * The Base node registry on Qortal's data network (QDN): the shared format and
 * the checks every entry must pass before anything probes it.
 *
 * Anyone with a Qortal name can publish a list of Base RPC endpoints as a JSON
 * resource with the identifier below. Bots read those lists, test each node
 * from where they run, and rank them by measured latency. Entries come from
 * strangers, so nothing is trusted:
 *   - https:// and wss:// only; no user:password, query string or fragment;
 *   - no private, loopback or link-local hosts, so a registry can never make
 *     your machine probe your own network;
 *   - no path segment that looks like an API key, so leaked keys don't spread;
 *   - text is cut short and stripped of control characters.
 *
 * Registry nodes are for reading and latency tests. Send transactions only
 * through a node you run or pay for: a stranger's node sees your transaction
 * before the sequencer does.
 *
 * No imports: this file runs unchanged in Node and in the Qortal app.
 */

export const QDN_SERVICE = "JSON";
export const NODES_IDENTIFIER = "base-arb-nodes-v1";
export const NODES_SCHEMA = "base-arb-nodes/1";
export const BASE_CHAIN_ID = 8453;
export const MAX_NODES = 50;
export const KINDS = ["rpc", "ws", "flashblocks"];

/** Strip control characters and cut to `max` characters. */
export function cleanText(v, max) {
  return String(v == null ? "" : v)
    .replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, " ")
    .trim()
    .slice(0, max);
}

/** True for hosts that must never be probed: loopback, private, link-local, intranet names. */
export function isPrivateHost(host) {
  const h = String(host || "").toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!h) return true;
  if (h === "localhost" || /\.(localhost|local|internal|lan|home|intranet|corp|arpa)$/.test(h)) return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if ([v4[1], v4[2], v4[3], v4[4]].some((x) => Number(x) > 255)) return true;
    return (
      a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
      (a === 169 && b === 254) || // link-local
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || b === 0)) ||
      (a === 198 && (b === 18 || b === 19)) // benchmarking
    );
  }
  if (h.includes(":")) return true; // IPv6 literals: refused outright, public nodes have names
  return !h.includes("."); // single-label names only resolve inside a network
}

/** Is an IP address (from DNS) private? Used by the Node prober after resolving a host. */
export function isPrivateIp(ip) {
  const a = String(ip || "").toLowerCase();
  if (a.includes(":")) {
    if (a.startsWith("::ffff:")) return isPrivateHost(a.slice(7));
    return a === "::" || a === "::1" || /^f[cd]/.test(a) || /^fe[89ab]/.test(a);
  }
  return isPrivateHost(a) && /^\d/.test(a);
}

/** A URL path segment that looks like an API key or a secret. */
export function keyLike(seg) {
  const s = String(seg || "");
  if (s.length < 16) return false;
  if (/^[0-9a-f]+$/i.test(s) && s.length >= 20) return true;
  if (!/^[A-Za-z0-9_.~-]+$/.test(s)) return false;
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/].filter((r) => r.test(s)).length;
  return classes >= 2;
}

/**
 * Check a node URL. Returns { ok, url, host, scheme } or { ok: false, reason }.
 * The returned url is normalised (lower-case host, no trailing slash).
 */
export function checkNodeUrl(raw) {
  let u;
  try {
    u = new URL(String(raw || "").trim());
  } catch {
    return { ok: false, reason: "not a URL" };
  }
  if (u.protocol !== "https:" && u.protocol !== "wss:") return { ok: false, reason: "only https:// and wss:// are accepted" };
  if (u.username || u.password) return { ok: false, reason: "URLs with a user or password are refused" };
  if (u.search || u.hash) return { ok: false, reason: "URLs with a query string or fragment are refused" };
  if (u.port && !/^\d{2,5}$/.test(u.port)) return { ok: false, reason: "bad port" };
  const host = u.hostname.toLowerCase();
  if (isPrivateHost(host)) return { ok: false, reason: "private, loopback or intranet host" };
  if (host.split(".").some((label) => keyLike(label) && label.length >= 20)) return { ok: false, reason: "host looks like it holds a key" };
  const segs = u.pathname.split("/").filter(Boolean);
  if (segs.length > 4) return { ok: false, reason: "path too long" };
  if (segs.some(keyLike)) return { ok: false, reason: "path looks like it holds an API key: share only public endpoints" };
  const path = segs.length ? "/" + segs.join("/") : "";
  return { ok: true, url: `${u.protocol}//${host}${u.port ? ":" + u.port : ""}${path}`, host, scheme: u.protocol.replace(":", "") };
}

/** Check one registry entry. */
export function checkNode(n) {
  if (!n || typeof n !== "object") return { ok: false, reason: "not an object" };
  const label = cleanText(n.label, 40);
  const u = checkNodeUrl(n.url);
  if (!u.ok) return { ok: false, label, reason: u.reason };
  const kind = KINDS.includes(n.kind) ? n.kind : u.scheme === "wss" ? "ws" : "rpc";
  if (kind === "ws" && u.scheme !== "wss") return { ok: false, label, reason: "a ws node needs a wss:// URL" };
  if (kind !== "ws" && u.scheme !== "https") return { ok: false, label, reason: "rpc and flashblocks nodes need an https:// URL" };
  const region = cleanText(n.region, 24).toLowerCase().replace(/[^a-z0-9-]/g, "") || "unknown";
  const node = { label: label || u.host, url: u.url, host: u.host, kind, region };
  const notes = cleanText(n.notes, 140);
  if (notes) node.notes = notes;
  const m = n.measured;
  if (m && typeof m === "object" && Number.isFinite(Number(m.p50Ms)) && Number(m.p50Ms) >= 0 && Number(m.p50Ms) < 60_000) {
    node.measured = { p50Ms: Math.round(Number(m.p50Ms)), from: cleanText(m.from, 24) || "unknown" };
    const at = Date.parse(m.at);
    if (Number.isFinite(at)) node.measured.at = new Date(at).toISOString();
  }
  return { ok: true, node };
}

/**
 * Check a whole registry document (parsed JSON or a JSON string). Bad entries
 * are dropped with a reason; a bad document returns ok: false.
 */
export function checkRegistry(doc, publisher) {
  let d = doc;
  if (typeof d === "string") {
    if (d.length > 64 * 1024) return { ok: false, reason: "larger than 64 KB" };
    try {
      d = JSON.parse(d);
    } catch {
      return { ok: false, reason: "not JSON" };
    }
  }
  if (!d || typeof d !== "object") return { ok: false, reason: "not an object" };
  if (d.schema !== NODES_SCHEMA) return { ok: false, reason: `schema is not ${NODES_SCHEMA}` };
  if (Number(d.chainId) !== BASE_CHAIN_ID) return { ok: false, reason: `chainId is not ${BASE_CHAIN_ID}` };
  if (!Array.isArray(d.nodes)) return { ok: false, reason: "nodes is not a list" };
  const pub = cleanText(publisher, 40) || null;
  const nodes = [];
  const rejected = [];
  const seen = new Set();
  for (const raw of d.nodes.slice(0, MAX_NODES)) {
    const r = checkNode(raw);
    if (!r.ok) {
      rejected.push({ label: r.label || cleanText(raw && raw.label, 40), reason: r.reason });
      continue;
    }
    if (seen.has(r.node.url)) continue;
    seen.add(r.node.url);
    nodes.push(pub ? { ...r.node, publisher: pub } : r.node);
  }
  if (d.nodes.length > MAX_NODES) rejected.push({ label: "", reason: `only the first ${MAX_NODES} entries are read` });
  const at = Date.parse(d.updatedAt);
  return { ok: true, publisher: pub, updatedAt: Number.isFinite(at) ? new Date(at).toISOString() : null, nodes, rejected };
}

/** Build a registry document to publish. Throws with every reason if any entry is refused. */
export function buildRegistry(entries, now = Date.now()) {
  const nodes = [];
  const problems = [];
  for (const e of entries || []) {
    const r = checkNode(e);
    if (r.ok) {
      const { host, publisher, ...keep } = r.node;
      nodes.push(keep);
    } else problems.push(`${r.label || e.url || "entry"}: ${r.reason}`);
  }
  if (problems.length) throw new Error(problems.join("; "));
  if (!nodes.length) throw new Error("no nodes to publish");
  if (nodes.length > MAX_NODES) throw new Error(`at most ${MAX_NODES} nodes`);
  return { schema: NODES_SCHEMA, chainId: BASE_CHAIN_ID, updatedAt: new Date(now).toISOString(), nodes };
}

/** Merge registries from several publishers: one row per URL, keeping every publisher that lists it. */
export function mergeRegistries(results) {
  const byUrl = new Map();
  for (const r of results) {
    if (!r || !r.ok) continue;
    for (const n of r.nodes) {
      const cur = byUrl.get(n.url);
      if (cur) {
        if (n.publisher && !cur.publishers.includes(n.publisher)) cur.publishers.push(n.publisher);
      } else byUrl.set(n.url, { ...n, publishers: n.publisher ? [n.publisher] : [] });
    }
  }
  return [...byUrl.values()];
}
