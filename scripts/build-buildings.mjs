// Builds one static page per offering plan, plus the buildings directory and sitemap-buildings.xml.
// Blog posts, the new-filings page, sitemap.xml and robots.txt come from build-pages.mjs (fast; run it too).
//
//   node scripts/build-buildings.mjs
//   SITE_URL=https://example.com node scripts/build-buildings.mjs
//
// Reads the public, read-only Supabase REST API (same key the site uses). Re-run it after new
// plans are ingested; pages for plans added since the last build do not exist until then.
import { mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { join } from "node:path";

import { SB, KEY, SITE_URL, AG, ROOT, OUT, TODAY, rest, all, rpc, esc, tc, slug, fileFor, month, day, usDate, money, fmtMoney, plural, BORO, boro, docLabel, pagesLabel, miles, MAST_HTML, MAST, SITE_NAME, ld, SEO, HEAD, MENU, FOOT, urlset } from "./site.mjs";

// ---------- junk records ----------
// AG rows that aren't a real offering: 0 units with nothing to read, or names like "*Resubmit*" or
// "(8/3/89 Rs-3 Filed)". Their pages still build (links may exist) but stay out of lists and the sitemap.
const JUNK_NAME = /resubmit|withdrawn|\(\s*\d{1,2}\/\d{1,2}\/\d{2,4}|\bfiled\s*\)/i;
const isJunk = (p, searchable) => JUNK_NAME.test(p.name || "") || (!searchable.has(p.plan_id) && !p.units_residential && !p.units_total);

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
  const items = shown.map((r) => { const d = docsById.get(r.file_id) || {}; const t = `<b>${esc(docLabel(d))}</b>, ${pagesLabel(r.first_page, r.last_page)}`; return `<li>${d.pdf_url ? `<a href="${esc(d.pdf_url)}#page=${r.first_page}" rel="noopener">${t}</a>` : t}</li>`; }).join("");
  const more = runs.length > shown.length ? `<li class="faint">and ${plural(runs.length - shown.length, "more place")}</li>` : "";
  return `<div class="where"><div class="where-h">Where to look: pages headed “${esc(SECTION_NAMES[kind])}”</div><ul>${items}${more}</ul></div>`;
}

function buildingPage(p, ctx) {
  const P = "../";
  const name = tc(p.name), addr = tc(p.address), group = boro(p.borough);
  const b = BORO[String(p.borough || "").trim().toUpperCase()] || tc(p.borough); // place name shown in the address
  const meta = p.meta || {}, mp = meta.plan || {};
  const docs = (ctx.docs.get(p.plan_id) || []).filter((d) => d.doc_kind !== "amendment");
  const docsById = new Map(docs.map((d) => [d.file_id, d]));
  const done = docs.filter((d) => d.status === "done");
  const searchable = done.length > 0;
  const sections = ctx.sections.get(p.plan_id) || [];
  // Counsel's contact from the AG record (meta.stat): attorney of record, address, phone.
  const st = meta.stat || {};
  const counsel = [st.By && tc(st.By), st.Address && tc(st.Address), st.Phone].filter(Boolean);
  const initial = money(mp["Initial Price"]), current = money(mp["Current Price"]);
  const agRecord = AG + encodeURIComponent(p.plan_id), agDocs = agRecord + "#tabs-6";
  const mainPdf = (docs.find((d) => d.pdf_url && d.doc_kind === "offering_plan") || docs.find((d) => d.pdf_url) || {}).pdf_url || null;
  const planHref = mainPdf || agDocs, planLabel = mainPdf ? "Open the original offering plan (PDF) ↗" : "View the original offering plan ↗";
  const canonical = `${SITE_URL}/buildings/${fileFor(p)}`;

  const title = `${addr || name} Offering Plan: Units, Parking, Budget & Team | The Condo Book Project`;
  const bits = [];
  if (p.units_residential != null) bits.push(plural(p.units_residential, "residential unit"));
  if (p.units_parking) bits.push(plural(p.units_parking, "parking unit"));
  const description = `${name}, ${addr}, ${b}. AG plan ${p.plan_id}${p.accepted_date ? `, accepted ${month(p.accepted_date)}` : ""}.${bits.length ? " " + bits.join(", ") + "." : ""} Budget, team, documents and source links.`;

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
  if (p.accepted_date) summary += ` The plan was accepted for filing in ${month(p.accepted_date)}.`;

  const coverage = searchable
    ? "The offering plan is searchable here."
    : docs.length ? "The offering plan is posted by the AG but not searched yet." : "The AG has not posted the offering plan for this filing yet.";

  const glance = [
    ["Residential units", p.units_residential],
    ["Parking units", p.units_parking],
    ["Storage units", p.units_storage],
    ["Commercial units", p.units_commercial],
    ["Accepted", day(p.accepted_date)],
  ].filter(([, v]) => v !== null && v !== undefined && v !== "");

  const near = ctx.plans.filter((q) => q.plan_id !== p.plan_id && q.lat && p.lat && !isJunk(q, ctx.searchable))
    .map((q) => ({ q, d: miles(p, q) })).sort((a, b) => a.d - b.d).slice(0, 6);
  const nearHtml = near.length ? `<h3>Compare Nearby Condo Plans</h3><ul class="near">${near.map(({ q, d }) => `<li><a href="${esc(fileFor(q))}">${esc(tc(q.name))}</a><span>${d < 0.1 ? "next door" : d.toFixed(1) + " mi"} · ${q.units_residential ?? "?"} units${q.units_parking ? ` · ${q.units_parking} parking` : ""}${q.accepted_date ? ` · ${new Date(q.accepted_date).getFullYear()}` : ""}</span></li>`).join("")}</ul>` : "";

  const img = ctx.images.has(p.plan_id)
    ? `<figure class="massing"><img src="img/${esc(p.plan_id)}.webp" alt="3D massing drawing of ${esc(name)} and neighboring buildings" loading="lazy"><figcaption>3D massing from NYC Building Footprints, not a photograph. The plan's building is in green.</figcaption></figure>` : "";

  const search = searchable ? `<form class="psearch" id="psearch" data-plan="${esc(p.plan_id)}">
      <label for="pq">Search This Offering Plan</label>
      <div class="prow"><input id="pq" type="search" placeholder="e.g. parking, storage, roof, managing agent" enterkeyhint="search"><button type="submit">Search</button></div>
      <div class="chips">${["parking", "storage", "roof", "inclusionary OR MIH", "managing agent", "architect"].map((t) => `<button type="button" data-q="${esc(t)}">${esc(t)}</button>`).join("")}</div>
      <div id="presults" role="status"></div>
    </form>
    <script type="application/json" id="pdocs">${JSON.stringify(Object.fromEntries(done.map((d) => [d.file_id, docLabel(d)]))).replace(/</g, "\\u003c")}</script>` : "";

  const docRows = docs.length ? docs
    .map((d) => `<li><span>${d.pdf_url ? `<a href="${esc(d.pdf_url)}" rel="noopener">${esc(docLabel(d))} ↗</a>` : esc(docLabel(d))}</span><span class="m">${d.num_pages ? d.num_pages + " pages" : ""}${d.size_mb ? ` · ${esc(d.size_mb)} MB` : ""} · ${d.status === "done" && !d.needs_ocr ? "searchable here" : d.needs_ocr ? "scanned, not text-searchable" : "not searched yet"}</span></li>`).join("") : "";

  const image = ctx.images.has(p.plan_id) ? `${SITE_URL}/buildings/img/${p.plan_id}.webp` : null;
  // Only what the AG record states. ApartmentComplex is schema.org's residential-building type.
  const ldJson = {
    "@context": "https://schema.org", "@type": "ApartmentComplex", "@id": canonical + "#building", name, url: canonical, description,
    identifier: { "@type": "PropertyValue", propertyID: "NY AG offering plan ID", value: p.plan_id },
    address: { "@type": "PostalAddress", streetAddress: addr, addressLocality: b, addressRegion: "NY", postalCode: p.zip || undefined, addressCountry: "US" },
  };
  if (p.units_residential != null) ldJson.numberOfAccommodationUnits = p.units_residential;
  if (p.lat) ldJson.geo = { "@type": "GeoCoordinates", latitude: p.lat, longitude: p.lng };
  if (image) ldJson.image = image;
  if (group !== "Outside New York City") ldJson.containedInPlace = { "@type": "Place", name: `${group}, New York` };
  const crumbs = {
    "@context": "https://schema.org", "@type": "BreadcrumbList", itemListElement: [
      { "@type": "ListItem", position: 1, name: "Buildings", item: `${SITE_URL}/buildings/` },
      { "@type": "ListItem", position: 2, name: group, item: `${SITE_URL}/buildings/#${slug(group)}` },
      { "@type": "ListItem", position: 3, name, item: canonical },
    ],
  };

  return HEAD(P, { title, description, canonical, noindex: !searchable || isJunk(p, ctx.searchable), image, imageAlt: `3D massing drawing of ${name}` }) + `<main class="bldg" data-plan="${esc(p.plan_id)}" data-borough="${esc(group)}" data-searchable="${searchable}">
  <nav class="crumbs" aria-label="Breadcrumb"><a href="index.html">Buildings</a> › <a href="index.html#${slug(group)}">${esc(group)}</a></nav>
  <h1>${esc(name)} Offering Plan</h1>
  <p class="addr">${esc(addr)} · ${esc(b)}, New York${p.zip ? " " + esc(p.zip) : ""}</p>
  <p class="meta">AG plan ID ${esc(p.plan_id)}${p.accepted_date ? ` · Accepted ${esc(day(p.accepted_date))}` : ""}</p>

  <nav class="tabs" aria-label="Sections">
    <a href="#overview">Overview</a><a href="#pricing">Pricing &amp; Units</a><a href="#budget">Budget &amp; Charges</a><a href="#team">Team</a><a href="#floor-plans">Floor Plans</a><a href="#documents">Documents</a>
  </nav>

  <section class="tab" id="overview">
    <h2>Overview</h2>
    <p>${esc(summary)}</p>
    <dl class="glance">${glance.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join("")}</dl>
    <div class="acts"><a class="btn primary" href="${esc(planHref)}" rel="noopener">${planLabel}</a><a class="btn" href="${esc(agRecord)}" rel="noopener">View the AG filing record ↗</a></div>
    <p class="cov"><b>Coverage.</b> ${esc(coverage)} <a href="${P}coverage.html">What's covered</a></p>
    ${search}
    ${img}
    ${nearHtml}
  </section>

  <section class="tab" id="pricing">
    <h2>Pricing &amp; Units</h2>
    <dl class="glance">
      ${[["Residential", p.units_residential], ["Commercial", p.units_commercial], ["Parking", p.units_parking], ["Storage", p.units_storage], ["Other", p.units_other], ["Total units", p.units_total]].filter(([, v]) => v != null).map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join("")}
      ${initial ? `<div><dt>Total offering price, initial</dt><dd>${fmtMoney(initial)}</dd></div>` : ""}
      ${current && current !== initial ? `<div><dt>Total offering price, current</dt><dd>${fmtMoney(current)}</dd></div>` : ""}
    </dl>
    ${whereToLook("schedule_a", sections, docsById)}
  </section>

  <section class="tab" id="budget">
    <h2>Budget &amp; Charges</h2>
    <div id="schedb" data-plan="${esc(p.plan_id)}"><noscript><p class="faint">Turn on JavaScript to see the Schedule B budget.</p></noscript></div>
    <div id="schedb-where">${whereToLook("schedule_b", sections, docsById)}</div>
  </section>

  <section class="tab" id="team">
    <h2>Team</h2>
    <dl class="glance">
      ${p.sponsor ? `<div><dt>Sponsor</dt><dd>${esc(tc(p.sponsor))}</dd></div>` : ""}
      ${p.law_firm ? `<div><dt>Sponsor's counsel</dt><dd>${esc(tc(p.law_firm))}${counsel.map((x) => `<span class="sub">${esc(x)}</span>`).join("")}</dd></div>` : ""}
    </dl>
    ${whereToLook("management_agreement", sections, docsById)}
  </section>

  <section class="tab" id="floor-plans">
    <h2>Floor Plans</h2>
    ${whereToLook("floor_plans", sections, docsById, 6) || `<p>${searchable ? "No pages headed “Floor plans” were found in the searched documents." : "The plan's documents are not searched yet."}</p>`}
    <p class="src">Floor plans are drawings inside the plan PDF. ${mainPdf ? "Linked page references open the PDF at that page." : "Open the plan from the Attorney General's site and go to the pages listed."}</p>
    <div class="acts"><a class="btn" href="${esc(planHref)}" rel="noopener">Open the plan documents ↗</a></div>
  </section>

  <section class="tab" id="documents">
    <h2>Documents</h2>
    ${docRows ? `<ul class="doclist">${docRows}</ul>` : `<p>The Attorney General has not posted documents for this plan yet. Copies can be requested through a FOIL request.</p>`}
    ${whereToLook("declaration", sections, docsById, 2)}
    ${whereToLook("bylaws", sections, docsById, 2)}
    <div class="acts"><a class="btn" href="${esc(agDocs)}" rel="noopener">View all documents on the AG website ↗</a></div>
  </section>

</main>
${ld(ldJson)}
${ld(crumbs)}
` + FOOT(P, `<script src="${P}building.js"></script>\n`);
}

// ---------- directory ----------
function directory(plans, ctx) {
  const P = "../";
  const by = new Map();
  for (const p of plans) { const b = boro(p.borough); if (!by.has(b)) by.set(b, []); by.get(b).push(p); }
  const order = ["Manhattan", "Brooklyn", "Queens", "Bronx", "Staten Island", "Outside New York City"];
  const boros = [...by.keys()].sort((a, b) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99));
  const body = boros.map((b) => {
    const list = by.get(b).sort((x, y) => tc(x.name).localeCompare(tc(y.name)));
    return `<h2 id="${slug(b)}">${esc(b)} <span class="count">${list.length}</span></h2><ul class="dir">${list.map((p) =>
      `<li><a href="${esc(fileFor(p))}">${esc(tc(p.name))}</a><span>${esc(tc(p.address))} · ${p.units_residential ?? "?"} units${p.units_parking ? ` · ${p.units_parking} parking` : ""}${ctx.searchable.has(p.plan_id) ? " · <b>searchable</b>" : ""}</span></li>`).join("")}</ul>`;
  }).join("\n");
  return HEAD(P, {
    title: "NYC Condo Offering Plans by Building | The Condo Book Project",
    description: `Every NYC condo offering plan on The Condo Book Project, by borough: ${plans.length.toLocaleString("en-US")} plans with units, parking, budgets and source links.`,
    canonical: `${SITE_URL}/buildings/`,
  }) + ld({
    "@context": "https://schema.org", "@type": "CollectionPage", name: "NYC Condo Offering Plans by Building", url: `${SITE_URL}/buildings/`,
    isPartOf: { "@type": "WebSite", name: SITE_NAME, url: `${SITE_URL}/` },
  }) + `
<main>
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
const docRows = await all("documents?select=file_id,plan_id,filename,doc_kind,amendment_no,size_mb,num_pages,status,needs_ocr,pdf_url&order=file_id");
const docs = new Map();
for (const d of docRows) { if (!docs.has(d.plan_id)) docs.set(d.plan_id, []); docs.get(d.plan_id).push(d); }
const searchable = new Set(docRows.filter((d) => d.status === "done").map((d) => d.plan_id));

const sections = new Map();
const sIds = [...searchable];
for (let i = 0; i < sIds.length; i += 20) {
  for (const s of await rpc("plan_sections", { p_ids: sIds.slice(i, i + 20) })) {
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
await writeFile(join(OUT, "index.html"), directory(plans.filter((p) => !isJunk(p, searchable)), ctx));

// Buildings sitemap: the directory and the searchable plans (the rest are noindex). sitemap.xml is an index
// written by build-pages.mjs that points here. lastmod is when the plan record was last fetched.
const urls = [["buildings/", TODAY], ...plans.filter((p) => searchable.has(p.plan_id) && !isJunk(p, searchable)).map((p) => ["buildings/" + fileFor(p), (p.fetched_at || "").slice(0, 10) || TODAY])];
await writeFile(join(ROOT, "sitemap-buildings.xml"), urlset(urls));

console.log(`${plans.length} building pages (${searchable.size} indexed, rest noindex), ${images.size} images, sitemap-buildings.xml with ${urls.length} URLs for ${SITE_URL}`);
