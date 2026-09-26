// Shared by the page generators: data access, text helpers and the site chrome (head, menu, footer).
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const SB = "https://dvywgltjqpntldlztapu.supabase.co";
export const KEY = "sb_publishable_At7fyv-9Vp7ByNP3AXHZ7g_qphsg6Rw";
export const SITE_URL = (process.env.SITE_URL || "https://www.condobooknyc.com").replace(/\/$/, "");
export const AG = "https://offeringplandatasearch.ag.ny.gov/REF/planFormServlet?planId=";
export const ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
export const OUT = join(ROOT, "buildings");
export const TODAY = new Date().toISOString().slice(0, 10);

// ---------- data ----------
export async function rest(path, { range } = {}) {
  const headers = { apikey: KEY, Accept: "application/json" };
  if (range) headers.Range = range;
  const r = await fetch(SB + "/rest/v1/" + path, { headers });
  if (!r.ok) throw new Error(`${path}: ${r.status} ${(await r.text()).slice(0, 200)}`);
  return r.json();
}
export async function all(path, size = 1000) {
  const out = [];
  for (let from = 0; ; from += size) {
    const rows = await rest(path, { range: `${from}-${from + size - 1}` });
    out.push(...rows);
    if (rows.length < size) return out;
  }
}
export async function rpc(fn, args) {
  const r = await fetch(SB + "/rest/v1/rpc/" + fn, {
    method: "POST", headers: { apikey: KEY, "Content-Type": "application/json" }, body: JSON.stringify(args),
  });
  if (!r.ok) throw new Error(`${fn}: ${r.status} ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

// ---------- text helpers ----------
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
export const tc = (s) => String(s ?? "").toLowerCase().replace(/\b([a-z])/g, (c) => c.toUpperCase())
  .replace(/\b(Llc|Lp|Ny|Nyc|Pc|Llp)\b/g, (w) => w.toUpperCase()).replace(/\(The\)/g, "").replace(/\s+/g, " ").trim()
  .replace(/(\d)(St|Nd|Rd|Th)\b/g, (_, d, x) => d + x.toLowerCase());
export const slug = (s) => String(s ?? "").toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
export const fileFor = (p) => `${slug(p.address)}-${slug(p.borough)}-${p.plan_id.toLowerCase()}.html`;
export const month = (d) => d ? new Date(d + "T12:00:00").toLocaleDateString("en-US", { month: "long", year: "numeric" }) : "";
export const day = (d) => d ? new Date(d + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "";
export const usDate = (s) => { const m = String(s || "").match(/^(\d{2})\/(\d{2})\/(\d{4})$/); return m ? `${m[3]}-${m[1]}-${m[2]}` : null; };
export const money = (s) => { const n = Number(String(s || "").replace(/[$,]/g, "")); return n > 0 ? n : null; };
export const fmtMoney = (n) => n >= 1e6 ? "$" + (n / 1e6).toFixed(n >= 1e7 ? 1 : 2).replace(/\.?0+$/, "") + " million" : "$" + Math.round(n).toLocaleString("en-US");
export const plural = (n, w) => `${n.toLocaleString("en-US")} ${w}${n === 1 ? "" : "s"}`;
// AG records use boroughs, counties, towns and the odd typo in this field. Group them for display only
// (file names still use the raw value so URLs stay stable).
export const BORO = {
  MANHATTAN: "Manhattan", MANHTTAN: "Manhattan", "NEW YORK": "Manhattan", NY: "Manhattan",
  BROOKLYN: "Brooklyn", KINGS: "Brooklyn", QUEENS: "Queens", FLUSHING: "Queens",
  BRONX: "Bronx", "STATEN ISLAND": "Staten Island", RICHMOND: "Staten Island",
};
export const boro = (b) => BORO[String(b || "").trim().toUpperCase()] || "Outside New York City";
export const docLabel = (d) => d.doc_kind === "amendment" ? `Amendment ${d.amendment_no ?? ""}`.trim() : "Offering Plan";
export const pagesLabel = (a, b) => (a === b ? `p. ${a}` : `pp. ${a}–${b}`);
export const miles = (a, b) => {
  const R = 3958.8, rad = Math.PI / 180, dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};

// ---------- shared chrome ----------
// The masthead is copied from index.html into scripts/masthead.html; its links are made relative here.
export const MAST_HTML = await readFile(join(ROOT, "scripts", "masthead.html"), "utf8");
export const MAST = (p) => MAST_HTML.replace(/href="(?!https?:|mailto:|#)([^"]+)"/g, (_, h) => `href="${p}${h}"`);
export const SITE_NAME = "The Condo Book Project";
export const ld = (obj) => `<script type="application/ld+json">${JSON.stringify(obj).replace(/</g, "\\u003c")}</script>`;
// Tags every page shares: canonical, social cards, analytics. Also stamped into the hand-written pages (see stampStatic).
export const SEO = (p, { title, description, canonical, image, imageAlt }) => `<link rel="canonical" href="${esc(canonical)}">
<meta property="og:site_name" content="${SITE_NAME}">
<meta property="og:locale" content="en_US">
<meta property="og:type" content="website">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${esc(canonical)}">
${image ? `<meta property="og:image" content="${esc(image)}">\n<meta property="og:image:alt" content="${esc(imageAlt || title)}">\n` : ""}<meta name="twitter:card" content="${image ? "summary_large_image" : "summary"}">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(description)}">
<meta name="theme-color" content="#879CB4">
<script src="${p}analytics.js"></script>`;
export const HEAD = (p, { title, description, canonical, noindex, image, imageAlt }) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
${noindex ? '<meta name="robots" content="noindex, follow">\n' : ""}${SEO(p, { title, description, canonical, image, imageAlt })}
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' fill='%23879CB4'/%3E%3Crect y='26' width='32' height='6' fill='%2365153B'/%3E%3Ctext x='16' y='21' text-anchor='middle' font-family='Georgia,serif' font-weight='700' font-size='17' fill='%2365153B' stroke='white' stroke-width='.8' paint-order='stroke'%3EOB%3C/text%3E%3C/svg%3E">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600&family=Libre+Caslon+Text:ital,wght@0,400;0,700;1,400&display=swap">
<link rel="stylesheet" href="${p}bureau.css">
<link rel="stylesheet" href="${p}pages.css">
<link rel="stylesheet" href="${p}menu.css">
</head>
<body>
${MAST(p)}
${MENU(p)}`;
export const MENU = (p) => `<details class="menu" id="menu">
  <summary aria-label="Menu"><svg class="bars-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16"/></svg><svg class="x-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg></summary>
  <nav aria-label="Site">
    <a href="${p}index.html">Search</a>
    <a href="${p}buildings/index.html">Buildings</a>
    <a href="${p}new-condo-filings.html">New filings</a>
    <a href="${p}blog/index.html">Guides</a>
    <a href="${p}about.html">About</a>
    <a href="${p}faq.html">FAQ</a>
    <a href="mailto:hello@halfave.co?subject=The%20Condo%20Book%20Project%20error%20report">Report an error</a>
    <hr>
    <div class="fine"><a href="${p}terms.html">Terms</a><a href="${p}privacy.html">Privacy</a><a href="${p}disclaimers.html">Disclaimers</a></div>
    <small>© 2026 Half Ave Company LLC</small>
  </nav>
</details>
`;
export const FOOT = (p, extraScripts = "") => `<footer>
  <div>The Condo Book Project · NYC condo offering plan search · Source: NY Attorney General offering plan database</div>
  <nav class="footnav" aria-label="More"><a href="${p}index.html">Search</a><a href="${p}buildings/index.html">Buildings</a><a href="${p}new-condo-filings.html">New condo filings</a><a href="${p}blog/index.html">Guides</a><a href="${p}about.html">About</a><a href="${p}faq.html">FAQ</a><a href="mailto:hello@halfave.co?subject=The%20Condo%20Book%20Project%20error%20report">Report an error</a><a href="${p}terms.html">Terms</a><a href="${p}privacy.html">Privacy</a><a href="${p}disclaimers.html">Disclaimers</a></nav>
  <div>© 2026 Half Ave Company LLC. The Condo Book Project is a service of Half Ave Company LLC.</div>
</footer>
<script src="${p}menu.js"></script>
${extraScripts}</body>
</html>
`;

// A <urlset> sitemap from [path, lastmod] pairs (paths relative to the site root).
export const urlset = (urls) => `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map(([u, mod]) => `  <url><loc>${SITE_URL}/${u}</loc>${mod ? `<lastmod>${mod}</lastmod>` : ""}</url>`).join("\n")}
</urlset>
`;
