# The Condo Book Project - search correctness loop.
# Each round scores the structured searches in scripts/search-cases.json two ways:
#   node scripts/search-eval.mjs      answers vs. ground truth computed independently from the data (distances, facts,
#                                     averages) and every quoted line checked against the page it cites
#   node scripts/search-ui-check.mjs  what a visitor sees in a real browser: images, counts, filters, 390px, dark mode
# If anything fails, Claude Code (your Claude plan, not API credits) fixes it; the round is committed only when the
# failing checks go down and nothing that passed breaks. With -Critic, Codex (your ChatGPT plan) also reviews the
# screenshots against rubric.md once everything passes, and Claude acts on what it finds.
#
# Run from C:\Users\susan\Desktop\openbook-search-loop (branch search-loop):
#   powershell -ExecutionPolicy Bypass -File .\search-loop.ps1                 # fix until green, at most 6 rounds
#   powershell -ExecutionPolicy Bypass -File .\search-loop.ps1 -Critic -Max 10 # keep polishing the pages too
# Add a question: append a case to scripts/search-cases.json with its hand-checked answer key, then run the loop.
# First run only: npm i --prefix .loop/tools playwright@1.63.0
# Nothing is pushed. Review with: git log --oneline search-loop

param(
  [int]$Max = 6,
  [switch]$Critic
)

$ErrorActionPreference = "Stop"

# Keep both CLIs on their signed-in subscription accounts: no API keys, no API credits.
Remove-Item Env:ANTHROPIC_API_KEY -ErrorAction SilentlyContinue
Remove-Item Env:OPENAI_API_KEY -ErrorAction SilentlyContinue

$root = (Get-Location).Path
$loopDir = Join-Path $root ".loop"
New-Item -ItemType Directory -Force $loopDir | Out-Null
$history = Join-Path $loopDir "search-history.md"
if (-not (Test-Path $history)) { "# Search loop history`n" | Set-Content $history -Encoding utf8 }

$branch = (git branch --show-current).Trim()
if ($branch -ne "search-loop") { throw "Run this from the openbook-search-loop folder on branch search-loop; current branch: $branch" }
if (@(git status --porcelain).Count -gt 0) { throw "There are uncommitted changes. Commit or discard them before starting." }
if (-not (Test-Path (Join-Path $loopDir "tools\node_modules\playwright"))) { throw "Playwright missing. Run: npm i --prefix .loop/tools playwright@1.63.0" }

# Runs both checks; returns the names of every failing check ("case: check").
function Invoke-Checks {
  node scripts/search-eval.mjs | Tee-Object -FilePath (Join-Path $loopDir "eval.txt") | Out-Host
  node scripts/search-ui-check.mjs | Tee-Object -FilePath (Join-Path $loopDir "ui.txt") | Out-Host
  $fails = @()
  foreach ($f in "eval.json", "ui.json") {
    $j = Get-Content (Join-Path $loopDir $f) -Raw | ConvertFrom-Json
    foreach ($c in $j.cases) { foreach ($k in $c.checks) { if (-not $k.pass) { $fails += "$($c.id): $($k.name)" } } }
  }
  return ,$fails
}

$fails = Invoke-Checks
for ($i = 1; $i -le $Max; $i++) {
  Write-Host "== Round $($i): $($fails.Count) failing checks =="
  $before = (git rev-parse HEAD).Trim()
  $task = ""

  if ($fails.Count -eq 0) {
    if (-not $Critic) { Write-Host "All checks pass."; break }
    $shots = Get-ChildItem (Join-Path $loopDir "shots") -Filter "*-top.png" | Sort-Object Name
    $imgArgs = @(); foreach ($s in $shots) { $imgArgs += "-i"; $imgArgs += $s.FullName }
    $critique = Join-Path $loopDir "critique.txt"
    $criticPrompt = @"
You are reviewing structured search results on The Condo Book Project, a search tool for NYC condo offering plans. Read-only.
Read rubric.md, CLAUDE.md, scripts/search-cases.json (each case says what a correct page shows, in "why"), .loop/search-history.md,
search-intents.js and the structured-search section of index.html. The attached screenshots are the top of each case's results page, named by case id.
Judge each page as a developer who asked that question: is it easy to understand, is every building shown with an image, do the filters make sense for
that list, is anything stated that the data doesn't support, is anything the question asked for missing? Do not claim you tested what you only read.
Give at most 3 concrete, verifiable improvements, most consequential first, each with the evidence, the expected behavior and an acceptance check
(ideally a new check for scripts/search-eval.mjs or scripts/search-ui-check.mjs). Do not repeat anything rejected or done in the history.
If nothing consequential and feasible remains, reply exactly DONE.
"@
    codex exec --sandbox read-only --skip-git-repo-check -c model_reasoning_effort=medium @imgArgs -o $critique $criticPrompt
    if ($LASTEXITCODE -ne 0) { throw "Codex critique failed" }
    $c = (Get-Content $critique -Raw).Trim()
    if ($c -match '^DONE\W*$') { Write-Host "Critic found nothing consequential left."; break }
    $task = "All checks pass. A reviewer suggests these improvements (in .loop/critique.txt):`n$c`n`nImplement the ones that are accurate and feasible. Add a check to scripts/search-eval.mjs or scripts/search-ui-check.mjs for each one you implement, so it stays fixed."
  } else {
    $task = "These checks fail (details in .loop/eval.txt, .loop/ui.txt, .loop/eval.json, .loop/ui.json; screenshots in .loop/shots):`n- " + ($fails -join "`n- ") + "`n`nFix the causes in search-intents.js and index.html."
  }

  $prompt = @"
You are improving the structured searches of The Condo Book Project (search-intents.js, rendered by index.html).
$task

Rules:
- Read CLAUDE.md, rubric.md, scripts/search-cases.json and .loop/search-history.md first.
- Fix the search or the page, not the test. Change scripts/search-cases.json or a check only if the answer key or check is provably wrong, and say why with the page text that proves it.
- Never invent prices, sales, units, professionals or citations. Every finding shown must come from the data with its page.
- No AI or paid API calls in the search path. Keep the Supabase URL, publishable key and existing RPCs; read-only; no new keys; no database changes.
- Keep element ids, ?q= search-on-load, light and dark themes. Don't hand-edit buildings/*.html.
- Re-run node scripts/search-eval.mjs and node scripts/search-ui-check.mjs to confirm. Do not commit, push or deploy.
End with "Implemented:" (what changed) and "Deferred or rejected:" (with reasons).
"@
  $editFile = Join-Path $loopDir "edit.txt"
  claude -p $prompt --permission-mode acceptEdits --allowedTools "Bash(node scripts/search-eval.mjs*)" "Bash(node scripts/search-ui-check.mjs*)" "Read" "Edit" "Write" "Grep" "Glob" | Tee-Object -FilePath $editFile
  if ($LASTEXITCODE -ne 0) { throw "Claude edit failed" }

  if (@(git status --porcelain).Count -eq 0) { Add-Content $history "`n## Round $i - no change`n$task" -Encoding utf8; Write-Host "No changes made; stopping."; break }

  $after = Invoke-Checks
  $broke = @($after | Where-Object { $fails -notcontains $_ })
  if ($after.Count -lt $fails.Count -or ($fails.Count -eq 0 -and $after.Count -eq 0)) {
    if ($broke.Count -gt 0) {
      Add-Content $history "`n## Round $i - rejected: broke $($broke -join '; ')`n$task`n`nClaude:`n$(Get-Content $editFile -Raw)" -Encoding utf8
      git checkout -- . ; git clean -fdq -- scripts search-intents.js index.html
      Write-Warning "Round $i broke passing checks; reverted."
      continue
    }
    git add -A
    git commit -qm "search loop round ${i}: $($fails.Count) -> $($after.Count) failing checks"
    Add-Content $history "`n## Round $i - committed $((git rev-parse --short HEAD).Trim()) ($($fails.Count) -> $($after.Count) failing)`n$task`n`nClaude:`n$(Get-Content $editFile -Raw)" -Encoding utf8
    $fails = $after
  } else {
    Add-Content $history "`n## Round $i - rejected: $($fails.Count) -> $($after.Count) failing`n$task`n`nClaude:`n$(Get-Content $editFile -Raw)" -Encoding utf8
    git checkout -- . ; git clean -fdq -- scripts search-intents.js index.html
    Write-Warning "Round $i didn't reduce failures; reverted."
  }
}

Write-Host "Done. $($fails.Count) failing checks. Review with: git log --oneline search-loop; screenshots in .loop\shots"
