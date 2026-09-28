// Track B: site health. Static SEO checks over every indexable page, then a real browser at 390px
// (light and dark) over a fixed sample of page types: horizontal scroll, tap targets, contrast, JS errors, alt text.
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, normalize, extname } from "node:path";
import { ROOT, htmlFiles, rel, read, head, urlPath, report } from "./lib.mjs";

const require = createRequire("C:/Users/susan/Desktop/openbook-search-loop/.loop/tools/package.json");
const { chromium } = require("playwright");

const checks = [];
const add = (name, pass, detail = "") => checks.push({ name, pass: !!pass, detail });

// ---- static SEO over every indexable page ----
const pages = htmlFiles().map((f) => ({ f, r: rel(f), html: read(f) })).map((p) => ({ ...p, h: head(p.html) }));
const indexable = pages.filter((p) => !p.h.noindex && !/^404\.html$/.test(p.r));
const descs = new Map();
for (const p of indexable) {
  const t = p.h.title || "", d = p.h.description || "";
  if (t.length > 65) add(`title-length: ${p.r}`, false, `${t.length} chars`);
  if (d && (d.length < 70 || d.length > 160)) add(`description-length: ${p.r}`, false, `${d.length} chars`);
  if (d) { if (!descs.has(d)) descs.set(d, []); descs.get(d).push(p.r); }
  if (!/<html[^>]*\slang=/i.test(p.html)) add(`html-lang: ${p.r}`, false);
  if (!/<meta[^>]*name=["']viewport["']/i.test(p.html)) add(`viewport-meta: ${p.r}`, false);
  if (!/<meta[^>]*property=["']og:title["']/i.test(p.html)) add(`og-title: ${p.r}`, false);
  const noAlt = [...p.html.matchAll(/<img\b[^>]*>/gi)].filter((m) => !/\salt=/i.test(m[0])).length;
  if (noAlt) add(`img-alt: ${p.r}`, false, `${noAlt} images without alt`);
  // Heading levels shouldn't skip (h2 -> h4) inside <main>.
  const main = (p.html.match(/<main\b[\s\S]*<\/main>/i) || [""])[0];
  let prev = 1, skip = false;
  for (const m of main.matchAll(/<h([1-6])\b/gi)) { const l = +m[1]; if (l > prev + 1) skip = true; prev = l; }
  if (skip) add(`heading-order: ${p.r}`, false);
}
for (const [d, rs] of descs) if (rs.length > 1) add(`duplicate-description: ${rs[0]}`, false, `${rs.length} pages share it: ${rs.slice(0, 4).join(", ")}`);
add("static: indexable pages scanned", indexable.length > 0, `${indexable.length} pages`);

// ---- browser sample ----
const pick = (re, n) => pages.filter((p) => re.test(p.r)).map((p) => p.r).sort().filter((_, i, a) => i % Math.max(1, Math.floor(a.length / n)) === 0).slice(0, n);
const idxB = pages.filter((p) => /^buildings\/[^/]+\.html$/.test(p.r) && p.r !== "buildings/index.html");
const sample = [...new Set([
  ...pages.filter((p) => !p.r.includes("/") ).map((p) => p.r),
  ...pick(/^blog\//, 20),
  "buildings/index.html",
  ...idxB.filter((p) => !p.h.noindex).map((p) => p.r).sort().filter((_, i) => i % 250 === 0),
  ...idxB.filter((p) => p.h.noindex).map((p) => p.r).sort().filter((_, i) => i % 1000 === 0),
  ...pick(/^(managing-agents|selling-agents|architects|sponsor-counsel|neighborhoods)\//, 12),
])].filter((r) => existsSync(join(ROOT, r)));

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".webp": "image/webp", ".jpg": "image/jpeg", ".ico": "image/x-icon", ".xml": "application/xml", ".txt": "text/plain" };
const server = createServer((req, res) => {
  const path = decodeURIComponent(new URL(req.url, "http://x").pathname);
  let f = normalize(join(ROOT, path));
  if (!f.startsWith(ROOT) || path.startsWith("/api/")) { res.writeHead(404); return res.end(); }
  if (existsSync(f) && statSync(f).isDirectory()) f = join(f, "index.html");
  if (!existsSync(f)) { res.writeHead(404); return res.end("not found"); }
  res.writeHead(200, { "Content-Type": TYPES[extname(f)] || "application/octet-stream" }); res.end(readFileSync(f));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch();

for (const scheme of ["light", "dark"]) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: scheme, deviceScaleFactor: 1 });
  // Keep the loop cheap and offline-safe: no analytics, map tiles or fonts.
  await ctx.route(/googletagmanager|google-analytics|plausible|fonts\.g|tile|mapbox/i, (r) => r.abort());
  for (const r of sample) {
    const page = await ctx.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e.message).slice(0, 120)));
    try {
      await page.goto(`${base}/${urlPath(r)}`, { waitUntil: "load", timeout: 30000 });
      await page.waitForTimeout(400);
      const m = await page.evaluate(() => {
        const vw = document.documentElement.clientWidth;
        const sw = Math.max(document.documentElement.scrollWidth, document.body.scrollWidth);
        const lum = (c) => { const m = c.match(/[\d.]+/g); if (!m) return null; const [r, g, b] = m.slice(0, 3).map((x) => { x = x / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
        const bgOf = (el) => { for (; el; el = el.parentElement) { const c = getComputedStyle(el).backgroundColor; if (c && !/rgba\(.*,\s*0\)$/.test(c) && c !== "transparent") return c; } return "rgb(255,255,255)"; };
        const ratio = (a, b) => { const x = lum(a), y = lum(b); if (x == null || y == null) return 21; return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
        const body = ratio(getComputedStyle(document.body).color, bgOf(document.body));
        // Tap targets: controls and standalone links (not links inside running text).
        const small = [];
        for (const el of document.querySelectorAll("a[href], button, input:not([type=hidden]), select, summary, [role=button]")) {
          const r = el.getBoundingClientRect(); const cs = getComputedStyle(el);
          if (!r.width || !r.height || cs.visibility === "hidden" || cs.display === "none") continue;
          if (el.tagName === "A" && cs.display === "inline" && el.closest("p, li:not(nav li), td, dd, figcaption, blockquote, .src, .meta, small")) continue;
          if (el.closest("[hidden], [aria-hidden=true]")) continue;
          if (r.height < 40 && r.width < 40 || r.height < 24) small.push(`${el.tagName.toLowerCase()}${el.className ? "." + String(el.className).split(" ")[0] : ""} "${(el.textContent || el.getAttribute("aria-label") || "").trim().slice(0, 24)}" ${Math.round(r.width)}x${Math.round(r.height)}`);
          else if (r.height < 40 && !/^(INPUT|SELECT)$/.test(el.tagName)) small.push(`${el.tagName.toLowerCase()}${el.className ? "." + String(el.className).split(" ")[0] : ""} "${(el.textContent || "").trim().slice(0, 24)}" ${Math.round(r.width)}x${Math.round(r.height)}`);
        }
        const lowText = [];
        for (const el of document.querySelectorAll("main p, main li, main a, main span, main td, main h1, main h2, main h3, main button")) {
          if (!el.childNodes.length || ![...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) continue;
          const cs = getComputedStyle(el); if (cs.visibility === "hidden" || !el.getBoundingClientRect().height) continue;
          const big = parseFloat(cs.fontSize) >= 24 || (parseFloat(cs.fontSize) >= 18.66 && +cs.fontWeight >= 700);
          const c = ratio(cs.color, bgOf(el));
          if (c < (big ? 3 : 4.5)) { lowText.push(`${el.tagName.toLowerCase()} "${el.textContent.trim().slice(0, 24)}" ${c.toFixed(2)}`); if (lowText.length > 4) break; }
        }
        return { overflow: sw - vw, body, small: [...new Set(small)].slice(0, 6), smallCount: small.length, lowText };
      });
      add(`no-horizontal-scroll@390 ${scheme}: ${r}`, m.overflow <= 1, m.overflow > 1 ? `${m.overflow}px too wide` : "");
      add(`tap-targets>=40px ${scheme}: ${r}`, m.smallCount === 0, m.smallCount ? `${m.smallCount} small: ${m.small.join("; ")}` : "");
      add(`contrast ${scheme}: ${r}`, m.body >= 4.5 && m.lowText.length === 0, m.lowText.join("; ") || (m.body < 4.5 ? `body ${m.body.toFixed(2)}` : ""));
      add(`no-js-errors ${scheme}: ${r}`, errors.length === 0, errors.slice(0, 2).join(" | "));
    } catch (e) {
      add(`loads ${scheme}: ${r}`, false, String(e.message).slice(0, 120));
    }
    await page.close();
  }
  await ctx.close();
}
await browser.close(); server.close();
report("health", checks);
