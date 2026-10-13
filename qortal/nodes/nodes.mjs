#!/usr/bin/env node
/**
 * Find the fastest Base nodes for where this machine sits.
 *
 * Reads the Base node registries people publish on Qortal (QDN resources with
 * the identifier base-arb-nodes-v1, through your local Qortal Core), or a
 * registry file, checks every entry, then times each node from this machine
 * and ranks them. It never edits .env and never sends a transaction: to use a
 * node, put it in RPC_URL (or WS_URL / FLASHBLOCKS_RPC_URL) yourself and
 * restart the bot. Send transactions only through a node you trust.
 *
 *   node qortal/nodes/nodes.mjs                        registries on QDN, ranked
 *   node qortal/nodes/nodes.mjs --file my-nodes.json   a registry file instead (repeatable)
 *   node qortal/nodes/nodes.mjs --names alice,bob      only these publishers
 *   node qortal/nodes/nodes.mjs --check my-nodes.json  check a file before you publish it
 *   node qortal/nodes/nodes.mjs --template             print a registry to fill in
 *
 * Options: --core http://127.0.0.1:12391  --samples 5  --timeout 4000  --max 30
 *          --json  --out qortal/out/nodes-ranked.json
 */
import { lookup } from "node:dns/promises";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { QortalCore, DEFAULT_CORE } from "../lib/qdn.mjs";
import { BASE_CHAIN_ID, NODES_IDENTIFIER, NODES_SCHEMA, QDN_SERVICE, checkRegistry, isPrivateIp, mergeRegistries } from "../lib/registry.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

export function parseArgs(argv) {
  const o = { files: [], names: null, core: process.env.QORTAL_API || DEFAULT_CORE, samples: 5, timeoutMs: 4000, max: 30, json: false, out: resolve(HERE, "..", "out", "nodes-ranked.json"), check: null, template: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "--file") o.files.push(next());
    else if (a === "--names") o.names = String(next() || "").split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--core") o.core = next();
    else if (a === "--samples") o.samples = Math.min(20, Math.max(1, Number(next()) || 5));
    else if (a === "--timeout") o.timeoutMs = Math.min(20_000, Math.max(500, Number(next()) || 4000));
    else if (a === "--max") o.max = Math.min(100, Math.max(1, Number(next()) || 30));
    else if (a === "--json") o.json = true;
    else if (a === "--out") o.out = resolve(next());
    else if (a === "--check") o.check = next();
    else if (a === "--template") o.template = true;
    else if (a === "--help" || a === "-h") o.help = true;
  }
  return o;
}

const quant = (xs, p) => {
  const v = xs.filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return null;
  return v[Math.min(v.length - 1, Math.max(0, Math.round((v.length - 1) * p)))];
};

/** One JSON-RPC call with a timeout. */
async function rpc(url, method, timeoutMs, fetchImpl) {
  const t0 = performance.now();
  const res = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: [] }),
    signal: AbortSignal.timeout(timeoutMs),
    redirect: "error",
  });
  const ms = performance.now() - t0;
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = await res.json();
  if (j.error) throw new Error(String(j.error.message || "rpc error").slice(0, 80));
  return { ms, result: j.result };
}

/**
 * Time a node: its chain id once, then `samples` eth_blockNumber round trips.
 * Hosts that resolve to a private address are refused before any request.
 */
export async function probeNode(node, { samples = 5, timeoutMs = 4000, fetchImpl = globalThis.fetch, resolver = lookup } = {}) {
  const out = { url: node.url, ok: false };
  if (node.kind === "ws") return { ...out, skipped: "wss endpoints are not timed here (use an https endpoint of the same provider)" };
  try {
    const addrs = await resolver(node.host, { all: true });
    if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) return { ...out, error: "resolves to a private address: refused" };
  } catch {
    return { ...out, error: "DNS lookup failed" };
  }
  try {
    const c = await rpc(node.url, "eth_chainId", timeoutMs, fetchImpl);
    out.chainId = Number(c.result);
    out.chainOk = out.chainId === BASE_CHAIN_ID;
    const ms = [];
    let block = null;
    for (let i = 0; i < samples; i++) {
      const r = await rpc(node.url, "eth_blockNumber", timeoutMs, fetchImpl);
      ms.push(r.ms);
      block = Number(r.result);
    }
    return { ...out, ok: true, p50Ms: Math.round(quant(ms, 0.5)), p90Ms: Math.round(quant(ms, 0.9)), minMs: Math.round(Math.min(...ms)), block };
  } catch (e) {
    return { ...out, error: String(e && e.message || e).slice(0, 80) };
  }
}

/** Rank probed nodes: on Base and answering first, then fastest; lag = blocks behind the freshest node. */
export function rank(rows) {
  const top = Math.max(0, ...rows.filter((r) => r.probe.ok && r.probe.chainOk && Number.isFinite(r.probe.block)).map((r) => r.probe.block));
  for (const r of rows) r.lagBlocks = r.probe.ok && Number.isFinite(r.probe.block) && top ? top - r.probe.block : null;
  const score = (r) => (r.probe.ok && r.probe.chainOk ? (r.lagBlocks > 2 ? 1 : 0) : 2);
  return rows.sort((a, b) => score(a) - score(b) || (a.probe.p50Ms ?? 1e9) - (b.probe.p50Ms ?? 1e9));
}

async function loadRegistries(o, core) {
  const results = [];
  for (const f of o.files) results.push({ source: f, ...checkRegistry(readFileSync(f, "utf8"), null) });
  if (!o.files.length) {
    let pubs;
    if (o.names) pubs = o.names.map((name) => ({ name }));
    else pubs = await core.search(QDN_SERVICE, NODES_IDENTIFIER, { limit: 100 });
    for (const p of pubs.slice(0, 100)) {
      try {
        const text = await core.fetchText(QDN_SERVICE, p.name, NODES_IDENTIFIER);
        results.push({ source: `qdn:${p.name}`, ...checkRegistry(text, p.name) });
      } catch (e) {
        results.push({ source: `qdn:${p.name}`, ok: false, reason: String(e.message || e).slice(0, 120) });
      }
    }
  }
  return results;
}

const TEMPLATE = {
  schema: NODES_SCHEMA,
  chainId: BASE_CHAIN_ID,
  updatedAt: "2026-01-01T00:00:00.000Z",
  nodes: [
    { label: "Base public RPC", url: "https://mainnet.base.org", kind: "rpc", region: "global", notes: "Rate-limited; fine for reading" },
    { label: "My node (example)", url: "https://base.example.com", kind: "rpc", region: "us-east", notes: "Only list endpoints you are happy for anyone to use" },
  ],
};

export async function main(argv = process.argv.slice(2), { log = console.log, fetchImpl = globalThis.fetch, resolver = lookup } = {}) {
  const o = parseArgs(argv);
  if (o.help) {
    log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("*/")[0].replace(/^#!.*\n\/\*\*?/, "").replace(/^ \* ?/gm, ""));
    return 0;
  }
  if (o.template) {
    log(JSON.stringify(TEMPLATE, null, 2));
    return 0;
  }
  if (o.check) {
    const r = checkRegistry(readFileSync(o.check, "utf8"), null);
    if (!r.ok) {
      log(`Refused: ${r.reason}`);
      return 1;
    }
    log(`${r.nodes.length} node(s) pass.${r.rejected.length ? ` Refused: ${r.rejected.map((x) => `${x.label || "?"} (${x.reason})`).join("; ")}` : ""}`);
    log("Publish it from the Qortal app (Base nodes → Share your nodes), or in Qortal Hub as a JSON resource with the identifier " + NODES_IDENTIFIER + ".");
    return r.rejected.length ? 1 : 0;
  }
  const core = new QortalCore(o.core, { fetchImpl });
  const regs = await loadRegistries(o, core);
  const bad = regs.filter((r) => !r.ok);
  const nodes = mergeRegistries(regs).slice(0, o.max);
  if (!nodes.length) {
    log(regs.length ? `No usable nodes. ${bad.map((r) => `${r.source}: ${r.reason}`).join("; ")}` : "No registries found on QDN yet. Publish yours from the Qortal app, or pass --file.");
    return regs.length ? 1 : 0;
  }
  // Probe four at a time.
  const rows = nodes.map((n) => ({ node: n, probe: null }));
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(4, rows.length) }, async () => {
      while (next < rows.length) {
        const r = rows[next++];
        r.probe = await probeNode(r.node, { samples: o.samples, timeoutMs: o.timeoutMs, fetchImpl, resolver });
      }
    }),
  );
  const ranked = rank(rows);
  const result = {
    at: new Date().toISOString(),
    from: "this machine",
    registries: regs.map((r) => ({ source: r.source, ok: r.ok, nodes: r.ok ? r.nodes.length : 0, refused: r.ok ? r.rejected : [{ reason: r.reason }] })),
    nodes: ranked.map((r, i) => ({ rank: i + 1, label: r.node.label, url: r.node.url, host: r.node.host, kind: r.node.kind, region: r.node.region, publishers: r.node.publishers, ...r.probe, lagBlocks: r.lagBlocks })),
  };
  try {
    mkdirSync(dirname(o.out), { recursive: true });
    writeFileSync(o.out, JSON.stringify(result, null, 2) + "\n");
  } catch {
    /* read-only folder: printing is enough */
  }
  if (o.json) {
    log(JSON.stringify(result, null, 2));
    return 0;
  }
  log(`Base nodes, timed from this machine (${o.samples} calls each):\n`);
  log("rank  p50 ms  p90 ms  behind  kind         region      host                                   listed by");
  for (const r of result.nodes) {
    const status = r.ok ? (r.chainOk ? "" : ` NOT BASE (chain ${r.chainId})`) : ` ${r.skipped || r.error}`;
    log(
      `${String(r.rank).padStart(4)}  ${String(r.p50Ms ?? "–").padStart(6)}  ${String(r.p90Ms ?? "–").padStart(6)}  ${String(r.lagBlocks ?? "–").padStart(6)}  ${r.kind.padEnd(11)}  ${r.region.padEnd(10)}  ${r.host.slice(0, 38).padEnd(38)} ${(r.publishers || []).join(", ").slice(0, 30) || "file"}${status}`,
    );
  }
  if (bad.length) log(`\nSkipped registries: ${bad.map((r) => `${r.source} (${r.reason})`).join("; ")}`);
  log(`\nSaved to ${o.out}. To use a node, set RPC_URL in your own .env and restart the bot; send only through a node you trust.`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => process.exit(code), (e) => {
    console.error(String(e && e.message || e));
    process.exit(1);
  });
}
