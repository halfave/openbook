# The Condo Book Project - site improvement loop.
# Codex (ChatGPT plan) critiques and reviews; Claude Code (Claude plan) edits.
# Run from C:\Users\susan\Desktop\openbook-loop with the server already running:
#   window 1:  npx -y serve -l 3000 .
#   window 2:  powershell -ExecutionPolicy Bypass -File .\loop.ps1
# Nothing is pushed. Review with: git log --oneline design-loop

param(
  [string]$Url = "http://localhost:3000",
  [int]$Max = 5,
  [string]$BuildingPath = "/buildings/1-prospect-park-west-brooklyn-cd180123.html"
)

$ErrorActionPreference = "Stop"

# Keep both CLIs on their signed-in subscription accounts.
Remove-Item Env:ANTHROPIC_API_KEY -ErrorAction SilentlyContinue
Remove-Item Env:OPENAI_API_KEY -ErrorAction SilentlyContinue

$root = (Get-Location).Path
$artifactDir = Join-Path $root ".loop"

function Assert-Exit([string]$Step) {
  if ($LASTEXITCODE -ne 0) { throw "$Step failed with exit code $LASTEXITCODE" }
}

function Assert-Server {
  try {
    $r = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 10
    if ($r.StatusCode -ne 200) { throw "HTTP $($r.StatusCode)" }
  } catch {
    throw "Local server is not running at $Url. In another window run: npx -y serve -l 3000 ."
  }
}

function Shot([string]$Name, [string]$Path, [string]$Viewport = "1440,900", [int]$WaitMs = 8000) {
  $out = Join-Path $artifactDir "$Name.png"
  npx -y playwright@1.63.0 screenshot --full-page --wait-for-timeout=$WaitMs --viewport-size=$Viewport "$Url$Path" $out
  Assert-Exit "Screenshot $Name"
}

# Safety checks: right branch, clean tree, server up.
$branch = (git branch --show-current).Trim()
if ($branch -ne "design-loop") { throw "Run this from the openbook-loop folder on design-loop; current branch: $branch" }
if (@(git status --porcelain).Count -gt 0) { throw "There are uncommitted changes. Commit or discard them before starting." }
Assert-Server

New-Item -ItemType Directory -Force $artifactDir | Out-Null
$historyFile = Join-Path $artifactDir "history.md"
if (-not (Test-Path $historyFile)) { "# Loop history`n" | Set-Content $historyFile }

for ($i = 1; $i -le $Max; $i++) {
  Write-Host "== Round $i =="
  Assert-Server
  $before = (git rev-parse HEAD).Trim()

  Shot "home-desktop"   "/" "1440,900" 3000
  Shot "home-mobile"    "/" "390,844" 3000
  Shot "precedent"      "/?q=parking%20sold%20separately"
  Shot "pricing"        "/?q=Compare%20pricing%20in%20Carroll%20Gardens"
  Shot "budget"         "/?q=Schedule%20B%20budget"
  Shot "team"           "/?q=managing%20agent"
  Shot "floorplans"     "/?q=floor%20plans%20Prospect%20Place"
  Shot "results-mobile" "/?q=parking%20sold%20separately" "390,844"
  Shot "building"       $BuildingPath
  Shot "about"          "/about.html" "1440,900" 3000

  $criticPrompt = @"
You are reviewing The Condo Book Project, a developer-facing search tool for NYC condo offering plans. Work in read-only mode.

Read rubric.md, CLAUDE.md, .loop/history.md, the relevant source files, and all attached screenshots (in order: home desktop, home mobile, searches for precedent, pricing, Schedule B budget, managing agent, floor plans, precedent results on mobile, a building page, the about page). Inspect the code where screenshots cannot establish behavior. Do not claim you tested something you only inferred from code.

Evaluate the whole user journey:
- Can someone search an address or plan ID and reach the right building?
- Do natural-language precedent searches return defensible matches?
- Are text matches distinguished from verified facts, such as a unit sold?
- Do pricing, Schedule B, team and floor-plan searches lead to useful documents, page references and building pages?
- Do amendments, coverage gaps and source limitations remain clear?
- Are navigation, buttons, layout, mobile behavior, accessibility and branding coherent?

Prioritize the most consequential current issue. Suggest at most 3 changes that can be implemented and verified in one round. For each give:
1. The evidence and where you saw it.
2. The expected behavior.
3. An acceptance check.
4. Any source or data limitation that prevents a truthful fix.

Do not repeat a rejected or completed suggestion from history. Do not suggest hand-editing generated buildings/*.html.
If no consequential, feasible improvement remains, reply exactly DONE.
"@

  $feedbackFile = Join-Path $artifactDir "feedback.txt"
  $shots = "home-desktop","home-mobile","precedent","pricing","budget","team","floorplans","results-mobile","building","about"
  $imgArgs = @(); foreach ($s in $shots) { $imgArgs += "-i"; $imgArgs += (Join-Path $artifactDir "$s.png") }
  codex exec --sandbox read-only --skip-git-repo-check -c model_reasoning_effort=medium @imgArgs -o $feedbackFile $criticPrompt
  Assert-Exit "Codex critique"

  $feedback = Get-Content $feedbackFile -Raw
  Write-Host $feedback
  if ($feedback.Trim() -match '^DONE\W*$') { Write-Host "Critic found nothing consequential left."; break }

  $editPrompt = @"
Read the critique in .loop/feedback.txt, plus rubric.md, CLAUDE.md and .loop/history.md.

Use your judgment. Implement only suggestions that are accurate, feasible and supported by the current data. You may reject a suggestion; say why in your final response. Prefer one complete, verifiable improvement over several partial ones.

Stay inside the CLAUDE.md boundaries. Do not hand-edit generated building HTML; change its generator if needed. Do not invent prices, sales, professionals or document citations. Do not commit, push or deploy.
"@
  claude -p $editPrompt --permission-mode acceptEdits
  Assert-Exit "Claude edit"

  if (@(git status --porcelain).Count -eq 0) {
    Add-Content $historyFile "`n## Round $i - no edit (Claude declined)`n$feedback"
    Write-Host "Claude made no changes; stopping."
    break
  }

  git diff --check
  Assert-Exit "Whitespace check"
  Assert-Server

  $reviewFile = Join-Path $artifactDir "review.txt"
  $reviewPrompt = @"
Review the uncommitted changes against commit $before, using .loop/feedback.txt, rubric.md and CLAUDE.md. Inspect git diff and the changed files.

Check for regressions in search interpretation, results, source links, amendment and coverage language, the generated-page workflow, element ids, ?q= loading, themes, mobile layout and accessibility. Verify the edit actually addresses the accepted critique. Do not edit files.

Reply exactly PASS if it is safe to commit. Otherwise start with FAIL and list specific defects and how to reproduce them. Do not demand unrelated features.
"@
  codex exec --sandbox read-only --skip-git-repo-check -c model_reasoning_effort=medium -o $reviewFile $reviewPrompt
  Assert-Exit "Codex review"

  $review = (Get-Content $reviewFile -Raw).Trim()
  Write-Host $review
  if ($review -notmatch '^PASS\b') {
    Add-Content $historyFile "`n## Round $i - failed review`n$feedback`n`n$review"
    Write-Warning "Review failed. Changes left uncommitted for you to inspect (git diff). Nothing was pushed."
    break
  }

  git add -A
  git commit -qm "site loop round $i"
  Assert-Exit "Commit"
  Add-Content $historyFile "`n## Round $i - committed $((git rev-parse --short HEAD).Trim())`n$feedback"
}

Write-Host "Done. Review with: git log --oneline design-loop"
