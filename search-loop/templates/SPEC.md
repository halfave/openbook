# Search templates spec: 10 question types, extractors and templates

Two layers, graded separately:

- **Extractor** (per question type, `search-loop/extractors/<type>.md`): how to search, which sources, which fields to pull, how to reconcile sources that disagree. Its output is a data JSON file. Judged by **number_extraction** and **precision** and **sourcing**.
- **Template** (per answer shape, `search-loop/templates/<name>.mjs`): how those fields render. Judged by **directness** and **template_fit**.

Two question types can share a template (the 10 types map onto 10 shapes today; expect some to merge into `metric` and `range` as the loop learns). `direct` is the fallback for questions nothing fits. The loop logs how often it's used: **over ~20% means the type set is wrong, not the templates.**

## Mapping

| Question type (`questions.json`) | Extractor | Template | Origin | Shape |
|---|---|---|---|---|
| pivot | `extractors/pivot.md` | `metric` | new | Big number + pivot dimension + scope + n + source + as-of; cross-check table; computed figures with formula |
| trend | `extractors/trend.md` | `answer-card` | existing (renderStat) | Latest figure + change + one row per period + sparkline |
| range | `extractors/range.md` | `range` | new | Low – high (typical), what puts you at each end, fee lines |
| comparison | `extractors/comparison.md` | `side-by-side` | existing (renderSide) | One column per item, one row per attribute, identical rows marked |
| fact | `extractors/fact.md` | `passages` | existing (renderPassages) | Answer paragraph, then the quoted passages it rests on, each cited |
| howto | `extractors/howto.md` | `steps` | new | Fees and deadline up top, numbered steps with where, sources |
| entity | `extractors/entity.md` | `dossier` | existing (renderAnswer) | Name, kind, 5–8 key fields, sources |
| regulation | `extractors/regulation.md` | `rule` | new | Threshold table (figure + period), applies to / exempt / effective, rule text citation, verdict for the asker's case |
| list | `extractors/list.md` | `list` | existing (renderCards) | Ranked table: #, name, ranking figure, source |
| yesno | `extractors/yesno.md` | `verdict` | new | Yes / No / Only if… first, condition table, rule basis |
| (none fits) | — | `direct` | fallback | Answer paragraph + sources |

## Data contract (extractor output → template input)

Written to `search-loop/log/<iter>-<qid>.data.json`:

```json
{
  "question_id": "q01", "question": "…", "type": "pivot", "extractor": "pivot", "template": "metric",
  "answer": "One or two sentences that state the answer, number included.",
  "…template's required fields…": "…",
  "conflicts": [{ "label": "…", "figures": [ {figure}, {figure} ], "resolution": "why they differ / which is headline" }],
  "caveats": ["…"],
  "notes": ["what was hard; what the template couldn't express — goes to Notes, not the rendered result"]
}
```

A **figure** is `{ "value": 1450, "prefix": "$", "unit": "/sqft", "basis": "median sold", "n": 23, "source": "Redfin", "url": "https://…", "as_of": "Jun–Aug 2026" }`.

## Rendering rules (all templates)

1. **The answer is the first thing on the page.** For number-shaped templates (`metric`, `answer-card`, `range`, `list`, `side-by-side` cells) that means the extracted figure, rendered from a figure object.
2. **Pivoted numbers are displayed, never pointed to.** Avg price, $/sqft, rent/bed, % change: the number with unit, the pivot dimension, the basis (median/average, sold/asking), sample size if published, source and as-of date. A link to the source sits beside the number, never in place of it. "See Redfin" is a failing result.
3. **Every number has a source and a date.** Templates render numbers only through `fig()` / `num()` + `cite()` in `_lib.mjs`. The renderer's check (`lint`) fails the render when a figure has no source, URL or as_of; when a value is a pointer ("see…", a URL); or when a $ or % amount in text isn't one of the extracted figures.
4. **Disagreement is shown, not hidden.** `conflicts` renders both figures with the reason.
5. **Mismatch is loud.** `metric` takes `asked` and `shown` ({ statistic, scope }); when they differ, a "Not exactly what you asked" line sits directly under the number. A figure a source shows only rounded or partial gets `"exact": false` and renders as "not published exactly", never as a value.
6. **Granularity is explicit.** When the figure's scope is wider or narrower than the question (ZIP not neighborhood, all apartments not 2BR), that goes in `caveats`, rendered right under the answer.
7. **No bloat.** No intro, no "it depends" without the conditions, no methodology essays; notes go to Notes.

## Per-template required fields

| Template | Required |
|---|---|
| metric | answer, figure, pivot, scope, asked, shown (optional: asked_unavailable, cross_check, derived, breakdown) |
| answer-card | answer, figure, covers (optional: change, breakdown, breakdown_label, metric_label) |
| range | answer, low, high, scope (optional: typical, components) |
| side-by-side | answer, items, rows (optional: winner) |
| passages | answer, passages |
| steps | answer, steps, sources (optional: needs, deadline) |
| dossier | answer, entity, kind, fields, sources |
| rule | answer, rule_name, citation, thresholds, applies_to (optional: exempt, effective, applies_here) |
| list | answer, rank_by, items (optional: basis, item_label) |
| verdict | answer, verdict, conditions, basis |
| direct | answer, sources (optional: more) |

## Render

```
node search-loop/templates/render.mjs search-loop/log/<iter>-<qid>.data.json search-loop/log/<iter>-<qid>.md
```

Exit 0 = clean; exit 2 = render-check problems (listed under Notes in the output file).
