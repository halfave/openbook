// QA for Schedule A readings the extractor held back (data/schedule-a-llm/<ID>.json, verdict "hold"): is the reading
// wrong, or does the plan's own table not add up?
//
//   node scripts/qa-schedule-a-held.mjs prepare    writes each held reading in the published format to data/schedule-a-qa-held/input/
//   node scripts/qa-schedule-a.mjs --all --pub data/schedule-a-qa-held/input --out data/schedule-a-qa-held
//                                                  re-reads them from the page images and adjudicates (as for published tables)
//   node scripts/qa-schedule-a-held.mjs report     applies the confirmed fixes to each held reading, runs the checks again,
//                                                  and writes data/schedule-a-qa-held/summary.json
//
// Report classes: "fixable" (after the confirmed fixes every check that failed now passes), "plan_does_not_reconcile"
// (the reading matches the page but the plan's own figures fail a check), "still_failing" (fixed cells, still failing),
// "unresolved" / "unreadable" (QA couldn't settle it). Nothing is published or changed by this script.
import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { all, money, ROOT } from "./site.mjs";

const LLM = join(ROOT, "data", "schedule-a-llm"), DIR = join(ROOT, "data", "schedule-a-qa-held"), IN = join(DIR, "input");
const mode = process.argv[2];
const held = [];
for (const f of (await readdir(LLM)).filter((f) => f.endsWith(".json"))) {
  const m = JSON.parse(await readFile(join(LLM, f), "utf8"));
  if (m.verdict === "hold" && m.units?.length) held.push(m);
}
const toPub = (u) => ({ unit: u.unit, type: u.type, floor: u.floor, beds: u.beds, baths: u.baths, sqft: u.int_sf, outdoor_sqft: u.ext_sf,
  price: u.price, pct: u.pct, cc_m: u.cc_m, tax_m: u.tax_m, carry_m: u.carry_m, page: u.page });

if (mode === "prepare") {
  await mkdir(IN, { recursive: true });
  for (const m of held) {
    const units = m.units.map(toPub);
    const pages = [...new Set([...(m.located_pages || []), ...units.map((u) => u.page)].filter(Boolean))].sort((a, b) => a - b);
    await writeFile(join(IN, m.plan_id + ".json"), JSON.stringify({ source: "held", checked: null, failed: m.steps?.at(-1)?.failed || [], units, pages }));
  }
  console.log(`${held.length} held readings written to ${IN}`);
  process.exit(0);
}

if (mode !== "report") { console.log("usage: prepare | report"); process.exit(1); }
const meta = new Map((await all("plans?select=plan_id,meta")).map((p) => [p.plan_id, p.meta?.plan || {}]));
const near = (a, b, tol) => a != null && b ? Math.abs(a - b) / Math.abs(b) <= tol : false;
const sum = (a) => a.reduce((s, x) => s + (x || 0), 0);
// The checks that decide publishing in extract-schedule-a-llm.mjs, for the figures QA can confirm.
function checks(units, printed, ag) {
  const c = {}, res = units.filter((u) => u.type === "residential");
  const total = sum(units.map((u) => u.price));
  c.ag = ag.length ? ag.some((a) => near(total, a, 0.03)) : null;
  c.printed = printed?.price ? near(total, printed.price, 0.005) : null;
  const pcts = units.map((u) => u.pct).filter((x) => x != null);
  c.pct100 = pcts.length ? sum(pcts) >= 99 && sum(pcts) <= 101 : null;
  const car = units.filter((u) => u.carry_m != null && u.cc_m != null && u.tax_m != null);
  c.carrying = car.length ? car.every((u) => Math.abs(u.carry_m - u.cc_m - u.tax_m) <= 2) : null;
  c.monthlyTotals = [["cc_m", printed?.cc_m], ["tax_m", printed?.tax_m]].every(([k, t]) => !t || Math.abs(sum(units.map((u) => u[k])) - t) <= Math.max(2, t * 0.002));
  const r = res.filter((u) => u.cc_m > 0 && u.pct > 0).map((u) => u.cc_m / u.pct);
  if (r.length >= 3) { const med = [...r].sort((a, b) => a - b)[r.length >> 1]; c.ccProportional = r.every((x) => Math.abs(x - med) / med <= 0.03); }
  c.uniqueLabels = new Set(units.map((u) => String(u.unit).toUpperCase().trim())).size === units.length;
  return c;
}
const failedOf = (c) => Object.entries(c).filter(([, v]) => v === false).map(([k]) => k);
const out = [], by = {};
for (const m of held) {
  const qf = join(DIR, m.plan_id + ".json");
  const q = JSON.parse(await readFile(qf, "utf8").catch(() => "null"));
  const mp = meta.get(m.plan_id) || {};
  const ag = [money(mp["Initial Price"]), money(mp["Current Price"])].filter(Boolean);
  const units = m.units.map(toPub);
  const before = failedOf(checks(units, m.printed_totals, ag));
  let cls, fixed = 0;
  if (!q || ["unreadable", "error", "not_published"].includes(q.verdict)) cls = q ? "unreadable" : "not_checked";
  else {
    // Apply what Opus confirmed: cell values, labels, rows that don't exist, rows that were missed.
    for (const x of q.findings || []) {
      if (x.outcome === "published_wrong") {
        const u = units.find((u) => u.unit === (x.field === "unit" ? x.published : x.unit) && (x.field === "unit" || u[x.field] === x.published || (u[x.field] != null && x.published != null && Math.abs(u[x.field] - x.published) < 0.006)));
        if (u && (x.printed != null || x.field === "carry_m")) { u[x.field] = x.printed; fixed++; }
      } else if (x.outcome === "published_unit_not_in_table") {
        const i = units.findIndex((u) => u.unit === x.unit); if (i >= 0) { units.splice(i, 1); fixed++; }
      } else if (x.outcome === "unit_missing_from_published") {
        const r = (q.read_units || []).find((r) => r.unit === x.unit);
        if (r && x.printed != null) { units.push({ ...toPub({ ...r, type: "residential" }), price: x.printed }); fixed++; }
      }
    }
    const after = failedOf(checks(units, m.printed_totals, ag));
    const unresolved = (q.findings || []).filter((f) => f.outcome === "unresolved").length;
    cls = !after.length ? "fixable" : unresolved ? "unresolved" : fixed ? "still_failing" : "plan_does_not_reconcile";
    out.push({ plan_id: m.plan_id, cls, failed_before: before, failed_after: after, cells_fixed: fixed, unresolved,
      cells_compared: q.cells_compared, cells_agreeing: q.cells_agreeing, units: units.length });
    by[cls] = (by[cls] || 0) + 1;
    continue;
  }
  out.push({ plan_id: m.plan_id, cls, failed_before: before, reason: q?.reason || null });
  by[cls] = (by[cls] || 0) + 1;
}
await writeFile(join(DIR, "summary.json"), JSON.stringify(out, null, 1));
console.log(`${held.length} held readings:`, by);
const why = {}; for (const o of out.filter((o) => o.cls === "plan_does_not_reconcile")) for (const k of o.failed_after) why[k] = (why[k] || 0) + 1;
console.log("checks the plans' own figures fail:", why);
