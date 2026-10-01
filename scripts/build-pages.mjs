// Builds the pages that aren't one-per-plan, in a few seconds:
//   - blog/*.html from content/blog/*.html (front matter + body), and blog/index.html
//   - new-condo-filings.html, the 10 newest NYC plans accepted for filing
//   - time-to-approval.html, common-charges.html and property-taxes.html, from the AG dates, the Schedule B budgets
//     and the Schedule A tax columns
//   - managing-agents/*.html, offering-plan-attorneys/*.html, architects/*.html, selling-agents/*.html and tax-consultants/*.html, a profile per firm,
//     and developers/*.html, a profile per development company behind the sponsors
//   - the SEO block in the hand-written pages (index, about, faq, terms, privacy, disclaimers)
//   - sitemap-pages.xml, sitemap.xml (an index of it and sitemap-buildings.xml) and robots.txt
//   - the redirects in vercel.json, for profile URLs that went away (see "redirects" below)
//
//   node scripts/build-pages.mjs
//
// Run after build-buildings.mjs, or on its own when only posts or the filings list changed.
// Every number and plan named here comes from the plan records; posts insert them with tokens:
//   {{stat:NAME}}  a count (see STATS below)      {{bldg:CD250420}}  link to that plan's building page
//   {{table:NAME}} a generated table (see TABLES)
import { mkdir, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { SITE_URL, AG, ROOT, TODAY, all, esc, tc, fileFor, day, month, usDate, money, fmtMoney, plural, boro, SITE_NAME, ld, SEO, HEAD, FOOT, urlset, fitDesc, firstFit, OG_SITE } from "./site.mjs";
import { PROFILE_MIN, isSelf, groupAgents, groupFirms, groupPros, groupCompanies, groupPrincipals, byPlan } from "./pros.mjs";

// ---------- data ----------
const plans = (await all("plans?select=plan_id,name,address,zip,borough,construction,submitted_date,accepted_date,units_residential,units_parking,units_commercial,units_storage,units_other,category,sponsor,law_firm,meta,fetched_at,lat,lng&order=plan_id"))
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
// A directory description: the sentence, then " Top: A (5), B (4)." with as many names as fit.
const withTop = (base, names) => fitDesc(base, names.map((s, i) => (i ? ", " : " Top: ") + s), ".").replace(/\.\.$/, ".");
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
  // FAQ structured data from the post's "Common Questions" section (<h3>question</h3><p>answer</p>), so the markup can't drift from the text.
  const faqSection = body.split(/<h2>Common Questions<\/h2>/)[1]?.split(/<h2>/)[0] || "";
  const faq = [...faqSection.matchAll(/<h3>([\s\S]*?)<\/h3>\s*<p>([\s\S]*?)<\/p>/g)]
    .map(([, q, a]) => ({ "@type": "Question", name: unhtml(q), acceptedAnswer: { "@type": "Answer", text: unhtml(a) } }));
  return HEAD(P, { image: OG_SITE, title: post.title, description: post.description, canonical: url }) + `
${ld({
    "@context": "https://schema.org", "@type": "BlogPosting", headline: post.h1, description: post.description, url, mainEntityOfPage: url,
    datePublished: post.published, dateModified: updated, inLanguage: "en-US", keywords: (post.keywords || []).join(", "), wordCount: words(body),
    author: ORG, publisher: ORG, isPartOf: { "@type": "Blog", name: `${SITE_NAME} Blog`, url: `${SITE_URL}/blog/` },
  })}${faq.length ? "\n" + ld({ "@context": "https://schema.org", "@type": "FAQPage", mainEntity: faq }) : ""}
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
  const description = "Plain-English guides to NYC condo offering plans: AG searches, CD numbers, amendments, Schedule A and B, common charges, first-year budgets and approval times.";
  return HEAD(P, { image: OG_SITE, title, description, canonical: url }) + `
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
// Skip AG rows that aren't a real offering ("*Resubmit*", "(8/3/89 Filed)", no units).
const realPlan = (p) => !/resubmit|withdrawn|\(\s*\d{1,2}\/\d{1,2}\/\d{2,4}|\bfiled\s*\)/i.test(p.name || "") && (p.units_residential || p.category !== "residential");
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
  const real = realPlan;
  const since = new Date(TODAY + "T12:00:00Z"); since.setUTCMonth(since.getUTCMonth() - 3);
  const SINCE = since.toISOString().slice(0, 10);
  const newest = accepted.filter(NYC).filter(real).sort((a, b) => b.accepted_date.localeCompare(a.accepted_date) || b.plan_id.localeCompare(a.plan_id));
  const recent = newest.filter((p) => p.accepted_date >= SINCE);
  const latest = recent.length ? recent : newest.slice(0, 10);
  const title = `New NYC Condo Offering Plans: Last 3 Months`;
  const description = fitDesc(`${latest.length} NYC condo offering plans accepted by the NY Attorney General in the last three months, with total sellout and price per unit.`,
    [` Latest: ${tc(latest[0].name)}, ${latest[0].plan_id}.`]);

  const price = (p) => money(p.meta?.plan?.["Current Price"]) || money(p.meta?.plan?.["Initial Price"]);
  const dash = `<span class="faint">—</span>`;
  const fmtM = (n) => fmtMoney(n).replace(" million", "M");
  const row = (p) => {
    const pr = price(p), u = p.units_residential;
    return `<tr id="${esc(p.plan_id.toLowerCase())}"><td><a href="buildings/${esc(fileFor(p))}" target="_blank" rel="noopener">${esc(tc(p.name))}</a><span class="sub">${esc(tc(p.address))} · ${esc(boro(p.borough))}${KIND[p.construction] ? ` · ${KIND[p.construction]}` : ""}</span></td>` +
      `<td class="nowrap">${esc(day(p.accepted_date))}</td><td class="num">${u ?? dash}</td>` +
      `<td class="num">${pr ? esc(fmtM(pr)) : dash}</td><td class="num">${pr && u ? esc(fmtM(pr / u)) : dash}</td></tr>`;
  };

  return HEAD(P, { image: OG_SITE, title, description, canonical: url }) + `
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
// Only rows with a blank "Amendment No" hold the original submission, so the page measures those plans alone,
// and only the RECENT_N most recently accepted of them, since review times decades ago say little about today's.
// Rows that aren't a real offering ("*Resubmit*") and plans with no residential units are skipped: CD160125, an
// all-commercial plan submitted in 2016 and accepted in 2026, would otherwise add two months to the average.
const DAY_MS = 864e5, RECENT_N = 50;
const timed = accepted.filter(NYC).filter(realPlan).filter((p) => p.units_residential > 0)
  .filter((p) => p.submitted_date && !String(p.meta?.plan?.["Amendment No"] ?? "").trim())
  .map((p) => ({ ...p, days: Math.round((Date.parse(p.accepted_date) - Date.parse(p.submitted_date)) / DAY_MS) }))
  .filter((p) => p.days >= 0)
  .sort((a, b) => b.accepted_date.localeCompare(a.accepted_date) || b.plan_id.localeCompare(a.plan_id))
  .slice(0, RECENT_N);
const avgOf = (ds) => Math.round(ds.reduce((s, d) => s + d, 0) / ds.length);
const medianOf = (ds) => { const s = [...ds].sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2); };
const mo = (d) => (d / (365.25 / 12)).toFixed(1).replace(/\.0$/, "");
// Months past 30 days, days up to that.
const dur = (d) => d > 30 ? `${mo(d)} month${mo(d) === "1" ? "" : "s"}` : plural(d, "day");
// The approval-times blog post quotes the same plans, so the post and this page can't disagree.
{
  const quart = (ds, f) => [...ds].sort((a, b) => a - b)[Math.round(f * (ds.length - 1))];
  const ds = timed.map((p) => p.days), by = (f) => timed.filter(f).map((p) => p.days);
  const mid = (xs) => xs.length ? dur(medianOf(xs)) : "none";
  const neu = by((p) => p.construction === "NEW"), old = by((p) => p.construction !== "NEW"), small = by((p) => p.units_residential <= 10);
  const topBoro = [...count(timed, (p) => boro(p.borough))].sort((a, b) => b[1] - a[1])[0];
  Object.assign(STATS, {
    appr_n: n(timed.length), appr_since: day(timed.at(-1).accepted_date),
    appr_median_days: n(medianOf(ds)), appr_median: dur(medianOf(ds)), appr_mean: dur(avgOf(ds)),
    appr_q1: dur(quart(ds, 0.25)), appr_q3: dur(quart(ds, 0.75)), appr_fastest: dur(Math.min(...ds)), appr_slowest: dur(Math.max(...ds)),
    appr_new_n: n(neu.length), appr_new_median: mid(neu), appr_rehab_n: n(old.length), appr_rehab_median: mid(old),
    appr_small_n: n(small.length), appr_small_median: mid(small),
    appr_top_boro: topBoro[0], appr_top_boro_n: n(topBoro[1]), appr_top_boro_median: mid(by((p) => boro(p.borough) === topBoro[0])),
  });
  TABLES.appr_by_year = () => `<div class="tscroll"><table><thead><tr><th>Year accepted</th><th>Median time</th><th>Plans</th></tr></thead><tbody>${
    [...new Set(timed.map((p) => p.accepted_date.slice(0, 4)))].sort().reverse().map((y) => {
      const xs = by((p) => p.accepted_date.startsWith(y));
      return `<tr><td>${y === thisYear ? `${y} (to date)` : y}</td><td>${dur(medianOf(xs))}</td><td>${n(xs.length)}</td></tr>`;
    }).join("")}</tbody></table></div>`;
}
const SIZES = [[1, 10, "1–10"], [11, 25, "11–25"], [26, 50, "26–50"], [51, Infinity, "51 or more"]];
const BINS = [[0, 90, "Under 3 months"], [90, 180, "3–6 months"], [180, 270, "6–9 months"], [270, 365, "9–12 months"], [365, 548, "12–18 months"], [548, 730, "18–24 months"], [730, Infinity, "Over 2 years"]];
// The homepage stat strip: each data page leaves its headline figure here, so the strip quotes the page it links to.
const HOME = {};
const FAST = `<svg class="ic" viewBox="0 0 24 24" width="15" height="15" fill="currentColor" aria-hidden="true"><path d="M13 2 4 14h7l-1 8 9-12h-7z"/></svg>`;
const SLOW = `<svg class="ic" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 2h12M6 22h12M7 2c0 6 10 6 10 10S7 16 7 22M17 2c0 6-10 6-10 10s10 4 10 10"/></svg>`;

function approvalPage() {
  const P = "";
  const url = `${SITE_URL}/time-to-approval.html`;
  const days = timed.map((p) => p.days);
  const mean = avgOf(days), median = medianOf(days), fastest = Math.min(...days), slowest = Math.max(...days);
  const oldest = timed.at(-1).accepted_date;
  const title = "NYC Condo Offering Plan Approval Times (AG Data)";
  const description = `How long the NY Attorney General takes to accept an NYC condo offering plan: ${dur(mean)} on average across the ${timed.length} most recent plans that can be timed.`;
  HOME.approval = { href: "time-to-approval.html", k: "Avg. time to AG approval", v: mo(mean), u: `month${mo(mean) === "1" ? "" : "s"}` };

  // By building size (residential units on the AG record).
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
    <div class="cols" role="img" aria-label="${esc(bins.map(([l, c]) => `${l}: ${plural(c, "plan")}`).join("; "))}">${bins.map(([label, c]) =>
      `<div class="col" title="${esc(label)}: ${plural(c, "plan")} (${Math.round(100 * c / timed.length)}%)"><span class="v">${n(c)}</span><span class="b" style="height:${Math.max(1, Math.round(100 * c / binMax))}%"></span><span class="l">${esc(label)}</span></div>`).join("")}</div>
  </figure>`;

  // By year accepted: the average, with a bar relative to the longest.
  const years = [...new Set(timed.map((p) => p.accepted_date.slice(0, 4)))].sort().reverse().map((y) => {
    const ds = timed.filter((p) => p.accepted_date.startsWith(y)).map((p) => p.days);
    return { label: y === thisYear ? `${y} (to date)` : y, n: ds.length, mean: avgOf(ds) };
  });
  const yearMax = Math.max(...years.map((e) => e.mean));
  const yearTable = `<div class="tscroll"><table class="bars"><thead><tr><th>Year accepted</th><th>Average</th><th aria-hidden="true"></th></tr></thead><tbody>${years.map((e) =>
    `<tr title="${plural(e.n, "plan")}"><td>${esc(e.label)}</td><td>${dur(e.mean)}</td><td class="bar" aria-hidden="true"><span style="width:${Math.max(1, Math.round(100 * e.mean / yearMax))}%"></span></td></tr>`).join("")}</tbody></table></div>`;

  const recent = timed;
  const recentTable = `<div class="tscroll"><table><thead><tr><th>CD number</th><th>Condominium</th><th>Submitted</th><th>Accepted</th><th>Time</th></tr></thead><tbody>${recent.map((p) =>
    `<tr><td>${esc(p.plan_id)}</td><td><a href="buildings/${esc(fileFor(p))}">${esc(tc(p.name))}</a></td><td>${esc(day(p.submitted_date))}</td><td>${esc(day(p.accepted_date))}</td><td>${dur(p.days)}</td></tr>`).join("")}</tbody></table></div>`;

  return HEAD(P, { image: OG_SITE, title, description, canonical: url }) + `
${ld({ "@context": "https://schema.org", "@type": "BreadcrumbList", itemListElement: [
    { "@type": "ListItem", position: 1, name: SITE_NAME, item: `${SITE_URL}/` },
    { "@type": "ListItem", position: 2, name: "Time to approval", item: url },
  ] })}
<main class="post approval split">
  <div class="aside">
  <h1>How Long Does Condo Offering Plan Approval Take?</h1>
  <p class="anote">The time from when a sponsor submits a New York City condominium offering plan to when the Attorney General accepts it for filing, across the ${n(timed.length)} most recent plans accepted since ${esc(day(oldest))}. Only plans not yet amended can be timed from the AG's records, so read the figures as a guide.</p>
  <div class="hero-stat">
    <p class="hs-k">Average time to approval</p>
    <p class="hs-v">${mo(mean)} <span>month${mo(mean) === "1" ? "" : "s"}</span></p>
    <p class="hs-s">Median ${dur(median)}: half the plans were accepted faster.</p>
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
  ${yearTable}

  <h2>The ${n(timed.length)} Plans Measured</h2>
  ${recentTable}

  ${cta(P)}
  </div>
</main>
` + FOOT(P);
}

// ---------- common charges ----------
// Monthly common charges from each plan's Schedule B first-year budget (schedule_b, status ok): estimated total
// expenses / 12, per residential unit and per square foot. Only plans with no commercial units and a single budget
// count, so nearly all the budget is carried by the homes (any parking or storage units' small share stays in).
// Only plans accepted in the last CC_YEARS years, since older budgets say little about today's.
// Square feet are the sum of the unit sizes in the plan's checked Schedule A table (data/schedule-a), used only
// when the plan has only residential units and the table lists every one with a size.
const CC_YEARS = 5;
const ccSince = `${Number(TODAY.slice(0, 4)) - CC_YEARS}${TODAY.slice(4)}`;
const schedA = new Map();
for (const f of await readdir(join(ROOT, "data", "schedule-a")).catch(() => [])) {
  schedA.set(f.replace(/\.json$/, ""), JSON.parse(await readFile(join(ROOT, "data", "schedule-a", f), "utf8")));
}
const charged = (await all("schedule_b?select=plan_id,budget_period,total_expenses,line_items&status=eq.ok")).map((r) => {
  const p = byId.get(r.plan_id);
  if (!p || !NYC(p) || !realPlan(p) || !p.accepted_date || p.accepted_date < ccSince) return null;
  if (!(p.units_residential > 0) || p.units_commercial > 0) return null;
  if (!(Number(r.total_expenses) > 0) || new Set((r.line_items || []).map((it) => it.budget)).size > 1) return null;
  const monthly = Number(r.total_expenses) / 12;
  const a = schedA.get(p.plan_id);
  const sf = a && !(p.units_commercial || p.units_parking || p.units_storage || p.units_other) && a.units.length === p.units_residential && a.units.every((u) => u.sqft > 0) ? a.units.reduce((s, u) => s + u.sqft, 0) : null;
  return { ...p, annual: Number(r.total_expenses), period: r.budget_period, perUnit: monthly / p.units_residential, perSf: sf ? monthly / sf : null };
}).filter(Boolean).sort((a, b) => b.accepted_date.localeCompare(a.accepted_date) || b.plan_id.localeCompare(a.plan_id));
const usd = (v) => `$${Math.round(v).toLocaleString("en-US")}`;
const usdSf = (v) => `$${v.toFixed(2)}`;
const CC_BINS = [[0, 300, "Under $300"], [300, 500, "$300–499"], [500, 750, "$500–749"], [750, 1000, "$750–999"], [1000, 1500, "$1,000–1,499"], [1500, 2500, "$1,500–2,499"], [2500, Infinity, "$2,500 or more"]];
const CC_RECENT = 50;

function commonChargesPage() {
  const P = "";
  const url = `${SITE_URL}/common-charges.html`;
  const per = charged.map((p) => p.perUnit), perSf = charged.filter((p) => p.perSf).map((p) => p.perSf);
  const mid = median(per), mean = per.reduce((s, v) => s + v, 0) / per.length, sfMid = median(perSf);
  const title = "What Are Common Charges in a New NYC Condo?";
  const description = fitDesc(`Median monthly common charges in new NYC condos: ${usd(mid)} per unit${sfMid != null ? ` and ${usdSf(sfMid)} per square foot` : ""}`,
    [`, from first-year budgets in ${n(charged.length)} plans accepted since ${day(ccSince)}`], ".");
  HOME.charges = { href: "common-charges.html", k: "Avg. common charges", v: usd(mean), u: "/month", s: perSf.length ? `${usdSf(avgOf(perSf))} /SF` : "" };

  // By building size (residential units on the AG record).
  const sizes = SIZES.map(([a, b, label]) => {
    const ps = charged.filter((p) => p.units_residential >= a && p.units_residential <= b);
    const sf = ps.filter((p) => p.perSf).map((p) => p.perSf);
    return ps.length ? { label, n: ps.length, unit: median(ps.map((p) => p.perUnit)), lo: Math.min(...ps.map((p) => p.perUnit)), hi: Math.max(...ps.map((p) => p.perUnit)), sf: median(sf), sfN: sf.length } : null;
  }).filter(Boolean);
  const sizeTable = `<div class="tscroll"><table class="dm"><thead><tr><th>Residential units</th><th>Plans</th><th>Per unit / month</th><th>Per SF / month</th><th>Lowest–highest per unit</th></tr></thead><tbody>${sizes.map((s) =>
    `<tr><td>${esc(s.label)}</td><td>${n(s.n)}</td><td><strong>${usd(s.unit)}</strong></td><td>${s.sf != null ? `<strong>${usdSf(s.sf)}</strong><span class="sub">${plural(s.sfN, "plan")} with unit sizes</span>` : "—"}</td><td>${usd(s.lo)}–${usd(s.hi)}</td></tr>`).join("")}</tbody></table></div>`;

  // Distribution of per-unit charges.
  const bins = CC_BINS.map(([a, b, label]) => [label, per.filter((v) => v >= a && v < b).length]);
  const binMax = Math.max(...bins.map((b) => b[1]));
  const histogram = `<figure class="chart">
    <div class="cols" role="img" aria-label="${esc(bins.map(([l, c]) => `${l}: ${plural(c, "plan")}`).join("; "))}">${bins.map(([label, c]) =>
      `<div class="col" title="${esc(label)}: ${plural(c, "plan")} (${Math.round(100 * c / charged.length)}%)"><span class="v">${n(c)}</span><span class="b" style="height:${Math.max(1, Math.round(100 * c / binMax))}%"></span><span class="l">${esc(label)}</span></div>`).join("")}</div>
  </figure>`;

  // By borough: the median per unit, with a bar relative to the highest.
  const boros = [...new Set(charged.map((p) => boro(p.borough)))].map((b) => {
    const ps = charged.filter((p) => boro(p.borough) === b);
    return { label: b, n: ps.length, v: median(ps.map((p) => p.perUnit)) };
  }).sort((a, b) => b.v - a.v);
  const boroMax = Math.max(...boros.map((e) => e.v));
  const boroTable = `<div class="tscroll"><table class="bars"><thead><tr><th>Borough</th><th>Per unit / month</th><th aria-hidden="true"></th></tr></thead><tbody>${boros.map((e) =>
    `<tr title="${plural(e.n, "plan")}"><td>${esc(e.label)} (${plural(e.n, "plan")})</td><td>${usd(e.v)}</td><td class="bar" aria-hidden="true"><span style="width:${Math.max(1, Math.round(100 * e.v / boroMax))}%"></span></td></tr>`).join("")}</tbody></table></div>`;

  const recent = charged.slice(0, CC_RECENT);
  const recentTable = `<div class="tscroll"><table><thead><tr><th>Condominium</th><th>Units</th><th>Accepted</th><th>Per unit / month</th><th>Per SF / month</th></tr></thead><tbody>${recent.map((p) =>
    `<tr><td><a href="buildings/${esc(fileFor(p))}">${esc(tc(p.name))}</a></td><td>${n(p.units_residential)}</td><td>${esc(day(p.accepted_date))}</td><td>${usd(p.perUnit)}</td><td>${p.perSf ? usdSf(p.perSf) : "—"}</td></tr>`).join("")}</tbody></table></div>`;

  return HEAD(P, { image: OG_SITE, title, description, canonical: url }) + `
${ld({ "@context": "https://schema.org", "@type": "BreadcrumbList", itemListElement: [
    { "@type": "ListItem", position: 1, name: SITE_NAME, item: `${SITE_URL}/` },
    { "@type": "ListItem", position: 2, name: "Common charges", item: url },
  ] })}
<main class="post approval split">
  <div class="aside">
  <h1>What Are Common Charges in a New NYC Condo?</h1>
  <p class="anote">The monthly common charges set by the first-year budget (Schedule B) in ${n(charged.length)} New York City condominium offering plans accepted since ${esc(day(ccSince))}. Buildings with commercial units are left out, so the budget falls on the homes (and any parking or storage units). Budgets are the sponsor's projections for the first year, not what owners pay today; real estate taxes are not included (see <a href="property-taxes.html">property taxes</a>).</p>
  <div class="hero-stat">
    <p class="hs-k">Median common charges per unit</p>
    <p class="hs-v">${usd(mid)} <span>a month</span></p>
    <p class="hs-s">Average ${usd(mean)}: a few large luxury buildings pull it up.</p>
  </div>
  <dl class="glance">
    ${sfMid != null ? `<div><dt>Per square foot</dt><dd>${usdSf(sfMid)} a month<span class="sub">median, ${plural(perSf.length, "plan")} with unit sizes</span></dd></div>` : ""}
    <div><dt>Budgets read</dt><dd>${n(charged.length)}</dd></div>
  </dl>
  </div>
  <div class="amain">
  <h2>By Building Size</h2>
  ${sizeTable}

  <h2>How Charges Are Spread</h2>
  ${histogram}

  <h2>By Borough</h2>
  ${boroTable}

  <h2>The ${n(recent.length)} Most Recent Plans</h2>
  ${recentTable}

  <p class="src">Per unit: the budget's estimated total expenses divided by 12 and by the residential units on the AG record, an average across the building's homes; larger homes pay more by their common interest. Per square foot: the same monthly total divided by the unit sizes listed in the plan's Schedule A, used only when the building has no parking or storage units and the price table lists every unit with a size. Medians are shown because a few budgets are far above the rest.</p>
  ${cta(P)}
  </div>
</main>
` + FOOT(P);
}

// ---------- property taxes ----------
// Projected first-year real estate taxes from each plan's Schedule A table (data/re-taxes, from extract-re-taxes.mjs,
// which keeps only tables whose monthly and annual tax columns agree). Only plans whose table lists exactly the
// residential units count, so every row is a home. Per square foot comes from the units with a size (per_sf).
// All years are kept: few tables carry both tax columns and unit sizes, and the page shows the year range.
const reTax = [];
for (const f of await readdir(join(ROOT, "data", "re-taxes")).catch(() => [])) {
  const p = byId.get(f.replace(/\.json$/, ""));
  if (!p || !NYC(p) || !realPlan(p) || !p.accepted_date || !(p.units_residential > 0)) continue;
  const t = JSON.parse(await readFile(join(ROOT, "data", "re-taxes", f), "utf8"));
  if (t.units.length !== p.units_residential) continue;
  reTax.push({ ...p, perUnit: t.monthly_total / t.units.length, perSf: t.per_sf || null, ccSf: charged.find((c) => c.plan_id === p.plan_id)?.perSf || null });
}
reTax.sort((a, b) => b.accepted_date.localeCompare(a.accepted_date) || b.plan_id.localeCompare(a.plan_id));
const TAX_BINS = [[0, 0.25, "Under $0.25"], [0.25, 0.5, "$0.25–0.49"], [0.5, 0.75, "$0.50–0.74"], [0.75, 1, "$0.75–0.99"], [1, 1.25, "$1.00–1.24"], [1.25, Infinity, "$1.25 or more"]];
const quart = (vs, q) => { const s = [...vs].sort((a, b) => a - b), i = (s.length - 1) * q, lo = Math.floor(i); return s[lo] + (s[Math.ceil(i)] - s[lo]) * (i - lo); };

function propertyTaxesPage() {
  const P = "";
  const url = `${SITE_URL}/property-taxes.html`;
  const sfPlans = reTax.filter((p) => p.perSf), sfs = sfPlans.map((p) => p.perSf);
  const mid = median(sfs), mean = sfs.reduce((s, v) => s + v, 0) / sfs.length, unitMid = median(reTax.map((p) => p.perUnit));
  const since = reTax.at(-1).accepted_date;
  const both = sfPlans.filter((p) => p.ccSf);
  const title = "Property Taxes per Square Foot in New NYC Condos";
  const description = fitDesc(`Projected first-year real estate taxes in new NYC condos: a median ${usdSf(mid)} per square foot a month`,
    [` and ${usd(unitMid)} per unit, from the Schedule A tables in ${n(reTax.length)} offering plans`], ".");
  HOME.taxes = { href: "property-taxes.html", k: "Avg. property taxes", v: usd(avgOf(reTax.map((p) => p.perUnit))), u: "/month", s: `${usdSf(mean)} /SF` };

  // By building size, by year accepted and by borough: the median per square foot, with how many plans it rests on.
  const group = (key, order) => [...new Set(sfPlans.map(key))].map((k) => {
    const ps = sfPlans.filter((p) => key(p) === k);
    return { label: k, n: ps.length, v: median(ps.map((p) => p.perSf)) };
  }).sort(order);
  const sizes = SIZES.map(([a, b, label]) => {
    const all = reTax.filter((p) => p.units_residential >= a && p.units_residential <= b), sf = all.filter((p) => p.perSf).map((p) => p.perSf);
    return all.length ? { label, n: all.length, unit: median(all.map((p) => p.perUnit)), sf: median(sf), sfN: sf.length, lo: sf.length ? Math.min(...sf) : null, hi: sf.length ? Math.max(...sf) : null } : null;
  }).filter(Boolean);
  const sizeTable = `<div class="tscroll"><table class="dm"><thead><tr><th>Residential units</th><th>Plans</th><th>Per SF / month</th><th>Per unit / month</th><th>Lowest–highest per SF</th></tr></thead><tbody>${sizes.map((s) =>
    `<tr><td>${esc(s.label)}</td><td>${n(s.n)}</td><td>${s.sf != null ? `<strong>${usdSf(s.sf)}</strong><span class="sub">${plural(s.sfN, "plan")} with unit sizes</span>` : "—"}</td><td>${usd(s.unit)}</td><td>${s.sfN > 1 ? `${usdSf(s.lo)}–${usdSf(s.hi)}` : "—"}</td></tr>`).join("")}</tbody></table></div>`;
  const barRows = (rows, head) => { const max = Math.max(...rows.map((e) => e.v)); return `<div class="tscroll"><table class="bars"><thead><tr><th>${head}</th><th>Per SF / month</th><th aria-hidden="true"></th></tr></thead><tbody>${rows.map((e) =>
    `<tr title="${plural(e.n, "plan")}"><td>${esc(e.label)} (${plural(e.n, "plan")})</td><td>${usdSf(e.v)}</td><td class="bar" aria-hidden="true"><span style="width:${Math.max(1, Math.round(100 * e.v / max))}%"></span></td></tr>`).join("")}</tbody></table></div>`; };
  const yearTable = barRows(group((p) => p.accepted_date.slice(0, 4), (a, b) => b.label.localeCompare(a.label)).map((e) => ({ ...e, label: e.label === thisYear ? `${e.label} (to date)` : e.label })), "Year accepted");
  const boroTable = barRows(group((p) => boro(p.borough), (a, b) => b.v - a.v), "Borough");

  const bins = TAX_BINS.map(([a, b, label]) => [label, sfs.filter((v) => v >= a && v < b).length]);
  const binMax = Math.max(...bins.map((b) => b[1]));
  const histogram = `<figure class="chart">
    <div class="cols" role="img" aria-label="${esc(bins.map(([l, c]) => `${l}: ${plural(c, "plan")}`).join("; "))}">${bins.map(([label, c]) =>
      `<div class="col" title="${esc(label)}: ${plural(c, "plan")} (${Math.round(100 * c / sfs.length)}%)"><span class="v">${n(c)}</span><span class="b" style="height:${Math.max(1, Math.round(100 * c / binMax))}%"></span><span class="l">${esc(label)}</span></div>`).join("")}</div>
  </figure>`;

  const planTable = `<div class="tscroll"><table><thead><tr><th>Condominium</th><th>Units</th><th>Accepted</th><th>Taxes per SF / month</th><th>Taxes per unit / month</th><th>Common charges per SF / month</th></tr></thead><tbody>${reTax.map((p) =>
    `<tr><td><a href="buildings/${esc(fileFor(p))}">${esc(tc(p.name))}</a></td><td>${n(p.units_residential)}</td><td>${esc(day(p.accepted_date))}</td><td>${p.perSf ? `<strong>${usdSf(p.perSf)}</strong>` : "—"}</td><td>${usd(p.perUnit)}</td><td>${p.ccSf ? usdSf(p.ccSf) : "—"}</td></tr>`).join("")}</tbody></table></div>`;

  return HEAD(P, { image: OG_SITE, title, description, canonical: url }) + `
${ld({ "@context": "https://schema.org", "@type": "BreadcrumbList", itemListElement: [
    { "@type": "ListItem", position: 1, name: SITE_NAME, item: `${SITE_URL}/` },
    { "@type": "ListItem", position: 2, name: "Property taxes", item: url },
  ] })}
<main class="post approval split">
  <div class="aside">
  <h1>Property Taxes per Square Foot in New NYC Condos</h1>
  <p class="anote">The projected first-year real estate taxes in the Schedule A price table of ${n(reTax.length)} New York City condominium offering plans accepted since ${esc(day(since))}, ${n(sfPlans.length)} of them with unit sizes. These are the sponsor's projections, often based on an assessment made before construction is finished or with a tax abatement in place, so taxes can rise materially once the building is reassessed or the benefit phases out.</p>
  <div class="hero-stat">
    <p class="hs-k">Median property taxes per square foot</p>
    <p class="hs-v">${usdSf(mid)} <span>a month</span></p>
    <p class="hs-s">Average ${usdSf(mean)}; the middle half of plans fall between ${usdSf(quart(sfs, 0.25))} and ${usdSf(quart(sfs, 0.75))}.</p>
  </div>
  <dl class="glance">
    <div><dt>Per unit</dt><dd>${usd(unitMid)} a month<span class="sub">median, ${plural(reTax.length, "plan")}</span></dd></div>
    ${both.length >= 5 ? `<div><dt>Common charges, same buildings</dt><dd>${usdSf(median(both.map((p) => p.ccSf)))} a month<span class="sub">median per SF, ${plural(both.length, "plan")} with both; taxes ${usdSf(median(both.map((p) => p.perSf)))}</span></dd></div>` : ""}
    <div><dt>Plans with unit sizes</dt><dd>${n(sfPlans.length)}</dd></div>
  </dl>
  </div>
  <div class="amain">
  <h2>By Building Size</h2>
  ${sizeTable}

  <h2>How Taxes per Square Foot Are Spread</h2>
  ${histogram}

  <h2>By Year Accepted</h2>
  ${yearTable}

  <h2>By Borough</h2>
  ${boroTable}

  <h2>The ${n(reTax.length)} Plans Read</h2>
  ${planTable}

  <p class="src">Taxes are read from the plan's Schedule A only when the table gives each unit's projected real estate taxes both monthly and annually and the two agree, and the tax column can be told apart from the common charges using the Schedule B budget; tables that show abated and unabated taxes side by side are left out. Per square foot: the units' monthly taxes divided by their sizes in the same table, leaving out any unit whose size looks misread (a rate more than 2.5 times off the building's median). Per unit: the building's monthly total divided by its residential units. Common charges per square foot are from the <a href="common-charges.html">common charges</a> page, for plans accepted since ${esc(day(ccSince))}. Medians are shown because a few plans are far from the rest.</p>
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

// ---------- budget blog posts ----------
// The common charges and first-year budget posts quote the same recent plans as common-charges.html (`charged`),
// plus each budget's expense lines, the management line above, and the reserve and managing agent facts.
{
  const items = new Map((await all("schedule_b?select=plan_id,line_items&status=eq.ok")).map((r) => [r.plan_id, r.line_items || []]));
  const ids = new Set(charged.map((p) => p.plan_id));
  const pct = (v) => `${Math.round(100 * v)}%`;
  const ten = (v) => usd(Math.round(v / 10) * 10), hundred = (v) => usd(Math.round(v / 100) * 100);
  const big = (v) => v >= 1e6 ? `$${(v / 1e6).toFixed(1).replace(/\.0$/, "")}M` : usd(Math.round(v / 1000) * 1000);
  const BANDS = [[2, 6, "2–6"], [7, 12, "7–12"], [13, 30, "13–30"], [31, 100, "31–100"], [101, Infinity, "101+"]];
  const bands = BANDS.map(([a, b, label]) => ({ label, ps: charged.filter((p) => p.units_residential >= a && p.units_residential <= b) })).filter((x) => x.ps.length >= 5);
  const boros = [...count(charged, (p) => boro(p.borough))].filter(([, c]) => c >= 10).sort((a, b) => b[1] - a[1]).map(([b]) => ({ label: b, ps: charged.filter((p) => boro(p.borough) === b) }));
  const perMonth = (ps) => median(ps.map((p) => p.perUnit));
  const lowest = [...bands].sort((a, b) => perMonth(a.ps) - perMonth(b.ps))[0];
  // Expense lines by kind, first match wins; totals and income lines are skipped. Shares are of total expenses, where the plan has the line.
  const KINDS = [["mgmt", "Management fee", /management|managing agent/], ["elevator", "Elevator (where present)", /elevator/], ["insurance", "Insurance", /insurance/],
    ["water", "Water &amp; sewer", /water|sewer/], ["staff", "Staff &amp; cleaning (where present)", /payroll|salar|wage|labor|janitor|clean|porter|superintendent|doorm|staff/],
    ["reserve", "Reserve / contingency", /reserve|contingenc/], ["utilities", "Utilities (electric, gas, heat)", /electric|gas|heat|fuel|oil|utilit|cooling/],
    ["repairs", "Repairs &amp; maintenance", /repair|mainten/], ["legal", "Legal &amp; accounting", /legal|audit|account|professional/]];
  const shares = Object.fromEntries(KINDS.map(([k]) => [k, []]));
  for (const p of charged) {
    const acc = {};
    for (const it of items.get(p.plan_id) || []) {
      const name = String(it.item || "").toLowerCase().trim();
      if (!/expense/i.test(it.section || "") || /^total/.test(name) || !(Number(it.amount) > 0)) continue;
      const k = KINDS.find(([key, , re]) => re.test(name) && !(key === "water" && /heat|hot water/.test(name)));
      if (k) acc[k[0]] = (acc[k[0]] || 0) + Number(it.amount);
    }
    for (const k in acc) shares[k].push(acc[k] / p.annual);
  }
  const share = (k) => pct(median(shares[k]) || 0);
  const fees = charged.filter((p) => mgmtFee.has(p.plan_id)).map((p) => mgmtFee.get(p.plan_id).perUnit);
  const feeTotals = charged.filter((p) => mgmtFee.has(p.plan_id)).map((p) => mgmtFee.get(p.plan_id).perUnit * p.units_residential);
  const managers = (await all("facts?select=plan_id,value_text,value_num&field=eq.managing_agent&value_text=not.is.null")).filter((f) => ids.has(f.plan_id));
  const bySponsor = managers.filter((f) => /sponsor/i.test(f.value_text));
  const reserves = (await all("facts?select=plan_id,value_num&field=eq.reserve_fund&value_num=not.is.null")).filter((f) => ids.has(f.plan_id)).map((f) => Number(f.value_num));
  Object.assign(STATS, {
    bud_n: n(charged.length), bud_since: day(ccSince), bud_parsed: n(Math.floor(items.size / 100) * 100),
    bud_month: ten(perMonth(charged)), bud_year: hundred(12 * perMonth(charged)),
    bud_low_band: lowest.label, bud_low_month: ten(perMonth(lowest.ps)),
    bud_boro_months: boros.map((b) => `${b.label} ${ten(perMonth(b.ps))}`).join(", "),
    bud_boro_years: boros.map((b) => `${b.label} ${hundred(12 * perMonth(b.ps))}`).join(", "),
    bud_elevator: share("elevator"), bud_staff: share("staff"), bud_insurance: share("insurance"), bud_water: share("water"), bud_reserve: share("reserve"), bud_mgmt: share("mgmt"),
    bud_fee: hundred(median(feeTotals)), bud_fee_unit: ten(median(fees)),
    bud_sponsor_mgr: pct(bySponsor.length / managers.length), bud_sponsor_nofee: n(bySponsor.filter((f) => !(f.value_num > 0)).length), bud_sponsor_n: n(bySponsor.length),
    bud_reserve_median: hundred(median(reserves)), bud_reserve_none: pct(reserves.filter((v) => v === 0).length / reserves.length),
  });
  const row = (cells) => `<tr>${cells.map((c) => `<td>${c}</td>`).join("")}</tr>`;
  const table = (head, rows) => `<div class="tscroll"><table><thead><tr>${head.map((h) => `<th>${h}</th>`).join("")}</tr></thead><tbody>${rows.join("")}</tbody></table></div>`;
  TABLES.cc_benchmarks = () => table(["Group", "Per unit / month", "Plans"], [
    row(["All NYC plans", ten(perMonth(charged)), n(charged.length)]),
    ...boros.map((b) => row([esc(b.label), ten(perMonth(b.ps)), n(b.ps.length)])),
    ...bands.map((b) => row([`${b.label} units`, ten(perMonth(b.ps)), n(b.ps.length)]))]);
  TABLES.budget_by_size = () => table(["Building size (residential units)", "Median per unit / year", "Median total budget", "Plans"],
    bands.map((b) => row([b.label, hundred(12 * perMonth(b.ps)), big(median(b.ps.map((p) => p.annual))), n(b.ps.length)])));
  TABLES.budget_shares = () => table(["Line item", "Median share of budget", "Plans with the line"],
    KINDS.filter(([k]) => shares[k].length).sort((a, b) => median(shares[b[0]]) - median(shares[a[0]])).map(([k, label]) => row([label, share(k), n(shares[k].length)])));
}

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
    // A section whose only card doesn't match the search hides with it.
    document.querySelectorAll(".aself").forEach((s) => { s.hidden = !!q && !s.querySelector("details.agent:not([hidden])"); });
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
  const title = `Top NYC Condo Property Managers`;
  const description = withTop(`${n(groups.length)} property managers named in ${n(namedPlans)} NYC condo offering plans, with the buildings each manages and the first-year fee per unit.`, groups.slice(0, 3).map((g) => `${g.name} (${g.plans.length})`));
  const bldg = (p) => `<li><a href="buildings/${esc(fileFor(p))}">${esc(tc(p.name))}</a><span>${esc(tc(p.address))} · ${esc(boro(p.borough))}${p.units_residential != null ? ` · ${p.units_residential} units` : ""}${p.accepted_date ? ` · ${p.accepted_date.slice(0, 4)}` : ""}${feeText(p)}</span></li>`;
  const card = (g, i) => `<details class="agent" id="${esc(g.slug)}" data-name="${esc(g.name.toLowerCase())}"${more(i)}>
    <summary>${rank(i)}<span class="an">${g.plans.length >= PROFILE_MIN ? `<a href="managing-agents/${esc(g.slug)}.html">${esc(g.name)}</a>` : esc(g.name)}</span><span class="ac">${plural(g.plans.length, "building")}${g.fee != null ? `<span class="fee" title="Median first-year management fee per residential unit, from Schedule B">${perYear(g.fee)}/unit/yr</span>` : `<span class="fee" aria-hidden="true"></span>`}</span></summary>
    <ul class="dir">${g.plans.map(bldg).join("")}</ul>
    ${g.plans.length >= PROFILE_MIN ? `<p class="acts"><a class="btn primary" href="managing-agents/${esc(g.slug)}.html">${esc(g.name)} profile</a></p>` : ""}
  </details>`;
  selfPlans.sort((a, b) => (b.p.accepted_date || "").localeCompare(a.p.accepted_date || ""));
  const selfRow = ({ p, as }) => `<li><a href="buildings/${esc(fileFor(p))}">${esc(tc(p.name))}</a><span>${esc(as)} · ${esc(boro(p.borough))}${p.units_residential != null ? ` · ${p.units_residential} units` : ""}${p.accepted_date ? ` · ${p.accepted_date.slice(0, 4)}` : ""}</span></li>`;
  return HEAD(P, { image: OG_SITE, title, description, canonical: url }) + `
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
  ${selfPlans.length ? `<section class="aself"><h2>Managed by the Sponsor</h2>
  <p>In these ${n(selfPlans.length)} plans no outside company is hired: the sponsor, a company tied to it, or the condo board manages the building, often at no fee for the first year.</p>
  <details class="agent" data-name="sponsor self-managed">
    <summary><span class="an">Sponsor or board managed</span><span class="ac">${plural(selfPlans.length, "building")}</span></summary>
    <ul class="dir">${selfPlans.map(selfRow).join("")}</ul>
  </details></section>` : ""}
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
  const title = `Top NYC Condo Offering Plan Attorneys`;
  const description = withTop(`The ${top.length} law firms named most often as sponsor's counsel in NYC condo offering plans, from the NY Attorney General's records.`, top.slice(0, 3).map((f) => `${tc(f.name)} (${f.plans.length})`));
  const bldg = (p) => `<li><a href="buildings/${esc(fileFor(p))}">${esc(tc(p.name))}</a><span>${esc(tc(p.address))} · ${esc(boro(p.borough))}${p.units_residential != null ? ` · ${p.units_residential} units` : ""}${p.accepted_date ? ` · ${p.accepted_date.slice(0, 4)}` : ""}</span></li>`;
  const span = (f) => f.years.length ? (f.years[0] === f.years.at(-1) ? f.years[0] : `${f.years[0]}–${f.years.at(-1)}`) : "";
  const card = (f, i) => `<details class="agent" id="${esc(f.slug)}" data-name="${esc(tc(f.name).toLowerCase())}"${more(i)}>
    <summary>${rank(i)}<span class="an">${f.plans.length >= PROFILE_MIN ? `<a href="offering-plan-attorneys/${esc(f.slug)}.html">${esc(tc(f.name))}</a>` : esc(tc(f.name))}</span><span class="ac">${plural(f.plans.length, "plan")}${span(f) ? `<span class="yrs" title="Years the plans were accepted for filing">${span(f)}</span>` : `<span class="yrs" aria-hidden="true"></span>`}</span></summary>
    ${f.plans.length > SHOWN ? `<p class="faint">The ${SHOWN} most recent of ${n(f.plans.length)}.</p>` : ""}
    <ul class="dir">${f.plans.slice(0, SHOWN).map(bldg).join("")}</ul>
    ${f.plans.length >= PROFILE_MIN ? `<p class="acts"><a class="btn primary" href="offering-plan-attorneys/${esc(f.slug)}.html">${esc(tc(f.name))} profile</a></p>` : ""}
  </details>`;
  return HEAD(P, { image: OG_SITE, title, description, canonical: url }) + `
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

// ---------- architects and selling agents ----------
// Named in the offering plan text (facts.architect, facts.selling_agent), grouped in pros.mjs. Selling agents skip plans
// where the sponsor or an affiliate sells its own units.
const ARCHITECTS = groupPros(await all("facts?select=plan_id,value_text&field=eq.architect&value_text=not.is.null&order=plan_id"), byId, "architect");
const SELLERS = groupPros(await all("facts?select=plan_id,value_text&field=eq.selling_agent&value_text=not.is.null&order=plan_id"), byId, "selling_agent");
// Who prepared each plan's first-year real estate tax estimate, read from the plan text by extract-tax-preparers.mjs.
const TAX_PREP = JSON.parse(await readFile(join(ROOT, "data", "tax-preparers.json"), "utf8").catch(() => "{}"));
const TAXERS = groupPros(Object.entries(TAX_PREP).map(([plan_id, t]) => ({ plan_id, value_text: t.name })), byId, "tax_preparer");
// The development company behind each sponsor, read from the plan text by extract-developer-companies.mjs with the page
// and sentence naming it, and the sponsor's principals (sponsor_principals), shown with each building.
const DEVELOPERS = groupCompanies(JSON.parse(await readFile(join(ROOT, "data", "developer-companies.json"), "utf8").catch(() => "{}")), byId);
const PRINCIPALS = byPlan(groupPrincipals(await all("sponsor_principals?select=plan_id,name,kind,role,file_id,page_no,quote&order=id"), byId), false);
const pdfById = new Map((await all("documents?select=file_id,pdf_url&pdf_url=not.is.null&order=file_id")).map((d) => [d.file_id, d.pdf_url]));
const PRO_DIRS = {
  developer: {
    groups: DEVELOPERS, dir: "developers", crumb: "Developers", noun: "developers", find: "Find a developer",
    title: "Top NYC Condo Developers by Building",
    h1: "Top NYC Condo Developers",
    listName: "Development companies most often behind the sponsor of NYC condominium offering plans",
    description: (g, planCount) => withTop(`${n(g.length)} development companies behind the sponsors of ${n(planCount)} NYC condominium offering plans, with the buildings each one developed.`, g.slice(0, 3).map((x) => `${x.name} (${x.plans.length})`)),
    note: (g, planCount) => `The development company behind the sponsor of each New York City condominium offering plan. The sponsor, which develops and sells the building, is usually a company formed for that one building; the plan names the firm it belongs to, or whose principals run it. ${n(g.length)} companies across ${n(planCount)} buildings. Ranked by the number of offering plans naming each company, not by size or quality.`,
    src: "Read from the offering plan's text, where it says whose affiliate the sponsor is, who its principals and members are and what firms they run; each profile cites the page. A firm's arms are counted together (Related's sales and management companies with Related), and a firm named only in a principal's past isn't counted. Many plans name only people and one-building companies, so they aren't included, nor are plans whose pages aren't searchable yet.",
  },
  architect: {
    groups: ARCHITECTS, dir: "architects", crumb: "Architects", noun: "architects", find: "Find an architect",
    title: "Top NYC Condo Building Architects",
    h1: "Top NYC Condo Architects",
    listName: "Architects most often named in NYC condominium offering plans",
    description: (g, planCount) => withTop(`${n(g.length)} architects named in ${n(planCount)} NYC condominium offering plans, with the buildings each one designed.`, g.slice(0, 3).map((x) => `${x.name} (${x.plans.length})`)),
    note: (g, planCount) => `The architect each New York City condominium offering plan names for the building. ${n(g.length)} architects across ${n(planCount)} buildings. Ranked by the number of offering plans naming each architect, not by quality.`,
    src: "Named in the offering plan as filed; for conversions and rehabs this is often the architect who certified the building's condition rather than its designer. Different spellings of one firm's name are counted together, and a person named alone is counted apart from their firm unless the plans name them together. Plans whose pages aren't searchable yet, or that don't name an architect, aren't included.",
  },
  seller: {
    groups: SELLERS, dir: "selling-agents", crumb: "Sales teams", noun: "sales teams", find: "Find a brokerage",
    title: "Top NYC Condo Building Sales Teams",
    h1: "Top NYC Condo Building Sales Teams",
    listName: "Sales teams (selling agents) most often named in NYC condominium offering plans",
    description: (g, planCount) => withTop(`${n(g.length)} brokerages named as selling agent in ${n(planCount)} NYC condo offering plans, with the new developments each was hired to sell.`, g.slice(0, 3).map((x) => `${x.name} (${x.plans.length})`)),
    note: (g, planCount) => `The selling agent each New York City condominium offering plan names to market and sell the units for the sponsor. ${n(g.length)} brokerages across ${n(planCount)} buildings. Ranked by the number of offering plans naming each firm, not by sales or quality.`,
    src: "Named in the offering plan as filed; a sponsor can change selling agents later, so this may not reflect who is selling a building today. Plans where the sponsor or an affiliate sells its own units aren't counted. Different spellings of one brokerage's name are counted together. Plans whose pages aren't searchable yet, or that don't name a selling agent, aren't included.",
  },
  taxer: {
    groups: TAXERS, dir: "tax-consultants", crumb: "Tax consultants", noun: "firms", find: "Find a firm",
    title: "Top NYC Condo Tax Opinion Firms",
    h1: "Top NYC Condo Real Estate Tax Consultants",
    listName: "Firms most often named as preparing the real estate tax estimate in NYC condominium offering plans",
    description: (g, planCount) => withTop(`${n(g.length)} firms that prepared the real estate tax estimate in ${n(planCount)} NYC condo offering plans, with the buildings for each.`, g.slice(0, 3).map((x) => `${x.name} (${x.plans.length})`)),
    note: (g, planCount) => `The firm each New York City condominium offering plan names as preparing its estimate of the building's first-year real estate taxes, usually the sponsor's tax certiorari counsel or a property tax consultant. The estimate sets the taxes shown for each unit in Schedule A. ${n(g.length)} firms across ${n(planCount)} buildings. Ranked by the number of offering plans naming each firm, not by accuracy or quality.`,
    src: "Read from the offering plan's text, where the plan names who prepared its real estate tax projection (the letter is usually in Part II). The New York City Department of Finance sets the actual assessment, which can differ from the estimate. Plans where the estimate is prepared by the sponsor or sponsor's counsel without naming a tax firm, or whose pages aren't searchable yet, aren't included. Different spellings of one firm's name are counted together; a firm that changed its name may appear more than once.",
  },
};
function proDirPage(kind) {
  const c = PRO_DIRS[kind];
  const P = "";
  const url = `${SITE_URL}/${c.dir}.html`;
  const all = c.groups, top = all.slice(0, TOP);
  const planCount = new Set(all.flatMap((g) => g.plans.map((p) => p.plan_id))).size;
  const description = c.description(all, planCount);
  const bldg = (p) => `<li><a href="buildings/${esc(fileFor(p))}">${esc(tc(p.name))}</a><span>${esc(tc(p.address))} · ${esc(boro(p.borough))}${p.units_residential != null ? ` · ${p.units_residential} units` : ""}${p.accepted_date ? ` · ${p.accepted_date.slice(0, 4)}` : ""}</span></li>`;
  const card = (g, i) => `<details class="agent" id="${esc(g.slug)}" data-name="${esc(g.name.toLowerCase())}"${more(i)}>
    <summary>${rank(i)}<span class="an">${g.plans.length >= PROFILE_MIN ? `<a href="${c.dir}/${esc(g.slug)}.html">${esc(g.name)}</a>` : esc(g.name)}</span><span class="ac">${plural(g.plans.length, "building")}${yearSpan(g.plans) ? `<span class="yrs" title="Years the plans were accepted for filing">${yearSpan(g.plans)}</span>` : `<span class="yrs" aria-hidden="true"></span>`}</span></summary>
    ${g.plans.length > SHOWN ? `<p class="faint">The ${SHOWN} most recent of ${n(g.plans.length)}.</p>` : ""}
    <ul class="dir">${g.plans.slice(0, SHOWN).map(bldg).join("")}</ul>
    ${g.plans.length >= PROFILE_MIN ? `<p class="acts"><a class="btn primary" href="${c.dir}/${esc(g.slug)}.html">${esc(g.name)} profile</a></p>` : ""}
  </details>`;
  return HEAD(P, { image: OG_SITE, title: c.title, description, canonical: url }) + `
${ld({ "@context": "https://schema.org", "@type": "ItemList", name: c.listName, url, numberOfItems: top.length,
    itemListOrder: "https://schema.org/ItemListOrderDescending",
    itemListElement: top.map((g, i) => ({ "@type": "ListItem", position: i + 1, name: g.name, url: g.plans.length >= PROFILE_MIN ? `${SITE_URL}/${c.dir}/${g.slug}.html` : `${url}#${g.slug}` })) })}
${ld({ "@context": "https://schema.org", "@type": "BreadcrumbList", itemListElement: [
    { "@type": "ListItem", position: 1, name: SITE_NAME, item: `${SITE_URL}/` },
    { "@type": "ListItem", position: 2, name: c.crumb, item: url },
  ] })}
<main class="post agents split">
  <div class="aside">
  <h1>${esc(c.h1)}</h1>
  <p class="anote">${esc(c.note(all, planCount))}</p>
  <label class="afind"><span>${esc(c.find)}</span><input id="afind" type="search" placeholder="Type a name" autocomplete="off"></label>
  </div>
  <div class="amain">
  <h2>${esc(c.h1.replace(/^Top /, `Top ${Math.min(TOP, all.length)} `))}</h2>
  <div class="agents-list">${all.map(card).join("\n")}</div>
  ${moreButton(all.length, c.noun)}
  <p class="src">${esc(c.src)}</p>
  ${cta(P)}
  </div>
</main>
${listScript}
` + FOOT(P);
}

// ---------- profile pages ----------
// One page per property manager (managing-agents/<slug>.html), law firm (offering-plan-attorneys/<slug>.html),
// architect (architects/<slug>.html) and selling agent (selling-agents/<slug>.html) named in at least PROFILE_MIN NYC plans: the buildings, a few key numbers, and a sidebar of the most similar firms.
// Websites come only from data/websites.json ({"managers"|"attorneys"|"architects"|"sellers": {slug: url}}), each checked
// against the site's own branding; a firm without an entry gets no website link.
const SITES = JSON.parse(await readFile(join(ROOT, "data", "websites.json"), "utf8").catch(() => "{}"));
// Firm logos (data/logos.json, from those websites) have share cards in img/og/<dir>/, made by build-og-images.mjs.
const LOGOS = JSON.parse(await readFile(join(ROOT, "data", "logos.json"), "utf8").catch(() => "{}"));
const LOGO_KIND = { manager: "managers", attorney: "attorneys", architect: "architects", seller: "sellers", taxer: "taxers", developer: "developers" };
const offerPrice = (p) => money(p.meta?.plan?.["Current Price"]) || money(p.meta?.plan?.["Initial Price"]);
const sumUnits = (list) => list.reduce((s, p) => s + (p.units_residential || 0), 0);
const yearSpan = (list) => { const ys = list.map((p) => p.accepted_date?.slice(0, 4)).filter(Boolean).sort(); return ys.length ? (ys[0] === ys.at(-1) ? ys[0] : `${ys[0]}–${ys.at(-1)}`) : ""; };

// Similarity on log scales, so 3 vs 6 buildings is as far apart as 30 vs 60. A dimension either side lacks costs a flat 1.
const lg = (v) => Math.log1p(v);
const distance = (a, b) => a.dims.reduce((s, v, i) => s + (v != null && b.dims[i] != null ? Math.abs(lg(v) - lg(b.dims[i])) : 1), 0);
const similarTo = (x, pool, k = 6) => pool.filter((y) => y !== x).map((y) => [y, distance(x, y)]).sort((a, b) => a[1] - b[1] || b[0].plans.length - a[0].plans.length).slice(0, k).map(([y]) => y);

// Managers: buildings, residential units, median first-year fee per unit. Attorneys: plans, units, median offering $/unit.
const MGR = AGENTS.filter((g) => g.plans.length >= PROFILE_MIN).map((g) => {
  const units = sumUnits(g.plans);
  return { ...g, display: g.name, units, dims: [g.plans.length, units, g.fee], dir: "managing-agents", site: SITES.managers?.[g.slug] };
});
// Attorneys, architects and selling agents: plans, units, median offering $/unit.
const byPrice = (list, dir, sites, display = (x) => x.name) => list.filter((f) => f.plans.length >= PROFILE_MIN).map((f) => {
  const units = sumUnits(f.plans);
  const perUnit = median(f.plans.map((p) => offerPrice(p) && p.units_residential ? offerPrice(p) / p.units_residential : null).filter((v) => v != null));
  return { ...f, display: display(f), units, perUnit, dims: [f.plans.length, units, perUnit], dir, site: sites?.[f.slug] };
});
const ATT = byPrice(FIRMS, "offering-plan-attorneys", SITES.attorneys, (f) => tc(f.name));
const ARCH = byPrice(ARCHITECTS, "architects", SITES.architects);
const SELL = byPrice(SELLERS, "selling-agents", SITES.sellers);
const TAX = byPrice(TAXERS, "tax-consultants", SITES.taxers);
const DEV = byPrice(DEVELOPERS, "developers", SITES.developers);
// What differs between the four $/unit profile kinds.
const ROLE = {
  developer: { pool: DEV, list: "Developers", as: "the company behind the sponsor", on: "in", other: "company", Other: "Developers", count: "building", type: "Organization",
    title: "NYC Condo Developers", short: "Condo Developers", source: "in the plan's text; each building below cites the page. The sponsor, which develops and sells the condominium, is usually a company formed for the one building." },
  attorney: { pool: ATT, list: "Offering plan attorneys", as: "sponsor's counsel", on: "on", other: "firm", Other: "Firms", count: "plan", type: "LegalService",
    title: "NYC Offering Plan Attorneys", short: "Offering Plan Attorneys", source: "as recorded by the Attorney General. This may not reflect current representation." },
  architect: { pool: ARCH, list: "Architects", as: "the architect", on: "in", other: "architect", Other: "Architects", count: "building", type: "ProfessionalService",
    title: "NYC Condo Building Architects", short: "Condo Building Architects", source: "in the plan's text. For conversions this is often the architect who certified the existing building." },
  seller: { pool: SELL, list: "Sales teams", as: "selling agent", on: "in", other: "brokerage", Other: "Brokerages", count: "building", type: "RealEstateAgent",
    title: "NYC Condo Building Sales Team", short: "Condo Sales Team", source: "in the plan's text. A sponsor can change selling agents, so this may not reflect who is selling each building today." },
  taxer: { pool: TAX, list: "Tax consultants", as: "preparing the real estate tax estimate", on: "in", other: "firm", Other: "Firms", count: "plan", type: "ProfessionalService",
    title: "NYC Condo Tax Opinion Letter", short: "Condo Tax Opinion Letter", source: "in the plan's text. The estimate projects the building's first-year real estate taxes; the Department of Finance sets the actual assessment." },
};
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
  const mgr = kind === "manager", r = ROLE[kind];
  const url = `${SITE_URL}/${x.dir}/${x.slug}.html`;
  const listUrl = `${SITE_URL}/${x.dir}.html`;
  const listName = mgr ? "Property managers" : r.list;
  const nyc = x.plans.length;
  const span = yearSpan(x.plans);
  const named = x.plans.slice(0, 3).map((p) => tc(p.name));
  const pricing = mgr ? x.fee : x.perUnit;
  const pricingText = pricing == null ? null : mgr ? `${perYear(pricing)}/unit/yr` : fmtMoney(pricing);
  const title = mgr
    ? firstFit(`${x.display} | NYC Condo Property Managers`, `${x.display} | Condo Property Managers`, x.display)
    : firstFit(`${x.display} | ${r.title}`, `${x.display} | ${r.short}`, x.display);
  // As many of the first three building names as fit, then (managers) the fee if there's room.
  const including = named.map((s, i) => (i ? ", " : ", including ") + s);
  const description = mgr
    ? fitDesc(fitDesc(`${x.display} is named as first-year managing agent in ${plural(nyc, "NYC condo offering plan")}${x.units ? ` (${plural(x.units, "unit")})` : ""}`, including, "."),
      [pricingText ? ` Median fee: ${pricingText}.` : ""])
    : fitDesc(`${x.display} is named as ${r.as} ${r.on} ${plural(nyc, "NYC condo offering plan")}${span ? ` (${span})` : ""}`, including, ".");
  const dash = `<span class="faint">—</span>`;

  const row = (p) => {
    const u = p.units_residential, pr = offerPrice(p), fee = mgmtFee.get(p.plan_id)?.perUnit;
    const last = mgr ? (fee != null ? perYear(fee) : dash) : (pr && u ? esc(fmtMoney(pr / u)) : dash);
    // Developers: the sponsor company, and the page naming this person with the sentence on hover.
    const cite = x.cites?.get(p.plan_id), pdf = cite && pdfById.get(cite.file_id);
    const people = kind === "developer" ? (PRINCIPALS.get(p.plan_id) || []).map((d) => d.name) : [];
    const named = cite ? `<span class="sub">${p.sponsor ? `Sponsor: ${esc(tc(p.sponsor))} · ` : ""}${people.length ? `Principals: ${esc(people.join(", "))} · ` : ""}${pdf && cite.page_no ? `<a href="${esc(pdf)}#page=${cite.page_no}" rel="noopener" title="${esc(cite.quote)}">Named on p. ${cite.page_no} ↗</a>` : `<span title="${esc(cite.quote)}">Named in the plan</span>`}</span>` : "";
    return `<tr id="${esc(p.plan_id.toLowerCase())}"><td><a href="${P}buildings/${esc(fileFor(p))}">${esc(tc(p.name))}</a><span class="sub">${esc(tc(p.address))} · ${esc(boro(p.borough))}${KIND[p.construction] ? ` · ${KIND[p.construction]}` : ""}</span>${named}</td>` +
      `<td class="nowrap">${p.accepted_date ? esc(p.accepted_date.slice(0, 4)) : dash}</td><td class="num">${u ?? dash}</td><td class="num">${last}</td></tr>`;
  };
  const pool = mgr ? MGR : r.pool;
  const sims = similarTo(x, pool);
  const simRow = (y) => {
    const pv = mgr ? (y.fee != null ? `${perYear(y.fee)}/unit/yr` : "") : (y.perUnit != null ? `${fmtMoney(y.perUnit)}/unit` : "");
    return `<li><a href="${esc(y.slug)}.html">${esc(y.display)}</a><span>${plural(y.plans.length, mgr ? "building" : r.count)} · ${plural(y.units, "unit")}${pv ? ` · ${esc(pv)}` : ""}</span></li>`;
  };
  const org = { "@type": mgr ? "Organization" : r.type, name: x.display, ...(x.site ? { url: x.site, sameAs: [x.site] } : {}), areaServed: "New York City" };

  const logo = LOGOS[LOGO_KIND[kind]]?.[x.slug];
  const image = logo ? `${SITE_URL}/img/og/${x.dir}/${x.slug}.png` : OG_SITE;
  return HEAD(P, { image, imageAlt: logo ? `${x.display} logo` : undefined, title, description, canonical: url }) + `
${ld({ "@context": "https://schema.org", "@type": "ProfilePage", name: title.replace(/ \| .*$/, ""), url, description, mainEntity: org })}
${ld({ "@context": "https://schema.org", "@type": "BreadcrumbList", itemListElement: [
    { "@type": "ListItem", position: 1, name: SITE_NAME, item: `${SITE_URL}/` },
    { "@type": "ListItem", position: 2, name: listName, item: listUrl },
    { "@type": "ListItem", position: 3, name: x.display, item: url },
  ] })}
<main class="post agents profile">
  <nav class="crumbs" aria-label="Breadcrumb"><a href="${P}index.html">${SITE_NAME}</a> › <a href="${P}${x.dir}.html">${listName}</a></nav>
  <div class="ptop">
  <div class="pinfo">
  <div class="pname">
  ${logo ? `<div class="flogo-w"><div class="flogo${logo.bg === "dark" ? " dark" : ""}"><img src="${P}img/logos/${x.dir}/${x.slug}.png" alt="${esc(x.display)} logo"></div></div>` : ""}
  <h1>${esc(x.display)}${x.site ? `&nbsp;<a class="fsite" href="${esc(x.site)}" target="_blank" rel="noopener" title="${esc(hostOf(x.site))}" aria-label="${esc(x.display)} website (${esc(hostOf(x.site))})">🔗</a>` : ""}</h1>
  </div>
  <p class="anote">${mgr
    ? `Named as the first-year managing agent in ${plural(nyc, "New York City condominium offering plan")}. The board can change managers after the first year, so this may not reflect who manages each building today.`
    : `Named as ${r.as} ${r.on} ${plural(nyc, "New York City condominium offering plan")}, ${r.source}`}</p>
  <dl class="glance">
    <div><dt>${mgr ? "Buildings" : r.count === "plan" ? "Plans" : "Buildings"}</dt><dd>${n(nyc)}</dd></div>
    <div><dt>Residential units</dt><dd>${x.units ? n(x.units) : "—"}</dd></div>
    <div><dt>${mgr ? "Median fee" : "Median $/unit"}</dt><dd>${pricingText ? esc(pricingText) : "—"}</dd></div>
    <div><dt>${span.includes("–") ? "Years" : "Year"}</dt><dd>${span || "—"}</dd></div>
  </dl>
  </div>
  ${plansMap(x.plans, `Map of the NYC condo buildings in plans naming ${x.display}`)}
  </div>
  <div class="pbottom">
  <div class="amain">
  <div class="tscroll"><table class="ftable"><thead><tr><th>Condominium</th><th>Accepted</th><th class="num">Units</th><th class="num">${mgr ? "Fee/unit/yr" : "$/unit"}</th></tr></thead><tbody>${x.plans.map(row).join("")}</tbody></table></div>
  <p class="src">${mgr
    ? "The fee is the management line of each plan's Schedule B first-year budget divided by its residential units; — means the budget hasn't been read or doesn't break it out. The median fee is across the buildings with a figure."
    : "$/unit is the offering price on the AG record divided by the residential units; the median is across the plans with both."} Different spellings of one ${mgr ? "company" : r.other}'s name are counted together.</p>
  ${cta(P)}
  </div>
  ${sims.length ? `<aside class="sims" aria-label="Similar ${mgr ? "managers" : r.other + "s"}"><h2>Similar ${mgr ? "Managers" : r.Other}</h2>
  <p class="anote">Closest in ${mgr ? "buildings" : r.count + "s"}, residential units and ${mgr ? "management fee per unit" : "offering price per unit"}.</p>
  <ul class="dir">${sims.map(simRow).join("")}</ul></aside>` : ""}
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
    // FAQ answers are the <details><summary>Q</summary><p>A</p>… blocks on the page, so the markup can't drift from the text. The masthead Data dropdown is also a <details>; skip it.
    const qa = [...html.matchAll(/<details(?![^>]*datamenu)[^>]*>\s*<summary>([\s\S]*?)<\/summary>([\s\S]*?)<\/details>/g)]
      .map(([, q, a]) => ({ "@type": "Question", name: unhtml(q), acceptedAnswer: { "@type": "Answer", text: unhtml(a) } }));
    if (qa.length) blocks.push({ "@context": "https://schema.org", "@type": "FAQPage", mainEntity: qa });
  }
  if (file !== "index.html") {
    blocks.push({ "@context": "https://schema.org", "@type": "BreadcrumbList", itemListElement: [
      { "@type": "ListItem", position: 1, name: SITE_NAME, item: `${SITE_URL}/` },
      { "@type": "ListItem", position: 2, name: title.replace(/^The Condo Book Project /, "").replace(/ The Condo Book Project$/, ""), item: canonical },
    ] });
  }
  const block = `<!-- seo -->\n${SEO("", { title, description, canonical, image: OG_SITE })}\n${blocks.map(ld).join("\n")}${blocks.length ? "\n" : ""}<!-- /seo -->`;
  let out = html.replace(/<!-- seo -->[\s\S]*?<!-- \/seo -->/, () => block);
  if (file === "index.html") {
    if (!/<!-- stats -->[\s\S]*?<!-- \/stats -->/.test(out)) throw new Error("index.html: missing <!-- stats --> markers");
    const cells = [HOME.approval, HOME.charges, HOME.taxes].map((c) =>
      `<a class="stat" href="${c.href}"><span class="k">${esc(c.k)}</span><span class="v">${esc(c.v)} <small>${esc(c.u)}</small></span>${c.s ? `<span class="s">${esc(c.s)}</span>` : ""}</a>`);
    out = out.replace(/<!-- stats -->[\s\S]*?<!-- \/stats -->/, () => `<!-- stats -->\n      ${cells.join("\n      ")}\n      <!-- /stats -->`);
  }
  await writeFile(join(ROOT, file), out);
}

// ---------- write ----------
await mkdir(join(ROOT, "blog"), { recursive: true });
for (const post of posts) await writeFile(join(ROOT, "blog", post.slug + ".html"), postPage(post));
await writeFile(join(ROOT, "blog", "index.html"), blogIndex());
await writeFile(join(ROOT, "new-condo-filings.html"), filingsPage());
await writeFile(join(ROOT, "time-to-approval.html"), approvalPage());
await writeFile(join(ROOT, "common-charges.html"), commonChargesPage());
await writeFile(join(ROOT, "property-taxes.html"), propertyTaxesPage());
await writeFile(join(ROOT, "managing-agents.html"), agentsPage());
await writeFile(join(ROOT, "offering-plan-attorneys.html"), attorneysPage());
await writeFile(join(ROOT, "developers.html"), proDirPage("developer"));
await writeFile(join(ROOT, "architects.html"), proDirPage("architect"));
await writeFile(join(ROOT, "selling-agents.html"), proDirPage("seller"));
await writeFile(join(ROOT, "tax-consultants.html"), proDirPage("taxer"));
const PROFILE_DIRS = ["developers", "managing-agents", "offering-plan-attorneys", "architects", "selling-agents", "tax-consultants"];
// The last build's profiles and the buildings each linked to, so a page that goes away (firms merged, or a new filing
// changes the name shown) can redirect to the profile that has its buildings now.
const oldProfiles = [];
for (const dir of PROFILE_DIRS) for (const f of (await readdir(join(ROOT, dir)).catch(() => [])).filter((f) => f.endsWith(".html"))) {
  const html = await readFile(join(ROOT, dir, f), "utf8");
  oldProfiles.push({ path: `/${dir}/${f}`, dir, plans: new Set([...html.matchAll(/buildings\/[^"]*-(c[dc]\d+)\.html/g)].map((m) => m[1].toUpperCase())) });
}

// ---------- redirects ----------
// Written before the profile directories are cleared, so a build that fails partway still has them.
// vercel.json keeps a permanent redirect for every profile URL that ever went away: to the profile sharing the most of
// its buildings, or to the directory when no profile has any. Older redirects follow their destination if it moved,
// and are dropped once their URL is a page again. Redirects outside the profile directories are left as they are.
const live = new Map([...DEV, ...MGR, ...ATT, ...ARCH, ...SELL, ...TAX].map((x) => [`/${x.dir}/${x.slug}.html`, x]));
const moved = new Map();
for (const o of oldProfiles) {
  if (live.has(o.path)) continue;
  let best = null, shared = 0;
  for (const [path, x] of live) {
    if (x.dir !== o.dir) continue;
    const n = x.plans.filter((p) => o.plans.has(p.plan_id)).length;
    if (n > shared) { best = path; shared = n; }
  }
  moved.set(o.path, best || `/${o.dir}.html`);
}
const VERCEL = join(ROOT, "vercel.json");
const vercel = JSON.parse(await readFile(VERCEL, "utf8").catch(() => "{}"));
const isPro = (path) => PROFILE_DIRS.some((d) => path.startsWith(`/${d}/`));
const redirects = new Map();
for (const r of vercel.redirects || []) redirects.set(r.source, r);
for (const [source, destination] of moved) redirects.set(source, { source, destination, permanent: true });
for (const [source, r] of redirects) {
  if (!isPro(source)) continue;
  if (live.has(source)) { redirects.delete(source); continue; }
  if (moved.has(r.destination)) r.destination = moved.get(r.destination);
}
vercel.redirects = [...redirects.values()].sort((a, b) => a.source.localeCompare(b.source));
const { redirects: rs, ...rest } = vercel;
const restJson = JSON.stringify(rest, null, 2).slice(1, -2).trim();
await writeFile(VERCEL, `{\n${restJson ? `  ${restJson},\n` : ""}  "redirects": [\n${rs.map((r) => `    ${JSON.stringify(r).replace(/":/g, "\": ").replace(/,"/g, ", \"")}`).join(",\n")}\n  ]\n}\n`);

for (const dir of PROFILE_DIRS) {
  // Start clean so a firm that drops below PROFILE_MIN or is regrouped doesn't leave a stale page behind.
  await rm(join(ROOT, dir), { recursive: true, force: true });
  await mkdir(join(ROOT, dir), { recursive: true });
}
for (const x of MGR) await writeFile(join(ROOT, "managing-agents", x.slug + ".html"), profilePage(x, "manager"));
for (const x of ATT) await writeFile(join(ROOT, "offering-plan-attorneys", x.slug + ".html"), profilePage(x, "attorney"));
for (const x of ARCH) await writeFile(join(ROOT, "architects", x.slug + ".html"), profilePage(x, "architect"));
for (const x of SELL) await writeFile(join(ROOT, "selling-agents", x.slug + ".html"), profilePage(x, "seller"));
for (const x of TAX) await writeFile(join(ROOT, "tax-consultants", x.slug + ".html"), profilePage(x, "taxer"));
for (const x of DEV) await writeFile(join(ROOT, "developers", x.slug + ".html"), profilePage(x, "developer"));
for (const [file, path] of Object.entries(STATIC)) await stampStatic(file, path);

const pageUrls = [["", TODAY], ["about.html"], ["faq.html", TODAY], ["new-condo-filings.html", TODAY], ["time-to-approval.html", TODAY], ["common-charges.html", TODAY], ["property-taxes.html", TODAY], ["developers.html", TODAY], ["managing-agents.html", TODAY], ["offering-plan-attorneys.html", TODAY], ["architects.html", TODAY], ["selling-agents.html", TODAY], ["tax-consultants.html", TODAY], ["blog/", TODAY], ["terms.html"], ["privacy.html"], ["disclaimers.html"],
  ...[...DEV, ...MGR, ...ATT, ...ARCH, ...SELL, ...TAX].map((x) => [`${x.dir}/${x.slug}.html`, TODAY]),
  ...posts.map((q) => [`blog/${q.slug}.html`, q.updated || q.published])];
await writeFile(join(ROOT, "sitemap-pages.xml"), urlset(pageUrls));
await writeFile(join(ROOT, "sitemap.xml"), `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap><loc>${SITE_URL}/sitemap-pages.xml</loc><lastmod>${TODAY}</lastmod></sitemap>
  <sitemap><loc>${SITE_URL}/sitemap-buildings.xml</loc></sitemap>
</sitemapindex>
`);
await writeFile(join(ROOT, "robots.txt"), `User-agent: *\nAllow: /\n\nSitemap: ${SITE_URL}/sitemap.xml\n`);
console.log(`${posts.length} posts, blog index, new-condo-filings.html, time-to-approval.html, common-charges.html, property-taxes.html, developers.html, managing-agents.html, offering-plan-attorneys.html, architects.html, selling-agents.html, tax-consultants.html, ${DEV.length} developer, ${MGR.length} manager, ${ATT.length} attorney, ${ARCH.length} architect, ${SELL.length} selling agent and ${TAX.length} tax consultant profiles, ${Object.keys(STATIC).length} stamped pages, sitemap-pages.xml with ${pageUrls.length} URLs`);
