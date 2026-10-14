# Agent SDK worker (spends your API promo credit)

Runs one job from `docs/AGENT_TASKS.md` with the Claude Agent SDK, billed to the
API key's organization (your $100 promo credit covers the Agent SDK). Each job
gets its own git worktree and branch next to the repo, so it never touches your
live bot folder, `main`, `.env`, wallets or keys. When it finishes it pushes the
branch; you review and merge on GitHub.

## One-time setup (PowerShell)

1. Create a NEW API key in Joshua's Individual Org (platform.claude.com/settings/keys)
   and delete the old one that was in the screenshot.
2. Save it (never paste it into code or chat):
   ```powershell
   setx ANTHROPIC_API_KEY "paste-new-key"
   ```
   Optional, for read-only verification scripts:
   ```powershell
   setx BASE_RPC_URL "your-read-only-RPC-url"
   ```
   Close the window and open a fresh PowerShell.
3. In the repo folder:
   ```powershell
   git fetch origin
   git checkout agent-sdk/runner -- tools/agent-sdk
   cd tools\agent-sdk
   npm install
   cd ..\..
   ```

## Run all three promo-credit jobs at once

```powershell
powershell -ExecutionPolicy Bypass -File tools\agent-sdk\run-all.ps1
```

That starts task 8 ($45 cap), task 6 ($35) and task 2 ($15) in three windows.

## Run a single job

```powershell
node tools\agent-sdk\run.mjs --task 6 --budget 40
node tools\agent-sdk\run.mjs --task 8 --budget 50
```

Run them in two PowerShell windows to work in parallel. `--budget` is a hard cap
per run (it can overshoot slightly, so leave headroom against the $100).
`--model opus` is stronger but uses credit roughly 5x faster; Sonnet is the default.

Progress shows in the window and in `..\base-arb-agent-worktrees\agent-runs.log`.
Each job ends with a report in `docs/agent-reports/` on its branch.

## What it is blocked from

Reading `.env`, keys or wallet files; starting the bot (`npm start`, `run.cmd`);
sending transactions or `--broadcast`; pushing, merging or switching to `main`;
force-pushing; deploying; editing files outside its worktree.
