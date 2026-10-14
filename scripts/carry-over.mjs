#!/usr/bin/env node
/**
 * Carry your settings, bot wallet and the bot's memory from an older install
 * into this one, so a fresh copy from GitHub picks up where the old one left
 * off: same funded bot wallet, same executors, same learned routes and pools.
 *
 *   node scripts/carry-over.mjs --from "C:\Users\you\source\base-arb-bot"
 *   node scripts/carry-over.mjs --from <old folder> --dry-run   show what would be copied
 *   node scripts/carry-over.mjs --from <old folder> --force     replace what's here (kept as *.bak)
 *   node scripts/carry-over.mjs --from <old folder> --with-reports   also copy reports\
 *
 * What it copies (none of it is in git, by design):
 *   .env                       your settings, RPC URLs, executor addresses and the bot wallet's key
 *   data\                      the bot's memory: learned.json, pools.json, tuning.json, records,
 *                              agents.json, keystore.json (if you encrypted the key), STOP
 *   bots\wrapper\.env          fleet wrapper settings, if you have them
 *   qortal\bridge\bridge.env   the Qortal bridge's read-only token, if you have one
 *   deploy\ashburn\.env.ashburn  the server settings, if you made them
 *
 * It never prints a key, a token or an RPC URL. It prints the bot wallet's
 * address (public) for the old and the new copy, so you can see they match,
 * and its ETH balance on Base when the RPC in .env answers.
 *
 * Updating in place (git pull in the old folder) needs none of this: git
 * never touches .env or data\.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Files and folders that hold your own state, relative to the install folder. */
export const ITEMS = [
  { path: ".env", what: "settings and the bot wallet's key", dir: false, required: true },
  { path: "data", what: "the bot's memory (learning, pools, tuning, records, keystore, STOP)", dir: true },
  { path: "bots/wrapper/.env", what: "fleet wrapper settings", dir: false },
  { path: "qortal/bridge/bridge.env", what: "Qortal bridge token", dir: false },
  { path: "deploy/ashburn/.env.ashburn", what: "server settings", dir: false },
];
const REPORTS = { path: "reports", what: "logs, digests and reviews", dir: true };

export function parseArgs(argv) {
  const o = { from: null, to: HERE, force: false, dryRun: false, withReports: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--from") o.from = argv[++i];
    else if (a === "--to") o.to = argv[++i];
    else if (a === "--force") o.force = true;
    else if (a === "--dry-run") o.dryRun = true;
    else if (a === "--with-reports") o.withReports = true;
    else if (a === "--help" || a === "-h") o.help = true;
    else throw new Error(`unknown option ${a} (see --help)`);
  }
  return o;
}

/** KEY=VALUE lines, # comments, optional quotes: the same rules the bot uses. */
export function readEnv(path) {
  const out = {};
  if (!existsSync(path)) return out;
  for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    let v = line.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[line.slice(0, eq).trim()] = v;
  }
  return out;
}

const fileHash = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
const stamp = () => new Date().toISOString().replace(/[-:]/g, "").replace(/\..*$/, "").replace("T", "-");

/** Every file under a folder, as paths relative to it. */
function walk(root, sub = "") {
  const out = [];
  for (const e of readdirSync(join(root, sub), { withFileTypes: true })) {
    const rel = sub ? join(sub, e.name) : e.name;
    if (e.isDirectory()) out.push(...walk(root, rel));
    else if (e.isFile()) out.push(rel);
  }
  return out;
}

/**
 * Plan the copy without touching anything: one row per file, with what will
 * happen to it. Identical files are skipped; different ones are only replaced
 * with --force, and the copy here is kept as <name>.<time>.bak first.
 */
export function plan(from, to, { force = false, withReports = false } = {}) {
  const rows = [];
  for (const item of withReports ? [...ITEMS, REPORTS] : ITEMS) {
    const src = join(from, item.path);
    if (!existsSync(src)) {
      rows.push({ item, rel: item.path, action: item.required ? "missing" : "absent" });
      continue;
    }
    const files = item.dir ? walk(src).map((f) => join(item.path, f)) : [item.path];
    for (const rel of files) {
      if (/(^|[\\/])\.gitkeep$/.test(rel)) continue;
      const s = join(from, rel);
      const d = join(to, rel);
      const bytes = statSync(s).size;
      if (!existsSync(d)) rows.push({ item, rel, action: "copy", bytes });
      else if (fileHash(s) === fileHash(d)) rows.push({ item, rel, action: "same", bytes });
      else rows.push({ item, rel, action: force ? "replace" : "keep", bytes });
    }
  }
  return rows;
}

export function apply(rows, from, to) {
  const t = stamp();
  for (const r of rows) {
    if (r.action !== "copy" && r.action !== "replace") continue;
    const d = join(to, r.rel);
    mkdirSync(dirname(d), { recursive: true });
    if (r.action === "replace") renameSync(d, `${d}.${t}.bak`);
    copyFileSync(join(from, r.rel), d);
  }
}

/** The bot wallet's public address from an .env (PRIVATE_KEY), or how it's held instead. */
export async function walletOf(env, deriveAddress) {
  if (env.PRIVATE_KEY) {
    try {
      return { address: await deriveAddress(env.PRIVATE_KEY), keyHash: createHash("sha256").update(env.PRIVATE_KEY.toLowerCase().replace(/^0x/, "")).digest("hex") };
    } catch {
      return { error: "PRIVATE_KEY is not a valid key" };
    }
  }
  if (env.KEYSTORE_FILE) return { keystore: env.KEYSTORE_FILE };
  return { none: true };
}

async function defaultDerive(pk) {
  let ethers;
  try {
    ethers = await import("ethers");
  } catch {
    throw new Error("install dependencies first (npm ci)");
  }
  return new ethers.Wallet(pk).address;
}

/** ETH balance on Base through the RPC in .env. The URL is never printed. */
export async function balanceOf(rpcUrl, address, fetchImpl = globalThis.fetch) {
  const call = async (method, params) => {
    const r = await fetchImpl(rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(8000) });
    const j = await r.json();
    if (j.error) throw new Error(String(j.error.message || "rpc error"));
    return j.result;
  };
  const chain = Number(BigInt(await call("eth_chainId", [])));
  const wei = BigInt(await call("eth_getBalance", [address, "latest"]));
  return { chainId: chain, eth: Number(wei) / 1e18 };
}

const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;

export async function main(argv = process.argv.slice(2), { log = console.log, deriveAddress = defaultDerive, fetchImpl = globalThis.fetch, now = Date.now() } = {}) {
  const o = parseArgs(argv);
  if (o.help || !o.from) {
    log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("*/")[0].replace(/^#!.*\n\/\*\*?/, "").replace(/^ \* ?/gm, ""));
    return o.help ? 0 : 2;
  }
  const from = resolve(o.from);
  const to = resolve(o.to);
  if (!existsSync(from)) throw new Error(`no folder at ${from}`);
  if (from === to) throw new Error("--from is this folder: nothing to carry over (updating in place keeps .env and data\\ anyway)");
  if (!existsSync(join(from, ".env")) && !existsSync(join(from, "data"))) throw new Error(`${from} has no .env and no data\\: is it the old bot folder?`);

  // A bot still running in the old folder keeps writing its records.
  const recent = existsSync(join(from, "data")) ? walk(join(from, "data")).filter((f) => now - statSync(join(from, "data", f)).mtimeMs < 120_000) : [];
  if (recent.length) log(`Careful: the old bot looks like it's still running (data\\ changed in the last 2 minutes). Stop it first, then run this again.`);

  const rows = plan(from, to, { force: o.force, withReports: o.withReports });
  const by = (a) => rows.filter((r) => r.action === a);
  const kb = (n) => (n >= 1 << 20 ? `${(n / (1 << 20)).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
  log(`From ${from}`);
  log(`To   ${to}${o.dryRun ? "   (dry run: nothing is copied)" : ""}\n`);
  for (const item of o.withReports ? [...ITEMS, REPORTS] : ITEMS) {
    const mine = rows.filter((r) => r.item === item);
    if (!mine.length) continue;
    if (mine[0].action === "absent") continue;
    if (mine[0].action === "missing") {
      log(`  ${item.path.padEnd(28)} not in the old folder`);
      continue;
    }
    const n = (a) => mine.filter((r) => r.action === a).length;
    const size = mine.reduce((s, r) => s + (r.bytes || 0), 0);
    const parts = [n("copy") && `${n("copy")} to copy`, n("replace") && `${n("replace")} to replace`, n("same") && `${n("same")} already here`, n("keep") && `${n("keep")} different here, kept (use --force)`].filter(Boolean);
    log(`  ${item.path.padEnd(28)} ${item.what}: ${parts.join(", ")} (${kb(size)})`);
  }
  if (!o.dryRun) apply(rows, from, to);
  log("");
  if (by("keep").length) log(`${by("keep").length} file(s) here differ from the old folder and were left alone${by("keep").some((r) => r.rel === ".env") ? ", .env among them" : ""}. Run again with --force to use the old folder's (this folder's are kept as *.bak).`);

  // Same wallet? Compare the old and the new .env by the wallet's public address.
  const oldEnv = readEnv(join(from, ".env"));
  const newEnv = readEnv(join(to, ".env"));
  const oldW = await walletOf(oldEnv, deriveAddress).catch((e) => ({ error: String(e.message || e) }));
  const newW = o.dryRun ? {} : await walletOf(newEnv, deriveAddress).catch((e) => ({ error: String(e.message || e) }));
  let ok = true;
  if (oldW.address) {
    log(`Bot wallet (old folder): ${oldW.address}`);
    if (o.dryRun) log("It comes across with .env when you run this without --dry-run.");
    else if (newW.address) {
      const same = newW.keyHash === oldW.keyHash;
      log(`Bot wallet (this folder): ${newW.address}  ${same ? "same wallet" : "DIFFERENT wallet: this folder has another key"}`);
      ok = same;
    } else if (!o.dryRun) {
      log(`This folder's .env has no bot key${newW.error ? ` (${newW.error})` : ""}.`);
      ok = false;
    }
  } else if (oldW.keystore) {
    log(`The old folder keeps the bot key encrypted (KEYSTORE_FILE=${oldW.keystore}); data\\keystore.json came across with data\\. The bot asks for its passphrase at start.`);
  } else if (oldW.error) {
    log(`Couldn't read the old bot key: ${oldW.error}.`);
  } else {
    log("The old .env has no PRIVATE_KEY or KEYSTORE_FILE: no bot wallet to carry over (paper mode only).");
  }
  for (const k of ["EXECUTOR_ADDRESS", "ROUTE_EXECUTOR_ADDRESS", "LIQ_EXECUTOR_ADDRESS"]) {
    if (oldEnv[k] && (o.dryRun || newEnv[k] === oldEnv[k])) log(`${k.padEnd(23)} ${short(oldEnv[k])} ${o.dryRun ? "comes across" : "carried over"}`);
    else if (oldEnv[k]) {
      log(`${k.padEnd(23)} differs from the old folder`);
      ok = false;
    }
  }
  const addr = newW.address || oldW.address;
  const rpc = (o.dryRun ? oldEnv : newEnv).RPC_URL;
  if (addr && rpc) {
    try {
      const b = await balanceOf(rpc, addr, fetchImpl);
      log(b.chainId === 8453 ? `Gas money in the bot wallet: ${b.eth.toFixed(6)} ETH on Base.` : `The RPC in .env is on chain ${b.chainId}, not Base (8453): check RPC_URL.`);
    } catch (e) {
      const why = String((e && e.message) || e).split(rpc).join("RPC_URL").slice(0, 60);
      log(`Couldn't read the balance (${why}). The dashboard shows it once the bot runs.`);
    }
  }
  log("\nRun only one live copy of the bot with this wallet at a time: two copies sending from one wallet clash and waste gas.");
  log("Keep an offline backup of .env (it holds the bot wallet's key). It never goes to GitHub.");
  if (existsSync(join(to, "data", "STOP"))) log("data\\STOP came across too: live sending stays off until you delete it, as before.");
  return ok ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    (e) => {
      console.error(String((e && e.message) || e));
      process.exit(1);
    },
  );
}
