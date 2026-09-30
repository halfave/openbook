# Extractor: yesno → template `verdict`

"Can a landlord…", "Is it legal…", "Does X apply…".

## Search
- The governing rule (statute, regulation, agency guidance) and one authoritative explainer (agency FAQ, tenant-rights guide from the AG/HCR/HPD).

## Fields
`verdict`: "Yes", "No", or "Only if …" — the first word the user reads. `conditions`: [{ when, then }] — each condition that flips or limits the answer (lease says so, amount limit, regulated unit). `basis`: the rule(s) with section.

## Reconcile
Regulated vs market-rate units often differ: make that a condition row, not a caveat.

## Fallback
No rule found → `direct` saying no rule was found, with what was searched.
