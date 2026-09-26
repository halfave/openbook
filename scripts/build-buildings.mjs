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
  const name = tc(p.name), addr = tc(p.address), group = boro(p.borough);
  const b = BORO[String(p.borough || "").trim().toUpperCase()] || tc(p.borough); // place name shown in the address
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

  const title = `${addr || name} Offering Plan: Units, Parking & Amendments | The Condo Book Project`;
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

  return HEAD(P, { title, description, canonical, noindex: !searchable, image, imageAlt: `3D massing drawing of ${name}` }) + `<main class="bldg" data-plan="${esc(p.plan_id)}" data-borough="${esc(group)}" data-searchable="${searchable}">
  <nav class="crumbs" aria-label="Breadcrumb"><a href="index.html">Buildings</a> › <a href="index.html#${slug(group)}">${esc(group)}</a></nav>
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
    <div class="tscroll"><table><thead><tr><th>No.</th><th>Submitted</th><th>Status</th><th>Searchable here</th></tr></thead><tbody>${amendRows}</tbody></table></div>` : `<p>No amendments are listed for this filing.</p>`}
    <div class="acts"><a class="btn" href="${esc(agDocs)}" rel="noopener">View all documents on the AG website ↗</a></div>
  </section>

  <section class="record">
    <h2>About this record</h2>
    <p>Source: New York State Attorney General, Real Estate Finance Bureau. The Condo Book Project is an independent research tool and is not affiliated with the Attorney General's office. Plan record last checked ${esc(day((p.fetched_at || "").slice(0, 10)) || day(TODAY))}${effective ? `; plan effective ${esc(day(effective))}` : ""}. ${esc(coverage)}</p>
    <p>Offering plans describe what was offered when filed. They do not confirm current availability, pricing, or the building's present condition. Review the source documents and later amendments before relying on anything here.</p>
    <p><a href="mailto:hello@halfave.co?subject=${encodeURIComponent(`The Condo Book Project error: ${p.plan_id}`)}">Found an error? Report it →</a></p>
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
    description: `Every NYC condo offering plan on The Condo Book Project, by borough: ${plans.length.toLocaleString("en-US")} plans with units, parking, amendments and source links.`,
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
const docRows = await all("documents?select=file_id,plan_id,filename,doc_kind,amendment_no,size_mb,num_pages,status&order=file_id");
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
await writeFile(join(OUT, "index.html"), directory(plans, ctx));

// Buildings sitemap: the directory and the searchable plans (the rest are noindex). sitemap.xml is an index
// written by build-pages.mjs that points here. lastmod is when the plan record was last fetched.
const urls = [["buildings/", TODAY], ...plans.filter((p) => searchable.has(p.plan_id)).map((p) => ["buildings/" + fileFor(p), (p.fetched_at || "").slice(0, 10) || TODAY])];
await writeFile(join(ROOT, "sitemap-buildings.xml"), urlset(urls));

console.log(`${plans.length} building pages (${searchable.size} indexed, rest noindex), ${images.size} images, sitemap-buildings.xml with ${urls.length} URLs for ${SITE_URL}`);
