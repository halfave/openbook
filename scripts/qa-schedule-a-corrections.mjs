// Turns the confirmed findings in data/schedule-a-qa/ into data/schedule-a-corrections.json, which
// extract-schedule-a.mjs applies to the published tables every time it rebuilds data/schedule-a/.
//
//   node scripts/qa-schedule-a-corrections.mjs                   adds corrections for newly checked plans
//   node scripts/qa-schedule-a-corrections.mjs --from-git REF    rebuilds them all from the uncorrected tables at REF
//
// Only findings Opus confirmed against the printed page are used (outcome published_wrong, published_unit_not_in_table,
// unit_missing_from_published); unresolved ones are left alone. Every change names the value it replaces, and is
// skipped at apply time if the published cell no longer holds it (the table was re-read since), so a correction can
// never land on a different reading.
//
// Rules on top of "use the printed value":
//  - Taxes and carrying charges: the site shows first-year figures with any abatement in effect. A correction that moves
//    to the other scenario (a higher figure) is not applied; nor is a "monthly" value that is ~12× the published one
//    (an annual column printed under a monthly heading).
//  - Not errors (as in the report): a second printing of a published row, the same row under a longer label
//    ("201-1F" / "201 Huron St. 1F"), a price published without its cents, parking/storage rows a homes-only table left out.
//  - Units missing from a table are added from the QA reading, with the price Opus confirmed.
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { ROOT } from "./site.mjs";

const QA = join(ROOT, "data", "schedule-a-qa"), PUB = join(ROOT, "data", "schedule-a");
const OUT = join(ROOT, "data", "schedule-a-corrections.json");
const READ_FIELD = { sqft: "int_sf", outdoor_sqft: "ext_sf" };
const MONEY = new Set(["tax_m", "carry_m", "cc_m"]);
const ANCILLARY = /\b(STORAGE|PARKING|GARAGE|SPACE|BIKE|BICYCLE|LOCKER|WINE|CABANA)\b|^(SL|SU|PS|P|S|B)[\s-]?\d/i;
const key = (s) => String(s).toUpperCase().replace(/[*†‡+]/g, "").replace(/^(UNIT|APT\.?)\s*/, "").replace(/[\s\-.#]/g, "").replace(/^0+(?=\d)/, "");
const last = (s) => String(s).trim().split(/[\s-]+/).at(-1).toUpperCase();
const eq = (a, b) => a != null && b != null && Math.abs(a - b) < 0.006;

// Corrections are worked out against the table as QA saw it, before any correction. A published table already marked
// qa_corrected keeps its existing corrections (rebuilding them from the corrected table would find nothing to fix);
// --from-git REF reads the uncorrected tables from a commit instead (e.g. to rebuild the whole file after changing a rule).
const argv = process.argv.slice(2);
const REF = argv.includes("--from-git") ? argv[argv.indexOf("--from-git") + 1] : null;
const prev = JSON.parse(await readFile(OUT, "utf8").catch(() => "{}"));
const git = (path) => { try { return execFileSync("git", ["show", `${REF}:${path}`], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }); } catch { return null; } };
const out = {}, skipped = {};
const skip = (why) => (skipped[why] = (skipped[why] || 0) + 1);
for (const f of (await readdir(QA)).filter((f) => /^C[DC]\d+\.json$/.test(f))) {
  const q = JSON.parse(await readFile(join(QA, f), "utf8"));
  if (!q.findings?.length) continue;
  let pubRaw = await readFile(join(PUB, f), "utf8").catch(() => null);
  if (!pubRaw) { skip("plan no longer published"); continue; }
  if (JSON.parse(pubRaw).qa_corrected) {
    if (!REF) { if (prev[q.plan_id]) out[q.plan_id] = prev[q.plan_id]; skip("already corrected, kept"); continue; }
    pubRaw = git(`data/schedule-a/${f}`);
    if (!pubRaw || JSON.parse(pubRaw).qa_corrected) { skip(`no uncorrected table at ${REF}`); continue; }
  }
  const pub = JSON.parse(pubRaw).units;
  const read = q.read_units || [];
  const ops = [];
  // The published row a finding is about: its label and published value, and when labels repeat, the price of the
  // read row that holds the printed value.
  const rowFor = (x) => {
    const field = x.field;
    let c = pub.filter((u) => (field === "unit" ? u.unit === x.published : u.unit === x.unit && (field === "unit" || eq(u[field], x.published) || u[field] === x.published)));
    if (c.length > 1) {
      const rf = READ_FIELD[field] || field;
      const r = read.filter((r) => (field === "unit" ? r.unit === x.printed : key(r.unit) === key(x.unit) || r.unit.toUpperCase().startsWith(String(x.unit).toUpperCase())) && (field === "unit" || eq(r[rf], x.printed)));
      // Prices can be blank (units not offered), so square feet and common interest identify the row too.
      // Same row: at least one of these figures present on both sides and equal, and none present on both and different.
      const PAIRS = [["price", "price"], ["sqft", "int_sf"], ["pct", "pct"], ["cc_m", "cc_m"]];
      const sig = (a, b) => {
        const both = PAIRS.filter(([pa, pb]) => a[pa] != null && b[pb] != null);
        return both.length > 0 && both.every(([pa, pb]) => eq(a[pa], b[pb]));
      };
      const bySig = c.filter((u) => !taken.has(u) && r.some((rr) => sig(u, rr)));
      if (bySig.length >= 1) c = bySig;
      else c = c.filter((u) => !taken.has(u));
    }
    return c[0] || null;
  };
  const pending = new Map(); // row → { field: [from, to] }
  const taken = new Set(); // rows already renamed (repeated labels: each finding takes a different row)
  for (const x of q.findings) {
    if (x.outcome === "published_wrong") {
      if (x.printed == null && x.field !== "unit") { skip("printed value blank"); continue; }
      if (x.field === "price" && Math.abs(x.printed - x.published) < 1) { skip("cents only"); continue; }
      if (MONEY.has(x.field) && x.field !== "cc_m") {
        if (x.printed > x.published && /421|abate|exempt|subsid|without|with /i.test(x.why || "")) { skip("other tax scenario (higher)"); continue; }
        if (Math.abs(x.printed / x.published - 12) < 0.05) { skip("annual figure under a monthly heading"); continue; }
      }
      const row = rowFor(x);
      if (!row) { skip("row not found"); continue; }
      if (x.field === "unit") taken.add(row);
      const s = pending.get(row) || {}; s[x.field] = [x.field === "unit" ? row.unit : row[x.field], x.printed]; pending.set(row, s);
    } else if (x.outcome === "published_unit_not_in_table") {
      const rows = pub.filter((u) => u.unit === x.unit);
      if (rows.length !== 1) { skip("phantom unit ambiguous"); continue; }
      ops.push({ unit: x.unit, match: { price: rows[0].price, sqft: rows[0].sqft, pct: rows[0].pct }, remove: true, why: x.why });
    } else if (x.outcome === "unit_missing_from_published") {
      if (pub.some((u) => key(u.unit) === key(x.unit)) || pub.some((u) => eq(u.price, x.printed) && last(u.unit) === last(x.unit))) { skip("duplicate or label variant"); continue; }
      if (ANCILLARY.test(x.unit) || (x.printed ?? 0) < 100000) { skip("ancillary row"); continue; }
      const r = read.find((r) => r.unit === x.unit);
      if (!r || x.printed == null) { skip("missing unit without a reading"); continue; }
      // A home has bedrooms or a home's size; cabanas, rooftop terraces and numbered spaces sold separately don't.
      const home = r.beds != null || (r.int_sf ?? 0) >= 400;
      ops.push({ add: { unit: r.unit, type: home ? "residential" : "other", floor: null, beds: r.beds, baths: r.baths, sqft: r.int_sf, outdoor_sqft: r.ext_sf,
        price: x.printed, pct: r.pct, cc_m: r.cc_m, tax_m: r.tax_m, carry_m: r.carry_m, page: r.page, qa_added: true }, why: x.why });
    }
  }
  // Taxes and carrying change together: after the change, carrying must still be charges + taxes, else carrying is
  // left as published when it was consistent, or cleared when it no longer adds up.
  for (const [row, s] of pending) {
    const val = (k) => (s[k] ? s[k][1] : row[k]);
    if (s.tax_m || s.cc_m || s.carry_m) {
      const cc = val("cc_m"), tax = val("tax_m"), carry = val("carry_m");
      if (cc != null && tax != null && carry != null && Math.abs(carry - cc - tax) > 2) {
        if (s.carry_m) { delete s.carry_m; skip("carrying correction doesn't add up"); }
        if (Math.abs(val("carry_m") - cc - tax) > 2) s.carry_m = [row.carry_m, null];
      }
    }
    // The row is identified by its label plus price, size and common interest as published (labels can repeat).
    if (Object.keys(s).length) ops.unshift({ unit: row.unit, match: { price: row.price, sqft: row.sqft, pct: row.pct }, set: s });
  }
  if (ops.length) out[q.plan_id] = ops;
}
await writeFile(OUT, JSON.stringify(out, null, 1));
const n = Object.values(out).flat();
const fields = {};
for (const o of n) if (o.set) for (const k of Object.keys(o.set)) fields[k] = (fields[k] || 0) + 1;
console.log(`${Object.keys(out).length} plans, ${n.filter((o) => o.set).length} rows changed, ${n.filter((o) => o.remove).length} removed, ${n.filter((o) => o.add).length} added`);
console.log("cells by field:", fields);
console.log("not applied:", skipped);
