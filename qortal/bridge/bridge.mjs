#!/usr/bin/env node
/**
 * The Qortal bridge: lets the terminal running as a Qortal app read your bot,
 * read-only, without the app ever holding a token.
 *
 * It listens on this machine only (127.0.0.1), holds one agent token with the
 * read scope, and forwards a fixed list of read routes to the bot's local
 * server. Writes (pausing, tuning, fleet control, issuing tokens, node tests)
 * are refused: those stay in the terminal on the bot's own machine. Only the
 * Qortal origins you list may read its answers.
 *
 *   1. In the bot's terminal: AI agents → Issue token, scope "read" only.
 *   2. Copy qortal/bridge/bridge.env.example to qortal/bridge/bridge.env and
 *      put the token there (the file is gitignored).
 *   3. node qortal/bridge/bridge.mjs   (or: npm run qortal:bridge)
 *
 * Settings (bridge.env or the environment): BOT_API_URL (http://127.0.0.1:8787),
 * BOT_AGENT_TOKEN (agt_…, read scope only), BRIDGE_PORT (8790),
 * QAPP_ORIGINS (comma-separated; defaults to Qortal's local UI and Core origins).
 */
import { createServer, request as httpRequest } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { publicStatus } from "../lib/status.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

export const DEFAULT_ORIGINS = ["http://127.0.0.1:12391", "http://localhost:12391", "http://127.0.0.1:12388", "http://localhost:12388"];

/** The read routes the Qortal app may use (path without query). */
export const READ_ROUTES = new Set([
  "/api/brief", "/api/health", "/api/latency", "/api/leaks", "/api/racers", "/api/routes/scores", "/api/targets",
  "/api/market", "/api/fleet", "/api/nodes", "/api/analytics", "/api/help", "/api/state", "/api/recent", "/api/summary",
]);

/** Read KEY=value lines (no shell expansion). */
export function readEnvFile(path) {
  const out = {};
  if (!existsSync(path)) return out;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trim().startsWith("#")) continue;
    out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
  }
  return out;
}

export function loadConfig(env = process.env, file = join(HERE, "bridge.env")) {
  const f = readEnvFile(file);
  const get = (k, d) => env[k] ?? f[k] ?? d;
  const origins = String(get("QAPP_ORIGINS", "")).split(",").map((s) => s.trim().replace(/\/+$/, "")).filter(Boolean);
  return {
    botUrl: String(get("BOT_API_URL", "http://127.0.0.1:8787")).replace(/\/+$/, ""),
    token: String(get("BOT_AGENT_TOKEN", "")),
    host: "127.0.0.1",
    port: Number(get("BRIDGE_PORT", 8790)),
    origins: origins.length ? origins : DEFAULT_ORIGINS,
  };
}

function upstream(cfg, method, path, body, { stream = false } = {}) {
  return new Promise((resolveP, reject) => {
    const u = new URL(cfg.botUrl + path);
    const headers = { "x-bot-token": cfg.token, accept: stream ? "text/event-stream" : "application/json" };
    if (body !== undefined) {
      headers["content-type"] = "application/json";
      headers["content-length"] = Buffer.byteLength(body);
    }
    const req = httpRequest({ hostname: u.hostname, port: u.port || 80, path: u.pathname + u.search, method, headers, timeout: stream ? 0 : 15_000 }, (res) => resolveP(res));
    req.on("timeout", () => req.destroy(new Error("the bot did not answer in 15 s")));
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

async function upstreamJson(cfg, path) {
  const res = await upstream(cfg, "GET", path);
  const chunks = [];
  for await (const c of res) chunks.push(c);
  const text = Buffer.concat(chunks).toString("utf8");
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: res.statusCode || 502, json };
}

async function readBody(req, max) {
  const chunks = [];
  let n = 0;
  for await (const c of req) {
    n += c.length;
    if (n > max) throw new Error("request body too large");
    chunks.push(c);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Check the token before serving: it must work, and it must be read-only. */
export async function checkToken(cfg) {
  if (!/^agt_[A-Za-z0-9_-]{16,}$/.test(cfg.token)) throw new Error("BOT_AGENT_TOKEN must be an agent token (agt_…). Issue one with the read scope only, in the terminal under AI agents.");
  let r;
  try {
    r = await upstreamJson(cfg, "/api/agents/me");
  } catch (e) {
    throw new Error(`the bot at ${cfg.botUrl} is not reachable (${String(e.message || e).slice(0, 80)}). Start the bot first.`);
  }
  if (r.status === 401) throw new Error("the bot refused the token (revoked or mistyped)");
  const scopes = (r.json && r.json.agent && r.json.agent.scopes) || [];
  const extra = scopes.filter((s) => s !== "read");
  if (extra.length) throw new Error(`this token also has ${extra.join(", ")}: the bridge only accepts a read-only token. Issue one with the read scope only.`);
  return scopes;
}

export function createBridge(cfg, { log = console.log } = {}) {
  const warned = new Set();
  const cors = (req, res) => {
    const origin = req.headers.origin;
    if (!origin) return true; // local tools such as curl
    if (!cfg.origins.includes(origin.replace(/\/+$/, ""))) {
      if (!warned.has(origin)) {
        warned.add(origin);
        log(`refused a request from ${origin.slice(0, 80)}: add it to QAPP_ORIGINS in bridge.env if that is your Qortal app`);
      }
      return false;
    }
    res.setHeader("access-control-allow-origin", origin);
    res.setHeader("vary", "origin");
    return true;
  };
  const send = (res, status, obj) => {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(JSON.stringify(obj));
  };

  return createServer(async (req, res) => {
    try {
      if (!cors(req, res)) return send(res, 403, { error: "origin not allowed" });
      const url = new URL(req.url || "/", "http://bridge");
      if (req.method === "OPTIONS") {
        res.writeHead(204, {
          "access-control-allow-methods": "GET, POST, OPTIONS",
          "access-control-allow-headers": "content-type, x-bot-token, authorization",
          "access-control-allow-private-network": "true",
          "access-control-max-age": "600",
        });
        return res.end();
      }
      if (req.method === "GET" && url.pathname === "/bridge/health") {
        let bot = { reachable: false };
        try {
          const b = await upstreamJson(cfg, "/api/brief");
          if (b.status === 200 && b.json) bot = { reachable: true, mode: b.json.mode ?? null, running: b.json.running === true, version: b.json.version ?? null };
          else bot = { reachable: true, error: `HTTP ${b.status}` };
        } catch {
          /* bot down */
        }
        return send(res, 200, { ok: true, bridge: "base-arb-qortal-bridge", readOnly: true, bot });
      }
      if (req.method === "GET" && url.pathname === "/bridge/snapshot") {
        const b = await upstreamJson(cfg, "/api/brief");
        if (b.status !== 200 || !b.json) return send(res, 502, { error: `the bot answered HTTP ${b.status}` });
        return send(res, 200, publicStatus(b.json));
      }
      if (req.method === "GET" && url.pathname === "/api/stream") {
        const up = await upstream(cfg, "GET", "/api/stream", undefined, { stream: true });
        res.writeHead(up.statusCode || 502, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
        up.pipe(res);
        req.on("close", () => up.destroy());
        return;
      }
      if (req.method === "GET" && READ_ROUTES.has(url.pathname)) {
        const up = await upstream(cfg, "GET", url.pathname + url.search);
        res.writeHead(up.statusCode || 502, { "content-type": up.headers["content-type"] || "application/json", "cache-control": "no-store" });
        return up.pipe(res);
      }
      if (req.method === "POST" && url.pathname === "/api/simulate") {
        const body = await readBody(req, 4096);
        const up = await upstream(cfg, "POST", "/api/simulate", body);
        res.writeHead(up.statusCode || 502, { "content-type": "application/json", "cache-control": "no-store" });
        return up.pipe(res);
      }
      return send(res, 403, { error: "read-only on Qortal: do this in the terminal on the bot's own machine" });
    } catch (e) {
      if (!res.headersSent) send(res, 502, { error: String(e && e.message || e).slice(0, 120) });
      else res.end();
    }
  });
}

export async function main({ env = process.env, log = console.log } = {}) {
  const cfg = loadConfig(env);
  if (!Number.isInteger(cfg.port) || cfg.port < 1024 || cfg.port > 65535) throw new Error("BRIDGE_PORT must be between 1024 and 65535");
  const scopes = await checkToken(cfg);
  const server = createBridge(cfg, { log });
  await new Promise((ok, fail) => server.once("error", fail).listen(cfg.port, cfg.host, ok));
  log(`Qortal bridge on http://${cfg.host}:${cfg.port}, read-only (token scopes: ${scopes.join(", ") || "read"}), for ${cfg.origins.join(", ")}`);
  log("In the Qortal app, open Network → Connect and use this address.");
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(`Bridge not started: ${String(e && e.message || e)}`);
    process.exit(1);
  });
}
