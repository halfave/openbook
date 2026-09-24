// Builds one static page per offering plan, plus a buildings directory, sitemap.xml and robots.txt.
//
//   node scripts/build-buildings.mjs
//   SITE_URL=https://example.com node scripts/build-buildings.mjs
//
// Reads the public, read-only Supabase REST API (same key the site uses). Re-run it after new
// plans are ingested; pages for plans added since the last build do not exist until then.
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";

const SB = "https://dvywgltjqpntldlztapu.supabase.co";
const KEY = "sb_publishable_At7fyv-9Vp7ByNP3AXHZ7g_qphsg6Rw";
const SITE_URL = (process.env.SITE_URL || "https://openbook-weld.vercel.app").replace(/\/$/, "");
const AG = "https://offeringplandatasearch.ag.ny.gov/REF/planFormServlet?planId=";
const ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const OUT = join(ROOT, "buildings");
const TODAY = new Date().toISOString().slice(0, 10);

// ---------- data ----------
async function rest(path, { range } = {}) {
  const headers = { apikey: KEY, Accept: "application/json" };
  if (range) headers.Range = range;
  const r = await fetch(SB + "/rest/v1/" + path, { headers });
  if (!r.ok) throw new Error(`${path}: ${r.status} ${(await r.text()).slice(0, 200)}`);
  return r.json();
}
async function all(path, size = 1000) {
  const out = [];
  for (let from = 0; ; from += size) {
    const rows = await rest(path, { range: `${from}-${from + size - 1}` });
    out.push(...rows);
    if (rows.length < size) return out;
  }
}
async function rpc(fn, args) {
  const r = await fetch(SB + "/rest/v1/rpc/" + fn, {
    method: "POST", headers: { apikey: KEY, "Content-Type": "application/json" }, body: JSON.stringify(args),
  });
  if (!r.ok) throw new Error(`${fn}: ${r.status} ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

// ---------- text helpers ----------
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const tc = (s) => String(s ?? "").toLowerCase().replace(/\b([a-z])/g, (c) => c.toUpperCase())
  .replace(/\b(Llc|Lp|Ny|Nyc|Pc|Llp)\b/g, (w) => w.toUpperCase()).replace(/\(The\)/g, "").replace(/\s+/g, " ").trim()
  .replace(/(\d)(St|Nd|Rd|Th)\b/g, (_, d, x) => d + x.toLowerCase());
const slug = (s) => String(s ?? "").toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
export const fileFor = (p) => `${slug(p.address)}-${slug(p.borough)}-${p.plan_id.toLowerCase()}.html`;
const month = (d) => d ? new Date(d + "T12:00:00").toLocaleDateString("en-US", { month: "long", year: "numeric" }) : "";
const day = (d) => d ? new Date(d + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "";
const usDate = (s) => { const m = String(s || "").match(/^(\d{2})\/(\d{2})\/(\d{4})$/); return m ? `${m[3]}-${m[1]}-${m[2]}` : null; };
const money = (s) => { const n = Number(String(s || "").replace(/[$,]/g, "")); return n > 0 ? n : null; };
const fmtMoney = (n) => n >= 1e6 ? "$" + (n / 1e6).toFixed(n >= 1e7 ? 1 : 2).replace(/\.?0+$/, "") + " million" : "$" + Math.round(n).toLocaleString("en-US");
const plural = (n, w) => `${n.toLocaleString("en-US")} ${w}${n === 1 ? "" : "s"}`;
const BORO = { MANHATTAN: "Manhattan", BROOKLYN: "Brooklyn", QUEENS: "Queens", BRONX: "Bronx", "STATEN ISLAND": "Staten Island" };
const boro = (b) => BORO[String(b || "").toUpperCase()] || tc(b);
const docLabel = (d) => d.doc_kind === "amendment" ? `Amendment ${d.amendment_no ?? ""}`.trim() : "Offering Plan";
const pagesLabel = (a, b) => (a === b ? `p. ${a}` : `pp. ${a}–${b}`);
const miles = (a, b) => {
  const R = 3958.8, rad = Math.PI / 180, dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};

// ---------- shared chrome ----------
const HEAD = (p, { title, description, canonical, noindex }) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
${noindex ? '<meta name="robots" content="noindex, follow">\n' : ""}<link rel="canonical" href="${esc(canonical)}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:type" content="website">
<meta property="og:url" content="${esc(canonical)}">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7' fill='%230E6B5B'/%3E%3Cpath d='M9 23V9h8a5 5 0 0 1 0 10h-8' fill='none' stroke='white' stroke-width='3'/%3E%3C/svg%3E">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600&family=Newsreader:ital,opsz,wght@0,6..72,500;1,6..72,400;1,6..72,500&display=swap">
<link rel="stylesheet" href="${p}pages.css">
<link rel="stylesheet" href="${p}menu.css">
</head>
<body>
<header class="top">
  <a class="brand" href="${p}index.html">Open Book</a>
</header>
${MENU(p)}`;
const MENU = (p) => `<details class="menu" id="menu">
  <summary aria-label="Menu"><svg class="bars-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16"/></svg><svg class="x-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg></summary>
  <nav aria-label="Site">
    <a href="${p}index.html">Search</a>
    <a href="${p}buildings/index.html">Buildings</a>
    <a href="${p}about.html">About</a>
    <a href="${p}about.html#coverage">Coverage</a>
    <a href="${p}faq.html">FAQ</a>
    <a href="mailto:hello@halfave.co?subject=Open%20Book%20error%20report">Report an error</a>
    <hr>
    <div class="fine"><a href="${p}terms.html">Terms</a><a href="${p}privacy.html">Privacy</a><a href="${p}disclaimers.html">Disclaimers</a></div>
    <small>© 2026 Half Ave Company LLC</small>
  </nav>
</details>
`;
const FOOT = (p, extraScripts = "") => `<footer>
  <div>Open Book · NYC condo offering plan search · Source: NY Attorney General offering plan database</div>
  <div>© 2026 Half Ave Company LLC. Open Book is a service of Half Ave Company LLC.</div>
</footer>
<script src="${p}menu.js"></script>
${extraScripts}</body>
</html>
`;

// ---------- building page ----------
const SECTION_NAMES = {
  schedule_a: "Schedule A", schedule_b: "Schedule B", floor_plans: "Floor plans",
  declaration: "Declaration", bylaws: "By-laws", management_agreement: "Management agreement",
};
function whereToLook(kind, sections, docsById, max = 4) {
  const runs = sections.filter((s) => s.kind === kind);
  if (!runs.length) return "";
  // Longest runs are the section itself; short ones are often a running mention. Show the longest, in page order.
  const shown = [...runs].sort((a, b) => (b.last_page - b.first_page) - (a.last_page - a.first_page) || a.first_page - b.first_page).slice(0, max)
    .sort((a, b) => a.file_id - b.file_id || a.first_page - b.first_page);
  const items = shown.map((r) => `<li><b>${esc(docLabel(docsById.get(r.file_id) || {}))}</b>, ${pagesLabel(r.first_page, r.last_page)}</li>`).join("");
  const more = runs.length > shown.length ? `<li class="faint">and ${plural(runs.length - shown.length, "more place")}</li>` : "";
  return `<div class="where"><div class="where-h">Where to look: pages headed “${esc(SECTION_NAMES[kind])}”</div><ul>${items}${more}</ul></div>`;
}
const pending = (what) => `<p class="pending"><b>Not yet extracted.</b> ${what}</p>`;

function buildingPage(p, ctx) {
  const P = "../";
  const name = tc(p.name), addr = tc(p.address), b = boro(p.borough);
  const meta = p.meta || {}, mp = meta.plan || {};
  const docs = ctx.docs.get(p.plan_id) || [];
  const docsById = new Map(docs.map((d) => [d.file_id, d]));
  const done = docs.filter((d) => d.status === "done");
  const searchable = done.length > 0;
  const sections = ctx.sections.get(p.plan_id) || [];
  const initial = money(mp["Initial Price"]), current = money(mp["Current Price"]);
  const effective = usDate(mp["Effective Date"]);
  const amends = (meta.amends || []).map((a) => ({ no: a.no, action: a.action, submitted: usDate(a.submitted) })).sort((x, y) => y.no - x.no);
  const lastAmend = amends[0];
  const agRecord = AG + encodeURIComponent(p.plan_id), agDocs = agRecord + "#tabs-6";
  const canonical = `${SITE_URL}/buildings/${fileFor(p)}`;

  const title = `${addr || name} Offering Plan: Units, Parking & Amendments | Open Book`;
  const bits = [];
  if (p.units_residential != null) bits.push(plural(p.units_residential, "residential unit"));
  if (p.units_parking) bits.push(plural(p.units_parking, "parking unit"));
  const description = `${name}, ${addr}, ${b}. AG plan ${p.plan_id}${p.accepted_date ? `, accepted ${month(p.accepted_date)}` : ""}.${bits.length ? " " + bits.join(", ") + "." : ""} Documents, amendments and source links.`;

  // One sentence from the AG record. States only what the record says.
  const kind = p.construction ? tc(p.construction).toLowerCase() + " construction " : "";
  let summary = `The Attorney General's record lists ${name} at ${addr} as a ${kind}condominium`;
  if (p.units_residential != null) summary += ` with ${plural(p.units_residential, "residential unit")}`;
  const extras = [];
  if (p.units_parking) extras.push(plural(p.units_parking, "parking unit"));
  if (p.units_storage) extras.push(plural(p.units_storage, "storage unit"));
  if (p.units_commercial) extras.push(plural(p.units_commercial, "commercial unit"));
  if (extras.length) summary += `, plus ${extras.join(" and ")}`;
  summary += ".";
  if (p.sponsor) summary += ` The sponsor is ${tc(p.sponsor)}.`;
  if (p.accepted_date) summary += ` The plan was accepted for filing in ${month(p.accepted_date)}`;
  if (p.accepted_date) summary += amends.length ? ` and has ${plural(amends.length, "amendment")} listed.` : ".";

  const coverage = searchable
    ? `${done.map(docLabel).join(", ")} ${done.length === 1 ? "is" : "are"} searchable here.` + (docs.length > done.length ? ` ${plural(docs.length - done.length, "posted document")} not searched yet.` : "") +
      ((p.amendments_listed ?? 0) > done.filter((d) => d.doc_kind === "amendment").length ? " Some listed amendments are not searched." : "")
    : docs.length ? `${plural(docs.length, "document")} posted by the AG, not searched yet.` : "The AG has not posted documents for this plan yet.";

  const glance = [
    ["Residential units", p.units_residential],
    ["Parking units", p.units_parking],
    ["Storage units", p.units_storage],
    ["Commercial units", p.units_commercial],
    ["Accepted", day(p.accepted_date)],
    ["Latest amendment", lastAmend ? `No. ${lastAmend.no}${lastAmend.submitted ? `, submitted ${day(lastAmend.submitted)}` : ""}` : (p.amendments_listed ? `${p.amendments_listed} listed` : "None listed")],
  ].filter(([, v]) => v !== null && v !== undefined && v !== "");

  const near = ctx.plans.filter((q) => q.plan_id !== p.plan_id && q.lat && p.lat)
    .map((q) => ({ q, d: miles(p, q) })).sort((a, b) => a.d - b.d).slice(0, 6);
  const nearHtml = near.length ? `<h3>Compare nearby condo plans</h3><ul class="near">${near.map(({ q, d }) => `<li><a href="${esc(fileFor(q))}">${esc(tc(q.name))}</a><span>${d < 0.1 ? "next door" : d.toFixed(1) + " mi"} · ${q.units_residential ?? "?"} units${q.units_parking ? ` · ${q.units_parking} parking` : ""}${q.accepted_date ? ` · ${new Date(q.accepted_date).getFullYear()}` : ""}</span></li>`).join("")}</ul>` : "";

  const img = ctx.images.has(p.plan_id)
    ? `<figure class="massing"><img src="img/${esc(p.plan_id)}.webp" alt="3D massing drawing of ${esc(name)} and neighboring buildings" loading="lazy"><figcaption>3D massing from NYC Building Footprints, not a photograph. The plan's building is in green.</figcaption></figure>` : "";

  const search = searchable ? `<form class="psearch" id="psearch" data-plan="${esc(p.plan_id)}">
      <label for="pq">Search this offering plan${done.length > 1 ? " and its amendments" : ""}</label>
      <div class="prow"><input id="pq" type="search" placeholder="e.g. parking, storage, roof, managing agent" enterkeyhint="search"><button type="submit">Search</button></div>
      <div class="chips">${["parking", "storage", "roof", "inclusionary OR MIH", "managing agent", "architect"].map((t) => `<button type="button" data-q="${esc(t)}">${esc(t)}</button>`).join("")}</div>
      <div id="presults" role="status"></div>
    </form>
    <script type="application/json" id="pdocs">${JSON.stringify(Object.fromEntries(done.map((d) => [d.file_id, docLabel(d)]))).replace(/</g, "\\u003c")}</script>` : "";

  const amendRows = amends.length ? amends.map((a) => {
    const d = docs.find((x) => x.doc_kind === "amendment" && x.amendment_no === a.no);
    const state = d ? (d.status === "done" ? "Searchable here" : "Posted, not searched yet") : "Not posted";
    return `<tr><td>${a.no}</td><td>${esc(day(a.submitted) || "—")}</td><td>${esc(tc(a.action) === "1" ? "—" : tc(a.action))}</td><td>${state}</td></tr>`;
  }).join("") : "";

  const docRows = docs.length ? docs.slice().sort((a, b) => (a.doc_kind === "amendment") - (b.doc_kind === "amendment") || (a.amendment_no ?? 0) - (b.amendment_no ?? 0))
    .map((d) => `<li><span>${esc(docLabel(d))}</span><span class="m">${d.num_pages ? d.num_pages + " pages" : ""}${d.size_mb ? ` · ${esc(d.size_mb)} MB` : ""} · ${d.status === "done" ? "searchable here" : "not searched yet"}</span></li>`).join("") : "";

  const ldJson = { "@context": "https://schema.org", "@type": "Residence", name, address: { "@type": "PostalAddress", streetAddress: addr, addressLocality: b, addressRegion: "NY", postalCode: p.zip || undefined, addressCountry: "US" } };
  if (p.lat) ldJson.geo = { "@type": "GeoCoordinates", latitude: p.lat, longitude: p.lng };

  return HEAD(P, { title, description, canonical, noindex: !searchable }) + `<main class="bldg">
  <nav class="crumbs" aria-label="Breadcrumb"><a href="index.html">Buildings</a> › <a href="index.html#${slug(b)}">${esc(b)}</a></nav>
  <h1>${esc(name)} offering plan</h1>
  <p class="addr">${esc(addr)} · ${esc(b)}, New York${p.zip ? " " + esc(p.zip) : ""}</p>
  <p class="meta">AG plan ID ${esc(p.plan_id)}${p.accepted_date ? ` · Accepted ${esc(day(p.accepted_date))}` : ""}</p>

  <nav class="tabs" aria-label="Sections">
    <a href="#overview">Overview</a><a href="#pricing">Pricing &amp; units</a><a href="#budget">Budget &amp; charges</a><a href="#team">Team</a><a href="#floor-plans">Floor plans</a><a href="#documents">Documents</a>
  </nav>

  <section class="tab" id="overview">
    <h2>Overview</h2>
    <p>${esc(summary)}</p>
    <dl class="glance">${glance.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join("")}</dl>
    <div class="acts"><a class="btn primary" href="${esc(agDocs)}" rel="noopener">View the original offering plan ↗</a><a class="btn" href="${esc(agRecord)}" rel="noopener">View the AG filing record ↗</a></div>
    <p class="cov"><b>Coverage.</b> ${esc(coverage)}</p>
    ${search}
    ${img}
    ${nearHtml}
  </section>

  <section class="tab" id="pricing">
    <h2>Pricing &amp; units</h2>
    <dl class="glance">
      ${[["Residential", p.units_residential], ["Commercial", p.units_commercial], ["Parking", p.units_parking], ["Storage", p.units_storage], ["Other", p.units_other], ["Total units", p.units_total]].filter(([, v]) => v != null).map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join("")}
      ${initial ? `<div><dt>Total offering price, initial</dt><dd>${fmtMoney(initial)}</dd></div>` : ""}
      ${current && current !== initial ? `<div><dt>Total offering price, current</dt><dd>${fmtMoney(current)}</dd></div>` : ""}
    </dl>
    <p class="src">Unit counts and total offering price as recorded by the Attorney General. The total offering price is the sum of all units at the plan's prices, not a sale price.</p>
    ${pending("Unit-by-unit prices, unit sizes and $/sf. These are in Schedule A of the plan and its amendments.")}
    ${whereToLook("schedule_a", sections, docsById)}
  </section>

  <section class="tab" id="budget">
    <h2>Budget &amp; charges</h2>
    ${pending("Projected first-year budget, common charges by unit and real estate tax estimates. These are in Schedule B, and later amendments may revise them.")}
    ${whereToLook("schedule_b", sections, docsById)}
  </section>

  <section class="tab" id="team">
    <h2>Team</h2>
    <dl class="glance">
      ${p.sponsor ? `<div><dt>Sponsor</dt><dd>${esc(tc(p.sponsor))}</dd></div>` : ""}
      ${p.law_firm ? `<div><dt>Sponsor's counsel</dt><dd>${esc(tc(p.law_firm))}</dd></div>` : ""}
    </dl>
    <p class="src">As recorded by the Attorney General.</p>
    ${pending("Architect, managing agent, selling agent and other named professionals. They are named in the plan, and an amendment can replace them.")}
    ${whereToLook("management_agreement", sections, docsById)}
  </section>

  <section class="tab" id="floor-plans">
    <h2>Floor plans</h2>
    ${whereToLook("floor_plans", sections, docsById, 6) || `<p>${searchable ? "No pages headed “Floor plans” were found in the searched documents." : "The plan's documents are not searched yet."}</p>`}
    <p class="src">Floor plans are drawings inside the plan PDF. Open the plan from the Attorney General's site and go to the pages listed.</p>
    <div class="acts"><a class="btn" href="${esc(agDocs)}" rel="noopener">Open the plan documents ↗</a></div>
  </section>

  <section class="tab" id="documents">
    <h2>Documents</h2>
    ${docRows ? `<ul class="doclist">${docRows}</ul>` : `<p>The Attorney General has not posted documents for this plan yet. Copies can be requested through a FOIL request.</p>`}
    ${whereToLook("declaration", sections, docsById, 2)}
    ${whereToLook("bylaws", sections, docsById, 2)}
    <h3>Amendments</h3>
    ${amendRows ? `<p>The original plan may have changed. These are the amendments listed for this filing.</p>
    <div class="tscroll"><table><thead><tr><th>No.</th><th>Submitted</th><th>Status</th><th>On Open Book</th></tr></thead><tbody>${amendRows}</tbody></table></div>` : `<p>No amendments are listed for this filing.</p>`}
    <div class="acts"><a class="btn" href="${esc(agDocs)}" rel="noopener">View all documents on the AG website ↗</a></div>
  </section>

  <section class="record">
    <h2>About this record</h2>
    <p>Source: New York State Attorney General, Real Estate Finance Bureau. Open Book is an independent research tool and is not affiliated with the Attorney General's office. Plan record last checked ${esc(day((p.fetched_at || "").slice(0, 10)) || day(TODAY))}${effective ? `; plan effective ${esc(day(effective))}` : ""}. ${esc(coverage)}</p>
    <p>Offering plans describe what was offered when filed. They do not confirm current availability, pricing, or the building's present condition. Review the source documents and later amendments before relying on anything here.</p>
    <p><a href="mailto:hello@halfave.co?subject=${encodeURIComponent(`Open Book error: ${p.plan_id}`)}">Found an error? Report it →</a></p>
  </section>
</main>
<script type="application/ld+json">${JSON.stringify(ldJson).replace(/</g, "\\u003c")}</script>
` + FOOT(P, `<script src="${P}building.js"></script>\n`);
}

// ---------- directory ----------
function directory(plans, ctx) {
  const P = "../";
  const by = new Map();
  for (const p of plans) { const b = boro(p.borough); if (!by.has(b)) by.set(b, []); by.get(b).push(p); }
  const order = ["Manhattan", "Brooklyn", "Queens", "Bronx", "Staten Island"];
  const boros = [...by.keys()].sort((a, b) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99));
  const body = boros.map((b) => {
    const list = by.get(b).sort((x, y) => tc(x.name).localeCompare(tc(y.name)));
    return `<h2 id="${slug(b)}">${esc(b)} <span class="count">${list.length}</span></h2><ul class="dir">${list.map((p) =>
      `<li><a href="${esc(fileFor(p))}">${esc(tc(p.name))}</a><span>${esc(tc(p.address))} · ${p.units_residential ?? "?"} units${p.units_parking ? ` · ${p.units_parking} parking` : ""}${ctx.searchable.has(p.plan_id) ? " · <b>searchable</b>" : ""}</span></li>`).join("")}</ul>`;
  }).join("\n");
  return HEAD(P, {
    title: "NYC Condo Offering Plans by Building | Open Book",
    description: `Every NYC condo offering plan on Open Book, by borough: ${plans.length.toLocaleString("en-US")} plans with units, parking, amendments and source links.`,
    canonical: `${SITE_URL}/buildings/index.html`,
  }) + `<main>
  <h1>Buildings</h1>
  <p class="lede">${plans.length.toLocaleString("en-US")} NYC condo offering plans on file. ${ctx.searchable.size.toLocaleString("en-US")} are searchable in full text.</p>
  <nav class="toc" aria-label="Boroughs">${boros.map((b) => `<a href="#${slug(b)}">${esc(b)}</a>`).join(" · ")}</nav>
  ${body}
</main>
` + FOOT(P);
}

// ---------- main ----------
const plans = (await all("plans?select=plan_id,name,address,zip,borough,construction,accepted_date,units_residential,units_commercial,units_parking,units_storage,units_other,units_total,sponsor,law_firm,amendments_listed,latest_amendment_no,latest_amendment_date,meta,fetched_at,lat,lng&order=plan_id"))
  .filter((p) => p.address);
const docRows = await all("documents?select=file_id,plan_id,filename,doc_kind,amendment_no,size_mb,num_pages,status&order=file_id");
const docs = new Map();
for (const d of docRows) { if (!docs.has(d.plan_id)) docs.set(d.plan_id, []); docs.get(d.plan_id).push(d); }
const searchable = new Set(docRows.filter((d) => d.status === "done").map((d) => d.plan_id));

const sections = new Map();
const sIds = [...searchable];
for (let i = 0; i < sIds.length; i += 1) {
  for (const s of await rpc("plan_sections", { p_ids: sIds.slice(i, i + 1) })) {
    if (!sections.has(s.plan_id)) sections.set(s.plan_id, []);
    sections.get(s.plan_id).push(s);
  }
}

await rm(OUT, { recursive: true, force: true });
await mkdir(join(OUT, "img"), { recursive: true });

// One massing image per plan: approved first, then highest score.
const images = new Set();
const imgRows = [];
for (let i = 0; i < sIds.length; i += 50) {
  const ids = sIds.slice(i, i + 50).map((id) => `"${id}"`).join(",");
  imgRows.push(...await all(`plan_images?select=plan_id,img,approved,score&plan_id=in.(${ids})&order=plan_id,approved.desc.nullslast,score.desc.nullslast`, 100));
}
for (const r of imgRows) {
  // Only indexed (searchable) pages get an image, to keep the repo small.
  if (images.has(r.plan_id) || !searchable.has(r.plan_id)) continue;
  const m = String(r.img || "").match(/^data:image\/webp;base64,(.+)$/);
  if (!m) continue;
  await writeFile(join(OUT, "img", r.plan_id + ".webp"), Buffer.from(m[1], "base64"));
  images.add(r.plan_id);
}

const ctx = { plans, docs, sections, images, searchable };
for (const p of plans) await writeFile(join(OUT, fileFor(p)), buildingPage(p, ctx));
await writeFile(join(OUT, "index.html"), directory(plans, ctx));

// Sitemap lists only pages we want indexed: site pages, the directory, and searchable plans.
const urls = ["index.html", "about.html", "faq.html", "buildings/index.html",
  ...plans.filter((p) => searchable.has(p.plan_id)).map((p) => "buildings/" + fileFor(p))];
await writeFile(join(ROOT, "sitemap.xml"), `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((u) => `  <url><loc>${SITE_URL}/${u}</loc><lastmod>${TODAY}</lastmod></url>`).join("\n")}
</urlset>
`);
await writeFile(join(ROOT, "robots.txt"), `User-agent: *\nAllow: /\n\nSitemap: ${SITE_URL}/sitemap.xml\n`);

console.log(`${plans.length} building pages (${searchable.size} indexed, rest noindex), ${images.size} images, sitemap with ${urls.length} URLs for ${SITE_URL}`);
