# Search result templates — inventory

## The 5 existing templates (site, `index.html`)

All five are inline render functions in `index.html`, picked in `runP` (the block commented "Result template: one building → dossier; buildings side by side → comparison; a number → answer card; otherwise the list"). They came in with commit 8fd14eed0 "Result templates: answer card, side-by-side comparison, dossier passages" (branch `result-templates`, merged to main). They render **Supabase plan data** (search_plans_v2, plan_sections, plans), not web sources.

| # | Template | Code | Question shape it serves | What it renders |
|---|---|---|---|---|
| 1 | Answer card | `renderStat(P)` (index.html ~1708), chosen by `parseStat` (~866), `body.stat` | A number question: "average", "how many", "per year", "by borough", "Brooklyn vs Queens", "which sponsor filed the most" | The figure (count, avg/median offering price per unit, units, parking), what it covers, a breakdown table by year/borough/sponsor/law firm/construction whose rows open to the buildings behind them, a year chart. Where the data doesn't exist (sale prices, $/sf, common charges) it says "not tracked" (`GAPS`) and shows the nearest real figure. |
| 2 | Side-by-side comparison | `renderSide(rows)` (~1820), chosen by `parseCompare` (~899), `body.answer` | Two or more named buildings: plan IDs, or addresses with "compare"/"vs"/"and" | A table, one column per building: address, borough/ZIP, accepted date, construction, plan type, sponsor, counsel, units, current/initial offering price, and page references into Schedule A/B, floor plans and so on. Rows that match across buildings are faint. |
| 3 | Dossier (single building) | `renderAnswer(r, P)` (~1558), when an address or plan ID matches exactly one plan | "What's at 123 Main St", a plan ID alone | Name, address, and links to the building page and its documents (floor plans, Schedule A pricing, Schedule B budget, declaration, bylaws, management agreement). |
| 4 | Passages | `renderPassages(rows)` (~1528), `P.view === "passages"`, `body.mention` | "Which plans mention X", or a plan ID/address plus extra words | Matching passages grouped by building: building name, plan ID and borough, then each passage with its document and page. |
| 5 | List (cards) | `renderCards(rows)` (~717), default, `body.plain` | Everything else: filters, text search, "newest", "largest" | Result cards (up to 60) with a title ("12 Matching Buildings in Brooklyn") and a status line saying how they're ranked, plus the map. |

`renderExtract` (~1965) also exists: it shows the AI tier's `/api/ask` answer. It's a fallback path, not a template, and this loop doesn't use it (no API credits).

## What the loop uses

The loop's questions (`questions.json`) are general NYC market and rules questions answered from the web, not from the offering-plan database. The site templates can't render them without new data sources. The site also deliberately marks $/sf and sale prices "not tracked", and CLAUDE.md says never to invent prices. So **the loop never edits `index.html`**. It works on copies in `search-loop/templates/*.mjs`:

- The 5 existing shapes are ported as markdown renderers of extracted figures: `answer-card`, `side-by-side`, `dossier`, `passages`, `list`.
- 5 new ones: `metric`, `range`, `rule`, `steps`, `verdict`.
- One fallback: `direct`.

A shape that wins overnight can be ported back into the site by hand, with a data source the site actually has.

Spec: `templates/SPEC.md`. Extractors: `extractors/*.md`.
