// Builds the pages that aren't one-per-plan, in a few seconds:
//   - blog/*.html from content/blog/*.html (front matter + body), and blog/index.html
//   - new-condo-filings.html, the 10 newest NYC plans accepted for filing
//   - the SEO block in the hand-written pages (index, about, faq, terms, privacy, disclaimers)
//   - sitemap-pages.xml, sitemap.xml (an index of it and sitemap-buildings.xml) and robots.txt
//
//   node scripts/build-pages.mjs
//
// Run after build-buildings.mjs, or on its own when only posts or the filings list changed.
// Every number and plan named here comes from the plan records; posts insert them with tokens:
//   {{stat:NAME}}  a count (see STATS below)      {{bldg:CD250420}}  link to that plan's building page
//   {{table:NAME}} a generated table (see TABLES)
import { mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { SITE_URL, AG, ROOT, TODAY, all, esc, tc, fileFor, day, month, usDate, money, fmtMoney, plural, boro, SITE_NAME, ld, SEO, HEAD, FOOT, urlset } from "./site.mjs";

// ---------- data ----------
const plans = (await all("plans?select=plan_id,name,address,zip,borough,construction,accepted_date,units_residential,units_parking,units_commercial,sponsor,meta,fetched_at&order=plan_id"))
  .filter((p) => p.address);
const searchable = new Set((await all("documents?select=plan_id&status=eq.done")).map((d) => d.plan_id));
const byId = new Map(plans.map((p) => [p.plan_id, p]));
const NYC = (p) => boro(p.borough) !== "Outside New York City";
const accepted = plans.filter((p) => p.accepted_date);
const thisYear = TODAY.slice(0, 4);

const count = (rows, key) => { const m = new Map(); for (const r of rows) { const k = key(r); m.set(k, (m.get(k) || 0) + 1); } return m; };
const byYear = count(accepted.filter(NYC), (p) => p.accepted_date.slice(0, 4));
const peak = [...byYear].filter(([y]) => y !== thisYear).sort((a, b) => b[1] - a[1])[0];
const byBoro = count(plans.filter(NYC), (p) => boro(p.borough));
const unitsByBoro = new Map(), sizes = new Map();
for (const p of plans.filter(NYC)) {
  const b = boro(p.borough), u = p.units_residential || 0;
  unitsByBoro.set(b, (unitsByBoro.get(b) || 0) + u);
  if (!sizes.has(b)) sizes.set(b, []);
  sizes.get(b).push(u);
}
const avg = (b) => { const a = sizes.get(b) || []; return a.length ? Math.round(a.reduce((s, x) => s + x, 0) / a.length) : 0; };
const topUnits = [...unitsByBoro].sort((a, b) => b[1] - a[1])[0];
const construction = count(plans.filter(NYC), (p) => ({ NEW: "New construction", REHAB: "Rehab", CONVERSION: "Conversion" }[p.construction] || "Not stated"));
const n = (x) => Number(x || 0).toLocaleString("en-US");

const STATS = {
  plans_total: n(plans.length),
  plans_nyc: n(plans.filter(NYC).length),
  plans_searchable: n(searchable.size),
  plans_cd: n(plans.filter((p) => p.plan_id.startsWith("CD")).length),
  plans_cc: n(plans.filter((p) => p.plan_id.startsWith("CC")).length),
  peak_year: peak?.[0], peak_count: n(peak?.[1]),
  this_year: thisYear, this_year_count: n(byYear.get(thisYear)),
  first_year: [...byYear.keys()].sort()[0],
  top_boro: [...byBoro].sort((a, b) => b[1] - a[1])[0]?.[0],
  top_boro_count: n([...byBoro].sort((a, b) => b[1] - a[1])[0]?.[1]),
  top_units_boro: topUnits?.[0], top_units_boro_count: n(topUnits?.[1]),
  avg_units_brooklyn: avg("Brooklyn"), avg_units_manhattan: avg("Manhattan"),
  new_construction_share: Math.round(100 * (construction.get("New construction") || 0) / plans.filter(NYC).length) + "%",
  today: day(TODAY),
};

// A plain table with a bar per row, so the numbers read at a glance without a chart library.
const barTable = (rows, [k, v], note = "") => {
  const max = Math.max(...rows.map((r) => r[1]));
  return `<div class="tscroll"><table class="bars"><thead><tr><th>${esc(k)}</th><th>${esc(v)}</th><th aria-hidden="true"></th></tr></thead><tbody>${rows.map(([a, b]) =>
    `<tr><td>${esc(a)}</td><td>${n(b)}</td><td class="bar" aria-hidden="true"><span style="width:${Math.max(1, Math.round(100 * b / max))}%"></span></td></tr>`).join("")}</tbody></table></div>${note ? `<p class="src">${note}</p>` : ""}`;
};
const TABLES = {
  by_year: () => barTable([...byYear].sort((a, b) => b[0].localeCompare(a[0])), ["Year accepted", "Plans"], `${thisYear} is year to date, as of ${day(TODAY)}.`),
  by_boro: () => barTable([...byBoro].sort((a, b) => b[1] - a[1]), ["Borough", "Plans"]),
  units_by_boro: () => barTable([...unitsByBoro].sort((a, b) => b[1] - a[1]), ["Borough", "Residential units"], "Residential units as listed on each plan's AG record, summed across plans."),
  by_construction: () => barTable([...construction].sort((a, b) => b[1] - a[1]), ["Construction type", "Plans"]),
};

// ---------- tokens ----------
function fill(body, P) {
  return body
    .replace(/\{\{stat:(\w+)\}\}/g, (_, k) => { if (!(k in STATS)) throw new Error(`unknown stat ${k}`); return esc(STATS[k]); })
    .replace(/\{\{table:(\w+)\}\}/g, (_, k) => { if (!TABLES[k]) throw new Error(`unknown table ${k}`); return TABLES[k](); })
    .replace(/\{\{bldg:(\w+)\}\}/g, (_, id) => { const p = byId.get(id); if (!p) throw new Error(`unknown plan ${id}`); return `${P}buildings/${fileFor(p)}`; });
}

// ---------- blog ----------
const ORG = { "@type": "Organization", "@id": `${SITE_URL}/#org`, name: "Half Ave Company LLC", email: "hello@halfave.co", url: `${SITE_URL}/` };
const SRC = join(ROOT, "content", "blog");
const posts = [];
for (const f of (await readdir(SRC)).filter((f) => f.endsWith(".html")).sort()) {
  const raw = await readFile(join(SRC, f), "utf8");
  const m = raw.match(/^<!--\s*(\{[\s\S]*?\})\s*-->\s*/);
  if (!m) throw new Error(`${f}: missing front matter`);
  posts.push({ ...JSON.parse(m[1]), slug: f.replace(/\.html$/, ""), body: raw.slice(m[0].length) });
}
posts.sort((a, b) => (a.order ?? 99) - (b.order ?? 99));
const words = (html) => html.replace(/<[^>]+>/g, " ").split(/\s+/).filter(Boolean).length;
const cta = (P) => `<form class="cta" action="${P}index.html" method="get" role="search">
    <label for="ctaq">Search NYC condo offering plans on ${SITE_NAME}</label>
    <div class="prow"><input id="ctaq" name="q" type="search" placeholder="Address, building name, CD number or topic" enterkeyhint="search"><button type="submit">Search</button></div>
  </form>`;

function postPage(post) {
  const P = "../";
  const url = `${SITE_URL}/blog/${post.slug}.html`;
  const body = fill(post.body, P);
  const mins = Math.max(2, Math.round(words(body) / 230));
  const updated = post.updated || post.published;
  const related = posts.filter((q) => q.slug !== post.slug).slice(0, 4);
  return HEAD(P, { title: post.title, description: post.description, canonical: url }) + `
${ld({
    "@context": "https://schema.org", "@type": "BlogPosting", headline: post.h1, description: post.description, url, mainEntityOfPage: url,
    datePublished: post.published, dateModified: updated, inLanguage: "en-US", keywords: (post.keywords || []).join(", "),
    author: ORG, publisher: ORG, isPartOf: { "@type": "Blog", name: `${SITE_NAME} Guides`, url: `${SITE_URL}/blog/` },
  })}
${ld({ "@context": "https://schema.org", "@type": "BreadcrumbList", itemListElement: [
    { "@type": "ListItem", position: 1, name: SITE_NAME, item: `${SITE_URL}/` },
    { "@type": "ListItem", position: 2, name: "Guides", item: `${SITE_URL}/blog/` },
    { "@type": "ListItem", position: 3, name: post.h1, item: url },
  ] })}
<main class="post">
  <nav class="crumbs" aria-label="Breadcrumb"><a href="${P}index.html">${SITE_NAME}</a> › <a href="index.html">Guides</a></nav>
  <article>
    <h1>${esc(post.h1)}</h1>
    <p class="meta">Updated <time datetime="${esc(updated)}">${esc(day(updated))}</time> · ${mins} min read</p>
    <p class="lede">${esc(post.summary || post.description)}</p>
    ${body}
  </article>
  ${cta(P)}
  <h2>More Guides</h2>
  <ul class="dir">${related.map((q) => `<li><a href="${esc(q.slug)}.html">${esc(q.h1)}</a><span>${esc(q.description)}</span></li>`).join("")}
    <li><a href="${P}new-condo-filings.html">New NYC Condo Offering Plans: The 10 Latest Filings</a><span>The newest plans accepted for filing by the Attorney General, with CD numbers.</span></li></ul>
</main>
` + FOOT(P);
}

function blogIndex() {
  const P = "../";
  const url = `${SITE_URL}/blog/`;
  const title = "NYC Condo Offering Plan Guides | The Condo Book Project";
  const description = "Plain-English guides to NYC condo offering plans: how to search the NY Attorney General's filings, read a CD number, find amendments, and read Schedule A and Schedule B.";
  return HEAD(P, { title, description, canonical: url }) + `
${ld({ "@context": "https://schema.org", "@type": "Blog", name: `${SITE_NAME} Guides`, description, url, publisher: ORG,
    blogPost: posts.map((q) => ({ "@type": "BlogPosting", headline: q.h1, url: `${SITE_URL}/blog/${q.slug}.html`, datePublished: q.published, dateModified: q.updated || q.published })) })}
<main>
  <nav class="crumbs" aria-label="Breadcrumb"><a href="${P}index.html">${SITE_NAME}</a></nav>
  <h1>Guides to NYC Condo Offering Plans</h1>
  <p class="lede">How to find, search and read the condo offering plans ("condo books") that sponsors file with the New York State Attorney General.</p>
  <ul class="dir">${posts.map((q) => `<li><a href="${esc(q.slug)}.html">${esc(q.h1)}</a><span>${esc(q.description)}</span></li>`).join("")}
    <li><a href="${P}new-condo-filings.html">New NYC Condo Offering Plans: The 10 Latest Filings</a><span>Updated with every rebuild from the Attorney General's records.</span></li></ul>
  ${cta(P)}
</main>
` + FOOT(P);
}

// ---------- new filings ----------
const KIND = { NEW: "new construction", REHAB: "rehab", CONVERSION: "conversion" };
function filingsPage() {
  const P = "";
  const url = `${SITE_URL}/new-condo-filings.html`;
  const latest = accepted.filter(NYC).sort((a, b) => b.accepted_date.localeCompare(a.accepted_date) || b.plan_id.localeCompare(a.plan_id)).slice(0, 10);
  const title = `New NYC Condo Filings: 10 Latest Offering Plans & CD Numbers | The Condo Book Project`;
  const units = latest.reduce((s, p) => s + (p.units_residential || 0), 0);
  const boros = count(latest, (p) => boro(p.borough));
  const boroText = [...boros].sort((a, b) => b[1] - a[1]).map(([b, c]) => `${c} in ${b}`).join(", ");
  const description = `The 10 newest NYC condominium offering plans accepted for filing by the NY Attorney General, with CD plan numbers, addresses, sponsors, unit counts and total offering prices. Latest: ${tc(latest[0].name)}, ${latest[0].plan_id}.`;

  const price = (p) => money(p.meta?.plan?.["Current Price"]) || money(p.meta?.plan?.["Initial Price"]);
  const row = (p) => `<tr><td>${esc(p.plan_id)}</td><td><a href="buildings/${esc(fileFor(p))}">${esc(tc(p.name))}</a></td><td>${esc(tc(p.address))}</td><td>${esc(boro(p.borough))}</td><td>${esc(day(p.accepted_date))}</td><td>${p.units_residential ?? "—"}</td></tr>`;
  const entry = (p, i) => {
    const name = tc(p.name), addr = tc(p.address), b = boro(p.borough), pr = price(p);
    const bits = [];
    if (p.units_residential != null) bits.push(plural(p.units_residential, "residential unit"));
    if (p.units_parking) bits.push(plural(p.units_parking, "parking unit"));
    if (p.units_commercial) bits.push(plural(p.units_commercial, "commercial unit"));
    let s = `${name} is a ${KIND[p.construction] ? KIND[p.construction] + " " : ""}condominium at ${addr}, ${b}. The Attorney General accepted its offering plan, ${p.plan_id}, for filing on ${day(p.accepted_date)}.`;
    if (bits.length) s += ` The AG record lists ${bits.join(", ")}.`;
    if (p.sponsor) s += ` The sponsor is ${tc(p.sponsor)}.`;
    if (pr) s += ` The total offering price on the record is ${fmtMoney(pr)}, the sum of all units at the plan's prices.`;
    return `<section class="filing" id="${esc(p.plan_id.toLowerCase())}">
    <h3><span class="cd">${esc(p.plan_id)}</span> ${i + 1}. ${esc(name)}</h3>
    <p class="addr">${esc(addr)} · ${esc(b)}, NY${p.zip ? " " + esc(p.zip) : ""}</p>
    <p>${esc(s)}</p>
    <p class="acts"><a class="btn" href="buildings/${esc(fileFor(p))}">${esc(name)} on ${SITE_NAME}</a><a class="btn" href="${esc(AG + encodeURIComponent(p.plan_id))}" rel="noopener">AG filing record for ${esc(p.plan_id)} ↗</a></p>
  </section>`;
  };

  return HEAD(P, { title, description, canonical: url }) + `
${ld({ "@context": "https://schema.org", "@type": "ItemList", name: "Newest NYC condominium offering plans accepted for filing", url, numberOfItems: latest.length,
    itemListOrder: "https://schema.org/ItemListOrderDescending",
    itemListElement: latest.map((p, i) => ({ "@type": "ListItem", position: i + 1, url: `${SITE_URL}/buildings/${fileFor(p)}`, name: `${tc(p.name)} (${p.plan_id})` })) })}
${ld({ "@context": "https://schema.org", "@type": "BreadcrumbList", itemListElement: [
    { "@type": "ListItem", position: 1, name: SITE_NAME, item: `${SITE_URL}/` },
    { "@type": "ListItem", position: 2, name: "New condo filings", item: url },
  ] })}
<main class="post">
  <nav class="crumbs" aria-label="Breadcrumb"><a href="index.html">${SITE_NAME}</a> › <a href="buildings/index.html">Buildings</a></nav>
  <h1>New NYC Condo Offering Plans: The 10 Latest Filings</h1>
  <p class="meta">Updated <time datetime="${TODAY}">${esc(day(TODAY))}</time> · Source: NY Attorney General</p>
  <p class="lede">The ten newest New York City condominium offering plans accepted for filing by the New York State Attorney General, with each plan's CD number, address, sponsor and unit count.</p>
  <p>These ${latest.length} plans were accepted between ${esc(day(latest[latest.length - 1].accepted_date))} and ${esc(day(latest[0].accepted_date))}: ${esc(boroText)}. Together they list ${plural(units, "residential unit")}. Each CD number is the Attorney General's plan ID; use it to pull up the filing, its documents and its amendments. <a href="blog/what-is-a-cd-number.html">What a CD number means →</a></p>

  <h2>At a Glance</h2>
  <div class="tscroll"><table><thead><tr><th>CD number</th><th>Condominium</th><th>Address</th><th>Borough</th><th>Accepted</th><th>Units</th></tr></thead><tbody>${latest.map(row).join("")}</tbody></table></div>

  <h2>The Filings</h2>
  ${latest.map(entry).join("\n  ")}

  <h2>About This List</h2>
  <p>"Accepted for filing" is the date the Attorney General's Real Estate Finance Bureau accepted the sponsor's offering plan. It is not an endorsement of the offering, and the plan's documents may not be posted on the AG's site yet. A sponsor generally can't sell units under a plan until it has been accepted for filing, and later changes arrive as numbered amendments.</p>
  <p>The list is rebuilt from the Attorney General's plan records and shows plans in the five boroughs only. Unit counts, sponsors and total offering prices are as recorded by the AG. See <a href="blog/how-to-search-ny-attorney-general-offering-plans.html">how to search the Attorney General's offering plan database</a>, or browse <a href="buildings/index.html">every condo offering plan by borough</a>.</p>
  ${cta(P)}
</main>
` + FOOT(P);
}

// ---------- hand-written pages: stamp the shared SEO tags and structured data between markers ----------
// Title and description stay hand-written in each page; everything between <!-- seo --> and <!-- /seo --> is replaced.
const STATIC = { "index.html": "", "about.html": "about.html", "faq.html": "faq.html", "terms.html": "terms.html", "privacy.html": "privacy.html", "disclaimers.html": "disclaimers.html" };
const unhtml = (s) => String(s).replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ").trim();
async function stampStatic(file, path) {
  const html = await readFile(join(ROOT, file), "utf8");
  if (!/<!-- seo -->[\s\S]*?<!-- \/seo -->/.test(html)) throw new Error(`${file}: missing <!-- seo --> markers`);
  const title = unhtml(html.match(/<title>([\s\S]*?)<\/title>/)[1]);
  const description = unhtml(html.match(/<meta name="description" content="([^"]*)"/)[1]);
  const canonical = `${SITE_URL}/${path}`;
  const blocks = [];
  if (file === "index.html") {
    blocks.push({
      "@context": "https://schema.org", "@graph": [
        { "@type": "WebSite", "@id": `${SITE_URL}/#site`, name: SITE_NAME, alternateName: ["Condo Book NYC", "condobooknyc.com"], url: `${SITE_URL}/`, description, publisher: { "@id": ORG["@id"] },
          potentialAction: { "@type": "SearchAction", target: { "@type": "EntryPoint", urlTemplate: `${SITE_URL}/?q={search_term_string}` }, "query-input": "required name=search_term_string" } },
        ORG,
        { "@type": "Dataset", name: "NYC condominium offering plans", description: "Condominium offering plans and amendments filed with the New York State Attorney General, searchable in full text with page citations.",
          url: `${SITE_URL}/buildings/`, creator: { "@id": ORG["@id"] }, isAccessibleForFree: true, spatialCoverage: "New York City, NY",
          isBasedOn: "https://offeringplandatasearch.ag.ny.gov/REF/", license: `${SITE_URL}/terms.html` },
      ],
    });
  }
  if (file === "faq.html") {
    // FAQ answers are the <details><summary>Q</summary><p>A</p>… blocks on the page, so the markup can't drift from the text.
    const qa = [...html.matchAll(/<details[^>]*>\s*<summary>([\s\S]*?)<\/summary>([\s\S]*?)<\/details>/g)]
      .map(([, q, a]) => ({ "@type": "Question", name: unhtml(q), acceptedAnswer: { "@type": "Answer", text: unhtml(a) } }));
    if (qa.length) blocks.push({ "@context": "https://schema.org", "@type": "FAQPage", mainEntity: qa });
  }
  if (file !== "index.html") {
    blocks.push({ "@context": "https://schema.org", "@type": "BreadcrumbList", itemListElement: [
      { "@type": "ListItem", position: 1, name: SITE_NAME, item: `${SITE_URL}/` },
      { "@type": "ListItem", position: 2, name: title.replace(/^The Condo Book Project /, "").replace(/ The Condo Book Project$/, ""), item: canonical },
    ] });
  }
  const block = `<!-- seo -->\n${SEO("", { title, description, canonical })}\n${blocks.map(ld).join("\n")}${blocks.length ? "\n" : ""}<!-- /seo -->`;
  await writeFile(join(ROOT, file), html.replace(/<!-- seo -->[\s\S]*?<!-- \/seo -->/, () => block));
}

// ---------- write ----------
await mkdir(join(ROOT, "blog"), { recursive: true });
for (const post of posts) await writeFile(join(ROOT, "blog", post.slug + ".html"), postPage(post));
await writeFile(join(ROOT, "blog", "index.html"), blogIndex());
await writeFile(join(ROOT, "new-condo-filings.html"), filingsPage());
for (const [file, path] of Object.entries(STATIC)) await stampStatic(file, path);

const pageUrls = [["", TODAY], ["about.html"], ["faq.html"], ["new-condo-filings.html", TODAY], ["blog/", TODAY],
  ...posts.map((q) => [`blog/${q.slug}.html`, q.updated || q.published])];
await writeFile(join(ROOT, "sitemap-pages.xml"), urlset(pageUrls));
await writeFile(join(ROOT, "sitemap.xml"), `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap><loc>${SITE_URL}/sitemap-pages.xml</loc><lastmod>${TODAY}</lastmod></sitemap>
  <sitemap><loc>${SITE_URL}/sitemap-buildings.xml</loc></sitemap>
</sitemapindex>
`);
await writeFile(join(ROOT, "robots.txt"), `User-agent: *\nAllow: /\n\nSitemap: ${SITE_URL}/sitemap.xml\n`);
console.log(`${posts.length} posts, blog index, new-condo-filings.html, ${Object.keys(STATIC).length} stamped pages, sitemap-pages.xml with ${pageUrls.length} URLs`);
