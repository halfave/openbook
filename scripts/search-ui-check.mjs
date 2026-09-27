// Opens each case in scripts/search-cases.json in a real browser and checks what a visitor sees:
// results render, every card's image loads, the title count matches the cards, filters and notes are there,
// nothing overflows at 390px, tap targets are 40px, dark mode renders. Saves screenshots to .loop/shots/.
//   node scripts/search-ui-check.mjs [case-id ...]      -> writes .loop/ui.json, exit 1 on any failure
// Needs Playwright in .loop/tools (npm i --prefix .loop/tools playwright@1.63.0); it serves the site itself.
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, extname, normalize } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { chromium } = createRequire(join(root, ".loop/tools/package.json"))("playwright");
const cases = JSON.parse(readFileSync(join(root, "scripts/search-cases.json"), "utf8"));
const only = process.argv.slice(2);
const shots = join(root, ".loop/shots");
mkdirSync(shots, { recursive: true });

// A static server for the site folder; /api/* answers 404 like a static host without functions.
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".ico": "image/x-icon", ".txt": "text/plain", ".xml": "application/xml", ".webmanifest": "application/manifest+json" };
const server = createServer((req, res) => {
  const path = decodeURIComponent(new URL(req.url, "http://x").pathname);
  let f = normalize(join(root, path));
  if (!f.startsWith(root) || path.startsWith("/api/")) { res.writeHead(404); return res.end(); }
  if (existsSync(f) && statSync(f).isDirectory()) f = join(f, "index.html");
  if (!existsSync(f)) { res.writeHead(404); return res.end("not found"); }
  res.writeHead(200, { "Content-Type": TYPES[extname(f)] || "application/octet-stream" }); res.end(readFileSync(f));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch();
const out = [];
async function open(ctx, q) {
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("console", (m) => { if (m.type() === "error" && !/api\/ask|Failed to load resource.*(404|501)/.test(m.text() + (m.location()?.url || ""))) errors.push("console: " + m.text()); });
  // HEAD count requests end without a body and report ERR_ABORTED; that isn't a failure.
  page.on("requestfailed", (r) => { const why = r.failure()?.errorText || ""; if (!/api\/ask|google|analytics|gtag/.test(r.url()) && !(r.method() === "HEAD" && /ABORTED/.test(why))) errors.push(`request failed (${why}): ${r.method()} ${r.url().slice(0, 120)}`); });
  await page.goto(`${base}/?q=${encodeURIComponent(q)}`, { waitUntil: "domcontentloaded" });
  // Done when the title is no longer "Searching" and the status no longer shows progress.
  await page.waitForFunction(() => { const t = document.getElementById("rtitle")?.textContent || "", s = document.getElementById("status")?.textContent || ""; return document.body.classList.contains("searched") && !/^Searching/.test(t) && !/…/.test(s); }, null, { timeout: 90000 });
  // Let the images arrive.
  await page.waitForFunction(() => [...document.querySelectorAll("#results .card img.ph")].every((i) => i.complete), null, { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(600);
  return { page, errors };
}

// A case that fails is run once more, so a network blip doesn't count as a bug.
for (const c of cases.filter((x) => !only.length || only.includes(x.id))) {
  let checks = await checkCase(c);
  if (checks.some((x) => !x.pass)) checks = await checkCase(c);
  const fails = checks.filter((x) => !x.pass);
  out.push({ id: c.id, q: c.q, pass: !fails.length, checks });
  console.log(`${fails.length ? "FAIL" : "PASS"}  ${c.id}`);
  for (const f of fails) console.log(`      ✗ ${f.name}: ${f.detail}`);
}
async function checkCase(c) {
  const checks = [];
  const ok = (name, pass, detail = "") => checks.push({ name, pass: !!pass, detail: pass ? "" : String(detail).slice(0, 500) });
  const E = c.expect;
  try {
    const desk = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const { page, errors } = await open(desk, c.q);
    const s = await page.evaluate(() => {
      const $ = (q) => document.querySelector(q), $$ = (q) => [...document.querySelectorAll(q)];
      const cards = $$("#results .card");
      return {
        title: $("#rtitle")?.textContent || "", status: $("#status")?.textContent || "", notice: $("#notice")?.hidden === false ? $("#notice").textContent : "",
        read: !$("#read")?.hidden, chips: $$("#read .fchip").length, notes: $$("#read .readnotes li").map((x) => x.textContent), dist: $$("#read .dist button").length,
        cards: cards.length, noImg: cards.filter((x) => !x.querySelector("img.ph")).map((x) => x.dataset.id),
        broken: cards.filter((x) => { const i = x.querySelector("img.ph"); return i && (!i.complete || i.naturalWidth === 0); }).map((x) => x.dataset.id),
        ev: cards.filter((x) => x.querySelector(".ev")).length, facets: $$("#facets .fgroup").length, facetKeys: [...new Set($$("#facets [data-fk]").map((b) => b.dataset.fk))],
        pivots: $$("#rview table.pivot").length, salesnote: !!$("#rview .salesnote"), more: !!$("#imore"), cover: !!$("#results .cover"),
        mapHits: $$("#dots circle.hit").length, ring: $$("#ring circle").length, rviewVisible: !$("#rview")?.hidden,
      };
    });
    ok("no errors in the page", !errors.length, errors.join(" | "));
    ok("no error notice", !s.notice, s.notice);
    ok("shows how the search was read", s.read && s.chips >= 1, `chips ${s.chips}`);
    if (E.kind === "list") {
      const n = +(s.title.match(/^\d+/) || [NaN])[0];
      ok("title starts with the number of results", Number.isFinite(n) && n > 0, s.title);
      ok("cards shown match the count (60 at a time)", s.cards === Math.min(n, 60), `${s.cards} cards for “${s.title}”`);
      ok("every card has a building image", !s.noImg.length, `no image: ${s.noImg.join(" ")}`);
      ok("every image loads", !s.broken.length, `broken: ${s.broken.join(" ")}`);
      ok("map highlights the results", s.mapHits >= Math.min(n, 1), `${s.mapHits} highlighted`);
      if (E.spec?.near) { ok("distance can be changed in place", s.dist >= 3, `${s.dist} distance buttons`); ok("map draws the radius", s.ring >= 1); }
      if (E.facets) ok("filters beside the results", E.facets.every((k) => s.facetKeys.includes(k)), `has ${s.facetKeys.join(", ")}`);
      if (E.spec?.mih || E.spec?.parking || E.spec?.beds) ok("every card shows its evidence", s.ev === s.cards, `${s.ev} of ${s.cards}`);
      if (E.coverage) ok("says how many buildings could be checked", s.cover);
      if (n > 60) ok("offers more results beyond the first 60", s.more);
    } else {
      ok("renders breakdown tables, not a result list", s.rviewVisible && s.pivots >= (E.minTables || 1), `${s.pivots} tables`);
      if (E.salesDisclaimer) ok("says there is no sales data", s.salesnote);
    }
    await page.screenshot({ path: join(shots, `${c.id}-desktop.png`), fullPage: true });
    // A closer look at the top of the results for reviewers.
    await page.screenshot({ path: join(shots, `${c.id}-top.png`) });
    await desk.close();

    const mob = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    const m = await open(mob, c.q);
    const mm = await m.page.evaluate(() => {
      const small = [...document.querySelectorAll("#facets .fbtn, #read .dist button, #boros button, .statctl select")].filter((b) => b.offsetParent && b.getBoundingClientRect().height < 39.5).map((b) => b.textContent.trim().slice(0, 20));
      return { overflow: document.documentElement.scrollWidth - window.innerWidth, small };
    });
    ok("no sideways scroll at 390px", mm.overflow <= 1, `${mm.overflow}px too wide`);
    ok("tap targets at least 40px at 390px", !mm.small.length, mm.small.join(", "));
    await m.page.screenshot({ path: join(shots, `${c.id}-mobile.png`), fullPage: true });
    await mob.close();

    const dark = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "dark" });
    const d = await open(dark, c.q);
    const bg = await d.page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    ok("dark mode renders a dark page", /rgb\((\d+), (\d+), (\d+)\)/.test(bg) && bg.match(/\d+/g).slice(0, 3).map(Number).reduce((a, b) => a + b, 0) < 200, bg);
    await d.page.screenshot({ path: join(shots, `${c.id}-dark.png`) });
    await dark.close();
  } catch (e) { ok("page loads and finishes", false, e.message); }
  return checks;
}
await browser.close(); server.close();
writeFileSync(join(root, ".loop/ui.json"), JSON.stringify({ at: new Date().toISOString(), cases: out }, null, 2));
const failed = out.filter((x) => !x.pass).length;
console.log(`\n${out.length - failed}/${out.length} cases pass in the browser · screenshots in .loop/shots`);
process.exit(failed ? 1 : 0);
