// Builds one static page per offering plan, plus the buildings directory and sitemap-buildings.xml.
// Blog posts, the new-filings page, sitemap.xml and robots.txt come from build-pages.mjs (fast; run it too).
//
//   node scripts/build-buildings.mjs
//   SITE_URL=https://example.com node scripts/build-buildings.mjs
//
// Reads the public, read-only Supabase REST API (same key the site uses). Re-run it after new
// plans are ingested; pages for plans added since the last build do not exist until then.
import { mkdir, writeFile, rm, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import { SB, KEY, SITE_URL, AG, ROOT, OUT, TODAY, rest, all, rpc, esc, tc, slug, fileFor, month, day, usDate, money, fmtMoney, plural, BORO, boro, docLabel, pagesLabel, miles, MAST_HTML, MAST, SITE_NAME, ld, SEO, HEAD, fitDesc, firstFit, OG_SITE, MENU, FOOT, urlset } from "./site.mjs";
import { groupAgents, groupFirms, groupPros, profileLinks } from "./pros.mjs";

// ---------- junk records ----------
// AG rows that aren't a real offering: 0 units with nothing to read, or names like "*Resubmit*" or
// "(8/3/89 Rs-3 Filed)". Their pages still build (links may exist) but stay out of lists and the sitemap.
const JUNK_NAME = /resubmit|withdrawn|\(\s*\d{1,2}\/\d{1,2}\/\d{2,4}|\bfiled\s*\)/i;
const isJunk = (p, searchable) => JUNK_NAME.test(p.name || "") || (!searchable.has(p.plan_id) && !p.units_residential && !p.units_total);

// ---------- building page ----------
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

  // The plan ID keeps two plans at one address apart, and is what people search the AG site by.
  // Titles use the first address of an "A/K/A" pair; the description keeps the full one.
  const tAddr = (addr || name).replace(/\s*[(,]?\s*\b(a\/k\/a|aka)\b.*$/i, "") || addr || name;
  const title = firstFit(`${tAddr} Condo Offering Plan (${p.plan_id})`, `${tAddr} Offering Plan (${p.plan_id})`, `${tAddr} (${p.plan_id})`);
  const bits = [];
  if (p.units_residential != null) bits.push(plural(p.units_residential, "residential unit"));
  if (p.units_parking) bits.push(plural(p.units_parking, "parking unit"));
  const where = [name.toLowerCase() === addr.toLowerCase() ? "" : name, addr, b].filter(Boolean).join(", ");
  const description = fitDesc(`${where}. AG plan ${p.plan_id}${p.accepted_date ? `, accepted ${month(p.accepted_date)}` : ""}.`,
    [bits.length ? " " + bits.join(", ") + "." : "", " Budget, team, documents and source links."]);

  const near = ctx.plans.filter((q) => q.plan_id !== p.plan_id && q.lat && p.lat && !isJunk(q, ctx.searchable))
    .map((q) => ({ q, d: miles(p, q) })).sort((a, b) => a.d - b.d).slice(0, 6);
  const nearHtml = near.length ? `<h3>Compare Nearby Condo Plans</h3><ul class="near">${near.map(({ q, d }) => `<li><a href="${esc(fileFor(q))}">${esc(tc(q.name))}</a><span>${d < 0.1 ? "next door" : d.toFixed(1) + " mi"} · ${q.units_residential ?? "?"} units${q.units_parking ? ` · ${q.units_parking} parking` : ""}${q.accepted_date ? ` · ${new Date(q.accepted_date).getFullYear()}` : ""}</span></li>`).join("")}</ul>` : "";

  const search = searchable ? `<form class="psearch" id="psearch" data-plan="${esc(p.plan_id)}">
      <label for="pq">Search This Offering Plan</label>
      <div class="prow"><input id="pq" type="search" placeholder="e.g. parking, storage, roof, managing agent" enterkeyhint="search"><button type="submit">Search</button></div>
      <div class="chips">${["parking", "storage", "roof", "inclusionary OR MIH", "managing agent", "architect"].map((t) => `<button type="button" data-q="${esc(t)}">${esc(t)}</button>`).join("")}</div>
      <div id="presults" role="status"></div>
    </form>
    <script type="application/json" id="pdocs">${JSON.stringify(Object.fromEntries(done.map((d) => [d.file_id, docLabel(d)]))).replace(/</g, "\\u003c")}</script>` : "";

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

  // Fact sheet: picture and buttons on the left, one table of facts on the right, then what's in the plan.
  const price = current || initial;
  const unitsLine = [p.units_residential != null && `${p.units_residential} residential`, p.units_parking && `${p.units_parking} parking`,
    p.units_storage && `${p.units_storage} storage`, p.units_commercial && `${p.units_commercial} commercial`].filter(Boolean).join(" · ");
  const row = (k, v) => v ? `<div><dt>${esc(k)}</dt><dd>${v}</dd></div>` : "";
  const taxBy = ctx.taxPrep.get(p.plan_id)?.name, taxSlug = taxBy && ctx.links.taxers.get(p.plan_id)?.[taxBy];
  const sheet = [
    row("Units", unitsLine && esc(unitsLine)),
    row("Offering price", price && `${esc(fmtMoney(price))} total${initial && current && current !== initial ? ` <span class="sub">${esc(fmtMoney(initial))} when first offered</span>` : ""}`),
    row("Construction", p.construction && esc(tc(p.construction))),
    row("Accepted", p.accepted_date && esc(day(p.accepted_date))),
    row("Sponsor", p.sponsor && esc(tc(p.sponsor))),
    row("Counsel", p.law_firm && (ctx.links.counsel.has(p.plan_id) ? `<a href="${P}offering-plan-attorneys/${esc(ctx.links.counsel.get(p.plan_id))}.html" title="Other offering plans with this counsel">${esc(tc(p.law_firm))}</a>` : esc(tc(p.law_firm))) +(counsel.length ? `<span class="sub">${counsel.map(esc).join(" · ")}</span>` : "")),
    row("Tax estimate", taxBy && (taxSlug ? `<a href="${P}tax-consultants/${esc(taxSlug)}.html" title="Other offering plans with this tax consultant">${esc(taxBy)}</a>` : esc(taxBy))
      + `<span class="sub">Prepared the first-year real estate tax projection</span>`),
    row("Plan ID", esc(p.plan_id)),
  ].join("");
  // One pictogram per kind of section; the tile opens the plan at that section's longest run.
  const ICON = {
    schedule_a: '<path d="M4 12.5V5a1 1 0 0 1 1-1h7.5L21 12.5 12.5 21z"/><circle cx="8.5" cy="8.5" r="1.5"/>',
    schedule_b: '<rect x="4" y="3" width="16" height="18" rx="1"/><path d="M8 17v-4M12 17V8M16 17v-6"/>',
    floor_plans: '<rect x="3" y="3" width="18" height="18"/><path d="M3 11h8v10M11 3v5M15 11h6M15 11v4"/>',
    management_agreement: '<circle cx="8" cy="8" r="4"/><path d="M11 11l9 9M16 16l2-2M18.5 18.5l2-2"/>',
    declaration: '<path d="M6 3h9l4 4v14H6z"/><path d="M15 3v4h4M9 12h7M9 16h5"/>',
    bylaws: '<path d="M4 5.5C4 4.7 4.7 4 5.5 4H11v16H5.5c-.8 0-1.5-.7-1.5-1.5zM20 5.5c0-.8-.7-1.5-1.5-1.5H13v16h5.5c.8 0 1.5-.7 1.5-1.5z"/>',
  };
  const KINDS = [["schedule_a", "Schedule A: unit prices", "pricing-pages"], ["schedule_b", "Schedule B: budget", ""], ["floor_plans", "Floor plans", "floor-plans"],
    ["management_agreement", "Management agreement", ""], ["declaration", "Declaration", ""], ["bylaws", "By-laws", ""]];
  const inPlan = KINDS.map(([k, label, id]) => {
    const runs = sections.filter((x) => x.kind === k);
    if (!runs.length) return "";
    const r = [...runs].sort((a, b) => (b.last_page - b.first_page) - (a.last_page - a.first_page) || a.first_page - b.first_page)[0];
    const d = docsById.get(r.file_id) || {};
    const inner = `<svg viewBox="0 0 24 24" aria-hidden="true">${ICON[k]}</svg><span>${esc(label)}</span>`;
    const at = id ? ` id="${id}"` : "";
    return d.pdf_url ? `<a class="pic"${at} href="${esc(d.pdf_url)}#page=${r.first_page}" rel="noopener">${inner}</a>` : `<div class="pic"${at}>${inner}</div>`;
  }).join("");

  // No plan button when the AG hasn't posted the plan: there is nothing to open.
  const buttons = (docs.length ? `<a class="btn primary" href="${esc(planHref)}" rel="noopener">${mainPdf ? "Open the offering plan ↗" : "View the offering plan ↗"}</a>` : "")
    + `<a class="btn${docs.length ? "" : " primary"}" href="${esc(agRecord)}" rel="noopener">AG filing record ↗</a>`;

  return HEAD(P, { title, description, canonical, noindex: !searchable || isJunk(p, ctx.searchable), image, imageAlt: `3D massing drawing of ${name}`, newTab: true }) + `<main class="bldg sheet-page" data-plan="${esc(p.plan_id)}" data-borough="${esc(group)}" data-searchable="${searchable}"${p.units_residential ? ` data-units="${p.units_residential}"` : ""}${["managers", "architects", "sellers"].map((k) => ctx.links[k].has(p.plan_id) ? ` data-${k}="${esc(JSON.stringify(ctx.links[k].get(p.plan_id)))}"` : "").join("")}>
  <nav class="crumbs" aria-label="Breadcrumb"><a href="index.html">Buildings</a> › <a href="index.html#${slug(group)}">${esc(group)}</a></nav>
  <h1>${esc(name)}</h1>
  <p class="addr">${esc(addr)}, ${esc(b)}, NY${p.zip ? " " + esc(p.zip) : ""}</p>

  <div class="sheet-grid${ctx.images.has(p.plan_id) ? "" : " noimg"}" id="overview">
    ${ctx.images.has(p.plan_id) ? `<div class="sheet-side">
      <figure class="massing"><img src="img/${esc(p.plan_id)}.webp" alt="3D massing drawing of ${esc(name)} and neighboring buildings" loading="lazy"><figcaption>3D massing, not a photo. The building is in green.</figcaption></figure>
      <div class="acts">${buttons}</div>
    </div>` : ""}
    <div>
      <span id="pricing"></span><span id="team"></span>
      <dl class="sheet" id="sheet">${sheet}</dl>
      ${ctx.images.has(p.plan_id) ? "" : `<div class="acts">${buttons}</div>`}
    </div>
  </div>

  ${searchable ? `<section class="sheet-sec">${search}</section>` : ""}

  ${ctx.scheduleA.has(p.plan_id) ? `<section class="sheet-sec" id="units" hidden>
    <h2>Units &amp; Prices</h2>
    <div id="scheda" data-src="${P}data/schedule-a/${esc(p.plan_id)}.json" data-pdf="${esc(mainPdf || "")}"></div>
  </section>` : ""}

  <section class="sheet-sec" id="documents">
    <h2>In the Plan</h2>
    ${inPlan ? `<div class="pics">${inPlan}</div>` : `<p class="faint">${docs.length ? "This plan's pages aren't searched yet, so there are no section links." : `The Attorney General hasn't posted this plan's documents yet. <a href="${esc(agDocs)}" rel="noopener">AG documents page ↗</a>`}</p>`}
  </section>

  ${searchable ? `<section class="sheet-sec" id="budget">
    <h2>Budget</h2>
    <div id="schedb" data-plan="${esc(p.plan_id)}"><noscript><p class="faint">Turn on JavaScript to see the Schedule B budget.</p></noscript></div>
    <div id="schedb-where"></div>
  </section>` : ""}

  ${near.length ? `<section class="sheet-sec" id="nearby">${nearHtml.replace("<h3>Compare Nearby Condo Plans</h3>", "<h2>Nearby Plans</h2>")}</section>` : ""}

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
    title: "NYC Condo Offering Plans by Building | The Condo Book Project", image: OG_SITE,
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

// Plans whose Schedule A table was read and checked (scripts/extract-schedule-a.mjs).
const scheduleA = new Set(await readdir(join(ROOT, "data", "schedule-a")).then((f) => f.map((x) => x.replace(/\.json$/, "")), () => []));
// Manager, counsel, architect, selling agent and tax consultant profile pages (built by build-pages.mjs from the same groups), linked from the fact sheet.
const factsOf = (field) => all(`facts?select=plan_id,value_text&field=eq.${field}&value_text=not.is.null&order=plan_id`);
const planById = new Map(plans.map((p) => [p.plan_id, p]));
// Who prepared each plan's real estate tax estimate, read from the plan text by extract-tax-preparers.mjs.
const taxPrep = new Map(Object.entries(JSON.parse(await readFile(join(ROOT, "data", "tax-preparers.json"), "utf8").catch(() => "{}"))));
const links = profileLinks(groupAgents(await factsOf("managing_agent"), planById), groupFirms(plans),
  groupPros(await factsOf("architect"), planById, "architect"), groupPros(await factsOf("selling_agent"), planById, "selling_agent"),
  groupPros([...taxPrep].map(([plan_id, t]) => ({ plan_id, value_text: t.name })), planById, "tax_preparer"));
const ctx = { plans, docs, sections, images, searchable, scheduleA, links, taxPrep };
for (const p of plans) await writeFile(join(OUT, fileFor(p)), buildingPage(p, ctx));
await writeFile(join(OUT, "index.html"), directory(plans.filter((p) => !isJunk(p, searchable)), ctx));

// Buildings sitemap: the directory and the searchable plans (the rest are noindex). sitemap.xml is an index
// written by build-pages.mjs that points here. lastmod is when the plan record was last fetched.
const urls = [["buildings/", TODAY], ...plans.filter((p) => searchable.has(p.plan_id) && !isJunk(p, searchable)).map((p) => ["buildings/" + fileFor(p), (p.fetched_at || "").slice(0, 10) || TODAY])];
await writeFile(join(ROOT, "sitemap-buildings.xml"), urlset(urls));

console.log(`${plans.length} building pages (${searchable.size} indexed, rest noindex), ${images.size} images, sitemap-buildings.xml with ${urls.length} URLs for ${SITE_URL}`);
