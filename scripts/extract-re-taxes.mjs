// Reads each plan's projected first-year real estate taxes from its Schedule A price table, with no AI.
//
//   node scripts/extract-re-taxes.mjs            writes data/re-taxes/<PLAN_ID>.json
//   node scripts/extract-re-taxes.mjs --test out.json PLAN_ID ...   a few plans, report only
//
// Tables the model read (source "model" in data/schedule-a) already carry each home's monthly taxes and are used
// as they are. For the rest, pattern matching:
// Only plans with a checked Schedule A table (data/schedule-a, from extract-schedule-a.mjs) are read, so the
// units, their sizes and the page each row sits on are already known. For each unit, the row is found again on
// its page and the dollar amounts after the offering price are read. Many tables print the projected real
// estate taxes twice, monthly and annual; a pair of amounts where one is 12 times the other (within 0.5%) is a
// candidate. A column counts only when every unit has a pair there. The pair whose building total matches the
// Schedule B budget (total expenses / 12, within 3%) is the common charges, not taxes, and is set aside.
// A plan is "ok" when exactly one column is left, the page mentions real estate taxes, and the result lands
// between $0.05 and $6 a square foot a month; anything else (no pair, abated and unabated columns side by
// side, no budget to tell common charges apart) gets no file, so nothing unchecked is shown.
// Per square foot uses the units with a size, leaving out any whose rate is more than 2.5 times off the
// building's median (a misread size), and only when at least half the units are left.
// Re-run after extract-schedule-a.mjs, then run build-pages.mjs.
import { writeFile, mkdir, rm, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { all, rpc, ROOT } from "./site.mjs";

const test = process.argv[2] === "--test";
const out = test ? process.argv[3] : null;
const only = test ? process.argv.slice(4) : [];
const DATA = join(ROOT, "data", "re-taxes");

const schedA = new Map();
for (const f of await readdir(join(ROOT, "data", "schedule-a"))) {
  schedA.set(f.replace(/\.json$/, ""), JSON.parse(await readFile(join(ROOT, "data", "schedule-a", f), "utf8")));
}
const budget = new Map();
for (const r of await all("schedule_b?select=plan_id,total_expenses,line_items&status=eq.ok")) {
  // Plans with several budgets (residential, commercial) have no single total to compare against.
  if (Number(r.total_expenses) > 0 && new Set((r.line_items || []).map((it) => it.budget)).size <= 1) budget.set(r.plan_id, Number(r.total_expenses));
}

// Dollar amounts: "$ 1,205.75", "$14,469", or a bare figure with cents ("1,202.76").
const AMT = /\$\s?(\d{1,3}(?:,\d{3})*(?:\.\d{2})?|\d+(?:\.\d{2})?)|(?<![\d.,%])(\d{1,3}(?:,\d{3})*\.\d{2})(?![\d%])/g;
const num = (s) => Number(String(s).replace(/,/g, ""));
const priceText = (v) => [v.toLocaleString("en-US"), String(v)];
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// The amounts after the unit's price on its row (the row may wrap onto the next line), or null.
function amountsAfterPrice(lines, u) {
  const start = new RegExp(`^\\s*(?:unit\\s+|apt\\.?\\s+)?${escRe(u.unit)}(?![a-z0-9])`, "i");
  for (let k = 0; k < lines.length; k++) {
    if (!start.test(lines[k])) continue;
    for (const text of [lines[k], lines[k] + " " + (lines[k + 1] || "")]) {
      const t = text.replace(/\s+/g, " ");
      const at = priceText(u.price).map((p) => t.search(new RegExp(`\\$?\\s?${escRe(p)}(?:\\.00)?(?![\\d,])`))).find((i) => i >= 0);
      if (at == null) continue;
      const rest = t.slice(at).replace(/^\$?\s?[\d,]+(?:\.\d{2})?/, "");
      return [...rest.matchAll(AMT)].map((m) => num(m[1] || m[2]));
    }
  }
  return null;
}

// Candidate columns in one row: index of the monthly amount → monthly value, for each (monthly, annual) pair.
function pairs(amts) {
  const out = new Map();
  for (let i = 0; i < amts.length; i++) for (let j = 0; j < amts.length; j++) {
    const m = amts[i], a = amts[j];
    if (i !== j && Math.abs(i - j) <= 2 && m >= 5 && Math.abs(a - 12 * m) / a <= 0.005) out.set(`${i}:${j}`, m);
  }
  return out;
}

// Per square foot, from the units with a size. A unit whose rate is more than 2.5 times off the building's
// median is left out: its size was most likely misread (another area column, or the unit number).
function perSqft(units) {
  const sized = units.filter((u) => u.sqft > 0);
  const med = sized.map((u) => u.monthly / u.sqft).sort((x, y) => x - y)[sized.length >> 1];
  const used = sized.filter((u) => { const r = u.monthly / u.sqft / med; return r <= 2.5 && r >= 1 / 2.5; });
  const sqft = used.length && used.length >= units.length / 2 ? used.reduce((s, u) => s + u.sqft, 0) : null;
  return { perSf: sqft ? used.reduce((s, u) => s + u.monthly, 0) / sqft : null, n: sqft ? used.length : 0 };
}

async function readPlan(id) {
  const a = schedA.get(id);
  // Tables read by the model (extract-schedule-a-llm.mjs) already carry each unit's first-year monthly taxes, checked
  // against the table's printed totals; only the homes count, since the property-tax page counts homes.
  if (a.source === "model") {
    const homes = a.units.filter((u) => u.type === "residential" && u.price != null);
    if (!homes.length || homes.some((u) => !(u.tax_m > 0))) return { plan_id: id, status: "model_no_tax" };
    const units = homes.map((u) => ({ unit: u.unit, sqft: u.sqft, monthly: u.tax_m }));
    const { perSf, n } = perSqft(units);
    if (perSf != null && (perSf < 0.05 || perSf > 6)) return { plan_id: id, status: "implausible", perSf };
    return { plan_id: id, status: "ok", source: "model", monthly_total: Math.round(units.reduce((s, u) => s + u.monthly, 0) * 100) / 100,
      per_sf: perSf && Math.round(perSf * 1e4) / 1e4, sf_units: n, units, pages: a.pages };
  }
  let pages = null;
  for (let t = 0; t < 3; t++) { try { pages = await rpc("schedule_a_pages", { p_plan: id }); break; } catch (e) { if (t === 2) return { plan_id: id, status: "error" }; } }
  const byPage = new Map(pages.map((p) => [p.page_no, p.body]));
  const rows = a.units.map((u) => ({ u, amts: byPage.has(u.page) ? amountsAfterPrice(byPage.get(u.page).split(/\n/), u) : null }));
  if (rows.some((r) => !r.amts)) return { plan_id: id, status: "row_not_found", missing: rows.filter((r) => !r.amts).map((r) => r.u.unit) };
  const perRow = rows.map((r) => pairs(r.amts));
  const cols = [...perRow[0].keys()].filter((k) => perRow.every((p) => p.has(k)));
  if (!cols.length) return { plan_id: id, status: "no_pair" };
  const totals = cols.map((k) => ({ k, monthly: perRow.reduce((s, p) => s + p.get(k), 0) }));
  // Drop duplicates of one column read two ways (the same monthly values under different index pairs).
  const distinct = totals.filter((c, i) => totals.findIndex((d) => Math.abs(d.monthly - c.monthly) < 0.01) === i);
  const b = budget.get(id);
  const left = b ? distinct.filter((c) => Math.abs(c.monthly - b / 12) / (b / 12) > 0.03) : null;
  if (!left) return { plan_id: id, status: "no_budget", cols: distinct.map((c) => c.monthly) };
  const text = pages.map((p) => p.body).join(" ").replace(/\s+/g, " ");
  if (!/real\s+estate\s+tax|r\.?\s?e\.?\s+tax|property\s+tax/i.test(text)) return { plan_id: id, status: "no_tax_header" };
  if (left.length !== 1) return { plan_id: id, status: left.length ? "ambiguous" : "only_common_charges", cols: left.map((c) => c.monthly) };
  const col = left[0].k;
  const units = rows.map((r, i) => ({ unit: r.u.unit, sqft: r.u.sqft, monthly: perRow[i].get(col) }));
  const { perSf, n } = perSqft(units);
  if (perSf != null && (perSf < 0.05 || perSf > 6)) return { plan_id: id, status: "implausible", perSf };
  return { plan_id: id, status: "ok", monthly_total: Math.round(left[0].monthly * 100) / 100, per_sf: perSf && Math.round(perSf * 1e4) / 1e4, sf_units: n, units, pages: [...new Set(a.units.map((u) => u.page))] };
}

const ids = only.length ? only : [...schedA.keys()];
const results = [];
let i = 0;
async function worker() { while (i < ids.length) results.push(await readPlan(ids[i++])); }
await Promise.all(Array.from({ length: 6 }, worker));
const by = results.reduce((m, r) => ((m[r.status] = (m[r.status] || 0) + 1), m), {});
if (test) {
  await writeFile(out, JSON.stringify(results, null, 1));
  console.log(`${results.length} plans:`, by, "→", out);
} else {
  await rm(DATA, { recursive: true, force: true });
  await mkdir(DATA, { recursive: true });
  const ok = results.filter((r) => r.status === "ok");
  for (const r of ok) await writeFile(join(DATA, r.plan_id + ".json"), JSON.stringify({ monthly_total: r.monthly_total, per_sf: r.per_sf, sf_units: r.sf_units, units: r.units, pages: r.pages }));
  console.log(`${results.length} plans:`, by, `→ ${ok.length} files in data/re-taxes/`);
}
