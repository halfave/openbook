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
        ids: cards.map((x) => x.dataset.id), evheads: $$("#results .card .evhead").map((x) => x.textContent),
        related: Object.fromEntries(cards.filter((x) => x.querySelector(".related")).map((x) => [x.dataset.id, { text: x.querySelector(".related").textContent, opens: [...x.querySelectorAll(".related [data-open]")].map((b) => b.dataset.open) }])),
        mentions: $("#pmentions") ? $$("#pmentions li[data-id]").map((x) => x.dataset.id) : null,
        quotes: Object.fromEntries(cards.map((x) => [x.dataset.id, x.querySelector(".ev blockquote")?.textContent || ""])),
        pk: Object.fromEntries(cards.map((x) => [x.dataset.id, { chip: x.querySelector(".pkchip")?.textContent || "", hint: x.querySelector(".pkhint")?.textContent || "", ev: x.querySelector(".ev")?.textContent || "" }])),
        basis: $$("#rview .stats h3").map((h) => [h.textContent, h.nextElementSibling?.classList.contains("basis") ? h.nextElementSibling.dataset.basis : null]),
        basisnote: $("#rview .basisnote")?.textContent || "",
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
      ok("the count says condo plans, not buildings", /^\d+ condo plans?\b/i.test(s.title), s.title);
      for (const [a, b] of E.relatedFilings || []) {
        const ra = s.related[a], rb = s.related[b];
        ok(`${a} and ${b} are both shown and marked as related filings`, s.ids.includes(a) && s.ids.includes(b) && ra?.opens.includes(b) && /related filing/i.test(ra.text) && rb?.opens.includes(a),
          `cards ${[a, b].filter((x) => s.ids.includes(x)).join(" ")}; ${a}: “${ra?.text || "no note"}”; ${b}: “${rb?.text || "no note"}”`);
      }
      if (E.spec?.parking) {
        ok("no card is listed on a mere mention of a parking license", !s.evheads.some((t) => /mention/i.test(t)), s.evheads.filter((t) => /mention/i.test(t)).join(" | "));
        ok("plans that only mention a parking license are kept apart from the cards", !(s.mentions || []).some((id) => s.ids.includes(id)), (s.mentions || []).filter((id) => s.ids.includes(id)).join(" "));
      }
      for (const [id, re] of E.evidenceShows || []) ok(`${id}'s card quotes /${re}/`, new RegExp(re).test(s.quotes[id] || ""), `“${(s.quotes[id] || "no card").slice(0, 200)}”`);
      // CD140317's qualifying words come late in a long cover-page sentence, so its quote must show that words were left out.
      if (E.spec?.mih && s.quotes.CD140317 != null) ok("a shortened MIH quote marks the words left out with “…”", /^“… .*”$/.test(s.quotes.CD140317), s.quotes.CD140317.slice(0, 120));
      if (E.parkingZero) {
        // A zero count and a missing count must read differently, and neither may say there's no parking.
        // The missing count is a fixture: one plan's parking count is blanked in the plans response.
        const nullId = s.ids.find((id) => id !== E.parkingZero);
        const fx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
        await fx.route((u) => /\/rest\/v1\/plans\?/.test(u.href), async (route) => {
          if (route.request().method() !== "GET") return route.continue();
          const resp = await route.fetch(); let body = await resp.json();
          if (Array.isArray(body)) body = body.map((p) => (p.plan_id === nullId ? { ...p, units_parking: null } : p));
          await route.fulfill({ response: resp, json: body });
        });
        const f = await open(fx, c.q);
        const pk = await f.page.evaluate(() => Object.fromEntries([...document.querySelectorAll("#results .card")].map((x) => [x.dataset.id, { chip: x.querySelector(".pkchip")?.textContent || "", hint: x.querySelector(".pkhint")?.textContent || "", ev: x.querySelector(".ev")?.textContent || "" }])));
        await fx.close();
        const z = pk[E.parkingZero], n = pk[nullId];
        const NOPARK = /\bno parking\b|parking (?:is )?not (?:offered|available)|without parking|parking unavailable/i;
        ok(`zero parking count (${E.parkingZero}) reads as a count of AG parking units`, z && /^0 parking units$/.test(z.chip.trim()) && /AG record lists 0 parking units/.test(z.hint) && /doesn’t show whether spaces are offered by license/.test(z.hint), JSON.stringify(z));
        ok(`missing parking count (fixture on ${nullId}) reads as unknown, not zero`, n && /not on record/i.test(n.chip) && !/\b0\b/.test(n.chip) && /doesn’t give a parking-unit count/.test(n.hint) && /doesn’t show whether spaces are offered by license/.test(n.hint), JSON.stringify(n));
        ok("neither parking label says parking is unavailable, and both keep the license evidence", z && n && ![z.chip, z.hint, n.chip, n.hint].some((t) => NOPARK.test(t)) && /licen/i.test(z.ev) && /licen/i.test(n.ev), JSON.stringify({ z, n }));
      }
    } else {
      ok("renders breakdown tables, not a result list", s.rviewVisible && s.pivots >= (E.minTables || 1), `${s.pivots} tables`);
      if (E.salesDisclaimer) ok("says there is no sales data", s.salesnote);
      const wrong = s.basis.filter(([t, b]) => !(b === "current" && /current .*\(AG record\)/i.test(t)) && !(b === "scheduleA" && /original Schedule A/i.test(t)));
      ok("every table names its price basis: current AG total or original Schedule A", s.basis.length && !wrong.length && s.basis.some(([, b]) => b === "current") && s.basis.some(([, b]) => b === "scheduleA"), wrong.map(([t, b]) => `${b}: ${t}`).join(" | ") || JSON.stringify(s.basis));
      ok("explains that the two price bases differ", /current total offering price in the AG record/.test(s.basisnote) && /original plan’s Schedule A/.test(s.basisnote) && /don’t reconcile/.test(s.basisnote), s.basisnote || "no note");
      if (E.unitDenominator) {
        // The counted-plan row shows residential units apart from the units the per-unit price is divided by, and the two agree with the figures.
        const [id, u] = E.unitDenominator;
        const row = await page.evaluate((id) => { const tr = document.querySelector(`#rview tr[data-id="${id}"]`); if (!tr) return null; const td = [...tr.cells].map((c) => c.textContent.trim());
          return { head: [...tr.closest("table").querySelectorAll("thead th")].map((h) => h.textContent), res: tr.querySelector(".ures")?.textContent.trim(), used: tr.querySelector(".uused b")?.textContent.trim(), mix: tr.querySelector(".uused .sub2")?.textContent.trim(), cur: td.at(-2), per: td.at(-1) }; }, id);
        const $n = (t) => { const m = String(t || "").match(/\$([\d.,]+)([MK])/); return m ? parseFloat(m[1].replace(/,/g, "")) * (m[2] === "M" ? 1e6 : 1e3) : NaN; };
        ok(`${id}: residential units and the per-unit divisor are shown apart (${u.residential} residential + ${u.storage} storage = ${u.used})`,
          row && row.head.includes("Residential units") && row.head.includes("Units divided by") && row.res === String(u.residential) && row.used === String(u.used) && row.mix === `${u.residential} residential + ${u.storage} storage`, JSON.stringify(row));
        ok(`${id}: the per-unit figure is the current total ÷ ${u.used}`, row && Math.abs($n(row.cur) / u.used / $n(row.per) - 1) < 0.01, JSON.stringify(row));
      }
      if (E.yearsBack) {
        // Removing the date chip leaves no date filter; the selector, title, notes and chips must all say so. Choosing 2 years brings it back.
        const settle = () => page.waitForFunction(() => { const t = document.getElementById("rtitle")?.textContent || "", st = document.getElementById("status")?.textContent || ""; return !/^Searching/.test(t) && !/…/.test(st) && document.querySelector('#rview select[data-stat="years"]'); }, null, { timeout: 90000 })
          .catch(async (e) => { throw new Error(`${e.message.split("\n")[0]} · page shows: ${await page.evaluate(() => ["rtitle", "status", "notice"].map((i) => document.getElementById(i)?.textContent.trim().slice(0, 200)).join(" | "))} · ${errors.join(" | ")}`); });
        const dates = () => page.evaluate(() => { const sel = document.querySelector('#rview select[data-stat="years"]');
          return { value: sel?.value, shown: sel?.selectedOptions[0]?.textContent, title: document.getElementById("rtitle").textContent, chips: [...document.querySelectorAll("#read .fchip")].map((x) => x.textContent), notes: [...document.querySelectorAll("#read .readnotes li")].map((x) => x.textContent).join(" | ") }; });
        // With no date limit the page reads Schedule A for every plan ever accepted, which takes minutes; this step checks the date
        // controls, so Schedule A page bodies answer empty while it runs. The 2-year run below uses the real data again.
        const noPages = (r) => r.fulfill({ json: [] });
        await page.route(/\/rest\/v1\/pages\?/, noPages);
        await page.click('#read [data-rm="since"]'); await settle();
        await page.unroute(/\/rest\/v1\/pages\?/, noPages);
        const a = await dates();
        ok("with the date chip removed, the selector shows “All dates” and the page says there is no date limit",
          a.value === "all" && a.shown === "All dates" && /accepted at any date$/i.test(a.title) && !a.chips.some((t) => /Accepted/.test(t)) && /No date limit/.test(a.notes) && !/Window:/.test(a.notes), JSON.stringify(a));
        await page.selectOption('#rview select[data-stat="years"]', "2"); await settle();
        const b = await dates();
        ok("choosing 2 years brings the date filter back", b.value === "2" && /in the last 2 years$/i.test(b.title) && b.chips.some((t) => /Accepted in the last 2 years/.test(t)) && /Window: accepted/.test(b.notes), JSON.stringify(b));
      }
    }
    await page.screenshot({ path: join(shots, `${c.id}-desktop.png`), fullPage: true });
    // A closer look at the top of the results for reviewers.
    await page.screenshot({ path: join(shots, `${c.id}-top.png`) });
    await desk.close();

    const mob = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    const m = await open(mob, c.q);
    const mm = await m.page.evaluate(() => {
      // Open every evidence disclosure (Schedule A sources, "N more", excluded plans, plans counted) so what's inside is measured too.
      document.querySelectorAll("#results details, #rview details").forEach((d) => { d.open = true; });
      const tiny = (sel, w) => [...document.querySelectorAll(sel)].filter((b) => { const r = b.getBoundingClientRect(); return b.offsetParent && (r.height < 39.5 || (w && r.width < 39.5)); });
      const name = (b) => (b.getAttribute("aria-label") || b.textContent).trim().slice(0, 30);
      const small = tiny("#facets .fbtn, #read .dist button, #boros button, .statctl select").map(name);
      const small2 = tiny("#read .fchip button, #results .card .acts .btn, #results .ev summary, #results .excl summary, #rview .excl summary, #results .ev .cite a, #results .ev details a", true).map(name);
      return { overflow: document.documentElement.scrollWidth - window.innerWidth, small, small2,
        measured: document.querySelectorAll("#read .fchip button, #results .card .acts .btn, #results .ev summary").length, opened: document.querySelectorAll("#results .ev details[open]").length };
    });
    ok("no sideways scroll at 390px, with evidence opened", mm.overflow <= 1, `${mm.overflow}px too wide`);
    ok("tap targets at least 40px at 390px", !mm.small.length, mm.small.join(", "));
    ok(`filter removal, card actions and evidence disclosures are 40px at 390px (${mm.measured} measured, ${mm.opened} evidence panels opened)`, mm.measured && !mm.small2.length, mm.small2.join(", "));
    if (E.spec?.beds) ok("unit evidence can be opened at 390px", mm.opened > 0, "no Schedule A source panels");
    await m.page.screenshot({ path: join(shots, `${c.id}-mobile.png`), fullPage: true });
    // A removal button still works on a phone: tapping it drops the filter.
    const rm = await m.page.$("#read .fchip button");
    if (rm) {
      const k = await rm.getAttribute("data-rm"), before = await m.page.$$eval("#read .fchip", (x) => x.length);
      await rm.tap();
      await m.page.waitForFunction(([k, n]) => !document.querySelector(`#read [data-rm="${k}"]`) || document.querySelectorAll("#read .fchip").length < n, [k, before], { timeout: 90000 }).then(() => true, () => false)
        .then((done) => ok("tapping a filter’s × on a phone removes it", done, `chip ${k} still there`));
    }
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
