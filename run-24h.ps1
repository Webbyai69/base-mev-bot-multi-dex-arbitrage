# Runs the paper-trading bot for a fixed time, then stops it and writes a summary.
# Usage: powershell -ExecutionPolicy Bypass -File run-24h.ps1 [-Hours 24]
param([double]$Hours = 24)

# Not "Stop": the bot logs warnings to stderr, which PowerShell 5.1 would treat as fatal.
$ErrorActionPreference = "Continue"
Set-Location $PSScriptRoot
$stamp = Get-Date -Format "yyyy-MM-dd_HHmm"
$out = "reports\run-$stamp.log"
$err = "reports\run-$stamp.err.log"
$startDay = (Get-Date).ToUniversalTime().ToString("yyyy-MM-dd")

$bot = Start-Process -FilePath "node" -ArgumentList "--max-old-space-size=256", "dist/main.js", "run" `
  -RedirectStandardOutput $out -RedirectStandardError $err -WindowStyle Hidden -PassThru
Set-Content -Path "reports\run-24h.status.txt" -Encoding utf8 -Value @"
bot pid $($bot.Id) started $(Get-Date -Format s), stops after $Hours h
log: $out
"@

# Poll instead of Wait-Process -Timeout, which caps at 32767 s (~9 h).
$deadline = (Get-Date).AddHours($Hours)
while (-not $bot.HasExited -and (Get-Date) -lt $deadline) { Start-Sleep -Seconds 30 }
$exited = $bot.HasExited
if (-not $exited) { Stop-Process -Id $bot.Id -Force }

$endDay = (Get-Date).ToUniversalTime().ToString("yyyy-MM-dd")
node dist/main.js summary *> "reports\summary-$stamp.txt"
node dist/main.js report $startDay *> $null
if ($endDay -ne $startDay) { node dist/main.js report $endDay *> $null }

$how = if ($exited) { "bot exited on its own (see $err)" } else { "stopped after $Hours h" }
Add-Content -Path "reports\run-24h.status.txt" -Encoding utf8 -Value "finished $(Get-Date -Format s): $how; summary in reports\summary-$stamp.txt"
