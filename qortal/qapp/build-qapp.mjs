#!/usr/bin/env node
/**
 * Build the Qortal app (a Q-App you publish as an APP resource) from the
 * terminal page and the Qortal sources:
 *
 *   index.html, terminal.js   the terminal (ui/terminal.html), started by boot.js
 *   boot.js                   finds the local read-only bridge, else runs the demo
 *   network.html, network.js  bridge connection, node registry, status snapshots
 *   lib/registry.mjs, lib/status.mjs   shared checks (same code the CLI tools use)
 *
 *   node qortal/qapp/build-qapp.mjs
 *     → qortal/qapp/app/                 the files, for previewing in Qortal Hub
 *     → qortal/out/arb-terminal-qapp.zip the zip to publish as an APP
 *
 * Edit the terminal in ui/terminal.html and the Qortal pages in qortal/qapp/src;
 * the app folder is generated.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { makeZip } from "../../scripts/lib/zip.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");

/** Split the terminal page into a document plus its script, started by boot.js. */
export function splitTerminal(html) {
  const open = html.lastIndexOf("<script>");
  const close = html.lastIndexOf("</script>");
  if (open < 0 || close < open) throw new Error("ui/terminal.html: the main <script> block was not found");
  const script = html.slice(open + "<script>".length, close);
  const body = html.slice(0, open) + '<script src="boot.js"></script>' + html.slice(close + "</script>".length);
  const doc =
    '<!doctype html>\n<html lang="en">\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n' +
    "<!-- Generated from ui/terminal.html by qortal/qapp/build-qapp.mjs. Edit the terminal there. -->\n" +
    body.trimEnd() +
    "\n</html>\n";
  return { index: doc, terminalJs: "/* Generated from ui/terminal.html by qortal/qapp/build-qapp.mjs. Edit the terminal there. */\n" + script.trim() + "\n" };
}

/**
 * Qortal Core reads and rewrites an app's HTML pages in the computer's default
 * charset (windows-1252 on Windows) and its HTML parser turns U+00A0 into
 * &nbsp;. A character whose UTF-8 bytes include one of these comes out as "�?"
 * (that is what happened to "● ENGINE ARMED"). Scripts and styles are left
 * alone by Qortal but escaped here too, so a page is safe whatever it holds.
 */
export const QORTAL_BAD_BYTES = new Set([0x81, 0x8d, 0x8f, 0x90, 0x9d, 0xa0]);
/** Look-alikes that survive, for the characters the pages use. */
export const QORTAL_STAND_INS = { "●": "•", "◐": "◑" };
/** Named entities Qortal's parser writes back as ASCII. Any other entity for a non-ASCII character is decoded first. */
const ASCII_ENTITIES = new Set(["amp", "lt", "gt", "quot", "apos", "nbsp"]);
const NAMED = { middot: "·", rarr: "→", larr: "←", harr: "↔", mdash: "—", ndash: "–", hellip: "…", times: "×", bull: "•", copy: "©", deg: "°", plusmn: "±", le: "≤", ge: "≥", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", euro: "€", pound: "£" };

const qortalBreaks = (ch) => [...Buffer.from(ch, "utf8")].some((b) => QORTAL_BAD_BYTES.has(b));

/** Make an HTML page survive Qortal Core on any operating system. Throws on a character with no stand-in. */
export function qortalSafeHtml(html, name = "page") {
  const out = [];
  let last = 0;
  const code = /<(script|style)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi;
  const escapeCode = (s, css) =>
    s.replace(/[^\x00-\x7f]/gu, (ch) => {
      const cp = ch.codePointAt(0);
      if (css) return "\\" + cp.toString(16).padStart(6, "0");
      return cp > 0xffff ? ch.split("").map((u) => "\\u" + u.charCodeAt(0).toString(16).padStart(4, "0")).join("") : "\\u" + cp.toString(16).padStart(4, "0");
    });
  const markup = (s) =>
    s
      .replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z][a-z0-9]*);/gi, (m, e) => {
        if (e[0] === "#") {
          const cp = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
          return cp < 0x80 || cp === 0xa0 ? m : String.fromCodePoint(cp);
        }
        if (ASCII_ENTITIES.has(e)) return m;
        if (NAMED[e]) return NAMED[e];
        throw new Error(`${name}: entity ${m} would be garbled by Qortal; write the character itself`);
      })
      .replace(/[^\x00-\x7f]/gu, (ch) => {
        if (ch === " ") return "&nbsp;";
        if (!qortalBreaks(ch)) return ch;
        if (QORTAL_STAND_INS[ch]) return QORTAL_STAND_INS[ch];
        throw new Error(`${name}: "${ch}" (U+${ch.codePointAt(0).toString(16).toUpperCase()}) is garbled by Qortal on Windows; add a stand-in to QORTAL_STAND_INS`);
      });
  for (const m of html.matchAll(code)) {
    out.push(markup(html.slice(last, m.index)));
    const open = m[0].slice(0, m[0].indexOf(">") + 1);
    const close = m[0].slice(m[0].lastIndexOf("<"));
    out.push(open + escapeCode(m[2], m[1].toLowerCase() === "style") + close);
    last = m.index + m[0].length;
  }
  out.push(markup(html.slice(last)));
  return out.join("");
}

/**
 * The app's files from a source tree (the repo, or a release being staged).
 * @param {(rel: string) => string} read reads a file relative to the tree root
 */
export function qappFiles(read) {
  const { index, terminalJs } = splitTerminal(read("ui/terminal.html"));
  return [
    { name: "index.html", data: qortalSafeHtml(index, "index.html") },
    { name: "terminal.js", data: terminalJs },
    { name: "boot.js", data: read("qortal/qapp/src/boot.js") },
    { name: "network.html", data: qortalSafeHtml(read("qortal/qapp/src/network.html"), "network.html") },
    { name: "network.js", data: read("qortal/qapp/src/network.js") },
    { name: "lib/registry.mjs", data: read("qortal/lib/registry.mjs") },
    { name: "lib/status.mjs", data: read("qortal/lib/status.mjs") },
  ];
}

export function build({ root = ROOT, appDir = join(root, "qortal", "qapp", "app"), zipPath = join(root, "qortal", "out", "arb-terminal-qapp.zip"), date = new Date() } = {}) {
  const files = qappFiles((rel) => readFileSync(join(root, rel), "utf8"));
  for (const f of files) {
    const p = join(appDir, f.name);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, f.data);
  }
  const zip = makeZip(files, date);
  mkdirSync(dirname(zipPath), { recursive: true });
  writeFileSync(zipPath, zip);
  return { files: files.map((f) => f.name), appDir, zipPath, bytes: zip.length };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const r = build();
  console.log(`Qortal app: ${r.files.length} files in ${r.appDir}`);
  console.log(`Publish this zip as an APP in Qortal Hub: ${r.zipPath} (${(r.bytes / 1024).toFixed(0)} KB)`);
}
