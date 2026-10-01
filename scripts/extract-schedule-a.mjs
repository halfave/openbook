// Reads each plan's Schedule A price table from the page text, with no AI: pattern matching only.
//
//   node scripts/extract-schedule-a.mjs            all plans; writes data/schedule-a/<PLAN_ID>.json
//   node scripts/extract-schedule-a.mjs --test out.json PLAN_ID ...   a few plans, report only
//
// For each plan with searchable text, schedule_a_pages() returns the pages most likely to hold the table
// (many prices and common-interest percentages). A table row is a line that starts with a unit number and
// has a price and a percentage. The sum of the prices is checked against the total offering price on the
// AG record: status "ok" when it matches within 3%, else "mismatch". Plans that pass get a static file
// the building page reads (data/schedule-a/<PLAN_ID>.json); the rest get nothing, so nothing unchecked is shown.
//
// Model results (data/schedule-a-llm/<PLAN_ID>.json, from extract-schedule-a-llm.mjs) take precedence per plan:
// a table that passed its checks replaces the pattern-matched one; a table held by those stricter checks removes
// it, unless the model read the same prices (then the pattern table stays, except for placeholder prices);
// "not found" leaves it. Re-run after new plans are loaded or the model pass adds plans, then run build-buildings.mjs.
import { writeFile, mkdir, rm, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { all, rpc, money, ROOT } from "./site.mjs";

const test = process.argv[2] === "--test";
const out = test ? process.argv[3] : null;
const only = test ? process.argv.slice(4) : [];
const DATA = join(ROOT, "data", "schedule-a");

const MONEY = /\$\s?(\d{1,3}(?:,\d{3})+|\d{4,})(?:\.\d{2})?/g;
// Some tables print prices without "$", or a scan turned "$" into "S": a comma-grouped number of 20,000 or more.
const BARE = /(?:^|\s)S?(\d{2,3}(?:,\d{3})+|\d(?:,\d{3}){2,})(?:\.\d{2})?(?=\s|$)/g;
const PCT = /(\d{1,2}\.\d{2,6})\s?%/;
const NOT_UNIT = /^(total|totals|subtotal|unit|units|residential|commercial|parking|storage|notes?|schedule|page|the|a|an|estimated|projected|percentage|price|offering)$/i;
const num = (s) => Number(String(s).replace(/,/g, ""));

function headerInfo(text) {
  const h = text.toLowerCase();
  return { bed: /\bbr\b|bed(room)?s?\b|\bbdrm/.test(h), bath: /\bbath|\bba\b/.test(h) };
}

// One table row, or null.
function parseRow(line, hdr, bare) {
  const l = line.replace(/\s+/g, " ").trim();
  const pm = PCT.exec(l);
  if (!pm) return null;
  let monies = [...l.matchAll(MONEY)].map((m) => ({ v: num(m[1]), i: m.index }));
  if (bare && !monies.some((m) => m.v >= 20000)) monies = [...l.matchAll(BARE)].map((m) => ({ v: num(m[1]), i: m.index }));
  // The price is the first dollar amount of $20,000 or more; the percentage can come before or after it.
  const priceM = monies.find((m) => m.v >= 20000);
  if (!priceM) return null;
  // Unit number: the first token, like 101, 2B, PH-A, P-3, "Unit 4C", or "Penthouse 2".
  const um = l.match(/^(?:unit\s+|apt\.?\s+)?((?:ph|penthouse|p|s|c|com|retail)?[\s-]?[a-z0-9]{1,5}(?:[-/.][a-z0-9]{1,4})?)\b/i);
  if (!um) return null;
  const unit = um[1].replace(/\s+/g, " ").trim();
  if (NOT_UNIT.test(unit) || !/\d|^ph|^[a-z]$/i.test(unit)) return null;
  if (/^\d$/.test(unit) && l[um.index + um[0].length] === "/") return null; // "0/ two half baths": a bed/bath figure, not a unit
  if (/^\d+\.\d{2,}$/.test(unit)) return null; // a percentage or decimal, not a unit number
  // Numbers between the unit and the price: square feet, bedrooms, bathrooms (and sometimes outdoor space).
  // Bracketed notes like "*Cellar [410.50 sf]" are dropped so their numbers aren't read as the unit's size.
  // Half baths written "3-1/2" or "3½" become 3.5.
  const mid = l.slice(um.index + um[0].length, Math.min(priceM.i, pm.index)).replace(/\[[^\]]*\]|\([^)]*\)/g, " ")
    .replace(/(\d)\s*(?:-\s*1\/2|½)/g, "$1.5");
  const studio = /\bstudio\b|\bstu\b/i.test(mid);
  // "2 & 2", "2/1.5", "3+3.5", "1 BR / 1 BA", "2 Bedrooms/2 Bathrooms", "1BD/1BA": bedrooms and baths written as a pair.
  const pair = mid.match(/(?:^|\s)(\d|studio)\s*(?:br|bd|bed(?:room)?s?)?\s*(?:&|\/|\+|and)\s*(\d(?:\.\d)?)\s*(?:ba(?:th(?:room)?)?s?)?(?=[\s;,]|$)/i);
  const nums = [...(pair ? mid.replace(pair[0], " ") : mid).matchAll(/(?<![\w.])(\d{1,2}(?:,\d{3})+|\d+(?:\.\d)?)(?![\w%])/g)].map((m) => num(m[1]));
  const big = nums.filter((n) => n >= 150 && n <= 30000);
  const small = nums.filter((n) => n <= 9);
  const sqft = big.length ? big[0] : null;
  let beds = null, baths = null;
  if (hdr.bed && hdr.bath && small.length >= 2) { beds = small[small.length - 2]; baths = small[small.length - 1]; }
  else if (hdr.bath && studio && small.length >= 1) { beds = 0; baths = small[small.length - 1]; }
  else if (hdr.bed && !hdr.bath && small.length >= 1) beds = small[small.length - 1];
  if (pair) { beds = /studio/i.test(pair[1]) ? 0 : Number(pair[1]); baths = Number(pair[2]); }
  if (studio) beds = 0;
  if (beds != null && (beds > 8 || !Number.isInteger(beds))) beds = null;
  return { unit, sqft, beds, baths, price: priceM.v, pct: Number(pm[1]) };
}

function parsePages(pages, bare) {
  const units = new Map();
  for (const pg of pages) {
    const lines = pg.body.split(/\n/);
    const firstRow = lines.findIndex((x) => parseRow(x, { bed: false, bath: false }, bare));
    const hdr = headerInfo(lines.slice(0, Math.max(firstRow, 0) + 1).join(" "));
    for (let k = 0; k < lines.length; k++) {
      let r = parseRow(lines[k], hdr, bare);
      // A row wrapped onto the next line: "1-A *Cellar [410.50 sf]" then "First Floor 1,296.84 … 13.91% $845,000".
      // Joined only when this line is a stub (a unit number and more words, no percentage), the next line is not
      // a row, a total or a note of its own, and the joined price is plausible for the size.
      if (!r && k + 1 < lines.length && /^\s*\S+\s+\S/.test(lines[k]) && !PCT.test(lines[k])
        && !/^\s*(sub)?totals?\b/i.test(lines[k + 1]) && !parseRow(lines[k + 1], hdr, bare)) {
        const joined = lines[k] + " " + lines[k + 1];
        const j = /not for sale|\bnotes?\b|×|\bx\s*\(/i.test(joined) ? null : parseRow(joined, hdr, bare);
        if (j && (!j.sqft || (j.price / j.sqft >= 150 && j.price / j.sqft <= 6000))) { r = j; k++; }
      }
      if (r && !units.has(r.unit.toUpperCase())) units.set(r.unit.toUpperCase(), { ...r, page: pg.page_no });
    }
  }
  return [...units.values()];
}

const plans = await all("plans?select=plan_id,meta&order=plan_id");
const meta = new Map(plans.map((p) => [p.plan_id, p.meta || {}]));
const docs = await all("documents?select=plan_id&status=eq.done&doc_kind=eq.offering_plan&order=plan_id");
const ids = only.length ? only : [...new Set(docs.map((d) => d.plan_id))];

const results = [];
let i = 0, done = 0;
async function worker() {
  while (i < ids.length) {
    const id = ids[i++];
    let pages = [];
    for (let t = 0; t < 3; t++) { try { pages = await rpc("schedule_a_pages", { p_plan: id }); break; } catch (e) { if (t === 2) pages = null; } }
    const mp = meta.get(id)?.plan || {};
    const agPrices = [money(mp["Initial Price"]), money(mp["Current Price"])].filter(Boolean);
    if (!pages || !pages.length) { results.push({ plan_id: id, status: pages ? "not_found" : "error", units: [], ag_price: agPrices[0] || null }); }
    else {
      // Strict reading first (prices marked "$"); if it doesn't add up, also accept bare prices.
      const check = (units) => { const total = units.reduce((s, u) => s + u.price, 0); return { units, total, match: agPrices.find((a) => Math.abs(total - a) / a <= 0.03) }; };
      let res = check(parsePages(pages, false));
      if (!res.match) { const alt = check(parsePages(pages, true)); if (alt.match || !res.units.length) res = alt; }
      let { units, total, match } = res;
      // Sanity checks on a matching table: most sized homes should land between $150 and $6,000 a square foot,
      // and the common-interest column should add up to about 100% (otherwise it was misread and is dropped).
      const sized = units.filter((u) => u.sqft);
      const odd = sized.filter((u) => u.price / u.sqft < 150 || u.price / u.sqft > 6000).length;
      if (match && sized.length && odd / sized.length > 0.05) match = undefined;
      const pctSum = units.reduce((s, u) => s + (u.pct || 0), 0);
      if (pctSum < 95 || pctSum > 105) units = units.map((u) => ({ ...u, pct: null }));
      results.push({
        plan_id: id, file_id: pages[0].file_id, pages: [...new Set(units.map((u) => u.page))],
        units, unit_count: units.length, price_total: total, ag_price: match || agPrices[0] || null,
        status: !units.length ? "not_found" : match ? "ok" : "mismatch",
      });
    }
    if (++done % 100 === 0) console.log(`${done}/${ids.length}`);
  }
}
await Promise.all(Array.from({ length: 6 }, worker));
const by = results.reduce((m, r) => ((m[r.status] = (m[r.status] || 0) + 1), m), {});
if (test) {
  await writeFile(out, JSON.stringify(results));
  console.log(`${results.length} plans:`, by, "→", out);
} else {
  await rm(DATA, { recursive: true, force: true });
  await mkdir(DATA, { recursive: true });
  const files = new Map(results.filter((r) => r.status === "ok")
    .map((r) => [r.plan_id, { source: "pattern", units: r.units, unit_count: r.unit_count, price_total: r.price_total, pages: r.pages }]));
  const npat = files.size;
  const llm = { published: 0, held: 0, confirmed: 0 };
  // At least 90% of the pattern table's prices found in the model's reading, and the model read no more than 10% extra.
  const samePrices = (a, b) => {
    const left = new Map();
    for (const u of b) if (u.price != null) left.set(u.price, (left.get(u.price) || 0) + 1);
    let hit = 0;
    for (const u of a) if (left.get(u.price) > 0) { hit++; left.set(u.price, left.get(u.price) - 1); }
    const nb = b.filter((u) => u.price != null).length;
    return a.length > 0 && hit >= 0.9 * a.length && nb <= 1.1 * a.length;
  };
  const LLM = join(ROOT, "data", "schedule-a-llm");
  for (const f of await readdir(LLM).catch(() => [])) {
    if (!f.endsWith(".json")) continue;
    const m = JSON.parse(await readFile(join(LLM, f), "utf8"));
    if (/^publish/.test(m.verdict)) {
      const units = m.units.map((u) => ({ unit: u.unit, type: u.type, floor: u.floor, beds: u.beds, baths: u.baths, sqft: u.int_sf,
        outdoor_sqft: u.ext_sf, price: u.price, pct: u.pct, cc_m: u.cc_m, tax_m: u.tax_m, carry_m: u.carry_m, page: u.page }));
      files.set(m.plan_id, { source: "model", checked: m.verdict === "publish_ag" ? "ag_total" : "printed_total", budget_period: m.budget_period,
        units, unit_count: units.length, price_total: m.price_total, pages: [...new Set(units.map((u) => u.page).filter(Boolean))] });
      llm.published++;
    } else if (m.verdict === "hold") {
      // A held reading still confirms a pattern-matched table when it found the same prices (compared as a multiset,
      // so unit-name formatting doesn't matter): two independent readings agree, and the pattern table already tied
      // out to the AG total. Placeholder plans (one price for every home) stay held even when both agree.
      const pat = files.get(m.plan_id);
      if (pat && m.checks?.notPlaceholder !== false && samePrices(pat.units, m.units)) llm.confirmed++;
      else { files.delete(m.plan_id); llm.held++; }
    }
  }
  for (const [id, row] of files) await writeFile(join(DATA, id + ".json"), JSON.stringify(row));
  console.log(`${results.length} plans:`, by, `| pattern ok ${npat}, model published ${llm.published}, model held ${llm.held} (and ${llm.confirmed} pattern tables kept, the model reading the same prices) → ${files.size} files in data/schedule-a/`);
}
