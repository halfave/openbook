# Extractor: range → template `range`

"How much does X cost" where the honest answer is low–typical–high.

## Search
- Official fee schedules first (NYC DOB fee schedule, agency rules). Then 2+ practitioner or survey sources for the non-fee parts (professional fees, premiums).
- Split the cost into components: government fees (exact, cited) and variable costs (ranges, cited).

## Fields
`low`, `typical` (if a source gives one), `high`: each a figure plus `drivers` (what puts a case there). `components`: fee lines. `scope`: what's included and excluded.

## Reconcile
If sources' ranges don't overlap, show both in `conflicts` and say why (scope, year, building size).

## Fallback
Only one sourced end → `range` with that end and a caveat on the other. Nothing → `direct`.
