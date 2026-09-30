# Run from your repo root:  .\search-loop\run-overnight.ps1
# Stops at the hour set below or after MaxIters, whichever comes first.
param(
  [int]$MaxIters = 60,
  [int]$StopHour = 7,          # local hour to stop (7 = 7:00 AM)
  [int]$MaxTurns = 80
)

$ErrorActionPreference = "Continue"
$root = (Get-Location).Path
$loop = Join-Path $root "search-loop"
New-Item -ItemType Directory -Force -Path (Join-Path $loop "log") | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $loop "templates") | Out-Null

$state = Join-Path $loop "state.json"
if (-not (Test-Path $state)) { '{"iter":0,"templates_found":false,"scores":{}}' | Set-Content $state }

$scores = Join-Path $loop "log\SCORES.csv"
if (-not (Test-Path $scores)) { "iter,question_id,type,extractor,template,fallback,score_before,score_after,number_extraction,template_fit,fixed,top_fix" | Set-Content $scores }

$prompt = Get-Content (Join-Path $loop "LOOP.md") -Raw

for ($i = 1; $i -le $MaxIters; $i++) {
  $now = Get-Date
  if ($now.Hour -ge $StopHour -and $now.Hour -lt 12) { Write-Host "Stop hour reached."; break }

  Write-Host "=== Iteration $i  $($now.ToString('HH:mm')) ==="
  $out = Join-Path $loop "log\run-$i.txt"

  claude -p $prompt --max-turns $MaxTurns --dangerously-skip-permissions 2>&1 | Tee-Object -FilePath $out

  Start-Sleep -Seconds 20   # brief cooldown between iterations
}

Write-Host "Done. See search-loop\log\SCORES.csv and search-loop\log\*.judge.json"
