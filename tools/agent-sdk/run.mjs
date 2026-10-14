#!/usr/bin/env node
// Agent SDK worker for base-arb-bot.
//
// Runs one task from docs/AGENT_TASKS.md (or a custom prompt file) with the
// Claude Agent SDK, billed to the ANTHROPIC_API_KEY you set, on its own git
// worktree and branch. It never touches main, your .env, your wallet or the
// live bot. When it finishes it commits and pushes the branch so you can
// review and merge it yourself.
//
// Usage (PowerShell, from the repo root):
//   node tools/agent-sdk/run.mjs --task 6 --budget 25
//   node tools/agent-sdk/run.mjs --prompt-file my-task.md --branch agent/my-task --budget 10
//
// Options:
//   --task N          Task number from docs/AGENT_TASKS.md (1-8)
//   --prompt-file F   Use your own prompt file instead of a numbered task
//   --branch B        Branch name (default: the task's own branch)
//   --budget USD      Hard spend cap for this run (default 20)
//   --model M         sonnet (default, cheaper) or opus
//   --base B          Branch to start from (default: main)
//   --no-push         Commit locally but don't push

import { query } from "@anthropic-ai/claude-agent-sdk";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, mkdirSync, appendFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..", "..");

// ---------- args ----------
const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : def;
};
const flag = (name) => args.includes(`--${name}`);

const taskNo = opt("task");
const promptFile = opt("prompt-file");
const budget = Number(opt("budget", "20"));
const model = opt("model", "sonnet");
const base = opt("base", "main");
const push = !flag("no-push");

if (!process.env.ANTHROPIC_API_KEY) {
  fail("ANTHROPIC_API_KEY isn't set. In PowerShell: setx ANTHROPIC_API_KEY \"your-key\" then open a new window.");
}
if (!taskNo && !promptFile) fail("Pass --task N (1-8) or --prompt-file FILE.");
if (!(budget > 0 && budget <= 100)) fail("--budget must be between 0 and 100 USD.");

// ---------- task prompt ----------
let taskPrompt;
let branch = opt("branch");
if (taskNo) {
  const md = readFileSync(join(repo, "docs", "AGENT_TASKS.md"), "utf8");
  const sections = md.split(/\n## (?=\d+\.)/);
  const section = sections.find((s) => s.startsWith(`${taskNo}.`));
  if (!section) fail(`Task ${taskNo} not found in docs/AGENT_TASKS.md`);
  const block = section.match(/```text\n([\s\S]*?)```/);
  if (!block) fail(`Task ${taskNo} has no prompt block`);
  taskPrompt = block[1];
  branch ??= (taskPrompt.match(/Work on a new branch: ([\w/-]+)/) || [])[1];
} else {
  taskPrompt = readFileSync(resolve(promptFile), "utf8");
}
if (!branch) fail("Couldn't work out a branch name. Pass --branch agent/your-name.");
if (/^(main|master|release\/|deploy\/)/.test(branch)) fail(`Refusing to work on protected branch ${branch}.`);

// ---------- worktree ----------
const git = (cwd, ...a) => execFileSync("git", a, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const wtRoot = join(repo, "..", "base-arb-agent-worktrees");
const wt = join(wtRoot, branch.replace(/\//g, "__"));
mkdirSync(wtRoot, { recursive: true });

git(repo, "fetch", "origin", base);
if (!existsSync(wt)) {
  const remoteHas = (() => { try { git(repo, "rev-parse", "--verify", `origin/${branch}`); return true; } catch { return false; } })();
  if (remoteHas) {
    git(repo, "fetch", "origin", branch);
    git(repo, "worktree", "add", "-B", branch, wt, `origin/${branch}`);
  } else {
    git(repo, "worktree", "add", "-B", branch, wt, `origin/${base}`);
  }
}
log(`Worktree: ${wt}`);
log(`Branch:   ${branch} (from ${base})  Model: ${model}  Budget cap: $${budget}`);

// ---------- safety ----------
// Things the agent may never do, checked before every tool call.
const BLOCKED = [
  [/(^|[\s"'\\/])\.env(?!\.example)\b/i, "the .env file holds your keys and RPC URLs"],
  [/keystore|private[_-]?key|mnemonic|seed phrase/i, "wallet secrets"],
  [/git\s+(push\s+.*\b(main|master)\b|push\s+(-f|--force)|merge\b|rebase\s+.*\bmain\b.*--onto|reset\s+--hard\s+origin\/main)/i, "pushing/merging main or force-pushing"],
  [/git\s+checkout\s+(main|master)\b|git\s+switch\s+(main|master)\b/i, "switching to main"],
  [/\b(npm\s+(run\s+)?start|run\.cmd|node\s+dist\/main\.js(?!\s+(check|discover|report|digest)))\b/i, "starting the bot"],
  [/new-wallet|sendTransaction|eth_sendRawTransaction|cast\s+send|forge\s+script.*--broadcast/i, "sending transactions"],
  [/wrangler\s+(deploy|publish)|gh\s+pr\s+merge/i, "deploying or merging"],
  [/\brm\s+-rf\s+[\/~]|Remove-Item.*-Recurse.*(C:\\|~)/i, "deleting outside the worktree"],
];

const inside = (p) => {
  if (!p) return true;
  const full = resolve(wt, p);
  return full.toLowerCase().startsWith(resolve(wt).toLowerCase());
};

async function guard(toolName, input) {
  const text = JSON.stringify(input ?? {});
  for (const [re, why] of BLOCKED) {
    if (re.test(text)) return { behavior: "deny", message: `Blocked: ${why}. Work around it or note it for the owner.` };
  }
  if (["Edit", "Write", "MultiEdit", "NotebookEdit"].includes(toolName)) {
    const p = input?.file_path ?? input?.notebook_path;
    if (!inside(p)) return { behavior: "deny", message: "Blocked: only edit files inside this worktree." };
  }
  return { behavior: "allow", updatedInput: input };
}

// ---------- prompt ----------
const rules = `
YOU ARE RUNNING UNATTENDED as an Agent SDK worker on the owner's Windows PC.
Working copy: ${wt} (a git worktree on branch ${branch}, started from origin/${base}).
The task text below may name an older base branch; ignore that and build on this worktree, which is already up to date with ${base}.

Extra rules on top of the task's own:
- The bot is LIVE on this machine from a different folder. Never start, stop or touch it, never read .env, never touch wallets or keys, never send transactions.
- BASE_RPC_URL ${process.env.BASE_RPC_URL ? "is set in your environment for read-only verification scripts" : "is NOT set; skip RPC verification steps and say so in your summary"}.
- Install deps with npm ci in the worktree if needed. Build with npm run build, test with npm test (and forge test if Foundry is installed).
- Commit as you go with clear messages. Don't push; the runner pushes your branch when you finish.
- You have a hard budget of about $${budget}. Prioritise a working, tested core over breadth. If you run low, stop at a clean commit.
- Finish by writing docs/agent-reports/${branch.replace(/\//g, "-")}.md: what you built, test results, what's left, and anything the owner must decide.
`;

// ---------- run ----------
const childEnv = { ...process.env };
for (const k of Object.keys(childEnv)) {
  if (/PRIVATE|SECRET|MNEMONIC|WALLET|TELEGRAM|CLOUDFLARE|WRANGLER|GITHUB_TOKEN|GH_TOKEN/i.test(k)) delete childEnv[k];
}

let cost = 0;
let resultText = "";
const started = Date.now();
try {
  for await (const msg of query({
    prompt: `${rules}\n\n----- TASK -----\n${taskPrompt}`,
    options: {
      cwd: wt,
      model,
      maxBudgetUsd: budget,
      maxTurns: 400,
      permissionMode: "default",
      canUseTool: guard,
      // The hook runs before EVERY tool call, including ones that would
      // otherwise be auto-approved, so the block list can't be skipped.
      hooks: {
        PreToolUse: [{
          hooks: [async (input) => {
            const verdict = await guard(input.tool_name, input.tool_input);
            if (verdict.behavior === "deny") {
              log(`blocked: ${input.tool_name} ${summarise(input.tool_input)}`);
              return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: verdict.message } };
            }
            return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" } };
          }],
        }],
      },
      settingSources: ["project"],
      systemPrompt: { type: "preset", preset: "claude_code" },
      env: childEnv,
    },
  })) {
    if (msg.type === "assistant") {
      for (const part of msg.message?.content ?? []) {
        if (part.type === "text" && part.text.trim()) log(`claude: ${part.text.trim().slice(0, 400)}`);
        if (part.type === "tool_use") log(`tool:   ${part.name} ${summarise(part.input)}`);
      }
    } else if (msg.type === "result") {
      cost = msg.total_cost_usd ?? cost;
      resultText = msg.result ?? msg.subtype ?? "";
    }
  }
} catch (e) {
  log(`Run stopped: ${e?.message ?? e}`);
}

// ---------- commit + push ----------
try {
  git(wt, "add", "-A");
  try { git(wt, "commit", "-m", `agent-sdk: work on ${branch}`); } catch { /* nothing new */ }
  if (push) {
    git(wt, "push", "-u", "origin", branch);
    log(`Pushed ${branch}. Open a PR on GitHub to review it; nothing was merged.`);
  }
} catch (e) {
  log(`Git step failed: ${e?.stderr ?? e?.message ?? e}`);
}

const mins = ((Date.now() - started) / 60000).toFixed(1);
log(`Done in ${mins} min. Estimated cost: $${Number(cost).toFixed(2)} of $${budget} cap.`);
if (resultText) log(`Summary: ${String(resultText).slice(0, 2000)}`);

// ---------- helpers ----------
function summarise(input) {
  const s = input?.command ?? input?.file_path ?? input?.pattern ?? "";
  return String(s).replace(/\s+/g, " ").slice(0, 160);
}
function log(line) {
  const out = `[${new Date().toISOString().slice(11, 19)}] ${line}`;
  console.log(out);
  try { appendFileSync(join(wtRoot, "agent-runs.log"), `${branch} ${out}\n`); } catch {}
}
function fail(m) { console.error(`\n  ${m}\n`); process.exit(1); }
