# Extractor: trend → template `answer-card`

A metric over time: month by month, quarter by quarter, YoY/QoQ.

## Search
- Find a source that publishes the series itself (StreetEasy Data Dashboard, Miller Samuel/Elliman quarterly reports, Corcoran quarterly reports). One source for the whole series beats stitching sources together.
- Fetch the report per period if the series isn't on one page; each period's figure gets its own `source`/`url`/`as_of`.

## Fields
`figure` = the latest period. `breakdown` = one row per period, oldest first, same basis throughout. `change` = the latest move the question asks about (YoY or QoQ), computed from the series or taken from the source (say which). `covers` = metric + scope + basis.

## Reconcile
If the source revised a past period, use the latest revision and note it. Don't mix median and average, or asking and sold, in one series.

## Fallback
Only endpoints available → `answer-card` with two rows and a caveat. Nothing → `direct`.
