# Extractor: list → template `list`

"Top N by metric".

## Search
- One source that ranks the whole set on one basis (a market report table, a data dashboard). Stitching figures from different sources into one ranking is only allowed if every figure has the same basis and period — say so in `basis`.

## Fields
`rank_by` (metric + basis), `items`: [{ name, figure, note? }] in rank order, `basis`: period, property type, minimum sample rule if the source has one.

## Reconcile
If a second source ranks differently, list its top 3 in `conflicts`.

## Fallback
Fewer than N ranked → show what's ranked and say how many are missing. Nothing → `direct`.
