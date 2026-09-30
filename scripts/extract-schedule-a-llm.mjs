// Reads each plan's Schedule A table with a model, then checks it against facts the model never saw.
// Runs through the local `claude` CLI (your Claude login, no API key in this repo).
//
//   node scripts/extract-schedule-a-llm.mjs --out DIR PLAN_ID ...      a few plans
//   node scripts/extract-schedule-a-llm.mjs --out DIR --all            every plan with an offering plan
//   options: --concurrency 4   --python PATH (needs PyMuPDF, for scans)   --cache DIR (downloaded PDFs)
//            --force (redo plans that already have DIR/<ID>.json)
//   node scripts/extract-schedule-a-llm.mjs --locate PLAN_ID ...       where Schedule A is, from the text layer (no model)
//
// Per plan:
//  1. Find the Schedule A pages in the text layer: score every page, and follow the table of contents (no model).
//  2. Clean text: Sonnet transcribes the table from text, thinking off. Output is tab-separated to keep it short.
//  3. The result is checked: prices vs the AG record's total offering price, vs the table's own printed total,
//     common interest ≈ 100%, common charges proportional to common interest, carrying = charges + taxes,
//     column sums vs the printed total row, $/sf in range, and not every home at one placeholder price.
//  4. Only if that fails, or there is no usable text (a scan): Sonnet reads the page images, thinking off,
//     then once more with thinking if that fails too. Scans are located first with small Haiku looks at the
//     table of contents and printed page numbers.
// Writes DIR/<ID>.json (units, checks, verdict, tokens used). Nothing is written to the database.
import { spawn } from "node:child_process";
import { mkdir, writeFile, readFile, access } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { all, rest, money } from "./site.mjs";

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv.splice(i, 2)[1] : d; };
const flag = (k) => { const i = argv.indexOf(k); return i >= 0 ? (argv.splice(i, 1), true) : false; };
const OUT = opt("--out", null);
const CONC = Number(opt("--concurrency", 4));
const PY = opt("--python", process.env.PYTHON || "python");
const CACHE = opt("--cache", join(tmpdir(), "openbook-plans"));
const EFFORT = opt("--effort", null);
const FORCE = flag("--force"), ALL = flag("--all"), LOCATE = flag("--locate");
if (!OUT && !LOCATE) { console.error("--out DIR is required"); process.exit(1); }

// ---------- helpers ----------
const run = (cmd, args, input, env = {}) => new Promise((res, rej) => {
  const p = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ...env } });
  let o = "", e = "";
  p.stdout.on("data", (d) => (o += d)); p.stderr.on("data", (d) => (e += d));
  p.on("error", rej);
  p.on("close", (c) => (c === 0 ? res(o) : rej(new Error(`${cmd} exited ${c}: ${(e || o).slice(0, 300)}`))));
  if (input != null) p.stdin.end(input); else p.stdin.end();
});
const exists = (f) => access(f).then(() => true, () => false);
// On Windows npm installs `claude` as a .cmd shim, which can't be spawned without a shell; use the binary behind it.
const WIN_BIN = join(process.env.APPDATA || "", "npm", "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe");
const CLAUDE = process.env.CLAUDE_BIN || (process.platform === "win32" && (await exists(WIN_BIN)) ? WIN_BIN : "claude");

const SYSTEM = "You transcribe tables from New York condominium offering plans exactly. Output only what is asked, no commentary.";
// One model call. Returns { text, usage } and adds its usage to the plan's tally.
// Thinking is off unless asked for: in testing it was ~80% of a call's tokens and most of its time, and
// transcription without it passed the checks as often.
async function ask(tally, model, prompt, { images = [], dirs = [], think = false } = {}) {
  // Default effort: in testing, low effort used more tokens and swapped area columns.
  const args = ["-p", "--model", model, ...(EFFORT ? ["--effort", EFFORT] : []), "--system-prompt", SYSTEM, "--strict-mcp-config", "--no-session-persistence",
    "--setting-sources", "", "--output-format", "json"];
  if (images.length) args.push("--tools", "Read", "--allowedTools", "Read", "--max-turns", String(images.length + 3), ...dirs.flatMap((d) => ["--add-dir", d]));
  else args.push("--tools", "");
  let j;
  for (let t = 0; ; t++) {
    try { j = JSON.parse(await run(CLAUDE, args, prompt, think ? {} : { MAX_THINKING_TOKENS: "0" })); break; }
    catch (e) { if (t === 2) throw e; await new Promise((r) => setTimeout(r, 5000 * (t + 1))); }
  }
  const u = j.usage || {};
  const tok = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.output_tokens || 0);
  tally.calls.push({ model, tokens: tok, output_tokens: u.output_tokens || 0, seconds: Math.round((j.duration_ms || 0) / 1000), cost_usd: j.total_cost_usd || 0 });
  if (j.is_error) throw new Error(`model error: ${String(j.result).slice(0, 200)}`);
  return String(j.result || "");
}

// ---------- 1. locate pages in the text layer ----------
function scorePage(body) {
  const lines = body.split("\n");
  const rows = lines.filter((l) => /\d(?:\.\d+)?\s?%/.test(l) && /\d{1,3}(?:,\d{3})+/.test(l)).length;
  const prices = lines.filter((l) => /\d{1,3},\d{3},\d{3}|\$\s?\d{3},\d{3}/.test(l)).length;
  const head = body.slice(0, 1500).toLowerCase();
  let s = rows * 3 + prices;
  if (/schedule\s*["“]?\s*a(?:-?\d)?\b/.test(head)) s += 12;
  if (/purchase prices?|offering prices?|prices and related|price schedule/.test(head)) s += 12;
  if (/schedule\s*["“]?\s*b\b|projected budget|budget for|purchase agreement|closing costs?|escrow|title insurance|transfer tax/.test(head)) s -= 25;
  return { s, rows };
}
// The table of contents gives Schedule A's printed page; printed page numbers (a page's first or last line) give the offset.
function tocPages(scored) {
  let printed = null;
  for (const p of scored.slice(0, 20)) {
    const L = p.body.split("\n");
    // A contents entry: "SCHEDULE A … OFFERING PRICES ……… 31", the leaders and number possibly on the next two lines.
    for (let i = 0; i < L.length && !printed; i++) {
      if (!/schedule\s*["“]?\s*a\b/i.test(L[i]) || /notes? to/i.test(L[i])) continue;
      for (const l of L.slice(i, i + 3)) {
        if (l !== L[i] && /schedule\s*["“]?\s*[b-z]\b/i.test(l)) break;
        const m = l.match(/(?:\.\s?){4,}\s*(\d{1,3})\s*$/);
        if (m) { printed = Number(m[1]); break; }
      }
    }
    if (printed) break;
  }
  if (!printed) return [];
  const pageNum = (body) => { const L = body.split("\n").map((s) => s.trim()).filter(Boolean); return [L[0], L[L.length - 1]].map((s) => /^\d{1,3}$/.test(s || "") ? Number(s) : null).find((x) => x != null) ?? null; };
  const offsets = scored.map((p) => { const n = pageNum(p.body); return n != null && n > 3 && Math.abs(n - printed) <= 40 ? p.page_no - n : null; }).filter((x) => x != null && x >= 0);
  if (!offsets.length) return [];
  const count = new Map(); for (const o of offsets) count.set(o, (count.get(o) || 0) + 1);
  const off = [...count].sort((a, b) => b[1] - a[1])[0][0];
  const start = printed + off;
  // The section can open with a page or two of text; take the table pages that follow.
  const win = scored.filter((p) => p.page_no >= start && p.page_no <= start + 6);
  const table = win.filter((p) => p.rows >= 2);
  return (table.length ? table : win.slice(0, 3)).slice(0, 6);
}
// A Schedule A table page: price and common-interest columns, and rows. The title is often not at the top.
// Column headings are often split across lines ("Offering" above "Price"), so the words are tested separately.
const isPriceTable = (p) => p.rows >= 2 && /\binterest\b/i.test(p.body) && /\b(offering|purchase)\b/i.test(p.body) && /\bprices?\b/i.test(p.body);

async function locateText(id) {
  const pages = await all(`pages?select=page_no,body&plan_id=eq.${id}&order=page_no`);
  if (!pages.length) return { pages: [], textLayer: false };
  const scored = pages.map((p) => ({ ...p, ...scorePage(p.body) }));
  let best = scored.reduce((a, b) => (b.s > a.s ? b : a));
  // The highest-scoring page can be a closing-cost or purchase-agreement page full of dollar amounts. When the table
  // of contents points to a real price table, that wins.
  const tocTable = tocPages(scored).filter(isPriceTable);
  if (tocTable.length) best = tocTable[0];
  else if (best.s < 20 || best.rows < 2) return { pages: [], textLayer: true };
  // Continuation pages on either side (a long table, or Schedule A-1 for parking and storage).
  const byNo = new Map(scored.map((p) => [p.page_no, p]));
  const pick = [best];
  for (const dir of [-1, 1]) for (let n = best.page_no + dir; ; n += dir) {
    const p = byNo.get(n);
    if (!p || p.rows < 2 || p.s < best.s * 0.25 || pick.length >= 6) break;
    pick.push(p);
  }
  pick.sort((a, b) => a.page_no - b.page_no);
  // Garbled OCR: a low share of plain words.
  const txt = pick.map((p) => p.body).join(" ");
  const words = txt.split(/\s+/).filter(Boolean);
  const clean = words.filter((w) => /^[A-Za-z]{2,}[.,:;)]?$|^[$(]?[\d,.]+%?[)]?$/.test(w)).length / Math.max(words.length, 1);
  return { pages: pick.map((p) => ({ page_no: p.page_no, body: p.body })), textLayer: true, clean };
}

// ---------- PDFs and page images ----------
async function pdfFor(id) {
  const docs = await rest(`documents?select=pdf_url&plan_id=eq.${id}&doc_kind=eq.offering_plan&status=eq.done&pdf_url=not.is.null&limit=1`);
  const url = docs[0]?.pdf_url;
  if (!url) return null;
  const f = join(CACHE, id + ".pdf");
  if (!(await exists(f))) {
    await mkdir(CACHE, { recursive: true });
    const r = await fetch(url);
    if (!r.ok) return null;
    await writeFile(f, Buffer.from(await r.arrayBuffer()));
  }
  return f;
}
const pageCount = async (pdf) => Number((await run(PY, [join(import.meta.dirname, "render-pages.py"), pdf, "count"])).trim());
const render = async (pdf, id, dpi, nums) => (await run(PY, [join(import.meta.dirname, "render-pages.py"), pdf, join(CACHE, id), String(dpi), ...nums.map(String)]))
  .trim().split(/\r?\n/).filter(Boolean);
const jsonIn = (s) => { try { return JSON.parse(s.match(/\{[\s\S]*\}/)[0]); } catch { return null; } };

// Scans: table of contents → printed page → PDF page (via the printed page number on a probed page).
async function locateScan(tally, id, pdf) {
  const count = await pageCount(pdf);
  const toc = await render(pdf, id, 80, [1, 2, 3, 4, 5, 6, 7, 8].filter((n) => n <= count));
  const a = jsonIn(await ask(tally, "haiku",
    `These are the first pages of an offering plan: ${toc.map((p, i) => `image ${i + 1}: ${p}`).join("; ")}. Read them. ` +
    `Reply with JSON only: {"printed_page": <the page number the table of contents gives for Schedule A (purchase/offering prices), or null>}`,
    { images: toc, dirs: [join(CACHE, id)] }));
  const printed = Number(a?.printed_page);
  if (!printed) return [];
  // Probe a page, read its printed number, jump by the difference. Front matter can push the offset past 40 pages.
  let probe = Math.min(count, printed + 4), target = null;
  for (let t = 0; t < 6; t++) {
    const [img] = await render(pdf, id, 60, [probe]);
    const b = jsonIn(await ask(tally, "haiku",
      `Read the image ${img}. Reply with JSON only: {"printed": <the page number printed on the page as an integer, or null>}`,
      { images: [img], dirs: [join(CACHE, id)] }));
    if (!Number(b?.printed)) { probe = Math.min(count, probe + 3); continue; }
    const next = Math.max(1, Math.min(count, probe + (printed - Number(b.printed))));
    if (next === probe) { target = probe; break; }
    probe = next;
  }
  if (!target) return [];
  // The section can open with pages of text before the table: one look at the next 8 pages picks the table pages.
  const win = [...Array(8).keys()].map((k) => target + k).filter((n) => n <= count);
  const thumbs = await render(pdf, id, 50, win);
  const c = jsonIn(await ask(tally, "haiku",
    `Read these page images: ${thumbs.map((p, i) => `image ${i + 1}: ${p}`).join("; ")}. ` +
    `Reply with JSON only: {"table_images": [the image numbers that show rows of the unit price table (unit numbers with prices), in order]}`,
    { images: thumbs, dirs: [join(CACHE, id)] }));
  const picked = (Array.isArray(c?.table_images) ? c.table_images : []).map((k) => win[Number(k) - 1]).filter(Boolean);
  return picked.length ? picked.slice(0, 5) : win.slice(0, 4);
}

// ---------- 2. transcription ----------
const COLS = ["unit", "type", "floor", "rooms", "beds", "baths", "int_sf", "sf2", "ext_sf", "price", "pct", "pct2", "cc_m", "cc_a", "tax_m", "tax_a", "tax2_m", "carry_m", "page", "note"];
const RULES = `Transcribe the Schedule A table (unit prices and related information). Copy numbers exactly as printed; never compute or guess.

Every U line has exactly ${COLS.length} cells after "U", separated by single tabs, in the order below. Write - for any cell that is blank, "N/A", or not in the table. Never leave a cell out; a missing cell shifts every column after it.
Example: U<TAB>2B<TAB>R<TAB>-<TAB>-<TAB>2<TAB>2<TAB>1235<TAB>-<TAB>223<TAB>1690000<TAB>4.25<TAB>4.41<TAB>536.78<TAB>-<TAB>1193.61<TAB>14323.33<TAB>-<TAB>1730.39<TAB>37<TAB>-

Output tab-separated lines only, in this order:
PERIOD<TAB>first-year budget period as printed
COLS<TAB>the table's column headers as printed, joined with " | "
TAX2<TAB>what tax2_m holds (e.g. "without 421-a"), or empty
SF2<TAB>what sf2 holds (e.g. "gross sf", "cellar"), or empty
then one line per unit:
U<TAB>${COLS.join("<TAB>")}
then:
TOTAL<TAB>price<TAB>pct<TAB>cc_m<TAB>tax_m<TAB>int_sf   (from the printed total row, empty cells if none)
PROBLEM<TAB>text   (one line per thing you could not read or were unsure of)
If there is no Schedule A price table on these pages, output only: NOTFOUND

Rules:
- unit exactly as printed. type: R residential, C commercial or community facility, P parking, S storage, O other.
- floor and rooms only if the table has them. Never derive bedrooms from rooms.
- beds/baths only when clearly stated: "2/2", "2BR/2BA", "2 Bedrooms/2 Bathrooms", "3+3-1/2" = 3 beds 3.5 baths. Studio = 0 beds. A half bath counts 0.5 ("2 full & 1 half" = 2.5). Unclear codes: leave empty, put the code in note.
- int_sf: interior/habitable/net square feet. sf2: a second area column (gross, cellar, uninhabitable); say which in SF2. ext_sf: terrace/balcony/yard/roof area when one number is printed for it; several separate areas: leave empty and list them in note.
- price: offering price. pct: percentage of common interest. pct2: a second percentage column, if any.
- cc_m / cc_a: monthly / annual common charges. tax_m / tax_a: monthly / annual real estate taxes. If two tax scenarios are printed, tax_m and tax_a are the ones the carrying-charge column uses (else the first), and the other monthly figure goes in tax2_m.
- carry_m: monthly carrying charges, only if printed.
- page: the PDF PAGE number of the row.
- Combine continuation pages and separate parking/storage tables into one list.
- Write numbers without $ , or % (1690000, 4.25).`;

const numOrNull = (s) => { const t = String(s ?? "").replace(/[$,%\s]/g, ""); return t === "" || !/^-?\d*\.?\d+$/.test(t) ? null : Number(t); };
const TYPES = { R: "residential", C: "commercial", P: "parking", S: "storage", O: "other" };
function parse(text) {
  if (/^\s*NOTFOUND\s*$/m.test(text) && !/^U\t/m.test(text)) return { found: false, units: [], problems: [] };
  const o = { found: true, units: [], problems: [], printed_totals: null, budget_period: null, columns_printed: null, tax2: null, sf2: null };
  for (let line of text.replace(/\r/g, "").split("\n")) {
    if (!line.includes("\t") && line.includes("|")) line = line.split("|").map((x) => x.trim()).join("\t");
    const c = line.split("\t");
    const k = c[0].trim();
    if (k === "U") {
      // A row with the wrong number of cells has shifted columns; it is dropped and reported, never guessed at.
      if (c.length !== COLS.length + 1) { o.bad_rows = (o.bad_rows || 0) + 1; o.problems.push(`row with ${c.length - 1} cells dropped: ${line.slice(0, 80)}`); continue; }
      const u = Object.fromEntries(COLS.map((name, i) => [name, (c[i + 1] ?? "").trim().replace(/^-$/, "")]));
      const num = ["rooms", "beds", "baths", "int_sf", "sf2", "ext_sf", "price", "pct", "pct2", "cc_m", "cc_a", "tax_m", "tax_a", "tax2_m", "carry_m", "page"];
      for (const n of num) u[n] = numOrNull(u[n]);
      u.type = TYPES[String(u.type).toUpperCase()[0]] || "other";
      // Bedrooms are whole numbers; "3+" (a den) must not become 3.5.
      if (u.beds != null && !Number.isInteger(u.beds)) { u.note = [u.note, `beds as printed: ${c[5]}`].filter(Boolean).join("; "); u.beds = null; }
      u.floor = u.floor || null; u.note = u.note || null;
      if (u.unit) o.units.push(u);
    } else if (k === "TOTAL") o.printed_totals = { price: numOrNull(c[1]), pct: numOrNull(c[2]), cc_m: numOrNull(c[3]), tax_m: numOrNull(c[4]), int_sf: numOrNull(c[5]) };
    else if (k === "PROBLEM" && c[1]) o.problems.push(c.slice(1).join(" ").trim());
    else if (k === "PERIOD") o.budget_period = c[1]?.trim() || null;
    else if (k === "COLS") o.columns_printed = c.slice(1).join(" ").split(" | ").map((x) => x.trim()).filter(Boolean);
    else if (k === "TAX2") o.tax2 = c[1]?.trim() || null;
    else if (k === "SF2") o.sf2 = c[1]?.trim() || null;
  }
  if (!o.units.length) o.found = false;
  return o;
}

// ---------- 3. checks ----------
const near = (a, b, tol) => a != null && b ? Math.abs(a - b) / Math.abs(b) <= tol : false;
const sum = (a) => a.reduce((s, x) => s + (x || 0), 0);
function check(o, agPrices) {
  const U = o.units, res = U.filter((u) => u.type === "residential");
  const total = sum(U.map((u) => u.price));
  const c = {};
  c.ag = agPrices.length ? agPrices.some((a) => near(total, a, 0.03)) : null;
  c.printed = o.printed_totals?.price ? near(total, o.printed_totals.price, 0.005) : null;
  const pcts = U.map((u) => u.pct).filter((x) => x != null);
  c.pct100 = pcts.length ? sum(pcts) >= 99 && sum(pcts) <= 101 : null;
  const ccOff = (k) => {
    const r = res.filter((u) => u.cc_m > 0 && u[k] > 0).map((u) => u.cc_m / u[k]);
    if (r.length < 3) return null;
    const med = [...r].sort((a, b) => a - b)[r.length >> 1];
    return r.filter((x) => Math.abs(x - med) / med > 0.03).length;
  };
  const offs = [ccOff("pct"), ccOff("pct2")].filter((x) => x != null);
  c.ccProportional = offs.length ? Math.min(...offs) === 0 : null;
  const car = U.filter((u) => u.carry_m != null && u.cc_m != null && u.tax_m != null);
  c.carrying = car.length ? car.every((u) => Math.abs(u.carry_m - u.cc_m - u.tax_m) <= 2) : null;
  // Area columns are the easiest to mix up (interior vs cellar vs gross): rows must add up to the printed total.
  // Tables differ on whether parking/storage count and whether cellar space (sf2) is included, so any of those sums may match.
  const pt = o.printed_totals || {};
  const sfSums = [U, res].flatMap((set) => [sum(set.map((u) => u.int_sf)), sum(set.map((u) => (u.int_sf || 0) + (u.sf2 || 0)))]);
  c.sqftTotal = pt.int_sf ? sfSums.some((x) => Math.abs(x - pt.int_sf) <= Math.max(2, pt.int_sf * 0.002)) : null;
  c.monthlyTotals = [["cc_m", pt.cc_m], ["tax_m", pt.tax_m]].every(([k, t]) => !t || Math.abs(sum(U.map((u) => u[k])) - t) <= Math.max(2, t * 0.002));
  const sized = res.filter((u) => u.int_sf && u.price);
  c.psf = sized.length ? sized.every((u) => u.price / u.int_sf >= 150 && u.price / u.int_sf <= 6000) : null;
  const rp = res.map((u) => u.price).filter((x) => x != null);
  c.notPlaceholder = !(rp.length >= 4 && new Set(rp).size === 1 && new Set(res.map((u) => u.int_sf).filter(Boolean)).size > 1);
  c.allRowsParsed = !o.bad_rows;
  const internal = c.pct100 !== false && c.ccProportional !== false && c.carrying !== false && c.psf !== false && c.notPlaceholder
    && c.sqftTotal !== false && c.monthlyTotals && c.allRowsParsed;
  const verdict = !o.found ? "not_found" : !internal ? "hold" : c.ag ? "publish_ag" : c.printed ? "publish_printed" : "hold";
  return { checks: c, verdict, price_total: total };
}

// ---------- per plan ----------
async function extract(id, agPrices) {
  const tally = { calls: [] };
  const steps = [];
  const loc = await locateText(id);
  let best = null;
  const attempt = async (step, model, prompt, extra) => {
    const o = parse(await ask(tally, model, prompt, extra));
    const r = { ...o, ...check(o, agPrices), step };
    steps.push({ step, verdict: r.verdict, units: o.units.length, failed: Object.entries(r.checks || {}).filter(([, v]) => v === false).map(([k]) => k) });
    if (!best || rank(r) > rank(best)) best = r;
    return r;
  };
  const rank = (r) => ({ publish_ag: 4, publish_printed: 3, hold: 2, not_found: 1 })[r.verdict] || 0;
  const textBlock = (pages) => pages.map((p) => `=============== PDF PAGE ${p.page_no} ===============\n${p.body}`).join("\n\n");

  // Done once it passes, or when the only failure is a property of the plan itself (one price for every home):
  // reading the page again can't change that, so it is held for a person without another model call.
  const settled = (r) => r.verdict.startsWith("publish")
    || (r.checks && !r.checks.notPlaceholder && Object.entries(r.checks).every(([k, v]) => k === "notPlaceholder" || v !== false));

  // 1. Clean text: Sonnet from text only, no thinking (~5k tokens).
  if (loc.pages.length && loc.clean >= 0.6) {
    if (settled(await attempt("sonnet-text", "sonnet", `${RULES}\n\nPages:\n\n${textBlock(loc.pages)}`))) return finish(id, best, steps, tally, loc);
  }
  const pdf = await pdfFor(id).catch(() => null);
  if (!pdf) {
    if (loc.pages.length && !steps.length) await attempt("sonnet-text", "sonnet", `${RULES}\n\nPages (OCR text, may be garbled):\n\n${textBlock(loc.pages)}`);
    return finish(id, best, steps, tally, loc, "no PDF");
  }
  let nums = loc.pages.map((p) => p.page_no);
  if (!nums.length) nums = await locateScan(tally, id, pdf);
  if (!nums.length) return finish(id, best, steps, tally, loc, "Schedule A pages not located");
  const imgs = await render(pdf, id, 150, nums);
  const hint = loc.pages.length ? `\n\nText layer of the same pages, for reference only (may be garbled or out of order; the images are the source of truth):\n\n${textBlock(loc.pages)}` : "";
  const imagePrompt = `${RULES}\n\nRead each page image with the Read tool: ${imgs.map((p, i) => `${p} (PDF PAGE ${nums[i]})`).join("; ")}. ` +
    `If the table clearly continues onto a page not given here, say so in a PROBLEM line.${hint}`;
  // 2. Page images, no thinking (~15k tokens). 3. Only if that fails too: the same with thinking.
  if (settled(await attempt("sonnet-images", "sonnet", imagePrompt, { images: imgs, dirs: [join(CACHE, id)] }))) return finish(id, best, steps, tally, loc);
  await attempt("sonnet-images-think", "sonnet", imagePrompt, { images: imgs, dirs: [join(CACHE, id)], think: true });
  return finish(id, best, steps, tally, loc);
}

function finish(id, r, steps, tally, loc, reason) {
  const tokens = sum(tally.calls.map((c) => c.tokens)), cost = sum(tally.calls.map((c) => c.cost_usd));
  const base = { plan_id: id, steps, calls: tally.calls.length, call_log: tally.calls, tokens, api_equiv_usd: Math.round(cost * 1000) / 1000, located_pages: loc.pages.map((p) => p.page_no), text_layer: loc.textLayer };
  if (!r) return { ...base, found: false, verdict: "not_found", reason: reason || "no Schedule A found", units: [] };
  return { ...base, found: r.found, verdict: r.verdict, checks: r.checks, price_total: r.price_total, step: r.step,
    budget_period: r.budget_period, columns_printed: r.columns_printed, tax2: r.tax2, sf2: r.sf2,
    printed_totals: r.printed_totals, problems: r.problems, units: r.units };
}

// ---------- main ----------
if (LOCATE) {
  for (const id of argv) { const l = await locateText(id); console.log(id, l.textLayer ? "text" : "no text", l.pages.map((p) => p.page_no).join(",") || "-", l.clean != null ? `clean ${l.clean.toFixed(2)}` : ""); }
  process.exit(0);
}
await mkdir(OUT, { recursive: true });
const plans = await all("plans?select=plan_id,meta&order=plan_id");
const meta = new Map(plans.map((p) => [p.plan_id, p.meta?.plan || {}]));
let ids = argv;
if (ALL) ids = [...new Set((await all("documents?select=plan_id&status=eq.done&doc_kind=eq.offering_plan&order=plan_id")).map((d) => d.plan_id))];
const results = [];
let i = 0;
async function worker() {
  while (i < ids.length) {
    const id = ids[i++];
    const f = join(OUT, id + ".json");
    if (!FORCE && (await exists(f))) { results.push(JSON.parse(await readFile(f, "utf8"))); continue; }
    const mp = meta.get(id) || {};
    const ag = [money(mp["Initial Price"]), money(mp["Current Price"])].filter(Boolean);
    let r;
    try { r = await extract(id, ag); } catch (e) { r = { plan_id: id, verdict: "error", reason: e.message, units: [], tokens: 0 }; }
    await writeFile(f, JSON.stringify(r, null, 1));
    results.push(r);
    console.log(`${id}  ${r.verdict.padEnd(15)} ${String(r.units.length).padStart(4)} units  ${String(r.tokens).padStart(7)} tok  ${(r.steps || []).map((s) => s.step + ":" + s.verdict).join(" → ")}${r.reason ? "  (" + r.reason + ")" : ""}`);
  }
}
await Promise.all(Array.from({ length: CONC }, worker));
const by = results.reduce((m, r) => ((m[r.verdict] = (m[r.verdict] || 0) + 1), m), {});
const tok = sum(results.map((r) => r.tokens || 0));
console.log(`\n${results.length} plans:`, by, `| ${tok.toLocaleString()} tokens, ${Math.round(tok / Math.max(results.length, 1)).toLocaleString()} per plan`);
