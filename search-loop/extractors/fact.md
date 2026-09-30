# Extractor: fact → template `passages`

"What is X and when did it take effect" — a definition plus the key dates or numbers.

## Search
- The law or agency page that defines it, plus one reputable news or explainer source for context.

## Fields
`answer`: one paragraph that answers every part of the question (what + when + who). `passages`: 1–3 short quotes (under 30 words) with `source`, `url`, `as_of`, `locator` (section or heading). Any number in `answer` must also be a figure (put it in a `key_figures` list of figures).

## Fallback
Only secondary sources → still `passages`, caveat that the primary text wasn't reached.
