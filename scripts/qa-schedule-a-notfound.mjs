// QA for plans where no Schedule A was found (data/schedule-a-llm/<ID>.json, verdict "not_found"): does the offering
// plan really have no unit price table, or did the extractor miss it?
//
//   node scripts/qa-schedule-a-notfound.mjs --all [--concurrency 4]
//   node scripts/qa-schedule-a-notfound.mjs --report
//
// Per plan: is there a PDF; Haiku reads the first pages for the table of contents entry of Schedule A (offering prices);
// the printed page is turned into a PDF page by probing printed page numbers; Sonnet looks at the pages around it and
// says which hold a unit price table and roughly how many rows. Also, independently of the contents, the text layer's
// pages are scanned for a price table the extractor's locator scored too low.
// Verdicts: found (pages listed: the plan has a Schedule A the extractor missed) / no_schedule_a (contents list none
// and nothing found) / not_located (contents point somewhere but no table was seen there) / no_pdf.
// Writes data/schedule-a-qa-notfound/<ID>.json. Nothing is extracted or published.
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { all, ROOT } from "./site.mjs";
import { ask, jsonIn, pdfFor, pageCount, render, pool, CACHE } from "./qa-lib.mjs";

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv.splice(i, 2)[1] : d; };
const flag = (k) => { const i = argv.indexOf(k); return i >= 0 ? (argv.splice(i, 1), true) : false; };
const OUT = join(ROOT, "data", "schedule-a-qa-notfound"), LLM = join(ROOT, "data", "schedule-a-llm"), PUB = join(ROOT, "data", "schedule-a");
const CONC = Number(opt("--concurrency", 4)), ALL = flag("--all"), REPORT = flag("--report");

// Text layer: pages with many price-and-percentage rows, wherever they are.
async function textCandidates(id) {
  const pages = await all(`pages?select=page_no,body&plan_id=eq.${id}&order=page_no`).catch(() => []);
  return pages.map((p) => {
    const L = p.body.split("\n");
    const rows = L.filter((l) => /\d(?:\.\d+)?\s?%/.test(l) && /\d{1,3}(?:,\d{3}){1,2}/.test(l)).length;
    return { page: p.page_no, rows, title: /schedule\s*["“]?\s*a\b/i.test(p.body.slice(0, 1500)) };
  }).filter((p) => p.rows >= 4).sort((a, b) => b.rows - a.rows).slice(0, 4).map((p) => p.page).sort((a, b) => a - b);
}

async function qa(id) {
  const tally = { calls: 0, tokens: 0 };
  const pdf = await pdfFor(id).catch(() => null);
  if (!pdf) return { plan_id: id, verdict: "no_pdf" };
  const count = await pageCount(pdf);
  const dir = join(CACHE, id);
  const look = async (nums) => {
    const imgs = await render(pdf, id, 70, nums);
    const c = jsonIn(await ask(tally, "sonnet",
      `Look at these offering plan pages: ${imgs.map((p, i) => `${p} (PDF PAGE ${nums[i]})`).join("; ")}. ` +
      `Reply with JSON only: {"tables": [{"page": <PDF page>, "rows": <approximate number of unit rows>}] for each page showing a table of condominium units with their offering/purchase prices (Schedule A), or [] if none}`,
      imgs, dir));
    return (Array.isArray(c?.tables) ? c.tables : []).filter((t) => nums.includes(Number(t.page)) && Number(t.rows) > 0);
  };
  // 1. Text layer candidates.
  const cand = await textCandidates(id);
  if (cand.length) {
    const t = await look(cand);
    if (t.length) return { plan_id: id, verdict: "found", via: "text layer", pages: t.map((x) => Number(x.page)), rows: t.reduce((s, x) => s + Number(x.rows), 0), page_count: count, ...tally };
  }
  // 2. Table of contents.
  const toc = await render(pdf, id, 80, [1, 2, 3, 4, 5, 6, 7, 8].filter((n) => n <= count));
  const a = jsonIn(await ask(tally, "haiku",
    `These are the first pages of an offering plan: ${toc.map((p, i) => `image ${i + 1}: ${p}`).join("; ")}. Read them. ` +
    `Reply with JSON only: {"listed": <true if the table of contents lists a Schedule A or a schedule of offering/purchase prices>, "printed_page": <its page number as listed, or null>}`,
    toc, dir));
  const printed = Number(a?.printed_page);
  if (!printed) return { plan_id: id, verdict: a?.listed ? "not_located" : "no_schedule_a", reason: a?.listed ? "listed in the contents without a page" : "not in the table of contents", text_candidates: cand, page_count: count, ...tally };
  let probe = Math.min(count, printed + 4), target = null;
  for (let t = 0; t < 6; t++) {
    const [img] = await render(pdf, id, 60, [probe]);
    const b = jsonIn(await ask(tally, "haiku", `Read the image ${img}. Reply with JSON only: {"printed": <the page number printed on the page as an integer, or null>}`, [img], dir));
    if (!Number(b?.printed)) { probe = Math.min(count, probe + 3); continue; }
    const diff = printed - Number(b.printed);
    if (Math.abs(diff) <= 2) { target = Math.max(1, probe + Math.min(diff, 0)); break; }
    probe = Math.max(1, Math.min(count, probe + diff));
  }
  if (!target) return { plan_id: id, verdict: "not_located", reason: `contents say page ${printed}; the PDF page wasn't found`, page_count: count, ...tally };
  const win = [...Array(8).keys()].map((k) => target - 1 + k).filter((n) => n >= 1 && n <= count);
  const t = await look(win);
  if (t.length) return { plan_id: id, verdict: "found", via: "table of contents", printed_page: printed, pages: t.map((x) => Number(x.page)), rows: t.reduce((s, x) => s + Number(x.rows), 0), page_count: count, ...tally };
  return { plan_id: id, verdict: "not_located", reason: `no price table on PDF pages ${win[0]}-${win.at(-1)} (contents say page ${printed})`, page_count: count, ...tally };
}

if (REPORT) {
  const rs = await Promise.all((await readdir(OUT)).filter((f) => f.endsWith(".json")).map(async (f) => JSON.parse(await readFile(join(OUT, f), "utf8"))));
  const by = {}; for (const r of rs) by[r.verdict] = (by[r.verdict] || 0) + 1;
  console.log(`${rs.length} plans`, by);
  process.exit(0);
}
let ids = argv;
if (ALL) {
  ids = [];
  for (const f of (await readdir(LLM)).filter((f) => f.endsWith(".json"))) {
    const m = JSON.parse(await readFile(join(LLM, f), "utf8"));
    if (m.verdict !== "not_found") continue;
    if (await readFile(join(PUB, f)).then(() => true, () => false)) continue; // published since (pattern table)
    ids.push(m.plan_id);
  }
}
console.log(`${ids.length} plans`);
await pool(ids, CONC, OUT, qa);
