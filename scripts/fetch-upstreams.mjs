#!/usr/bin/env node
/**
 * Fetch the upstream bots the fleet wraps, at their pinned commits.
 *
 * In a git clone, `git submodule update --init <path>` does this. A release
 * zip has no git history, so this script reads bots/upstream/PINS.json and
 * clones each upstream into its folder, then checks out the pinned commit.
 * Upstream code keeps its own licence (see bots/README.md): read it before
 * you use or redistribute a bot.
 *
 *   node scripts/fetch-upstreams.mjs                 every upstream
 *   node scripts/fetch-upstreams.mjs hummingbot      only the paths containing this text
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pinsFile = join(ROOT, "bots", "upstream", "PINS.json");
if (!existsSync(pinsFile)) {
  console.log("No bots/upstream/PINS.json: in a git clone, use git submodule update --init instead.");
  process.exit(0);
}
const only = process.argv[2] || "";
const { pins } = JSON.parse(readFileSync(pinsFile, "utf8"));
const run = (args, cwd) => spawnSync("git", args, { cwd, stdio: "inherit" }).status === 0;
let failed = 0;
for (const p of pins) {
  if (only && !p.path.includes(only)) continue;
  if (!p.url || !/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+(\.git)?$/.test(p.url) || !/^[0-9a-f]{40}$/.test(p.commit)) {
    console.log(`skip ${p.path}: unexpected pin`);
    failed++;
    continue;
  }
  const dir = join(ROOT, p.path);
  if (existsSync(dir) && readdirSync(dir).length) {
    console.log(`${p.path}: already present`);
    continue;
  }
  console.log(`${p.path}: cloning ${p.url} at ${p.commit.slice(0, 7)}`);
  if (!run(["clone", "--filter=blob:none", "--no-checkout", p.url, dir], ROOT) || !run(["checkout", "--quiet", p.commit], dir)) failed++;
}
process.exit(failed ? 1 : 0);
