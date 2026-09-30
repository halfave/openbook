# Extractor: comparison → template `side-by-side`

A vs B vs C on the same attributes (software pricing, neighborhoods, programs).

## Search
- One query per item, on its own site first (pricing page, rate schedule), then one independent comparison source for cross-checking.
- Decide the rows before extracting: the attributes the question names, plus at most 3 the asker would need to decide (e.g. minimum monthly fee, per-unit price, setup fee).

## Fields
Per item, per row: a figure (`value`, `unit`, `source`, `url`, `as_of`) or short text. Pricing not published → the cell says "Not published — quote only" with the source that says so. Compute the asked-for total (e.g. 100 units) in a `derived`-style row with the formula in the label.

## Reconcile
Vendor page beats third-party review. Third-party figures older than 12 months go in `caveats` only.

## Fallback
Fewer than 2 items with data → `direct`.
