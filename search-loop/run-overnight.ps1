# Run from a standalone PowerShell window (not the Claude desktop Terminal panel, which dies with the app/session):
#   .\search-loop\run-overnight.ps1
# Stops at the hour set below or after MaxIters, whichever comes first.
param(
  [int]$MaxIters = 60,
  [int]$StopHour = 7,          # local hour to stop (7 = 7:00 AM)
  [int]$MaxTurns = 80, 
  [int]$IterTimeoutMin = 60    # kill an iteration that runs longer than this
)

$ErrorActionPreference = "Continue"

# Run on the claude.ai (Max) login, never API credits: an API key in the environment takes precedence over the login.
# Clear it (and anything else that would redirect auth or mark this as a nested Claude Code session) for this
# PowerShell process only; child processes inherit the cleaned environment. User-level variables are left alone.
foreach ($v in 'ANTHROPIC_API_KEY','ANTHROPIC_AUTH_TOKEN','OPENAI_API_KEY','CLAUDECODE','CLAUDE_CODE_ENTRYPOINT') {
  Remove-Item "Env:$v" -ErrorAction SilentlyContinue
}

# Paths come from the script's own location, so the current directory doesn't matter.
$loop = $PSScriptRoot
$root = Split-Path $loop -Parent
Set-Location $root
$logDir = Join-Path $loop "log"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

# Resolve claude.exe directly (the npm claude.ps1 shim re-quotes arguments and wraps stderr in PowerShell errors).
$claude = (Get-Command claude.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1).Source
if (-not $claude) {
  $shim = (Get-Command claude -ErrorAction SilentlyContinue).Source
  if ($shim) { $claude = Join-Path (Split-Path $shim) "node_modules\@anthropic-ai\claude-code\bin\claude.exe" }
}
if (-not $claude -or -not (Test-Path $claude)) { Write-Host "claude.exe not found."; exit 1 }

# Refuse to start unless the CLI is on the claude.ai subscription login.
$auth = & $claude auth status 2>$null | Out-String
try { $authJson = $auth | ConvertFrom-Json } catch { $authJson = $null }
if (-not $authJson -or $authJson.authMethod -ne 'claude.ai') {
  Write-Host "Not on the claude.ai login (auth status: $auth). Not running."
  exit 1
}
Write-Host "Auth: $($authJson.authMethod), subscription $($authJson.subscriptionType)"

$state = Join-Path $loop "state.json"
if (-not (Test-Path $state)) { '{"iter":0,"templates_found":false,"scores":{}}' | Set-Content $state }

$scores = Join-Path $logDir "SCORES.csv"
if (-not (Test-Path $scores)) { "iter,question_id,type,extractor,template,fallback,score_before,score_after,number_extraction,template_fit,fixed,top_fix" | Set-Content $scores }

# Pass a short ASCII prompt and let Claude read LOOP.md itself. Passing the file's text as an argument goes through
# PowerShell 5.1's native-argument quoting (embedded " are not escaped) and Get-Content's ANSI default (mangles UTF-8).
$prompt = "Read search-loop/LOOP.md in this repository and carry out exactly one iteration as it describes. The user is asleep; do not ask questions."

for ($i = 1; $i -le $MaxIters; $i++) {
  $now = Get-Date
  if ($now.Hour -ge $StopHour -and $now.Hour -lt 12) { Write-Host "Stop hour reached."; break }

  $stamp = $now.ToString('yyyyMMdd-HHmm')
  $out = Join-Path $logDir "run-$stamp.json"
  $err = Join-Path $logDir "run-$stamp.err.txt"
  $head = (git rev-parse HEAD)
  Write-Host "=== Iteration $i  $($now.ToString('HH:mm'))  -> $out ==="

  $argList = @('-p', "`"$prompt`"", '--output-format', 'json', '--max-turns', $MaxTurns, '--dangerously-skip-permissions')
  $p = Start-Process -FilePath $claude -ArgumentList $argList -NoNewWindow -PassThru `
         -RedirectStandardOutput $out -RedirectStandardError $err
  if (-not $p.WaitForExit($IterTimeoutMin * 60 * 1000)) {
    Write-Host "Iteration timed out after $IterTimeoutMin min; killing."
    & taskkill /PID $p.Id /T /F | Out-Null
  }

  # Report how it ended.
  try {
    $r = Get-Content $out -Raw | ConvertFrom-Json
    Write-Host ("  {0}  turns={1}  error={2}" -f $r.subtype, $r.num_turns, $r.is_error)
  } catch { Write-Host "  no JSON result (see $err)" }
  $errText = if (Test-Path $err) { Get-Content $err -Raw } else { '' }
  if ($errText -match 'ANTHROPIC_API_KEY|API key|auth source') {
    Write-Host "  stderr mentions an API key; stopping so no credits are used:"; Write-Host $errText
    break
  }
  if ((git rev-parse HEAD) -eq $head) { Write-Host "  no new commit this iteration" }
  else { Write-Host "  committed: $(git log -1 --oneline)" }

  Start-Sleep -Seconds 20   # brief cooldown between iterations
}

Write-Host "Done. See search-loop\log\SCORES.csv and search-loop\log\*.judge.json"
