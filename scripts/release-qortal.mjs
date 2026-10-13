#!/usr/bin/env node
/**
 * Build the public release zip (for Qortal, or anywhere): the committed source
 * of a git ref, cleaned of anything private, checked for secrets, with the
 * Qortal app prebuilt.
 *
 *   node scripts/release-qortal.mjs                 HEAD → release/
 *   node scripts/release-qortal.mjs --ref <branch>  another ref
 *   options: --out <dir>  --private <file>  --max-mb 45  --name base-arb-system
 *
 * What goes in: every file git tracks at the ref (so .env, data/, reports/,
 * node_modules/ and anything else ignored can never slip in), minus internal
 * planning docs, plus:
 *   RELEASE.md                       what this is and how to build it
 *   bots/upstream/PINS.json          the upstream bots and their pinned commits
 *   qortal/qapp/app/…                the Qortal app, built from this same source
 *   qortal/qapp/arb-terminal-qapp.zip  that app, ready to publish as an APP
 *
 * release.private.json (gitignored, never shipped) holds your own rules:
 *   { "replaceRegex": [["pattern", "flags", "replacement"], …],  applied first
 *     "replace": [["text to find", "replacement"], …],           then these, literally
 *     "mustNotContain": ["text", …] }                            the build fails if any remains
 * Use it for your name, local paths, wallet and contract addresses. The build
 * also fails on anything that looks like a key, token or keyed RPC URL.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { makeZip } from "./lib/zip.mjs";
import { qappFiles } from "../qortal/qapp/build-qapp.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");

/** Internal to the operator's own setup: never part of a public release. */
export const EXCLUDE = [/^docs\/FLEET-PLAN\.md$/, /^docs\/AGENT_TASKS\.md$/, /^release\.private/, /^qortal\/qapp\/app\//, /^qortal\/out\//, /^release\//];

/** Well-known, public development keys (Hardhat/Anvil accounts): safe to appear in tests. */
const PUBLIC_TEST_KEYS = new Set([
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
]);

const SECRET_PATTERNS = [
  { name: "private key block", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: "keyed Alchemy URL", re: /alchemy\.com\/v2\/[A-Za-z0-9_-]{16,}/ },
  { name: "keyed Infura URL", re: /infura\.io\/v3\/[0-9a-f]{32}/i },
  { name: "keyed QuickNode URL", re: /quiknode\.pro\/[0-9a-f]{20,}/i },
  { name: "agent token", re: /\bagt_[A-Za-z0-9_-]{20,}/ },
  { name: "GitHub token", re: /\b(ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})/ },
  { name: "Slack token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/ },
  { name: "AWS key", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "API secret key", re: /\bsk-[A-Za-z0-9]{24,}/ },
  { name: "Telegram bot token", re: /\b\d{8,10}:AA[A-Za-z0-9_-]{30,}/ },
];

/** Secret-named settings that must never carry a value in a shipped file. */
const SECRET_ASSIGN = /^[ \t]*(?:export[ \t]+)?((?:[A-Z0-9_]*_)?(?:PRIVATE_KEY|MNEMONIC|SEED_PHRASE|CLOUD_TOKEN|INGEST_TOKEN|TELEGRAM_BOT_TOKEN|BOT_AGENT_TOKEN|CLIENT_SECRET|API_PASSWORD|JWT_SECRET|HUMMINGBOT_PASSWORD|API_SECRET))[ \t]*=[ \t]*['"]?([^\s'"#]+)/gm;
const FAKE = /example|secret|fake|dummy|test|0123456789|abcdef|attacker|bridgetoken/i;
const PLACEHOLDER = /your|example|replace|placeholder|changeme|xxxx|<|>|…|\.\.\.|\$\{|^0x$/i;

const TEXT_EXT = /\.(md|txt|ts|tsx|js|mjs|cjs|json|jsonc|html|css|sol|py|sh|ps1|cmd|bat|yml|yaml|toml|example|env|gitignore|gitmodules|csv|jsonl|svg)$/i;
const isText = (path, buf) => TEXT_EXT.test(path) || (!buf.includes(0) && buf.length < 2_000_000);

/** Check one text file. Returns a list of findings. */
export function scanText(path, text, mustNotContain = []) {
  const out = [];
  const inTests = /(^|\/)(test|fixtures?)\//.test(path);
  for (const p of SECRET_PATTERNS) {
    const m = p.re.exec(text);
    // Tests carry deliberately fake keys to prove redaction works; those spell themselves out.
    if (m && !(inTests && FAKE.test(m[0]))) out.push({ path, what: p.name, sample: m[0].slice(0, 24) + "…" });
  }
  if (!inTests)
    for (const m of text.matchAll(SECRET_ASSIGN)) {
      if (m[2].length >= 8 && !PLACEHOLDER.test(m[2])) out.push({ path, what: `a value for ${m[1]}`, sample: m[1] + "=…" });
    }
  // A 32-byte hex value written next to a key-ish word could be a private key.
  for (const m of text.matchAll(/0x[0-9a-fA-F]{64}\b/g)) {
    const before = text.slice(Math.max(0, m.index - 60), m.index);
    if (/priv|secret|mnemonic|seed|signer|wallet\s*\(|new Wallet/i.test(before) && !PUBLIC_TEST_KEYS.has(m[0].toLowerCase())) out.push({ path, what: "possible private key", sample: m[0].slice(0, 12) + "…" });
  }
  const low = text.toLowerCase();
  for (const s of mustNotContain) if (s && low.includes(String(s).toLowerCase())) out.push({ path, what: "private text from release.private.json", sample: String(s).slice(0, 6) + "…" });
  return out;
}

function git(args, opts = {}) {
  const r = spawnSync("git", args, { cwd: opts.cwd || ROOT, input: opts.input, maxBuffer: 1024 * 1024 * 512 });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${String(r.stderr).trim().slice(0, 200)}`);
  return r.stdout;
}

/** Every tracked file at a ref, read in one git process. Gitlinks (submodules) are returned separately. */
export function readTree(ref, cwd = ROOT) {
  const listing = git(["ls-tree", "-r", "-z", "--full-tree", ref], { cwd }).toString("utf8").split("\0").filter(Boolean);
  const blobs = [];
  const links = [];
  for (const line of listing) {
    const [meta, path] = line.split("\t");
    const [mode, type, sha] = meta.split(" ");
    if (type === "commit") links.push({ path, commit: sha });
    else if (type === "blob" && mode !== "120000") blobs.push({ path, sha, executable: mode === "100755" });
  }
  const out = git(["cat-file", "--batch"], { cwd, input: blobs.map((b) => b.sha).join("\n") + "\n" });
  let pos = 0;
  for (const b of blobs) {
    const nl = out.indexOf(10, pos);
    const header = out.subarray(pos, nl).toString("utf8").split(" ");
    const size = Number(header[2]);
    b.data = out.subarray(nl + 1, nl + 1 + size);
    pos = nl + 1 + size + 1;
  }
  return { blobs, links };
}

function parseGitmodules(text) {
  const map = new Map();
  let cur = null;
  for (const line of text.split(/\r?\n/)) {
    const sec = /^\[submodule "(.+)"\]/.exec(line);
    if (sec) {
      cur = {};
      continue;
    }
    const kv = /^\s*(path|url)\s*=\s*(.+?)\s*$/.exec(line);
    if (cur && kv) {
      cur[kv[1]] = kv[2];
      if (cur.path && cur.url) map.set(cur.path, cur.url);
    }
  }
  return map;
}

function releaseNotes({ name, ref, sha, date, files, pins }) {
  return `# ${name}

An arbitrage system for Base: the trading bot (backruns and permissionless
liquidations, never front-running or sandwiching), its command center, a fleet
of detect-and-paper bots, and the Qortal layer that hosts the dashboard and a
shared Base node registry on Qortal's data network.

Built ${date} from ${ref} (${sha.slice(0, 12)}). ${files} files.

## Build it

Needs Node.js 20 or newer (and Python 3 for some fleet bots).

\`\`\`
npm ci
npm run build
npm test
\`\`\`

Then copy \`.env.example\` to \`.env\` and read README.md before anything else.
The bot starts in paper mode and sends nothing until you deploy your own
contracts, fund your own gas-only wallet and switch it to live yourself.

The upstream bots the fleet wraps are not included (their licences differ).
\`node scripts/fetch-upstreams.mjs\` clones them at the pinned commits listed in
\`bots/upstream/PINS.json\` (${pins} upstreams); see \`bots/README.md\` for each
licence before you use one.

## On Qortal

Start with \`qortal/README.md\`:

- \`qortal/qapp/arb-terminal-qapp.zip\` is the dashboard as a Qortal app:
  publish it as an APP from Qortal Hub.
- \`npm run qortal:bridge\` lets that app read your bot, read-only, through a
  bridge bound to your own machine.
- \`npm run qortal:nodes\` reads the Base node lists people publish on Qortal,
  times every node from your machine and ranks them.

## Safety

- No keys, \`.env\`, trading records or learned data are in this archive, and
  none belong on Qortal. Keys stay on the machine that trades.
- Every live send is simulated first, capped by a daily gas budget and stopped
  by a circuit breaker; the contracts revert unless a trade is profitable.
- Nothing here is financial advice. Trading on-chain can lose money: start in
  paper mode and keep the caps small.
`;
}

export function buildRelease({ ref = "HEAD", outDir = join(ROOT, "release"), privateFile = join(ROOT, "release.private.json"), maxMb = 45, name = "base-arb-system", cwd = ROOT, log = console.log } = {}) {
  const sha = git(["rev-parse", ref], { cwd }).toString().trim();
  const date = new Date();
  const priv = existsSync(privateFile) ? JSON.parse(readFileSync(privateFile, "utf8")) : { replace: [], mustNotContain: [] };
  if (!existsSync(privateFile)) log(`note: no ${privateFile}; only the generic secret checks will run`);
  const { blobs, links } = readTree(ref, cwd);
  const files = new Map();
  for (const b of blobs) {
    if (EXCLUDE.some((re) => re.test(b.path))) continue;
    let data = b.data;
    if (isText(b.path, data)) {
      let text = data.toString("utf8");
      for (const [pattern, flags, rep] of priv.replaceRegex || []) text = text.replace(new RegExp(pattern, flags), rep);
      for (const [find, rep] of priv.replace || []) if (find) text = text.split(find).join(rep);
      data = Buffer.from(text, "utf8");
    }
    files.set(b.path, { name: b.path, data, executable: b.executable });
  }

  // Generated files.
  const modules = files.has(".gitmodules") ? parseGitmodules(files.get(".gitmodules").data.toString("utf8")) : new Map();
  const pins = links.map((l) => ({ path: l.path, url: modules.get(l.path) || null, commit: l.commit }));
  files.set("bots/upstream/PINS.json", { name: "bots/upstream/PINS.json", data: JSON.stringify({ note: "Upstream bots wrapped by the fleet, pinned. Fetch with node scripts/fetch-upstreams.mjs. Licences: bots/README.md.", pins }, null, 2) + "\n" });
  const read = (rel) => {
    const f = files.get(rel);
    if (!f) throw new Error(`release is missing ${rel}`);
    return f.data.toString("utf8");
  };
  const app = qappFiles(read);
  for (const f of app) files.set(`qortal/qapp/app/${f.name}`, { name: `qortal/qapp/app/${f.name}`, data: f.data });
  const appZip = makeZip(app, date);
  files.set("qortal/qapp/arb-terminal-qapp.zip", { name: "qortal/qapp/arb-terminal-qapp.zip", data: appZip });
  files.set("RELEASE.md", { name: "RELEASE.md", data: releaseNotes({ name, ref, sha, date: date.toISOString().slice(0, 10), files: files.size + 1, pins: pins.length }) });

  // Secrets and private text: fail the build on any finding.
  const findings = [];
  for (const f of files.values()) {
    const buf = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data);
    if (f.name.endsWith(".zip") || !isText(f.name, buf)) continue;
    findings.push(...scanText(f.name, buf.toString("utf8"), priv.mustNotContain || []));
  }
  if (findings.length) {
    const lines = findings.slice(0, 40).map((x) => `  ${x.path}: ${x.what} (${x.sample})`);
    throw new Error(`release refused, ${findings.length} finding(s):\n${lines.join("\n")}`);
  }

  const entries = [...files.values()].sort((a, b) => a.name.localeCompare(b.name)).map((f) => ({ ...f, name: `${name}/${f.name}` }));
  const zip = makeZip(entries, date);
  if (zip.length > maxMb * 1024 * 1024) throw new Error(`release is ${(zip.length / 1048576).toFixed(1)} MB, over the ${maxMb} MB limit`);
  mkdirSync(outDir, { recursive: true });
  const base = `${name}-${date.toISOString().slice(0, 10)}-${sha.slice(0, 7)}`;
  const zipPath = join(outDir, `${base}.zip`);
  writeFileSync(zipPath, zip);
  const hash = createHash("sha256").update(zip).digest("hex");
  writeFileSync(join(outDir, `${base}.sha256`), `${hash}  ${base}.zip\n`);
  const appPath = join(outDir, "arb-terminal-qapp.zip");
  writeFileSync(appPath, appZip);
  return { zipPath, appPath, sha256: hash, bytes: zip.length, files: entries.length, sha };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2);
  const opt = (f, d) => (a.includes(f) ? a[a.indexOf(f) + 1] : d);
  try {
    const r = buildRelease({ ref: opt("--ref", "HEAD"), outDir: resolve(opt("--out", join(ROOT, "release"))), privateFile: resolve(opt("--private", join(ROOT, "release.private.json"))), maxMb: Number(opt("--max-mb", 45)), name: opt("--name", "base-arb-system") });
    console.log(`Release: ${r.zipPath}\n  ${r.files} files, ${(r.bytes / 1048576).toFixed(2)} MB, sha256 ${r.sha256}\nQortal app: ${r.appPath}`);
  } catch (e) {
    console.error(String(e && e.message || e));
    process.exit(1);
  }
}
