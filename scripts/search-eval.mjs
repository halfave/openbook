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
  // The whole result, for reviewers: .loop/results/<case>.json
  mkdirSync(join(root, ".loop/results"), { recursive: true });
  writeFileSync(join(root, `.loop/results/${c.id}.json`), JSON.stringify(res, null, 1));
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
    if (E.spec?.mih) {
      const weak = vis.filter((r) => !I.mihAssertion(r.why?.evidence?.[0]?.text));
      ok("every MIH quote shown contains the words that qualify it", !weak.length, weak.map((r) => `${r.plan_id}: “${String(r.why?.evidence?.[0]?.text || "").slice(0, 80)}”`).join("; "));
    }
    for (const [id, re] of E.evidenceShows || []) {
      const e = vis.find((r) => r.plan_id === id)?.why?.evidence?.[0];
      ok(`${id}'s quote shows /${re}/`, e && new RegExp(re).test(e.text), e ? `“${e.text.slice(0, 160)}”` : "not listed");
    }
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
  if (E.unitsVerbatim) {
    // A square footage must be a number in the row other than the unit's own identifier.
    const bad = [];
    for (const r of res.rows) for (const u of r.units || []) {
      if (u.sf == null) continue;
      const toks = norm(u.line).split(" ").slice(/^(unit|apt\.?|apartment)$/i.test(norm(u.line).split(" ")[0]) ? 2 : 1);
      if (!toks.some((t) => !t.startsWith("$") && +t.replace(/,/g, "") === u.sf)) bad.push(`${r.plan_id} ${u.unit}: ${u.sf} sf not in its row apart from the unit number`);
    }
    ok("square footage comes from the row, never the unit number", !bad.length, bad.slice(0, 10).join("; "));
  }
  if (E.unitArea) {
    const got = new Map(res.rows.flatMap((r) => (r.units || []).map((u) => [r.plan_id + ":" + u.unit, u.sf])));
    const bad = E.unitArea.filter(([p, u, sf]) => got.get(p + ":" + u) !== sf).map(([p, u, sf]) => `${p} ${u}: want ${sf}, got ${got.get(p + ":" + u)}`);
    ok(`verified square footages (${E.unitArea.length})`, !bad.length, bad.join("; "));
  }
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
  if (E.spec?.parking) {
    // Listed from the text only with a sentence that offers the license; mentions are kept apart and not counted.
    const weak = vis.filter((r) => r.why?.parking !== "fact" && !(r.why?.parking === "text" && I.parkingOffer(r.why.evidence?.[0]?.text)));
    ok("text-only matches quote a license offered in the building", !weak.length, weak.map((r) => `${r.plan_id}: “${String(r.why?.evidence?.[0]?.text || "").slice(0, 80)}”`).join("; "));
    const both = (res.mentions || []).filter((m) => res.rows.some((r) => r.plan_id === m.plan_id));
    ok("plans that only mention a parking license are listed apart, not counted", !both.length && new RegExp(`^${res.rows.length} `).test(res.title), `${both.map((m) => m.plan_id).join(" ")} · title “${res.title}” for ${res.rows.length} rows`);
  }
  if (E.relatedFilings) {
    const by = new Map(res.rows.map((r) => [r.plan_id, r]));
    const bad = E.relatedFilings.filter(([a, b]) => !by.has(a) || !by.has(b) || by.get(a).relatedTo?.plan_id !== b || !by.get(b).relatedFrom?.some((x) => x.plan_id === a)).map((x) => x.join("→"));
    ok("related filings are both listed and name each other", !bad.length, bad.join(", "));
  }
  if (res.kind === "list") ok("the count is of condo plans, not buildings", /^\d+ condo plans?\b/.test(res.title), res.title);

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

// Offline fixtures for the parsers: sentences and Schedule A rows whose right reading is known.
function fixtures() {
  const checks = [], ok = (name, pass, detail = "") => checks.push({ name, pass: !!pass, detail: pass ? "" : String(detail).slice(0, 600) });
  const offers = [
    ["No parking licenses are offered.", false],
    ["The Sponsor will not offer parking licenses to Purchasers.", false],
    ["Purchasers may obtain a parking license at the garage in the adjacent building at 12 Main Street.", false],
    ["Parking licenses are sold for spaces in another building owned by an affiliate of Sponsor.", false],
    ["Parking Space Licensee:", false],
    ["Parking Spaces may be licensed to members of the public.", false],
    ["The parking spaces shall be licensed to owners of residential units through a contract with the condominium Board of Managers.", true],
    ["Any portion of Common Elements restricted in use and subject to exclusive license agreements such as (but not limited to) Parking Spaces and Storage Spaces.", false],
    ["STORAGE BIN LICENSE AGREEMENT made by WRB 280 ATLANTIC AVE., LLC, having an office at 95 - 25 Queens Boulevard, Rego Park, NY 11374 (“Sponsor”).", false],
    ["Each Purchaser of a Residential Unit may purchase a license to use one parking space in the Building’s garage for $75,000.", true],
    ["If Purchaser is also obtaining a parking space, a License must also be executed to evidence the transfer of the space.", true],
    ["Sponsor is offering purchasers of residential Units the opportunity to purchase the Parking Space License, at a rate of $50,000.00 on a first come first serve basis", true],
  ];
  const badOffer = offers.filter(([s, want]) => I.parkingOffer(s) !== want).map(([s, want]) => `${want ? "missed" : "accepted"}: “${s.slice(0, 70)}”`);
  ok(`parking-license sentences read right (${offers.length} fixtures)`, !badOffer.length, badOffer.join("; "));

  const page = (file_id, body) => ({ file_id, page_no: 1, body });
  const rowsOf = (body) => Object.fromEntries(I.parseScheduleA([page(1, body)]).map((u) => [u.unit, u.sf]));
  const sfCases = [
    ["one area column; unit number 1201 is not its area",
      "Unit Bedrooms Baths Unit Square Footage Offering Price % of Common Interest\n1201 1 1 750 $1,150,000.00 1.2345%\n1202 2 2 1,040 $1,650,000.00 1.7345%", { 1201: 750, 1202: 1040 }],
    ["unit area first, then a terrace column",
      "Unit Bdrms Baths Unit Square Footage (1) Limited Common Area Square Footage Offering Price (2) % of Residential Common Interest (3)\n1201 1 1 750 300 $1,150,000.00 1.2345%\n1202 2 2 1,040 0 $1,650,000.00 1.7345%", { 1201: 750, 1202: 1040 }],
    ["terrace column first: two area-sized numbers can't be told apart",
      "Unit# Bedrooms Bathrooms Terrace/Balcony Square Footage Unit Square Footage Offering Price Common Interest\n1201 1 1 300 750 $1,150,000 0.2811%\n1202 1 1 0 646 $905,000 0.2380%", { 1201: null, 1202: 646 }],
    ["no area column: the unit number is never a square footage",
      "Unit Bedrooms Baths Offering Price % of Common Interest\n1201 1 1 $1,150,000.00 1.2345%\n1502 2 2 $1,650,000.00 1.7345%", { 1201: null, 1502: null }],
  ];
  for (const [name, body, want] of sfCases) {
    const got = rowsOf(body);
    const bad = Object.entries(want).filter(([u, v]) => got[u] !== v).map(([u, v]) => `${u}: want ${v}, got ${got[u]}`);
    ok(`square footage: ${name}`, !bad.length, bad.join("; ") || JSON.stringify(got));
  }

  ok("a “*SEE CD160304*” record points at CD160304", I.seeRef("CHARLIE WEST CONDOMINIUM (THE) - *SEE CD160304*") === "CD160304" && I.seeRef("CHARLIE WEST CONDOMINIUM (THE)") === null);

  // MIH: a long cover-page sentence whose affordable-unit count comes after character 420 must be quoted around the count.
  const cover = "CONDOMINIUM OFFERING PLAN 500 EXAMPLE CONDOMINIUM 500 EXAMPLE AVENUE BROOKLYN, NEW YORK 11238 48 Residential Units " + ".".repeat(260) +
    " $45,273,195 31 Storage Lockers (licensed) " + ".".repeat(90) + " $528,750 Total Offering Amount " + ".".repeat(40) + " $45,801,945, consisting of 37 Market Rate Units and 11 Inclusionary Units.";
  const mih = I.classifyMIH([{ file_id: 9, page_no: 1, body: cover }]), e0 = mih.evidence[0];
  ok("MIH fixture: the qualifying words come after character 420", cover.indexOf("11 Inclusionary Units") > 420);
  ok("MIH quote keeps an affordable-unit count found after character 420", mih.onsite && e0 && /11 Inclusionary Units/.test(e0.text) && e0.text.length <= 420 && I.mihAssertion(e0.text), JSON.stringify(e0));
  ok("MIH quote is verbatim, marks the words left out, and keeps its page", e0 && cover.includes(e0.text) && e0.cutBefore === true && !e0.cutAfter && e0.page_no === 1 && e0.file_id === 9, JSON.stringify(e0));
  const short = I.classifyMIH([{ file_id: 9, page_no: 2, body: "The Building contains 11 Inclusionary Units." }]).evidence[0];
  ok("a short MIH sentence is quoted whole, with nothing marked left out", short && short.text === "The Building contains 11 Inclusionary Units." && !short.cutBefore && !short.cutAfter, JSON.stringify(short));
  return { checks, ms: 0 };
}

// Averages on a fake data source: two plans whose current AG total differs from the initial total.
async function statsFixture() {
  const checks = [], ok = (name, pass, detail = "") => checks.push({ name, pass: !!pass, detail: pass ? "" : String(detail).slice(0, 600) });
  const base = { plan_type: "CONDOMINIUM", status: "ACCEPTED", construction: "NEW", borough: "BROOKLYN", accepted_date: "2026-05-08", units_commercial: 0, units_parking: 0, units_storage: 0 };
  const plans = [
    { ...base, plan_id: "FX000001", units_residential: 20, price_initial: 18000000, price_current: 20000000 },
    { ...base, plan_id: "FX000002", units_residential: 10, price_initial: 10000000, price_current: 10000000 },
  ];
  const fake = { today: "2026-09-27", rest: async (p) => (/^plans\?/.test(p) && !/offset=[1-9]/.test(p) ? plans : []), rpc: async () => [] };
  const res = await I.run(I.parse("average price for new condos in last 2 years", "2026-09-27"), fake);
  const t = new Map((res.tables || []).map((x) => [x.id, x]));
  ok("averages use the current AG total, not the initial one", Math.abs(t.get("boro-year")?.grand.v - 1000000) < 1 && Math.abs(t.get("boro-year-total")?.grand.v - 15000000) < 1,
    `per unit ${t.get("boro-year")?.grand.v}, per plan ${t.get("boro-year-total")?.grand.v}`);
  ok("AG tables are labelled as current recorded offering totals", ["boro-year", "boro-size", "boro-year-total"].every((k) => t.get(k)?.basis === "current" && /current .*\(AG record\)/.test(t.get(k).title)), [...t.values()].map((x) => x.title).join(" | "));
  ok("the plans whose current and initial totals differ are counted", res.priceBasis?.changed === 1 && res.notes.some((n) => /1 of 2 plans the AG’s current total differs from its initial total/.test(n)), JSON.stringify(res.priceBasis));
  ok("each counted plan keeps both totals", res.rows.every((r) => "price_initial" in r && "price_current" in r));
  return { checks, ms: 0 };
}

const out = [];
if (!only.length || only.includes("fixtures")) {
  const f1 = fixtures(), f2 = await statsFixture().catch((e) => ({ checks: [{ name: "stats fixture", pass: false, detail: e.stack }] }));
  const r = { checks: [...f1.checks, ...f2.checks], ms: 0 }, fails = r.checks.filter((x) => !x.pass);
  out.push({ id: "fixtures", q: "(offline parser fixtures)", pass: !fails.length, ...r });
  console.log(`${fails.length ? "FAIL" : "PASS"}  ${"fixtures".padEnd(14)} ${r.checks.length} parser fixture checks`);
  for (const f of fails) console.log(`      ✗ ${f.name}: ${f.detail}`);
}
for (const c of cases.filter((x) => !only.length || only.includes(x.id))) {
  const r = await evaluate(c).catch((e) => ({ checks: [{ name: "evaluation", pass: false, detail: e.stack }] }));
  const fails = r.checks.filter((x) => !x.pass);
  out.push({ id: c.id, q: c.q, pass: !fails.length, ...r });
  console.log(`${fails.length ? "FAIL" : "PASS"}  ${c.id.padEnd(14)} ${String(r.ms ?? "").padStart(6)} ms  ${r.count ?? ""}${r.total != null && r.total !== r.count ? `/${r.total}` : ""}  ${r.title || ""}`);
  for (const f of fails) console.log(`      ✗ ${f.name}: ${f.detail}`);
}
mkdirSync(join(root, ".loop/results"), { recursive: true });
// The top of each cited page the checks read (table headers), for reviewers.
writeFileSync(join(root, ".loop/results/pages.json"), JSON.stringify(Object.fromEntries(await Promise.all([...pageCache].map(async ([k, v]) => [k, (await v).slice(0, 600)]))), null, 1));
writeFileSync(join(root, ".loop/eval.json"), JSON.stringify({ at: new Date().toISOString(), cases: out }, null, 2));
const failed = out.filter((x) => !x.pass).length;
console.log(`\n${out.length - failed}/${out.length} cases pass · ${out.flatMap((x) => x.checks).filter((x) => x.pass).length}/${out.flatMap((x) => x.checks).length} checks`);
process.exit(failed ? 1 : 0);
