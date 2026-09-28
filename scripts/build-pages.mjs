// Builds the pages that aren't one-per-plan, in a few seconds:
//   - blog/*.html from content/blog/*.html (front matter + body), and blog/index.html
//   - new-condo-filings.html, the 10 newest NYC plans accepted for filing
//   - managing-agents/*.html and offering-plan-attorneys/*.html, a profile per manager and law firm
//   - the SEO block in the hand-written pages (index, about, faq, terms, privacy, disclaimers)
//   - sitemap-pages.xml, sitemap.xml (an index of it and sitemap-buildings.xml) and robots.txt
//
//   node scripts/build-pages.mjs
//
// Run after build-buildings.mjs, or on its own when only posts or the filings list changed.
// Every number and plan named here comes from the plan records; posts insert them with tokens:
//   {{stat:NAME}}  a count (see STATS below)      {{bldg:CD250420}}  link to that plan's building page
//   {{table:NAME}} a generated table (see TABLES)
import { mkdir, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { SITE_URL, AG, ROOT, TODAY, all, esc, tc, fileFor, day, month, usDate, money, fmtMoney, plural, boro, SITE_NAME, ld, SEO, HEAD, FOOT, urlset } from "./site.mjs";
import { PROFILE_MIN, isSelf, groupAgents, groupFirms } from "./pros.mjs";

// ---------- data ----------
const plans = (await all("plans?select=plan_id,name,address,zip,borough,construction,submitted_date,accepted_date,units_residential,units_parking,units_commercial,units_total,sponsor,law_firm,meta,fetched_at,lat,lng&order=plan_id"))
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
    author: ORG, publisher: ORG, isPartOf: { "@type": "Blog", name: `${SITE_NAME} Blog`, url: `${SITE_URL}/blog/` },
  })}
${ld({ "@context": "https://schema.org", "@type": "BreadcrumbList", itemListElement: [
    { "@type": "ListItem", position: 1, name: SITE_NAME, item: `${SITE_URL}/` },
    { "@type": "ListItem", position: 2, name: "Blog", item: `${SITE_URL}/blog/` },
    { "@type": "ListItem", position: 3, name: post.h1, item: url },
  ] })}
<main class="post">
  <nav class="crumbs" aria-label="Breadcrumb"><a href="${P}index.html">${SITE_NAME}</a> › <a href="index.html">Blog</a></nav>
  <article>
    <h1>${esc(post.h1)}</h1>
    <p class="meta">Updated <time datetime="${esc(updated)}">${esc(day(updated))}</time> · ${mins} min read</p>
    <p class="lede">${esc(post.summary || post.description)}</p>
    ${body}
  </article>
  ${cta(P)}
  <h2>More from the Blog</h2>
  <ul class="dir">${related.map((q) => `<li><a href="${esc(q.slug)}.html">${esc(q.h1)}</a><span>${esc(q.description)}</span></li>`).join("")}
    <li><a href="${P}new-condo-filings.html">New NYC Condo Offering Plans: The 10 Latest Filings</a><span>The newest plans accepted for filing by the Attorney General, with CD numbers.</span></li></ul>
</main>
` + FOOT(P);
}

function blogIndex() {
  const P = "../";
  const url = `${SITE_URL}/blog/`;
  const title = "Blog: NYC Condo Offering Plans Explained | The Condo Book Project";
  const description = "Plain-English guides to NYC condo offering plans: how to search the NY Attorney General's filings, read a CD number, find amendments, and read Schedule A and Schedule B.";
  return HEAD(P, { title, description, canonical: url }) + `
${ld({ "@context": "https://schema.org", "@type": "Blog", name: `${SITE_NAME} Blog`, description, url, publisher: ORG,
    blogPost: posts.map((q) => ({ "@type": "BlogPosting", headline: q.h1, url: `${SITE_URL}/blog/${q.slug}.html`, datePublished: q.published, dateModified: q.updated || q.published })) })}
<main>
  <nav class="crumbs" aria-label="Breadcrumb"><a href="${P}index.html">${SITE_NAME}</a></nav>
  <h1>Blog</h1>
  <p class="lede">How to find, search and read the condo offering plans ("condo books") that sponsors file with the New York State Attorney General.</p>
  <ul class="dir">${posts.map((q) => `<li><a href="${esc(q.slug)}.html">${esc(q.h1)}</a><span>${esc(q.description)}</span></li>`).join("")}
    <li><a href="${P}new-condo-filings.html">New NYC Condo Offering Plans: The Last 3 Months</a><span>Every plan accepted for filing in the last three months, with total sellout and $/unit.</span></li></ul>
  ${cta(P)}
</main>
` + FOOT(P);
}

// ---------- new filings ----------
// Plans accepted for filing in the last three months (the 10 newest if none), one row each.
const KIND = { NEW: "new construction", REHAB: "rehab", CONVERSION: "conversion" };
// Borough outlines, the same projected paths the home page map draws (site_assets.boroughs_svg).
const GEO = JSON.parse((await all("site_assets?key=eq.boroughs_svg&select=value"))[0].value);
const BORO_LABELS = { Manhattan: [-73.972, 40.79], Brooklyn: [-73.95, 40.645], Queens: [-73.82, 40.705], Bronx: [-73.865, 40.85], "Staten Island": [-74.15, 40.585] };
const project = (lat, lng) => { const B = GEO.B, sx = GEO.W / ((B.maxLng - B.minLng) * GEO.k); return [(lng - B.minLng) * GEO.k * sx, (B.maxLat - lat) * sx]; };
// A static map of the given plans; each dot links to that plan's row on the page.
function plansMap(list, label) {
  const dots = list.filter((p) => p.lat && p.lng).map((p) => {
    const [x, y] = project(p.lat, p.lng);
    return `<a href="#${esc(p.plan_id.toLowerCase())}" data-id="${esc(p.plan_id.toLowerCase())}"><circle class="dot" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="15"><title>${esc(tc(p.name))}, ${esc(tc(p.address))}</title></circle></a>`;
  });
  return `<figure class="fmap"><svg viewBox="0 0 ${GEO.W} ${GEO.H}" role="img" aria-label="${esc(label)}">
    ${Object.values(GEO.paths).map((d) => `<path class="boro" d="${d}"/>`).join("")}
    ${Object.entries(BORO_LABELS).map(([name, [lng, lat]]) => { const [x, y] = project(lat, lng); return `<text class="boro-label" x="${x.toFixed(1)}" y="${y.toFixed(1)}" text-anchor="middle">${esc(name)}</text>`; }).join("")}
    <g class="dots">${dots.join("")}</g>
  </svg></figure>`;
}
function filingsPage() {
  const P = "";
  const url = `${SITE_URL}/new-condo-filings.html`;
  // Skip AG rows that aren't a real offering ("*Resubmit*", "(8/3/89 Filed)", no units).
  const real = (p) => !/resubmit|withdrawn|\(\s*\d{1,2}\/\d{1,2}\/\d{2,4}|\bfiled\s*\)/i.test(p.name || "") && (p.units_residential || p.units_total);
  const since = new Date(TODAY + "T12:00:00Z"); since.setUTCMonth(since.getUTCMonth() - 3);
  const SINCE = since.toISOString().slice(0, 10);
  const newest = accepted.filter(NYC).filter(real).sort((a, b) => b.accepted_date.localeCompare(a.accepted_date) || b.plan_id.localeCompare(a.plan_id));
  const recent = newest.filter((p) => p.accepted_date >= SINCE);
  const latest = recent.length ? recent : newest.slice(0, 10);
  const title = `New NYC Condo Offering Plans: Filings from the Last 3 Months | The Condo Book Project`;
  const description = `${latest.length} NYC condominium offering plans accepted for filing by the NY Attorney General in the last three months, with total sellout and price per unit. Latest: ${tc(latest[0].name)}, ${latest[0].plan_id}.`;

  const price = (p) => money(p.meta?.plan?.["Current Price"]) || money(p.meta?.plan?.["Initial Price"]);
  const dash = `<span class="faint">—</span>`;
  const fmtM = (n) => fmtMoney(n).replace(" million", "M");
  const row = (p) => {
    const pr = price(p), u = p.units_residential;
    return `<tr id="${esc(p.plan_id.toLowerCase())}"><td><a href="buildings/${esc(fileFor(p))}" target="_blank" rel="noopener">${esc(tc(p.name))}</a><span class="sub">${esc(tc(p.address))} · ${esc(boro(p.borough))}${KIND[p.construction] ? ` · ${KIND[p.construction]}` : ""}</span></td>` +
      `<td class="nowrap">${esc(day(p.accepted_date))}</td><td class="num">${u ?? dash}</td>` +
      `<td class="num">${pr ? esc(fmtM(pr)) : dash}</td><td class="num">${pr && u ? esc(fmtM(pr / u)) : dash}</td></tr>`;
  };

  return HEAD(P, { title, description, canonical: url }) + `
${ld({ "@context": "https://schema.org", "@type": "ItemList", name: "NYC condominium offering plans accepted for filing in the last three months", url, numberOfItems: latest.length,
    itemListOrder: "https://schema.org/ItemListOrderDescending",
    itemListElement: latest.map((p, i) => ({ "@type": "ListItem", position: i + 1, url: `${SITE_URL}/buildings/${fileFor(p)}`, name: `${tc(p.name)} (${p.plan_id})` })) })}
${ld({ "@context": "https://schema.org", "@type": "BreadcrumbList", itemListElement: [
    { "@type": "ListItem", position: 1, name: SITE_NAME, item: `${SITE_URL}/` },
    { "@type": "ListItem", position: 2, name: "New construction", item: url },
  ] })}
<main class="post filings split">
  <div class="aside">
  <h1>New NYC Condo Offering Plans</h1>
  <p class="anote">Every New York City condominium offering plan the Attorney General accepted for filing ${recent.length ? "in the last three months" : "most recently"}. "Accepted for filing" is not an endorsement of the offering, and a sponsor generally can't sell units until then. Five boroughs only.</p>
  ${plansMap(latest, `Map of the ${latest.length} NYC condo offering plans accepted for filing most recently`)}
  </div>
  <div class="amain">
  <div class="tscroll"><table class="ftable"><thead><tr><th>Condominium</th><th>Accepted</th><th class="num">Units</th><th class="num">Total sellout</th><th class="num">$/unit</th></tr></thead><tbody>${latest.map(row).join("")}</tbody></table></div>
  <p class="src">Total sellout is the offering price on the AG record. $/unit is that total divided by the residential units.</p>

  ${cta(P)}
  </div>
</main>
${hoverScript}
` + FOOT(P);
}

// ---------- time to approval ----------
// Days from submission to acceptance for filing. The AG's plan row carries "Submitted Date", but on any plan with
// amendments that row is amendment 1's and the date is when amendment 1 was submitted, usually after acceptance.
// Only rows with a blank "Amendment No" hold the original submission, so the page measures those plans alone.
const DAY_MS = 864e5;
const timed = accepted.filter(NYC)
  .filter((p) => p.submitted_date && !String(p.meta?.plan?.["Amendment No"] ?? "").trim())
  .map((p) => ({ ...p, days: Math.round((Date.parse(p.accepted_date) - Date.parse(p.submitted_date)) / DAY_MS) }))
  .filter((p) => p.days >= 0);
const avgOf = (ds) => Math.round(ds.reduce((s, d) => s + d, 0) / ds.length);
const mo = (d) => (d / (365.25 / 12)).toFixed(1).replace(/\.0$/, "");
// Months past 30 days, days up to that.
const dur = (d) => d > 30 ? `${mo(d)} month${mo(d) === "1" ? "" : "s"}` : plural(d, "day");
const SIZES = [[1, 10, "1–10"], [11, 25, "11–25"], [26, 50, "26–50"], [51, Infinity, "51 or more"]];
const BINS = [[0, 90, "Under 3 months"], [90, 180, "3–6 months"], [180, 270, "6–9 months"], [270, 365, "9–12 months"], [365, 548, "12–18 months"], [548, 730, "18–24 months"], [730, Infinity, "Over 2 years"]];
const ERAS = [["2000", "2004"], ["2005", "2009"], ["2010", "2014"], ["2015", "2019"], ["2020", thisYear]];
const FAST = `<svg class="ic" viewBox="0 0 24 24" width="15" height="15" fill="currentColor" aria-hidden="true"><path d="M13 2 4 14h7l-1 8 9-12h-7z"/></svg>`;
const SLOW = `<svg class="ic" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 2h12M6 22h12M7 2c0 6 10 6 10 10S7 16 7 22M17 2c0 6-10 6-10 10s10 4 10 10"/></svg>`;

function approvalPage() {
  const P = "";
  const url = `${SITE_URL}/time-to-approval.html`;
  const days = timed.map((p) => p.days);
  const mean = avgOf(days), fastest = Math.min(...days), slowest = Math.max(...days);
  const title = "How Long Does AG Approval Take for an NYC Condo Offering Plan? | The Condo Book Project";
  const description = `How long the NY Attorney General takes to accept an NYC condo offering plan for filing: ${dur(mean)} on average, measured on ${timed.length} plans.`;

  // By building size (residential units on the AG record). Plans listing no residential units are left out.
  const sizes = SIZES.map(([a, b, label]) => {
    const ds = timed.filter((p) => p.units_residential >= a && p.units_residential <= b).map((p) => p.days);
    return ds.length ? { label, n: ds.length, min: Math.min(...ds), mean: avgOf(ds), max: Math.max(...ds) } : null;
  }).filter(Boolean);
  const sizeTable = `<div class="tscroll"><table class="dm"><thead><tr><th>Residential units</th><th>Plans</th><th>Average</th><th>${FAST} Fastest</th><th>${SLOW} Slowest</th></tr></thead><tbody>${sizes.map((s) =>
    `<tr><td>${esc(s.label)}</td><td>${n(s.n)}</td><td><strong>${dur(s.mean)}</strong></td><td>${dur(s.min)}</td><td>${dur(s.max)}</td></tr>`).join("")}</tbody></table></div>`;

  // Distribution: one column per bin, height relative to the tallest.
  const bins = BINS.map(([a, b, label]) => [label, days.filter((d) => d >= a && d < b).length]);
  const binMax = Math.max(...bins.map((b) => b[1]));
  const histogram = `<figure class="chart">
    <div class="cols" role="img" aria-label="${esc(bins.map(([l, c]) => `${l}: ${c} plans`).join("; "))}">${bins.map(([label, c]) =>
      `<div class="col" title="${esc(label)}: ${plural(c, "plan")} (${Math.round(100 * c / timed.length)}%)"><span class="v">${n(c)}</span><span class="b" style="height:${Math.max(1, Math.round(100 * c / binMax))}%"></span><span class="l">${esc(label)}</span></div>`).join("")}</div>
  </figure>`;

  // By era: the average, with a bar relative to the longest.
  const eras = ERAS.map(([a, b]) => {
    const ds = timed.filter((p) => p.accepted_date.slice(0, 4) >= a && p.accepted_date.slice(0, 4) <= b).map((p) => p.days);
    return ds.length ? { label: `${a}–${b}`, n: ds.length, mean: avgOf(ds) } : null;
  }).filter(Boolean);
  const eraMax = Math.max(...eras.map((e) => e.mean));
  const eraTable = `<div class="tscroll"><table class="bars"><thead><tr><th>Year accepted</th><th>Average</th><th aria-hidden="true"></th></tr></thead><tbody>${eras.map((e) =>
    `<tr title="${plural(e.n, "plan")}"><td>${esc(e.label)}</td><td>${dur(e.mean)}</td><td class="bar" aria-hidden="true"><span style="width:${Math.max(1, Math.round(100 * e.mean / eraMax))}%"></span></td></tr>`).join("")}</tbody></table></div>`;

  const recent = [...timed].sort((a, b) => b.accepted_date.localeCompare(a.accepted_date) || b.plan_id.localeCompare(a.plan_id)).slice(0, 10);
  const recentTable = `<div class="tscroll"><table><thead><tr><th>CD number</th><th>Condominium</th><th>Submitted</th><th>Accepted</th><th>Time</th></tr></thead><tbody>${recent.map((p) =>
    `<tr><td>${esc(p.plan_id)}</td><td><a href="buildings/${esc(fileFor(p))}">${esc(tc(p.name))}</a></td><td>${esc(day(p.submitted_date))}</td><td>${esc(day(p.accepted_date))}</td><td>${dur(p.days)}</td></tr>`).join("")}</tbody></table></div>`;

  return HEAD(P, { title, description, canonical: url }) + `
${ld({ "@context": "https://schema.org", "@type": "BreadcrumbList", itemListElement: [
    { "@type": "ListItem", position: 1, name: SITE_NAME, item: `${SITE_URL}/` },
    { "@type": "ListItem", position: 2, name: "Time to approval", item: url },
  ] })}
<main class="post approval split">
  <div class="aside">
  <h1>How Long Does Condo Offering Plan Approval Take?</h1>
  <p class="anote">The time from when a sponsor submits a New York City condominium offering plan to when the Attorney General accepts it for filing. Only the ${n(timed.length)} plans never amended can be timed from the AG's records, so read the figures as a guide.</p>
  <div class="hero-stat">
    <p class="hs-k">Average time to approval</p>
    <p class="hs-v">${mo(mean)} <span>month${mo(mean) === "1" ? "" : "s"}</span></p>
  </div>
  <dl class="glance">
    <div><dt>${FAST} Fastest</dt><dd>${dur(fastest)}</dd></div>
    <div><dt>${SLOW} Slowest</dt><dd>${dur(slowest)}</dd></div>
  </dl>
  </div>
  <div class="amain">
  <h2>By Building Size</h2>
  ${sizeTable}

  <h2>How the Wait Is Spread</h2>
  ${histogram}

  <h2>By Year Accepted</h2>
  ${eraTable}

  <h2>Most Recent Plans Measured</h2>
  ${recentTable}

  ${cta(P)}
  </div>
</main>
` + FOOT(P);
}

// ---------- managing agents ----------
// From the first-year management agreement in each offering plan (facts.managing_agent), grouped in pros.mjs.
const agentFacts = await all("facts?select=plan_id,value_text&field=eq.managing_agent&value_text=not.is.null&order=plan_id");

// Management fee per residential unit per year, from the management line of the plan's Schedule B first-year budget
// (schedule_b, status ok). Skipped when the budget has several management lines and none is clearly the total or residential one.
const MGMT_LINE = /^(condominium |property )?management( fees?)?(\s*(\(\s*(total|residential)\s*\)|[-–]\s*(total|residential)))?$/i;
const mgmtFee = new Map();
for (const r of await all("schedule_b?select=plan_id,line_items&status=eq.ok")) {
  const p = byId.get(r.plan_id);
  if (!p?.units_residential) continue;
  const hits = (r.line_items || []).filter((it) => MGMT_LINE.test(String(it.item || "").trim()) && !/income/i.test(it.section || "") && Number(it.amount) > 0);
  const total = hits.filter((h) => /total/i.test(h.item));
  const res = hits.filter((h) => /residential/i.test(`${h.item} ${h.budget || ""}`) && !/non-?\s?residential/i.test(`${h.item} ${h.budget || ""}`));
  const pick = total.length === 1 ? total[0] : hits.length === 1 ? hits[0] : res.length === 1 ? res[0]
    : hits.length && new Set(hits.map((h) => h.amount)).size === 1 ? hits[0] : null;
  if (pick) mgmtFee.set(p.plan_id, { perUnit: Number(pick.amount) / p.units_residential, page: pick.page });
}
const perYear = (v) => `$${Math.round(v).toLocaleString("en-US")}`;
const median = (a) => { const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length ? (s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2) : null; };

// Gold, silver and bronze trophies for the top three; plain numbers after that.
const TROPHY = `<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 4h8v5a4 4 0 0 1-8 0z" fill="currentColor"/><path d="M8 6H5v1a3 3 0 0 0 3 3M16 6h3v1a3 3 0 0 1-3 3M12 13v4M8 20h8M9 17h6"/></svg>`;
const rank = (i) => i < 3 ? `<span class="rank r${i + 1}" title="${["1st", "2nd", "3rd"][i]}"><span class="vh">${i + 1}.</span>${TROPHY}</span>` : `<span class="rank">${i + 1}</span>`;
// Directory lists show the top 50 and hide the rest behind a button; typing in the find box searches all of them.
const TOP = 50;
const more = (i) => i >= TOP ? " hidden data-more" : "";
const moreButton = (total, noun) => total > TOP ? `<p class="amore"><button type="button" class="btn" id="amore" data-all="Show all ${n(total)} ${noun}" data-top="Show top ${TOP} only">Show all ${n(total)} ${noun}</button></p>` : "";
const listScript = `<script>
(() => {
  const box = document.getElementById("afind"), btn = document.getElementById("amore");
  const cards = [...document.querySelectorAll("details.agent")];
  let all = false;
  const show = () => {
    const q = box ? box.value.trim().toLowerCase() : "";
    cards.forEach((c) => { c.hidden = q ? !c.dataset.name.includes(q) : !all && c.hasAttribute("data-more"); });
    if (btn) { btn.parentNode.hidden = !!q; btn.textContent = all ? btn.dataset.top : btn.dataset.all; }
  };
  if (box) box.addEventListener("input", show);
  if (btn) btn.addEventListener("click", () => { all = !all; show(); });
  // A link to a card below the top ${TOP} opens the full list.
  const hit = location.hash && document.getElementById(decodeURIComponent(location.hash.slice(1)));
  if (hit && hit.hasAttribute("data-more")) { all = true; show(); hit.scrollIntoView(); }
})();
</script>`;
const AGENTS = groupAgents(agentFacts, byId)
  .map((g) => ({ ...g, fee: median(g.plans.map((p) => mgmtFee.get(p.plan_id)?.perUnit).filter((v) => v != null)) }));
// plan_id -> its agent group, or the manager as filed when the sponsor or board manages it.
const planAgent = new Map();
for (const g of AGENTS) for (const p of g.plans) planAgent.set(p.plan_id, g);
const selfPlans = [];
for (const f of agentFacts) {
  const p = byId.get(f.plan_id);
  if (!p || !NYC(p) || !isSelf(f.value_text, p) || planAgent.has(p.plan_id)) continue;
  planAgent.set(p.plan_id, { self: f.value_text.trim() });
  selfPlans.push({ p, as: f.value_text.trim() });
}
const feeText = (p) => mgmtFee.has(p.plan_id) ? ` · ${perYear(mgmtFee.get(p.plan_id).perUnit)}/unit/yr` : "";
function agentsPage() {
  const P = "";
  const url = `${SITE_URL}/managing-agents.html`;
  const groups = AGENTS;
  const namedPlans = groups.reduce((s, g) => s + g.plans.length, 0);
  const title = `NYC Condo Property Managers: Who Manages Which Buildings | The Condo Book Project`;
  const description = `${n(groups.length)} property managers named in ${n(namedPlans)} NYC condominium offering plans, with the buildings each one manages and the first-year management fee per unit. Top: ${groups.slice(0, 3).map((g) => `${g.name} (${g.plans.length})`).join(", ")}.`;
  const search = (g) => `${P}index.html?q=${encodeURIComponent("managed by " + g.query)}`;
  const bldg = (p) => `<li><a href="buildings/${esc(fileFor(p))}">${esc(tc(p.name))}</a><span>${esc(tc(p.address))} · ${esc(boro(p.borough))}${p.units_residential != null ? ` · ${p.units_residential} units` : ""}${p.accepted_date ? ` · ${p.accepted_date.slice(0, 4)}` : ""}${feeText(p)}</span></li>`;
  const card = (g, i) => `<details class="agent" id="${esc(g.slug)}" data-name="${esc(g.name.toLowerCase())}"${more(i)}>
    <summary>${rank(i)}<span class="an">${esc(g.name)}</span><span class="ac">${plural(g.plans.length, "building")}${g.fee != null ? `<span class="fee" title="Median first-year management fee per residential unit, from Schedule B">${perYear(g.fee)}/unit/yr</span>` : `<span class="fee" aria-hidden="true"></span>`}</span></summary>
    <ul class="dir">${g.plans.map(bldg).join("")}</ul>
    <p class="acts">${g.plans.length >= PROFILE_MIN ? `<a class="btn primary" href="managing-agents/${esc(g.slug)}.html">${esc(g.name)} profile</a>` : ""}<a class="btn" href="${esc(search(g))}">Search buildings managed by ${esc(g.query)}</a></p>
  </details>`;
  selfPlans.sort((a, b) => (b.p.accepted_date || "").localeCompare(a.p.accepted_date || ""));
  const selfRow = ({ p, as }) => `<li><a href="buildings/${esc(fileFor(p))}">${esc(tc(p.name))}</a><span>${esc(as)} · ${esc(boro(p.borough))}${p.units_residential != null ? ` · ${p.units_residential} units` : ""}${p.accepted_date ? ` · ${p.accepted_date.slice(0, 4)}` : ""}</span></li>`;
  return HEAD(P, { title, description, canonical: url }) + `
${ld({ "@context": "https://schema.org", "@type": "BreadcrumbList", itemListElement: [
    { "@type": "ListItem", position: 1, name: SITE_NAME, item: `${SITE_URL}/` },
    { "@type": "ListItem", position: 2, name: "Property managers", item: url },
  ] })}
<main class="post agents split">
  <div class="aside">
  <h1>NYC Condo Property Managers</h1>
  <p class="anote">The managing agent each offering plan names for the condominium's first year, and the management fee its Schedule B budget sets per unit. ${n(groups.length)} managers across ${n(namedPlans)} buildings. Ranked by the number of offering plans naming each firm as the first-year managing agent. May not reflect current management or pricing.</p>
  <label class="afind"><span>Find a manager</span><input id="afind" type="search" placeholder="Type a name" autocomplete="off"></label>
  </div>
  <div class="amain">
  <h2>Top ${TOP} Condo Property Managers</h2>
  <div class="agents-list">${groups.map((g, i) => card(g, i)).join("\n")}</div>
  ${moreButton(groups.length, "managers")}
  ${selfPlans.length ? `<h2>Managed by the Sponsor</h2>
  <p>In these ${n(selfPlans.length)} plans no outside company is hired: the sponsor, a company tied to it, or the condo board manages the building, often at no fee for the first year.</p>
  <details class="agent" data-name="sponsor self-managed">
    <summary><span class="an">Sponsor or board managed</span><span class="ac">${plural(selfPlans.length, "building")}</span></summary>
    <ul class="dir">${selfPlans.map(selfRow).join("")}</ul>
  </details>` : ""}
  <p class="src">Named in the offering plan as filed; the board can change managers after the first year. The fee is the management line of the plan's Schedule B first-year budget divided by its residential units; a manager's figure is the median across its buildings with a readable budget. Plans whose pages aren't searchable yet, or that don't name a manager, aren't included.</p>
  ${cta(P)}
  </div>
</main>
${listScript}
` + FOOT(P);
}

// ---------- offering plan attorneys ----------
// Sponsor's counsel from the AG plan record (plans.law_firm), grouped in pros.mjs.
const SHOWN = 25;
const FIRMS = groupFirms(plans);
function attorneysPage() {
  const P = "";
  const url = `${SITE_URL}/offering-plan-attorneys.html`;
  const all = FIRMS, top = FIRMS.slice(0, TOP);
  const withCounsel = plans.filter((p) => p.law_firm && NYC(p)).length;
  const title = `Top NYC Condo Offering Plan Attorneys: Sponsor's Counsel by Plans Filed | The Condo Book Project`;
  const description = `The ${top.length} law firms named most often as sponsor's counsel in NYC condominium offering plans, from the NY Attorney General's records. Top: ${top.slice(0, 3).map((f) => `${tc(f.name)} (${f.plans.length})`).join(", ")}.`;
  const search = (f) => `${P}index.html?q=${encodeURIComponent("counsel " + f.query)}`;
  const bldg = (p) => `<li><a href="buildings/${esc(fileFor(p))}">${esc(tc(p.name))}</a><span>${esc(tc(p.address))} · ${esc(boro(p.borough))}${p.units_residential != null ? ` · ${p.units_residential} units` : ""}${p.accepted_date ? ` · ${p.accepted_date.slice(0, 4)}` : ""}</span></li>`;
  const span = (f) => f.years.length ? (f.years[0] === f.years.at(-1) ? f.years[0] : `${f.years[0]}–${f.years.at(-1)}`) : "";
  const card = (f, i) => `<details class="agent" id="${esc(f.slug)}" data-name="${esc(tc(f.name).toLowerCase())}"${more(i)}>
    <summary>${rank(i)}<span class="an">${esc(tc(f.name))}</span><span class="ac">${plural(f.plans.length, "plan")}${span(f) ? `<span class="yrs" title="Years the plans were accepted for filing">${span(f)}</span>` : `<span class="yrs" aria-hidden="true"></span>`}</span></summary>
    ${f.plans.length > SHOWN ? `<p class="faint">The ${SHOWN} most recent of ${n(f.plans.length)}.</p>` : ""}
    <ul class="dir">${f.plans.slice(0, SHOWN).map(bldg).join("")}</ul>
    <p class="acts">${f.plans.length >= PROFILE_MIN ? `<a class="btn primary" href="offering-plan-attorneys/${esc(f.slug)}.html">${esc(tc(f.name))} profile</a>` : ""}<a class="btn" href="${esc(search(f))}">Search plans with counsel ${esc(f.query)}</a></p>
  </details>`;
  return HEAD(P, { title, description, canonical: url }) + `
${ld({ "@context": "https://schema.org", "@type": "ItemList", name: "Law firms most often named as sponsor's counsel in NYC condominium offering plans", url, numberOfItems: top.length,
    itemListOrder: "https://schema.org/ItemListOrderDescending",
    itemListElement: top.map((f, i) => ({ "@type": "ListItem", position: i + 1, name: tc(f.name), url: f.plans.length >= PROFILE_MIN ? `${SITE_URL}/offering-plan-attorneys/${f.slug}.html` : `${url}#${f.slug}` })) })}
${ld({ "@context": "https://schema.org", "@type": "BreadcrumbList", itemListElement: [
    { "@type": "ListItem", position: 1, name: SITE_NAME, item: `${SITE_URL}/` },
    { "@type": "ListItem", position: 2, name: "Offering plan attorneys", item: url },
  ] })}
<main class="post agents split">
  <div class="aside">
  <h1>Top NYC Condo Offering Plan Attorneys</h1>
  <p class="anote">The law firms named as the sponsor's counsel on New York City condominium offering plans. ${n(all.length)} firms across the ${n(withCounsel)} NYC plans that name their counsel. Ranked by the number of offering plans naming each firm as sponsor's counsel, not by quality. May not reflect current representation.</p>
  <label class="afind"><span>Find a firm</span><input id="afind" type="search" placeholder="Type a name" autocomplete="off"></label>
  </div>
  <div class="amain">
  <h2>Top ${TOP} Condo Offering Plan Attorneys</h2>
  <div class="agents-list">${all.map(card).join("\n")}</div>
  ${moreButton(all.length, "firms")}
  <p class="src">Counsel as recorded by the Attorney General when the plan was filed. Different spellings of one firm's name are counted together; a firm that changed its name may appear more than once.</p>
  ${cta(P)}
  </div>
</main>
${listScript}
` + FOOT(P);
}

// ---------- manager and attorney profile pages ----------
// One page per property manager (managing-agents/<slug>.html) and per law firm (offering-plan-attorneys/<slug>.html)
// named in at least PROFILE_MIN NYC plans: the buildings, a few key numbers, and a sidebar of the most similar firms.
// Websites come only from data/websites.json ({"managers": {slug: url}, "attorneys": {slug: url}}), checked by hand;
// a firm without an entry gets no website link.
const SITES = JSON.parse(await readFile(join(ROOT, "data", "websites.json"), "utf8").catch(() => "{}"));
const offerPrice = (p) => money(p.meta?.plan?.["Current Price"]) || money(p.meta?.plan?.["Initial Price"]);
const sumUnits = (list) => list.reduce((s, p) => s + (p.units_residential || 0), 0);
const yearSpan = (list) => { const ys = list.map((p) => p.accepted_date?.slice(0, 4)).filter(Boolean).sort(); return ys.length ? (ys[0] === ys.at(-1) ? ys[0] : `${ys[0]}–${ys.at(-1)}`) : ""; };
const boroList = (list) => [...count(list, (p) => boro(p.borough))].sort((a, b) => b[1] - a[1]).map(([b]) => b);

// Similarity on log scales, so 3 vs 6 buildings is as far apart as 30 vs 60. A dimension either side lacks costs a flat 1.
const lg = (v) => Math.log1p(v);
const distance = (a, b) => a.dims.reduce((s, v, i) => s + (v != null && b.dims[i] != null ? Math.abs(lg(v) - lg(b.dims[i])) : 1), 0);
const similarTo = (x, pool, k = 6) => pool.filter((y) => y !== x).map((y) => [y, distance(x, y)]).sort((a, b) => a[1] - b[1] || b[0].plans.length - a[0].plans.length).slice(0, k).map(([y]) => y);

// Managers: buildings, residential units, median first-year fee per unit. Attorneys: plans, units, median offering $/unit.
const MGR = AGENTS.filter((g) => g.plans.length >= PROFILE_MIN).map((g) => {
  const units = sumUnits(g.plans);
  return { ...g, display: g.name, units, dims: [g.plans.length, units, g.fee], dir: "managing-agents", site: SITES.managers?.[g.slug] };
});
const ATT = FIRMS.filter((f) => f.plans.length >= PROFILE_MIN).map((f) => {
  const units = sumUnits(f.plans);
  const perUnit = median(f.plans.map((p) => offerPrice(p) && p.units_residential ? offerPrice(p) / p.units_residential : null).filter((v) => v != null));
  return { ...f, display: tc(f.name), units, perUnit, dims: [f.plans.length, units, perUnit], dir: "offering-plan-attorneys", site: SITES.attorneys?.[f.slug] };
});
const profileHref = (x, P) => `${P}${x.dir}/${x.slug}.html`;
const hoverScript = `<script>
(() => {
  // Hovering a dot marks its row, and hovering a row marks its dot.
  const pair = (id) => [document.getElementById(id), document.querySelector('.fmap a[data-id="' + id + '"]')];
  const on = (id, v) => pair(id).forEach((el) => el && el.classList.toggle("on", v));
  document.querySelectorAll(".fmap a[data-id]").forEach((a) => {
    a.addEventListener("mouseenter", () => on(a.dataset.id, true));
    a.addEventListener("mouseleave", () => on(a.dataset.id, false));
  });
  document.querySelectorAll(".ftable tbody tr[id]").forEach((tr) => {
    tr.addEventListener("mouseenter", () => on(tr.id, true));
    tr.addEventListener("mouseleave", () => on(tr.id, false));
  });
})();
</script>`;
const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return u; } };

function profilePage(x, kind) {
  const P = "../";
  const mgr = kind === "manager";
  const url = `${SITE_URL}/${x.dir}/${x.slug}.html`;
  const listUrl = `${SITE_URL}/${x.dir}.html`;
  const listName = mgr ? "Property managers" : "Offering plan attorneys";
  const nyc = x.plans.length;
  const boros = boroList(x.plans);
  const span = yearSpan(x.plans);
  const named = x.plans.slice(0, 3).map((p) => tc(p.name));
  const pricing = mgr ? x.fee : x.perUnit;
  const pricingText = pricing == null ? null : mgr ? `${perYear(pricing)}/unit/yr` : fmtMoney(pricing);
  const title = mgr ? `${x.display}: NYC Condo Buildings Managed | The Condo Book Project`
    : `${x.display}: NYC Condo Offering Plans as Sponsor's Counsel | The Condo Book Project`;
  const description = mgr
    ? `${x.display} is named as the first-year managing agent in ${plural(nyc, "NYC condo offering plan")}${x.units ? ` covering ${plural(x.units, "residential unit")}` : ""}, including ${named.join(", ")}.${pricingText ? ` Median first-year management fee: ${pricingText}.` : ""}`
    : `${x.display} is named as sponsor's counsel on ${plural(nyc, "NYC condo offering plan")}${span ? ` accepted ${span.includes("–") ? "from " + span.replace("–", " to ") : "in " + span}` : ""}, including ${named.join(", ")}.`;
  const search = mgr ? `${P}index.html?q=${encodeURIComponent("managed by " + x.query)}` : `${P}index.html?q=${encodeURIComponent("counsel " + x.query)}`;
  const dash = `<span class="faint">—</span>`;

  const row = (p) => {
    const u = p.units_residential, pr = offerPrice(p), fee = mgmtFee.get(p.plan_id)?.perUnit;
    const last = mgr ? (fee != null ? perYear(fee) : dash) : (pr && u ? esc(fmtMoney(pr / u)) : dash);
    return `<tr id="${esc(p.plan_id.toLowerCase())}"><td><a href="${P}buildings/${esc(fileFor(p))}">${esc(tc(p.name))}</a><span class="sub">${esc(tc(p.address))} · ${esc(boro(p.borough))}${KIND[p.construction] ? ` · ${KIND[p.construction]}` : ""}</span></td>` +
      `<td class="nowrap">${p.accepted_date ? esc(p.accepted_date.slice(0, 4)) : dash}</td><td class="num">${u ?? dash}</td><td class="num">${last}</td></tr>`;
  };
  const pool = mgr ? MGR : ATT;
  const sims = similarTo(x, pool);
  const simRow = (y) => {
    const pv = mgr ? (y.fee != null ? `${perYear(y.fee)}/unit/yr` : "") : (y.perUnit != null ? `${fmtMoney(y.perUnit)}/unit` : "");
    return `<li><a href="${esc(y.slug)}.html">${esc(y.display)}</a><span>${plural(y.plans.length, mgr ? "building" : "plan")} · ${plural(y.units, "unit")}${pv ? ` · ${esc(pv)}` : ""}</span></li>`;
  };
  const org = { "@type": mgr ? "Organization" : "LegalService", name: x.display, ...(x.site ? { url: x.site, sameAs: [x.site] } : {}), areaServed: "New York City" };

  return HEAD(P, { title, description, canonical: url }) + `
${ld({ "@context": "https://schema.org", "@type": "ProfilePage", name: title.replace(/ \| .*$/, ""), url, description, mainEntity: org })}
${ld({ "@context": "https://schema.org", "@type": "BreadcrumbList", itemListElement: [
    { "@type": "ListItem", position: 1, name: SITE_NAME, item: `${SITE_URL}/` },
    { "@type": "ListItem", position: 2, name: listName, item: listUrl },
    { "@type": "ListItem", position: 3, name: x.display, item: url },
  ] })}
<main class="post agents profile split">
  <div class="aside">
  <nav class="crumbs" aria-label="Breadcrumb"><a href="${P}index.html">${SITE_NAME}</a> › <a href="${P}${x.dir}.html">${listName}</a></nav>
  <h1>${esc(x.display)}</h1>
  <p class="anote">${mgr
    ? `Named as the first-year managing agent in ${plural(nyc, "New York City condominium offering plan")}. The board can change managers after the first year, so this may not reflect who manages each building today.`
    : `Named as the sponsor's counsel on ${plural(nyc, "New York City condominium offering plan")}, as recorded by the Attorney General. This may not reflect current representation.`}</p>
  <dl class="glance">
    <div><dt>${mgr ? "Buildings" : "Plans"}</dt><dd>${n(nyc)}</dd></div>
    <div><dt>Residential units</dt><dd>${x.units ? n(x.units) : "—"}</dd></div>
    <div><dt>${mgr ? "Median fee" : "Median $/unit"}</dt><dd>${pricingText ? esc(pricingText) : "—"}</dd></div>
    <div><dt>${span.includes("–") ? "Years" : "Year"}</dt><dd>${span || "—"}</dd></div>
  </dl>
  <p class="acts">${x.site ? `<a class="btn primary" href="${esc(x.site)}" target="_blank" rel="noopener">${esc(hostOf(x.site))} ↗</a>` : ""}<a class="btn" href="${esc(search)}">Search ${mgr ? "its buildings" : "its plans"}</a></p>
  ${sims.length ? `<div class="sims"><h2>Similar ${mgr ? "Managers" : "Firms"}</h2>
  <p class="anote">Closest in ${mgr ? "buildings" : "plans"}, residential units and ${mgr ? "management fee per unit" : "offering price per unit"}.</p>
  <ul class="dir">${sims.map(simRow).join("")}</ul></div>` : ""}
  </div>
  <div class="amain">
  <h2>${mgr ? "Buildings Managed" : "Offering Plans"}</h2>
  <p>${esc(x.display)} ${mgr ? "is named as managing agent" : "is named as sponsor's counsel"} in ${plural(nyc, "plan")}${boros.length ? ` in ${boros.length > 1 ? boros.slice(0, -1).join(", ") + " and " + boros.at(-1) : boros[0]}` : ""}${span ? `, accepted for filing ${span.includes("–") ? "from " + span.replace("–", " to ") : "in " + span}` : ""}.</p>
  ${plansMap(x.plans, `Map of the NYC condo buildings in plans naming ${x.display}`)}
  <div class="tscroll"><table class="ftable"><thead><tr><th>Condominium</th><th>Accepted</th><th class="num">Units</th><th class="num">${mgr ? "Fee/unit/yr" : "$/unit"}</th></tr></thead><tbody>${x.plans.map(row).join("")}</tbody></table></div>
  <p class="src">${mgr
    ? "The fee is the management line of each plan's Schedule B first-year budget divided by its residential units; — means the budget hasn't been read or doesn't break it out. The median fee is across the buildings with a figure."
    : "$/unit is the offering price on the AG record divided by the residential units; the median is across the plans with both."} Different spellings of one ${mgr ? "company" : "firm"}'s name are counted together.</p>
  ${cta(P)}
  </div>
</main>
${hoverScript}
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
        { "@type": "Dataset", name: "NYC condominium offering plans", description: "Condominium offering plans filed with the New York State Attorney General, searchable in full text with page citations.",
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
await writeFile(join(ROOT, "time-to-approval.html"), approvalPage());
await writeFile(join(ROOT, "managing-agents.html"), agentsPage());
await writeFile(join(ROOT, "offering-plan-attorneys.html"), attorneysPage());
for (const dir of ["managing-agents", "offering-plan-attorneys"]) {
  // Start clean so a firm that drops below PROFILE_MIN or is regrouped doesn't leave a stale page behind.
  await rm(join(ROOT, dir), { recursive: true, force: true });
  await mkdir(join(ROOT, dir), { recursive: true });
}
for (const x of MGR) await writeFile(join(ROOT, "managing-agents", x.slug + ".html"), profilePage(x, "manager"));
for (const x of ATT) await writeFile(join(ROOT, "offering-plan-attorneys", x.slug + ".html"), profilePage(x, "attorney"));
for (const [file, path] of Object.entries(STATIC)) await stampStatic(file, path);

const pageUrls = [["", TODAY], ["about.html"], ["faq.html", TODAY], ["new-condo-filings.html", TODAY], ["time-to-approval.html", TODAY], ["managing-agents.html", TODAY], ["offering-plan-attorneys.html", TODAY], ["blog/", TODAY],
  ...MGR.map((x) => [`managing-agents/${x.slug}.html`, TODAY]), ...ATT.map((x) => [`offering-plan-attorneys/${x.slug}.html`, TODAY]),
  ...posts.map((q) => [`blog/${q.slug}.html`, q.updated || q.published])];
await writeFile(join(ROOT, "sitemap-pages.xml"), urlset(pageUrls));
await writeFile(join(ROOT, "sitemap.xml"), `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap><loc>${SITE_URL}/sitemap-pages.xml</loc><lastmod>${TODAY}</lastmod></sitemap>
  <sitemap><loc>${SITE_URL}/sitemap-buildings.xml</loc></sitemap>
</sitemapindex>
`);
await writeFile(join(ROOT, "robots.txt"), `User-agent: *\nAllow: /\n\nSitemap: ${SITE_URL}/sitemap.xml\n`);
console.log(`${posts.length} posts, blog index, new-condo-filings.html, time-to-approval.html, managing-agents.html, offering-plan-attorneys.html, ${MGR.length} manager and ${ATT.length} attorney profiles, ${Object.keys(STATIC).length} stamped pages, sitemap-pages.xml with ${pageUrls.length} URLs`);
