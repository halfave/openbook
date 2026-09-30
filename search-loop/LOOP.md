# Search Template Improvement Loop — one iteration

You are running one iteration of an overnight loop. State persists in `search-loop/state.json`; logs go in `search-loop/log/`. Do the work, update state, and stop. Do not ask the user anything — they are asleep. Make the most reasonable call and note it in the log.

## Goal
Search results should answer a question **completely on the page** — the user should never need to click through. Pivoted numbers (average price, price per square foot, rent per bedroom, median by neighborhood, year-over-year %) must be **extracted and displayed as the number**, with source and as-of date, not "see Redfin".

Two layers, improved separately (see `search-loop/templates/SPEC.md`):
- **Extractor** per question type — `search-loop/extractors/<type>.md`: how to search, which sources, which fields, how to reconcile. Did it get the number?
- **Template** per answer shape — `search-loop/templates/<name>.mjs`: how the fields render. Did it show the number well?
- **Fallback** — `templates/direct.mjs` for questions no template fits. Track its use; over ~20% of iterations means the question types are wrong.

## Scope — hard rules
- Edit **only files under `search-loop/`**. Never touch `index.html`, `building.js`, `buildings/`, `scripts/` or any other site file. The site's templates in `index.html` render database data; these are the loop's copies (see `TEMPLATE_INVENTORY.md`).
- The working tree may have other people's uncommitted changes. Never `git add -A`, `git add .`, `git stash`, `git checkout`, `git reset` or `git merge`. Stage and commit by path only (step 8).
- Never push.

## Setup (only if `state.json` has no `templates_found`)
Already done: `TEMPLATE_INVENTORY.md`, `templates/SPEC.md`, `templates/*.mjs`, `extractors/*.md`. If `templates_found` is missing, set it to true and continue.

## Iteration
1. **Pick.** Read `state.json`. Pick the next question from `search-loop/questions.json` in order after `state.last_question` (rotate). Prefer questions whose last score < 8; never skip `pivot` questions. Let N = `state.iter + 1`.
2. **Extract.** Follow `search-loop/extractors/<type>.md` for the question's type. Use your **WebSearch** and **WebFetch** tools (no API keys, no paid services). For pivot questions, fetch at least 2 sources and extract the actual figures; compute averages/medians yourself when sources give components. Write the result as data JSON (contract in `templates/SPEC.md`) to `search-loop/log/<N>-<question_id>.data.json`, choosing the template the SPEC maps the type to, or `direct` if it truly doesn't fit (say why in `notes`).
3. **Render.** `node search-loop/templates/render.mjs search-loop/log/<N>-<qid>.data.json search-loop/log/<N>-<qid>.md`. Exit 2 means a render-check problem (unsourced figure, pointer instead of a number, missing field): fix the data if the extractor missed something, or leave it and let the judge see it — never invent a source to pass the check. The file has the sections Question / Template used / Rendered result / Data extracted / Notes.
4. **Judge.** Spawn a subagent that has not seen your work. Give it the full text of `search-loop/JUDGE.md` plus the full text of the rendered `.md` file, and nothing else. It returns JSON. Save it to `search-loop/log/<N>-<qid>.judge.json`.
5. **Diagnose.** If overall < 8, decide which layer failed:
   - `number_extraction`, `precision` or `sourcing` lowest → **extractor** problem (wrong sources, wrong scope, missed sample size, didn't reconcile).
   - `directness` or `template_fit` lowest, or the rendered page hides a number that is in the data → **template** problem.
   - Template `direct` used → note whether an existing template could have fit, or a new type is needed.
6. **Improve** the failing layer, once: edit `extractors/<type>.md` or `templates/<name>.mjs` (and `_lib.mjs` / `SPEC.md` if a shared rule changes). Prefer changes that generalize to the whole type/shape; don't hardcode this question. Then redo only what the change affects (re-extract for an extractor change, re-render for a template change), writing `<N>-<qid>.after.data.json` / `<N>-<qid>.after.md`, and re-judge once with a fresh subagent → `<N>-<qid>.after.judge.json`. After a template edit, re-render one earlier log's data file with the new template to check it still renders (exit 0 or same problems as before).
7. **Log.** Append one line to `search-loop/log/SCORES.csv` (quote any field containing a comma):
   `iter,question_id,type,extractor,template,fallback,score_before,score_after,number_extraction,template_fit,fixed,top_fix`
   - `fallback` = 1 if template was `direct`, else 0. `number_extraction`, `template_fit` = from the first judge (N/A → empty). `fixed` = `extractor`, `template`, or `none`. `score_after` = empty if no re-judge.
   - Then compute the fallback rate over all rows so far. If it is over 20% with at least 10 rows, add a line to `search-loop/log/FLAGS.md` naming the questions that fell back.
8. **Save & commit.** Update `state.json`: `iter = N`, `last_question = <qid>`, `scores[<qid>] = { "before": x, "after": y, "iter": N, "template": "...", "fixed": "..." }`, `fallback_count`. Then:
   ```
   git add -- search-loop
   git commit -m "search-loop: iter N — <template> <score_before>→<score_after>" -- search-loop
   ```

## Rules
- Never delete templates or extractors. Never change unrelated code.
- If WebSearch returns nothing useful, log it and move on; do not fabricate numbers.
- Every displayed number needs a source and date. A number without a source is a failing result.
- Run everything in the foreground; don't wait on background jobs.
- Stop after this one iteration.
