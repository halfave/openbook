// QA for published Schedule A tables: re-reads each one from the offering plan's page images and compares cell by cell.
// Runs through the local `claude` CLI on your Claude subscription login (any API key in the environment is removed).
//
//   node scripts/qa-schedule-a.mjs PLAN_ID ...       a few plans
//   node scripts/qa-schedule-a.mjs --all             every plan in data/schedule-a/
//   options: --concurrency 3   --python PATH (needs PyMuPDF)   --cache DIR (downloaded PDFs)   --force (redo finished plans)
//            --source pattern|model   --limit N   --call-timeout 600
//   node scripts/qa-schedule-a.mjs --report          summary of data/schedule-a-qa/ (no model calls)
//
// Per plan:
//  1. Render the pages the published table came from, plus the page after the last one (a table the regex parser
//     cut short), at 150 dpi.
//  2. Blind reading: Sonnet transcribes the table from the images, thinking off, without seeing the published values.
//  3. Compare by unit: price, common interest, beds, baths, interior and outdoor sf, monthly charges, taxes, carrying.
//  4. Every disagreement, and every published unit the reading didn't find, goes to Opus with the images and the two
//     candidate values (unlabelled, in random order), which reads the printed value.
//  5. Verdict: "verified" (no published cell is wrong), "errors" (Opus confirmed the published value is wrong in at
//     least one cell; corrections listed), "unresolved" (disagreements Opus couldn't settle), "unreadable".
// Writes data/schedule-a-qa/<ID>.json. Nothing in data/schedule-a/ or the database is changed.
import { spawn } from "node:child_process";
import { mkdir, writeFile, readFile, readdir, access } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { rest, ROOT } from "./site.mjs";

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv.splice(i, 2)[1] : d; };
const flag = (k) => { const i = argv.indexOf(k); return i >= 0 ? (argv.splice(i, 1), true) : false; };
// --pub DIR / --out DIR check another set of tables in the same format (held readings, via qa-schedule-a-held.mjs).
const PUB = opt("--pub", join(ROOT, "data", "schedule-a"));
const OUT = opt("--out", join(ROOT, "data", "schedule-a-qa"));
const CONC = Number(opt("--concurrency", 3));
const PY = opt("--python", process.env.PYTHON || "python");
const CACHE = opt("--cache", join(tmpdir(), "openbook-plans"));
const CALL_TIMEOUT = Number(opt("--call-timeout", 600)) * 1000;
const SOURCE = opt("--source", null), LIMIT = Number(opt("--limit", 0));
const FORCE = flag("--force"), ALL = flag("--all"), REPORT = flag("--report");

// ---------- model calls (same setup as extract-schedule-a-llm.mjs) ----------
const { ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, ...BASE_ENV } = process.env;
const run = (cmd, args, input, env = {}, timeout = 0) => new Promise((res, rej) => {
  const p = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"], env: { ...BASE_ENV, ...env } });
  let o = "", e = "", timedOut = false;
  const timer = timeout ? setTimeout(() => { timedOut = true; p.kill(); }, timeout) : null;
  p.stdout.on("data", (d) => (o += d)); p.stderr.on("data", (d) => (e += d));
  p.on("error", rej);
  p.on("close", (c) => {
    if (timer) clearTimeout(timer);
    if (timedOut) rej(Object.assign(new Error(`timed out after ${timeout / 1000}s`), { timeout: true }));
    else if (c === 0) res(o); else rej(new Error(`${cmd} exited ${c}: ${(e || o).slice(0, 300)}`));
  });
  if (input != null) p.stdin.end(input); else p.stdin.end();
});
const hash = (s) => createHash("sha1").update(s).digest("hex").slice(0, 12);
const exists = (f) => access(f).then(() => true, () => false);
const WIN_BIN = join(process.env.APPDATA || "", "npm", "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe");
const CLAUDE = process.env.CLAUDE_BIN || (process.platform === "win32" && (await exists(WIN_BIN)) ? WIN_BIN : "claude");
const SYSTEM = "You transcribe tables from New York condominium offering plans exactly. Output only what is asked, no commentary.";

async function ask(tally, model, prompt, images, dir) {
  const args = ["-p", "--model", model, "--system-prompt", SYSTEM, "--strict-mcp-config", "--no-session-persistence",
    "--setting-sources", "", "--output-format", "json", "--tools", "Read", "--allowedTools", "Read",
    "--max-turns", String(images.length + 3), "--add-dir", dir];
  let j;
  for (let t = 0; ; t++) {
    try { j = JSON.parse(await run(CLAUDE, args, prompt, { MAX_THINKING_TOKENS: "0" }, CALL_TIMEOUT)); if (!j.is_error) break; throw new Error(`model error: ${String(j.result).slice(0, 200)}`); }
    catch (e) {
      // Usage limits: wait them out rather than burn through the list.
      if (/limit|rate|overloaded|529|429/i.test(e.message) && t < 12) { console.log(`  [${model}] ${e.message.slice(0, 120)}; waiting 10 min`); await new Promise((r) => setTimeout(r, 600000)); continue; }
      if (e.timeout || t >= 2) throw e;
      await new Promise((r) => setTimeout(r, 5000 * (t + 1)));
    }
  }
  const u = j.usage || {};
  tally.tokens += (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.output_tokens || 0);
  tally.calls++;
  return String(j.result || "");
}

// ---------- PDF pages ----------
async function pdfFor(id) {
  const f = join(CACHE, id + ".pdf");
  if (await exists(f)) return f;
  const docs = await rest(`documents?select=pdf_url&plan_id=eq.${id}&doc_kind=eq.offering_plan&status=eq.done&pdf_url=not.is.null&limit=1`);
  const url = docs[0]?.pdf_url;
  if (!url) return null;
  const r = await fetch(url);
  if (!r.ok) return null;
  await mkdir(CACHE, { recursive: true });
  await writeFile(f, Buffer.from(await r.arrayBuffer()));
  return f;
}
const pageCount = async (pdf) => Number((await run(PY, [join(ROOT, "scripts", "render-pages.py"), pdf, "count"])).trim());
const render = async (pdf, id, dpi, nums) => (await run(PY, [join(ROOT, "scripts", "render-pages.py"), pdf, join(CACHE, id), String(dpi), ...nums.map(String)]))
  .trim().split(/\r?\n/).filter(Boolean);

// ---------- blind reading ----------
// Fewer columns than the extractor: only what the site shows. Tax is the scenario the carrying charges use.
const COLS = ["unit", "beds", "baths", "int_sf", "ext_sf", "price", "pct", "pct2", "cc_m", "tax_m", "carry_m", "page"];
const RULES = `Transcribe the Schedule A table (unit prices and related information) on these pages. Copy numbers exactly as printed; never compute or guess.

Output one line per unit, tab-separated, exactly ${COLS.length} cells after "U":
U<TAB>${COLS.join("<TAB>")}
Write - for any cell that is blank, "N/A", or not in the table. Never leave a cell out.
Example: U<TAB>2B<TAB>2<TAB>2<TAB>1235<TAB>223<TAB>1690000<TAB>4.25<TAB>-<TAB>1536.78<TAB>1193.61<TAB>2730.39<TAB>37
After the units: PROBLEM<TAB>text   (one line per thing you could not read or were unsure of)
If there is no Schedule A price table on these pages, output only: NOTFOUND

Rules:
- Include every unit row on these pages: residential, commercial, parking, storage. Skip total and subtotal rows.
- unit exactly as printed.
- beds/baths only when the table states them. Studio = 0 beds. A half bath counts 0.5 ("2 full & 1 half" = 2.5, "3-1/2" = 3.5). Never derive bedrooms from a room count.
- int_sf: interior/habitable/net square feet. If a second area figure is printed (gross, cellar), do not use it here.
- ext_sf: terrace/balcony/yard/roof area, when one number is printed for it; otherwise -. Never the combined interior + outdoor total.
- price: offering/purchase price. pct: percentage of common interest. pct2: a second common-interest column if one is printed (e.g. residential only), else -.
- cc_m: monthly common charges. tax_m: monthly real estate taxes; if two tax scenarios are printed, the one the carrying-charge column adds up with (else the first). Annual-only figures: write -.
- carry_m: total monthly carrying charges, only if printed.
- page: the PDF PAGE number of the row (given with each image).
- Write numbers without $ , or % (1690000, 4.25).`;

const numOrNull = (s) => { const t = String(s ?? "").replace(/[$,%\s]/g, ""); return t === "" || !/^-?\d*\.?\d+$/.test(t) ? null : Number(t); };
function parse(text) {
  const o = { units: [], problems: [], bad_rows: 0, notfound: /^\s*NOTFOUND\s*$/m.test(text) };
  for (let line of text.replace(/\r/g, "").split("\n")) {
    if (!line.includes("\t") && line.includes("|")) line = line.split("|").map((x) => x.trim()).join("\t");
    const c = line.split("\t");
    if (c[0].trim() === "U") {
      if (c.length !== COLS.length + 1) { o.bad_rows++; o.problems.push(`row with ${c.length - 1} cells: ${line.slice(0, 80)}`); continue; }
      const u = Object.fromEntries(COLS.map((n, i) => [n, (c[i + 1] ?? "").trim().replace(/^-$/, "")]));
      for (const n of COLS.slice(1)) u[n] = numOrNull(u[n]);
      if (u.unit) o.units.push(u);
    } else if (c[0].trim() === "PROBLEM" && c[1]) o.problems.push(c.slice(1).join(" ").trim());
  }
  return o;
}

// ---------- comparison ----------
// Published field ← reading field.
const FIELDS = [["price", "price"], ["pct", "pct"], ["beds", "beds"], ["baths", "baths"], ["sqft", "int_sf"], ["outdoor_sqft", "ext_sf"], ["cc_m", "cc_m"], ["tax_m", "tax_m"], ["carry_m", "carry_m"]];
const key = (s) => String(s).toUpperCase().replace(/[*†‡+]/g, "").replace(/^(UNIT|APT\.?)\s*/, "").replace(/[\s\-.#]/g, "").replace(/^0+(?=\d)/, "");
const same = (f, a, b) => {
  if (a == null || b == null) return a == b;
  if (f === "pct") return Math.abs(a - b) <= 0.0006 + 1e-9 || Math.abs(a - b) / Math.max(a, b) < 0.0002;
  if (["cc_m", "tax_m", "carry_m"].includes(f)) return Math.abs(a - b) <= 0.011;
  return Math.abs(a - b) < 0.5;
};
// Matching a published row to a read row, in order of preference:
//  1. the same label (each read row used once, so repeated published labels can't all match one row);
//  2. a label that extends the published one ("6A" ↔ "6A B RT", where B and RT are outdoor-space codes), same price;
//  3. a different label at the same price on the same page, when that price is unique on both sides ("46" ↔ "4B").
// 2 counts as a label difference only when the published labels repeat (published "4" four times for 4A-4D);
// otherwise it's noted as a variant. 3 always goes to adjudication.
const ANCILLARY = /\b(STORAGE|PARKING|GARAGE|SPACE|BIKE|BICYCLE|LOCKER|WINE|CABANA)\b|^(SL|SU|PS|P|S|B)[\s-]?\d/i;
function compare(pub, read) {
  const used = new Set();
  const free = () => read.filter((r) => !used.has(r));
  const counts = new Map(); for (const p of pub) counts.set(key(p.unit), (counts.get(key(p.unit)) || 0) + 1);
  const diffs = [], missing = [], extra = [], variants = [];
  let cells = 0, agree = 0;
  const pairs = new Map();
  // Pass 1: exact labels; with repeated labels, prefer the row at the same price.
  for (const p of pub) {
    const c = free().filter((r) => key(r.unit) === key(p.unit));
    const r = c.find((r) => same("price", r.price, p.price)) || (counts.get(key(p.unit)) > 1 ? null : c[0]);
    if (r) { used.add(r); pairs.set(p, r); }
  }
  // Pass 2: extended labels at the same price.
  for (const p of pub) {
    if (pairs.has(p)) continue;
    const k = key(p.unit);
    const rk = (r) => key(r.unit);
    const c = free().filter((r) => (rk(r).startsWith(k) || rk(r).endsWith(k) || k.startsWith(rk(r))) && same("price", r.price, p.price));
    if (!c.length) continue;
    used.add(c[0]); pairs.set(p, c[0]);
    // The printed label extends the published one: a variant. The published one is longer ("PH 3" for "PH"): a difference.
    if (counts.get(k) > 1 || rk(c[0]).length < k.length) diffs.push({ unit: p.unit, field: "unit", published: p.unit, read: c[0].unit, kind: "differs", page: c[0].page ?? p.page });
    else variants.push({ published: p.unit, read: c[0].unit });
  }
  // Pass 3: same unique price, same page.
  for (const p of pub) {
    if (pairs.has(p) || p.price == null) continue;
    const c = free().filter((r) => same("price", r.price, p.price) && (!r.page || !p.page || r.page === p.page));
    const twins = pub.filter((q) => !pairs.has(q) && same("price", q.price, p.price));
    if (c.length !== 1 || twins.length !== 1) continue;
    used.add(c[0]); pairs.set(p, c[0]);
    diffs.push({ unit: p.unit, field: "unit", published: p.unit, read: c[0].unit, kind: "differs", page: c[0].page ?? p.page });
  }
  for (const p of pub) {
    const r = pairs.get(p);
    if (!r) { missing.push(p.unit); continue; }
    for (const [pf, rf] of FIELDS) {
      const a = p[pf] ?? null, b = r[rf] ?? null;
      if (a == null && b == null) continue;
      if (a == null) { diffs.push({ unit: p.unit, field: pf, published: null, read: b, kind: "not_published", page: r.page ?? p.page }); continue; }
      cells++;
      // Two common-interest columns (whole building / residential only): either one is a correct reading.
      if (same(pf, a, b) || (pf === "pct" && same(pf, a, r.pct2))) agree++;
      else diffs.push({ unit: p.unit, field: pf, published: a, read: b, kind: b == null ? "not_read" : "differs", page: r.page ?? p.page });
    }
  }
  // Rows the reading found that weren't published. Unpriced rows ("not offered for sale") and parking/storage/other
  // ancillary rows are listed, not counted as errors: the published tables often cover homes only.
  const seen = new Set(), unpriced = [], ancillary = [];
  for (const r of free()) {
    if (seen.has(key(r.unit))) continue;
    seen.add(key(r.unit));
    const row = { unit: r.unit, price: r.price, page: r.page };
    (!r.price ? unpriced : ANCILLARY.test(r.unit) || r.price < 100000 ? ancillary : extra).push(row);
  }
  return { cells, agree, diffs, missing, extra, unpriced, ancillary, variants };
}

// ---------- adjudication ----------
const LABEL = { price: "offering price", pct: "percentage of common interest", beds: "bedrooms", baths: "bathrooms (half = .5)", sqft: "interior square feet",
  outdoor_sqft: "outdoor (terrace/balcony) square feet", cc_m: "monthly common charges", tax_m: "monthly real estate taxes (the scenario the carrying charges use)", carry_m: "monthly carrying charges" };
async function adjudicate(tally, imgs, nums, dir, items) {
  const lines = items.map((d, i) => {
    if (d.kind === "missing") return `${i + 1}. Is there a row for unit "${d.unit}" in the table? If so, its offering price.`;
    if (d.kind === "extra") return `${i + 1}. Is there a row for unit "${d.unit}" in the unit table (not a total)? If so, its offering price.`;
    const cands = [d.published, d.read].filter((x) => x != null).sort(() => Math.random() - 0.5);
    if (d.field === "unit") return `${i + 1}. The unit label of a row${d.page ? ` on PDF page ${d.page}` : ""}: is it printed "${cands[0]}" or "${cands[1]}"? Put the label exactly as printed in "printed" (a string).`;
    return `${i + 1}. Unit "${d.unit}", ${LABEL[d.field]}${d.page ? ` (around PDF page ${d.page})` : ""}. Candidate readings: ${cands.join(" or ")}${cands.length < 2 ? " or blank" : ""}.`;
  });
  const prompt = `Two transcriptions of this Schedule A table disagree on the cells below. Read each one carefully on the page images (zoom in mentally on the exact row and column) and report what is printed. A candidate may be wrong, or both may be. Report what is printed, even when it breaks the pattern of neighbouring rows or doesn't add up; never infer a value from other rows or arithmetic. If you can't make out the print, set "sure" to false.
Page images (read each with the Read tool): ${imgs.map((p, i) => `${p} (PDF PAGE ${nums[i]})`).join("; ")}.

${lines.join("\n")}

Reply with JSON only: {"answers": [{"n": 1, "printed": <the number exactly as printed, without $ , or %; null if the cell is blank, N/A or the row doesn't exist>, "row_exists": true|false, "sure": true|false, "why": "<short>"} , ...]}`;
  const txt = await ask(tally, "opus", prompt, imgs, dir);
  try { return JSON.parse(txt.match(/\{[\s\S]*\}/)[0]).answers || []; } catch { return []; }
}

// ---------- per plan ----------
async function qa(id) {
  // data/schedule-a/ is rebuilt (deleted and rewritten) after each extraction batch; a plan can vanish or change mid-run.
  const raw = await readFile(join(PUB, id + ".json"), "utf8").catch(() => null);
  if (raw == null) return { plan_id: id, verdict: "not_published", reason: "no longer in data/schedule-a/" };
  const pub = JSON.parse(raw);
  const tally = { calls: 0, tokens: 0 };
  const base = { plan_id: id, source: pub.source, checked: pub.checked || null, units_published: pub.units.length, pub_hash: hash(raw) };
  const pdf = await pdfFor(id).catch(() => null);
  if (!pdf) return { ...base, verdict: "unreadable", reason: "no PDF" };
  const count = await pageCount(pdf);
  let pages = [...new Set((pub.pages?.length ? pub.pages : pub.units.map((u) => u.page)).filter(Boolean))].sort((a, b) => a - b);
  if (!pages.length) return { ...base, verdict: "unreadable", reason: "published table has no page numbers" };
  // Fill gaps, and add the page after (a continuation the original parse missed).
  const lo = pages[0], hi = Math.min(count, pages.at(-1) + 1);
  pages = [...Array(hi - lo + 1).keys()].map((k) => lo + k).slice(0, 12);
  const dir = join(CACHE, id);
  const imgs = await render(pdf, id, 150, pages);
  // Calls are sized by rows: a call that has to write out too many rows stops early. Up to ~35 published rows and
  // 3 pages a call; a dense page gets a call of its own.
  const per = new Map(); for (const u of pub.units) if (u.page) per.set(u.page, (per.get(u.page) || 0) + 1);
  const groups = [];
  for (let k = 0; k < pages.length; k++) {
    const g = groups.at(-1), n = per.get(pages[k]) ?? 15;
    if (g && g.idx.length < 3 && g.rows + n <= 35) { g.idx.push(k); g.rows += n; } else groups.push({ idx: [k], rows: n });
  }
  const read = { units: [], problems: [], bad_rows: 0 };
  for (const g of groups) {
    const ci = g.idx.map((k) => imgs[k]), cn = g.idx.map((k) => pages[k]);
    const o = parse(await ask(tally, "sonnet", `${RULES}\n\nRead each page image with the Read tool: ${ci.map((p, i) => `${p} (PDF PAGE ${cn[i]})`).join("; ")}.`, ci, dir));
    read.units.push(...o.units); read.problems.push(...o.problems); read.bad_rows += o.bad_rows;
  }
  // A page that came back well short of what was published is read again on its own.
  for (const [pg, n] of per) {
    const got = read.units.filter((u) => u.page === pg).length, k = pages.indexOf(pg);
    if (k < 0 || got >= n - 3) continue;
    const o = parse(await ask(tally, "sonnet", `${RULES}\n\nRead the page image with the Read tool: ${imgs[k]} (PDF PAGE ${pg}).`, [imgs[k]], dir));
    if (o.units.length > got) { read.units = read.units.filter((u) => u.page !== pg).concat(o.units.map((u) => ({ ...u, page: pg }))); read.problems.push(...o.problems); }
  }
  if (!read.units.length) return { ...base, verdict: "unreadable", reason: "the reading found no table on the published pages", pages, problems: read.problems, ...tally };
  const cmp = compare(pub.units, read.units);
  // Adjudicate: disagreements on published values, published units not found, units found but not published.
  const items = [
    ...cmp.diffs.filter((d) => d.kind !== "not_published"),
    ...cmp.missing.map((unit) => ({ unit, kind: "missing", page: pub.units.find((u) => u.unit === unit)?.page })),
    ...cmp.extra.map((e) => ({ unit: e.unit, kind: "extra", read: e.price, page: e.page })),
  ];
  const findings = [];
  for (let s = 0; s < items.length && s < 120; s += 30) {
    const batch = items.slice(s, s + 30);
    // Only the pages these items sit on, when known; else all.
    const want = new Set(batch.map((d) => d.page).filter(Boolean));
    const idx = want.size ? pages.map((p, i) => (want.has(p) ? i : -1)).filter((i) => i >= 0) : pages.map((_, i) => i);
    const use = idx.length ? idx : pages.map((_, i) => i);
    const ans = await adjudicate(tally, use.map((i) => imgs[i]), use.map((i) => pages[i]), dir, batch).catch((e) => (console.log(`  ${id} adjudication failed: ${e.message.slice(0, 100)}`), []));
    batch.forEach((d, i) => {
      const a = ans.find((x) => Number(x.n) === i + 1);
      const printed = !a ? undefined : d.field === "unit" ? (a.printed == null ? null : String(a.printed)) : numOrNull(a.printed);
      let outcome;
      if (!a || a.sure === false) outcome = "unresolved";
      else if (d.kind === "missing") outcome = a.row_exists === false ? "published_unit_not_in_table" : "ok";
      else if (d.kind === "extra") outcome = a.row_exists === false ? "ok" : "unit_missing_from_published";
      else if (d.field === "unit") outcome = printed == null ? "unresolved" : key(printed) === key(d.published) ? "ok" : "published_wrong";
      else outcome = same(d.field, d.published, printed) ? "ok" : "published_wrong";
      findings.push({ ...d, printed: printed ?? null, outcome, why: a?.why || null });
    });
  }
  const errors = findings.filter((f) => ["published_wrong", "published_unit_not_in_table", "unit_missing_from_published"].includes(f.outcome));
  const unresolved = findings.filter((f) => f.outcome === "unresolved").length + Math.max(0, items.length - 120);
  const verdict = errors.length ? "errors" : unresolved ? "unresolved" : "verified";
  return { ...base, verdict, pages, units_read: read.units.length, cells_compared: cmp.cells, cells_agreeing: cmp.agree,
    errors: errors.length, unresolved, findings, unpriced_rows: cmp.unpriced, ancillary_rows: cmp.ancillary, label_variants: cmp.variants, filled_by_reading: cmp.diffs.filter((d) => d.kind === "not_published").length,
    read_problems: read.problems.slice(0, 20), read_units: read.units, ...tally };
}

// ---------- report ----------
async function report() {
  const files = (await readdir(OUT)).filter((f) => f.endsWith(".json"));
  const rs = await Promise.all(files.map(async (f) => JSON.parse(await readFile(join(OUT, f), "utf8"))));
  const by = {}, bySrc = {}, fieldErr = {}, kinds = {};
  let cells = 0, agree = 0, tok = 0;
  for (const r of rs) {
    by[r.verdict] = (by[r.verdict] || 0) + 1;
    const s = `${r.source}${r.checked ? ":" + r.checked : ""}`;
    (bySrc[s] ||= {})[r.verdict] = (bySrc[s][r.verdict] || 0) + 1;
    cells += r.cells_compared || 0; agree += r.cells_agreeing || 0; tok += r.tokens || 0;
    for (const f of r.findings || []) if (f.outcome !== "ok" && f.outcome !== "unresolved") {
      kinds[f.outcome] = (kinds[f.outcome] || 0) + 1;
      if (f.field) fieldErr[f.field] = (fieldErr[f.field] || 0) + 1;
    }
  }
  console.log(`${rs.length} plans checked`, by);
  console.log("by source:", bySrc);
  console.log(`cells: ${agree.toLocaleString()} of ${cells.toLocaleString()} agreed on the blind reading (${(100 * agree / Math.max(cells, 1)).toFixed(2)}%)`);
  console.log("confirmed errors by kind:", kinds);
  console.log("confirmed wrong cells by field:", fieldErr);
  console.log(`${tok.toLocaleString()} tokens`);
}

// ---------- main ----------
if (REPORT) { await report(); process.exit(0); }
await mkdir(OUT, { recursive: true });
let ids = argv;
if (ALL) {
  const pubs = (await readdir(PUB)).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5));
  ids = [];
  for (const id of pubs) {
    if (SOURCE) { const j = JSON.parse(await readFile(join(PUB, id + ".json"), "utf8")); if (j.source !== SOURCE) continue; }
    ids.push(id);
  }
}
if (LIMIT) ids = ids.slice(0, LIMIT);
let i = 0, errStreak = 0, done = 0;
async function worker() {
  while (i < ids.length) {
    if (errStreak >= 8) { console.log(`stopping: ${errStreak} errors in a row; re-run to resume`); i = ids.length; break; }
    const id = ids[i++];
    const f = join(OUT, id + ".json");
    // Finished plans are skipped unless the published table has changed since (or the last try errored).
    if (!FORCE && (await exists(f))) {
      const prev = JSON.parse(await readFile(f, "utf8"));
      const now = await readFile(join(PUB, id + ".json"), "utf8").catch(() => null);
      if (prev.verdict !== "error" && (!prev.pub_hash || !now || hash(now) === prev.pub_hash)) continue;
    }
    let r;
    try { r = await qa(id); errStreak = 0; }
    catch (e) { r = { plan_id: id, verdict: "error", reason: e.message.slice(0, 300) }; errStreak++; }
    await writeFile(f, JSON.stringify({ ...r, qa_date: new Date().toISOString() }, null, 1));
    done++;
    console.log(`${String(done).padStart(4)}/${ids.length} ${id} ${String(r.source || "").padEnd(7)} ${r.verdict.padEnd(10)} ${r.cells_agreeing ?? "-"}/${r.cells_compared ?? "-"} cells  ${r.errors ?? 0} errors  ${r.unresolved ?? 0} unresolved  ${r.tokens ?? 0} tok${r.reason ? "  (" + r.reason + ")" : ""}`);
  }
}
await Promise.all(Array.from({ length: CONC }, worker));
await report();
