# Extractor: regulation → template `rule`

What a rule says, its numbers, dates and who it covers.

## Search
- Primary text first: the agency's order or law (rentguidelinesboard.cityofnewyork.us, nyc.gov/hpd, nyc.gov/buildings LL97 pages, NYS legislation, NY Senate law text). Then one explainer from a law firm or agency FAQ to check reading.
- Confirm the version in force for the period asked (e.g. RGB Order # for the lease year).

## Fields
`rule_name`; `citation` (source, url, as_of, section); `thresholds` — each number as a figure with its `period` (lease start window, compliance period); `applies_to`, `exempt`, `effective`; `applies_here` when the question gives a case (a 6-unit building).

## Reconcile
Primary text beats explainer. If the explainer disagrees, the primary text wins and the disagreement goes in `caveats`.

## Fallback
Primary text unavailable → use two agreeing secondary sources and say so in `caveats`. Nothing → `direct`.
