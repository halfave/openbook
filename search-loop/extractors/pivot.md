# Extractor: pivot → template `metric`

Questions asking for one number cut along a dimension: avg/median price, $/sqft, rent per bedroom, per unit, fee %, cost per kWh, cap rate, days on market.

## Search
1. Parse the question into: **metric** (price, rent, fee, cost), **statistic** (average or median — keep the one asked; say so if a source gives the other), **pivot** (per sqft, per bedroom, per unit, % of rent), **scope** (neighborhood, property type, bedroom count, building size), **period** ("right now" = latest month or quarter published; "last 90 days"; a year).
2. Query with the neighborhood + property type + metric words + the current year, e.g. `Carroll Gardens condo price per square foot 2026`. Then query the named primary sources directly (below).
3. Fetch **at least 2 independent sources** and read the page, not the search snippet.

## Sources, best first
- Market reports with stated methodology: Corcoran, Douglas Elliman/Miller Samuel, Brown Harris Stevens, StreetEasy Data Dashboard, UrbanDigs, REBNY.
- Portal neighborhood pages (Redfin, Zillow, Realtor.com, StreetEasy): usable, but record their basis (median sale vs list, which period, which property types).
- Agencies for costs and rates: Con Edison tariffs, NYC Water Board rate schedule, NYSERDA, NYC DOF.
- Industry surveys for fees and cap rates: name the survey and its sample.
- Not usable as a figure: SEO blogs without a named data source, AI-summary pages, figures with no period.

## Fields for the template
`asked`: { statistic, scope } exactly as the question puts them ("average", "condos only"). `shown`: the same for the headline figure you picked ("median", "all home types"). `asked_unavailable`: one sentence on why the asked version isn't shown, if it isn't. A figure a source shows only rounded ("$1K") gets `"exact": false` with the value as displayed; never expand it into a precise number.

`pivots`: when the question asks for several cuts ("per bedroom and per square foot"), one row per cut, in the question's order: `{ label, figure, note }`. Label is the cut as asked; note flags a scope that differs from the headline ("large buildings only"). A cut with no usable figure still gets a row, with `note` saying why. Keep the headline `basis` under ~12 words; contradictions in a source's labelling go in `notes`, not the basis.

## Fields to pull (per source; each becomes a figure)
`value` (number), `prefix`/`unit`, `basis` (median/average + sale or asking), `n` (sample size if published), `source`, `url`, `as_of` (the period the data covers, not the page's publish date if they differ — say which), `scope` as the source defines it.

## Compute
- If sources give components (price and sqft; rent and bedrooms), compute the pivot yourself and put it in `derived` with the formula and inputs.
- Don't average medians from different sources into a new number. Pick the headline by: exact scope match > larger n > more recent > methodology stated. Put the rest in `cross_check`.

## Reconcile
If two figures for the same scope differ by more than 10%, add a `conflicts` entry with both, and say why (asking vs sold, period, property mix, sample size). Never drop the disagreeing one silently.

## Fallback
No source gives the pivot at the asked scope → use the closest scope, state the gap in `caveats` ("Carroll Gardens figure not published; this is the 11231 ZIP"). No usable figure at all → template `direct`, say so, don't estimate.
