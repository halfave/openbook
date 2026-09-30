# Overnight search-template loop

**What it does:** each iteration, Claude Code picks a question, researches it with its built-in web search (no API credits), renders the answer through one of your search result templates, hands it to a fresh judge agent that scores it on a 10-point rubric, then edits the template if the score is under 8 and re-judges. Repeats until morning. First run also finds your 5 templates and scaffolds 5 more (10 total).

**Run** (PowerShell, from the repo root that contains your templates):
```powershell
.\search-loop\run-overnight.ps1
```
Optional: `-MaxIters 40 -StopHour 6`

**In the morning, read:**
- `search-loop/log/SCORES.csv` — one line per iteration, before/after score, top fix
- `search-loop/TEMPLATE_INVENTORY.md` — where the 5 live and what the 5 new ones are
- `search-loop/templates/SPEC.md` — the 10-template spec
- `git log --oneline` — one commit per iteration; revert any you dislike

**Files:** `LOOP.md` (the per-iteration instructions), `JUDGE.md` (rubric), `questions.json` (30 questions, 18 are pivoted-number questions), `state.json` (progress).

**Why not ChatGPT:** the judge is a separate Claude subagent that hasn't seen the search work, so it can't grade its own answer. Swap in ChatGPT later by replacing step 4 of `LOOP.md` with an OpenAI API call.

**Before bed check:** `claude --version` works, you're in the right repo, and `git status` is clean.
