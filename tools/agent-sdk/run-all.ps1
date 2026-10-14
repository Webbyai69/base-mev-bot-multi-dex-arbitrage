# Starts the three promo-credit jobs in parallel, each in its own window.
# Caps add up to $95 so the $100 promo credit isn't overrun.
# Run from the repo root:  powershell -ExecutionPolicy Bypass -File tools\agent-sdk\run-all.ps1
$repo = (Resolve-Path "$PSScriptRoot\..\..").Path
$jobs = @(
  @{ task = 8; budget = 45 },  # missed-trade replay
  @{ task = 6; budget = 35 },  # fork tests + gas calibration + CI
  @{ task = 2; budget = 15 }   # Curve/Balancer measure-first
)
foreach ($j in $jobs) {
  Start-Process powershell -WorkingDirectory $repo -ArgumentList @(
    "-NoExit", "-Command",
    "node tools\agent-sdk\run.mjs --task $($j.task) --budget $($j.budget)"
  )
  Start-Sleep -Seconds 5   # stagger git fetches
}
Write-Host "Started $($jobs.Count) jobs. Watch each window, or ..\base-arb-agent-worktrees\agent-runs.log"
