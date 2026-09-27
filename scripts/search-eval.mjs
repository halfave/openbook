// Scores the structured searches in search-intents.js against the live data, with ground truth computed here
// independently (distances, parking facts, averages) and every quoted line checked against the page it cites.
// Read-only: public tables and RPCs with the site's publishable key. No AI calls.
//   node scripts/search-eval.mjs [case-id ...]      -> prints a summary, writes .loop/eval.json, exit 1 on any failure
import { createRequire } from "node:module";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const I = createRequire(import.meta.url)(join(root, "search-intents.js"));
const cases = JSON.parse(readFileSync(join(root, "scripts/search-cases.json"), "utf8"));
const only = process.argv.slice(2);

const SB = "https://dvywgltjqpntldlztapu.supabase.co", KEY = "sb_publishable_At7fyv-9Vp7ByNP3AXHZ7g_qphsg6Rw";
const H = { apikey: KEY, "Content-Type": "application/json" };
const today = new Date().toISOString().slice(0, 10);
async function get(path) {
  for (let a = 0; ; a++) {
    const r = await fetch(`${SB}/rest/v1/${path}`, { headers: H });
    if (r.ok) return r.json();
    if (a >= 2 || r.status < 500) throw new Error(`${r.status} ${(await r.text()).slice(0, 200)} :: ${path.slice(0, 160)}`);
    await new Promise((s) => setTimeout(s, 1500));
  }
}
const io = {
  today,
  rest: get,
  rpc: async (fn, args) => { const r = await fetch(`${SB}/rest/v1/rpc/${fn}`, { method: "POST", headers: H, body: JSON.stringify(args) }); if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 200)}`); return r.json(); },
  geocode: async (t) => { const r = await fetch("https://geosearch.planninglabs.nyc/v2/search?size=1&text=" + encodeURIComponent(t)); const f = r.ok ? (await r.json()).features?.[0] : null; return f ? { lat: f.geometry.coordinates[1], lng: f.geometry.coordinates[0], label: f.properties.label } : null; },
};
const all = async (path) => { const out = []; for (let o = 0; ; o += 1000) { const b = await get(`${path}${path.includes("?") ? "&" : "?"}limit=1000&offset=${o}`); out.push(...b); if (b.length < 1000) return out; } };
const norm = (s) => String(s || "").replace(/\s+/g, " ").trim();
// PDF text breaks words and numbers apart ("$ 7 5 ,000"), so quotes are compared with all spacing removed.
const squash = (s) => String(s || "").toLowerCase().replace(/[\s\u00ad]+/g, "");
const inList = (ids) => `(${ids.map((x) => `"${x}"`).join(",")})`;
const pageCache = new Map();
async function pageText(file_id, page_no) {
  const k = file_id + ":" + page_no;
  if (!pageCache.has(k)) pageCache.set(k, get(`pages?select=body&file_id=eq.${file_id}&page_no=eq.${page_no}`).then((r) => norm(r[0]?.body)));
  return pageCache.get(k);
}
function haversine(a, b) { const t = (d) => d * Math.PI / 180, dl = t(b.lat - a.lat), dg = t(b.lng - a.lng); const h = Math.sin(dl / 2) ** 2 + Math.cos(t(a.lat)) * Math.cos(t(b.lat)) * Math.sin(dg / 2) ** 2; return 2 * 3958.8 * Math.asin(Math.sqrt(h)); }
// The rows a visitor sees first: the result's own default filters applied.
function visible(res) {
  const off = new Map((res.facets || []).map((f) => [f.k, new Set(f.values.filter((v) => !v.on).map((v) => String(v.v)))]));
  return res.rows.filter((r) => (res.facets || []).every((f) => !off.get(f.k)?.has(String(I.facetKey(f.k, r)))));
}
function subset(want, got) { for (const [k, v] of Object.entries(want)) { if (v && typeof v === "object") { if (!got?.[k] || !subset(v, got[k])) return false; } else if (got?.[k] !== v) return false; } return true; }

async function evaluate(c) {
  const E = c.expect, checks = [];
  const ok = (name, pass, detail = "") => checks.push({ name, pass: !!pass, detail: pass ? "" : String(detail).slice(0, 600) });
  const spec = I.parse(c.q, today);
  ok("question is read as a structured search", spec, "parse() returned null");
  if (!spec) return { checks, ms: 0 };
  ok("filters read from the question", subset(E.spec || {}, spec), `expected ${JSON.stringify(E.spec)} in ${JSON.stringify(spec)}`);
  const t0 = Date.now();
  let res;
  try { res = await I.run(spec, io); } catch (e) { ok("search runs", false, e.message); return { checks, ms: Date.now() - t0 }; }
  const ms = Date.now() - t0;
  ok("search runs", !res.error, res.error);
  ok("finishes in under 25 s", ms < 25000, `${ms} ms`);
  ok(`result is a ${E.kind}`, res.kind === E.kind, res.kind);
  const vis = res.kind === "list" ? visible(res) : res.rows;
  const ids = new Set(vis.map((r) => r.plan_id));

  if (E.required) { const miss = E.required.filter((x) => !ids.has(x)); ok(`lists all ${E.required.length} verified plans`, !miss.length, `missing ${miss.join(" ")}`); }
  if (E.forbidden) { const bad = E.forbidden.filter((x) => ids.has(x)); ok("lists none of the known non-matches", !bad.length, `should not list ${bad.join(" ")}`); }
  if (E.required && E.optional) { const extra = [...ids].filter((x) => !E.required.includes(x) && !E.optional.includes(x)); ok("no unreviewed plans listed (add them to the answer key if right)", !extra.length, `unreviewed: ${extra.join(" ")}`); }

  if (E.evidenceOnPage) {
    const bad = [];
    for (const r of vis) {
      const e = r.why?.evidence?.[0];
      if (!e) { bad.push(`${r.plan_id}: no quote`); continue; }
      const page = await pageText(e.file_id, e.page_no);
      if (!squash(page).includes(squash(e.text).slice(0, 100))) bad.push(`${r.plan_id}: quote not on p.${e.page_no}`);
    }
    ok("every listed plan quotes a page that says it", !bad.length, bad.join("; "));
  }

  if (E.anchorPlan) ok("measures from the named building", res.anchor?.plan_id === E.anchorPlan, `anchor ${res.anchor?.plan_id} ${res.anchor?.label}`);
  if (E.radiusComplete && res.anchor) {
    // Independent: every geocoded condo plan, measured here.
    const plans = await all("plans?select=plan_id,lat,lng,plan_type&lat=not.is.null");
    const truth = new Set(plans.filter((p) => (p.plan_type === "CONDOMINIUM" || p.plan_type === "COOPERATIVE/CONDOMINIUM") && haversine(res.anchor, p) <= spec.near.miles).map((p) => p.plan_id));
    const got = new Set(res.rows.map((r) => r.plan_id));
    const miss = [...truth].filter((x) => !got.has(x)), extra = [...got].filter((x) => !truth.has(x));
    ok(`finds every condo within ${spec.near.miles} mi (${truth.size})`, !miss.length && !extra.length, `missing ${miss.length}: ${miss.slice(0, 12).join(" ")}; extra ${extra.length}: ${extra.slice(0, 12).join(" ")}`);
    const sorted = res.rows.every((r, i, a) => !i || a[i - 1].distance <= r.distance + 1e-9);
    ok("nearest first", sorted);
    const hidden = res.rows.length - vis.length;
    ok("hidden rows are only withdrawn, abandoned or rejected plans", vis.length && res.rows.filter((r) => !vis.includes(r)).every((r) => !I.LIVE.includes(r.status)), `${hidden} hidden`);
  }
  if (E.facets) { const have = (res.facets || []).map((f) => f.k); const miss = E.facets.filter((k) => !have.includes(k)); ok("offers the expected filters", !miss.length, `missing filters ${miss.join(", ")}; has ${have.join(", ")}`); }
  if (E.facets) ok("every filter value has a count and they add up", (res.facets || []).every((f) => f.values.reduce((s, v) => s + v.n, 0) === res.rows.length), JSON.stringify((res.facets || []).map((f) => [f.k, f.values.reduce((s, v) => s + v.n, 0)])));

  if (E.unitsVerbatim) {
    const bad = []; let n = 0;
    for (const r of res.rows) for (const u of r.units || []) {
      n++;
      const page = await pageText(u.file_id, u.page_no);
      if (!page.includes(norm(u.line))) bad.push(`${r.plan_id} ${u.unit}: line not on p.${u.page_no}`);
      if (!norm(u.line).includes(u.price.toLocaleString("en-US"))) bad.push(`${r.plan_id} ${u.unit}: price ${u.price} not in its line`);
      if (!(u.beds >= spec.beds.min && u.beds <= spec.beds.max)) bad.push(`${r.plan_id} ${u.unit}: ${u.beds} BR`);
      if (!(u.price >= spec.price.min && u.price <= spec.price.max)) bad.push(`${r.plan_id} ${u.unit}: $${u.price}`);
      if (r.distance > spec.near.miles) bad.push(`${r.plan_id}: ${r.distance} mi`);
    }
    ok(`every unit (${n}) is read from a line on its cited page, in range`, n && !bad.length, bad.slice(0, 10).join("; ") || "no units");
  }
  if (E.requiredUnits) {
    const have = new Set(res.rows.flatMap((r) => (r.units || []).map((u) => r.plan_id + ":" + u.unit)));
    const miss = E.requiredUnits.filter(([p, u]) => !have.has(p + ":" + u));
    ok(`finds the ${E.requiredUnits.length} verified units`, !miss.length, `missing ${miss.map((x) => x.join(" ")).join(", ")}`);
  }
  if (E.forbiddenUnits) { const have = new Set(res.rows.flatMap((r) => (r.units || []).map((u) => r.plan_id + ":" + u.unit))); const bad = E.forbiddenUnits.filter(([p, u]) => have.has(p + ":" + u)); ok("no misread units", !bad.length, bad.map((x) => x.join(" ")).join(", ")); }
  if (E.coverage) ok("coverage accounts for every building checked", res.coverage?.length && res.coverage.reduce((s, x) => s + x.n, 0) === res.candidates, JSON.stringify(res.coverage));

  if (E.unitRange) ok(`every building has ${E.unitRange[0]}–${E.unitRange[1]} residential units`, vis.every((r) => r.units_residential >= E.unitRange[0] && r.units_residential <= E.unitRange[1]), vis.filter((r) => !(r.units_residential >= E.unitRange[0] && r.units_residential <= E.unitRange[1])).map((r) => `${r.plan_id}:${r.units_residential}`).join(" "));
  if (E.parkingFactsRequired) {
    const facts = await all("facts?select=plan_id,value_text,quote&field=eq.parking_arrangement&value_text=in.(licensed,sold_or_licensed)");
    const fp = facts.filter((f) => /licen[cs]/i.test(f.quote || "")).map((f) => f.plan_id);
    const small = fp.length ? (await get(`plans?select=plan_id&plan_id=in.${inList(fp)}&units_residential=gte.${E.unitRange[0]}&units_residential=lte.${E.unitRange[1]}&plan_type=eq.CONDOMINIUM`)).map((p) => p.plan_id) : [];
    const miss = small.filter((x) => !ids.has(x));
    ok(`lists all ${small.length} plans whose extracted parking arrangement is a license`, !miss.length, `missing ${miss.join(" ")}`);
  }
  if (E.evidenceWords) {
    const bad = [];
    for (const r of vis) {
      const e = r.why?.evidence?.[0];
      if (!e || !E.evidenceWords.every((w) => new RegExp(w, "i").test(e.text))) { bad.push(`${r.plan_id}: quote lacks ${E.evidenceWords.join("/")}`); continue; }
      if (e.file_id && e.page_no) { const page = await pageText(e.file_id, e.page_no); const probe = squash(norm(e.text).split(/\s*\.\.\.\s*/)[0].replace(/^\*\s*/, "")).slice(0, 50); if (!squash(page).includes(probe)) bad.push(`${r.plan_id}: quote not on p.${e.page_no}`); }
    }
    ok("every listed plan quotes the line that says it", !bad.length, bad.join("; "));
  }

  if (E.kind === "table") {
    ok(`at least ${E.minTables} breakdown tables`, (res.tables || []).length >= E.minTables, (res.tables || []).length);
    if (E.salesDisclaimer) ok("says plainly there is no sales data", res.notes.some((n) => /no closed-sale records/i.test(n)), res.notes.join(" | "));
    const since = new Date(); since.setFullYear(since.getFullYear() - E.yearsBack);
    const s = since.toISOString().slice(0, 10);
    const truth = (await all(`plans?select=plan_id,price_current,units_residential,units_commercial,units_parking,units_storage,borough&plan_type=eq.CONDOMINIUM&construction=eq.NEW&status=eq.ACCEPTED&accepted_date=gte.${s}`))
      .filter((p) => Number(p.price_current) > 0 && p.units_residential > 0);
    ok(`counts every priced plan in the window (${truth.length})`, truth.length === res.rows.length, `table counts ${res.rows.length}`);
    const per = truth.map((p) => Number(p.price_current) / (p.units_residential + (p.units_commercial || 0) + (p.units_parking || 0) + (p.units_storage || 0)));
    const avg = per.reduce((a, b) => a + b, 0) / (per.length || 1);
    const t0 = res.tables?.[0];
    ok("headline average matches an independent calculation", t0 && Math.abs(t0.grand.v - avg) / avg < 0.005, `table ${t0?.grand.v} vs ${avg}`);
    ok("pivot rows add up to the total", (res.tables || []).every((t) => t.rows.reduce((a, r) => a + r.total.n, 0) === t.grand.n && t.totals.reduce((a, c) => a + c.n, 0) === t.grand.n), "row or column counts don't sum to the grand total");
  }

  if (E.images && vis.length) {
    const need = vis.slice(0, 200).map((r) => r.plan_id), got = new Set();
    for (let i = 0; i < need.length; i += 100) (await io.rpc("plan_thumbs", { p_ids: need.slice(i, i + 100) })).forEach((t) => t.thumb && got.add(t.plan_id));
    const miss = need.filter((x) => !got.has(x));
    ok("every listed building has an image", !miss.length, `${miss.length} without: ${miss.slice(0, 15).join(" ")}`);
  }
  return { checks, ms, count: vis.length, total: res.rows.length, title: res.title };
}

const out = [];
for (const c of cases.filter((x) => !only.length || only.includes(x.id))) {
  const r = await evaluate(c).catch((e) => ({ checks: [{ name: "evaluation", pass: false, detail: e.stack }] }));
  const fails = r.checks.filter((x) => !x.pass);
  out.push({ id: c.id, q: c.q, pass: !fails.length, ...r });
  console.log(`${fails.length ? "FAIL" : "PASS"}  ${c.id.padEnd(14)} ${String(r.ms ?? "").padStart(6)} ms  ${r.count ?? ""}${r.total != null && r.total !== r.count ? `/${r.total}` : ""}  ${r.title || ""}`);
  for (const f of fails) console.log(`      ✗ ${f.name}: ${f.detail}`);
}
mkdirSync(join(root, ".loop"), { recursive: true });
writeFileSync(join(root, ".loop/eval.json"), JSON.stringify({ at: new Date().toISOString(), cases: out }, null, 2));
const failed = out.filter((x) => !x.pass).length;
console.log(`\n${out.length - failed}/${out.length} cases pass · ${out.flatMap((x) => x.checks).filter((x) => x.pass).length}/${out.flatMap((x) => x.checks).length} checks`);
process.exit(failed ? 1 : 0);
