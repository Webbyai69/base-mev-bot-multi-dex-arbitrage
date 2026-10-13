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
 * The app's files from a source tree (the repo, or a release being staged).
 * @param {(rel: string) => string} read reads a file relative to the tree root
 */
export function qappFiles(read) {
  const { index, terminalJs } = splitTerminal(read("ui/terminal.html"));
  return [
    { name: "index.html", data: index },
    { name: "terminal.js", data: terminalJs },
    { name: "boot.js", data: read("qortal/qapp/src/boot.js") },
    { name: "network.html", data: read("qortal/qapp/src/network.html") },
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
