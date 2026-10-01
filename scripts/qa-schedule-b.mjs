// QA for Schedule B budgets (schedule_b, status ok): re-reads each budget from the offering plan's page images and
// compares it line by line with what is stored, then has Opus read every line the two disagree on.
//
//   node scripts/qa-schedule-b.mjs --all [--status ok|partial] [--concurrency 3]   every budget with that status
//   node scripts/qa-schedule-b.mjs PLAN_ID ...
//   node scripts/qa-schedule-b.mjs --report
//
// Per plan:
//  1. Render the stored budget's pages (150 dpi), at most 8.
//  2. Blind reading: Sonnet lists every line item with its first-year annual amount, and the printed totals.
//  3. Match stored items to read items: same page and name, then same name, then same amount on the same page.
//  4. Opus reads each disagreement (amount differs, stored line not found, total differs) with both candidates unlabelled.
//  5. Verdict: verified / errors (a stored amount or total is confirmed wrong, or a stored line doesn't exist) /
//     unresolved / unreadable. Writes data/schedule-b-qa/<ID>.json. Nothing in the database changes.
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { all, ROOT } from "./site.mjs";
import { ask, jsonIn, pdfFor, pageCount, render, numOrNull, pool, CACHE } from "./qa-lib.mjs";

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv.splice(i, 2)[1] : d; };
const flag = (k) => { const i = argv.indexOf(k); return i >= 0 ? (argv.splice(i, 1), true) : false; };
const OUT = join(ROOT, "data", "schedule-b-qa");
const CONC = Number(opt("--concurrency", 3)), STATUS = opt("--status", "ok");
const ALL = flag("--all"), REPORT = flag("--report");

const RULES = `Transcribe the condominium's first-year operating budget (Schedule B) on these pages. Copy amounts exactly as printed; never compute.

Output tab-separated lines only:
L<TAB>budget<TAB>section<TAB>item<TAB>amount<TAB>page
T<TAB>budget<TAB>total_income or total_expenses<TAB>amount<TAB>page
PROBLEM<TAB>text   (anything you could not read or were unsure of)
If there is no budget on these pages, output only: NOTFOUND

Rules:
- One L line per printed line item that has an amount, including subtotals and totals as printed (e.g. "Total Payroll", "Estimated Total Expenses").
- budget: the budget the line belongs to, as titled ("Condominium", "Residential", "Commercial", "Garage"); "Condominium" if there is only one.
- section: Income or Expenses.
- item: the line's label as printed, without footnote numbers.
- amount: the first-year ANNUAL amount. If a line prints monthly and annual amounts, use the annual one. A per-unit or per-square-foot column is not the amount. Negative or bracketed amounts: write -1234.
- T lines: the printed total income and total expenses for each budget.
- page: the PDF PAGE number of the line (given with each image).
- Numbers without $ or commas (12345.67).`;

const norm = (s) => String(s || "").toLowerCase().replace(/\(.*?\)|[^a-z0-9 ]/g, " ").replace(/\b(and|the|of|estimated|total|for|a)\b/g, " ").replace(/\s+/g, " ").trim();
const sameAmt = (a, b) => a != null && b != null && Math.abs(a - b) < 0.5;
function parse(text) {
  const o = { items: [], totals: [], problems: [] };
  for (const line of text.replace(/\r/g, "").split("\n")) {
    const c = line.split("\t").map((x) => x.trim());
    if (c[0] === "L" && c.length >= 6) o.items.push({ budget: c[1], section: c[2], item: c[3], amount: numOrNull(c[4]), page: numOrNull(c[5]) });
    else if (c[0] === "T" && c.length >= 5) o.totals.push({ budget: c[1], kind: /income/i.test(c[2]) ? "income" : "expenses", amount: numOrNull(c[3]), page: numOrNull(c[4]) });
    else if (c[0] === "PROBLEM" && c[1]) o.problems.push(c.slice(1).join(" "));
  }
  return o;
}

async function qa(id, row) {
  const tally = { calls: 0, tokens: 0 };
  const stored = (row.line_items || []).filter((x) => x.amount != null);
  const pdf = await pdfFor(id).catch(() => null);
  if (!pdf) return { plan_id: id, verdict: "unreadable", reason: "no PDF" };
  const count = await pageCount(pdf);
  let pages = [...new Set([...(row.pages || []), ...stored.map((x) => x.page)].filter((p) => p && p <= count))].sort((a, b) => a - b);
  if (!pages.length) return { plan_id: id, verdict: "unreadable", reason: "stored budget has no page numbers" };
  // Notes pages hold few amounts; the line-item pages are the ones with stored items.
  const withItems = pages.filter((p) => stored.some((x) => x.page === p));
  pages = (withItems.length ? withItems : pages).slice(0, 8);
  const dir = join(CACHE, id);
  const imgs = await render(pdf, id, 150, pages);
  const read = { items: [], totals: [], problems: [] };
  for (let s = 0; s < imgs.length; s += 2) {
    const ci = imgs.slice(s, s + 2), cn = pages.slice(s, s + 2);
    const o = parse(await ask(tally, "sonnet", `${RULES}\n\nRead each page image with the Read tool: ${ci.map((p, i) => `${p} (PDF PAGE ${cn[i]})`).join("; ")}.`, ci, dir));
    read.items.push(...o.items); read.totals.push(...o.totals); read.problems.push(...o.problems);
  }
  if (!read.items.length) return { plan_id: id, verdict: "unreadable", reason: "the reading found no budget on the stored pages", pages, ...tally };

  // Match stored lines to read lines.
  const used = new Set(), diffs = [];
  let compared = 0, agree = 0;
  for (const x of stored) {
    const n = norm(x.item);
    const free = read.items.filter((r) => !used.has(r));
    const r = free.find((r) => r.page === x.page && norm(r.item) === n && sameAmt(r.amount, x.amount))
      || free.find((r) => norm(r.item) === n && sameAmt(r.amount, x.amount))
      || free.find((r) => r.page === x.page && norm(r.item) === n)
      || free.find((r) => norm(r.item) === n)
      || free.find((r) => r.page === x.page && sameAmt(r.amount, x.amount))
      || free.find((r) => n.length > 3 && (norm(r.item).includes(n) || n.includes(norm(r.item))) && norm(r.item).length > 3);
    if (!r) { diffs.push({ kind: "not_read", item: x.item, stored: x.amount, page: x.page }); continue; }
    used.add(r); compared++;
    if (sameAmt(r.amount, x.amount)) agree++;
    else diffs.push({ kind: "amount", item: x.item, stored: x.amount, read: r.amount, page: x.page || r.page });
  }
  // Stored totals vs printed totals.
  for (const [k, v] of [["expenses", row.total_expenses], ["income", row.total_income]]) {
    if (v == null) continue;
    const t = read.totals.filter((t) => t.kind === k).map((t) => t.amount);
    compared++;
    if (!t.length || t.some((a) => sameAmt(a, Number(v)))) { agree++; continue; }
    diffs.push({ kind: "total", item: `Total ${k}`, stored: Number(v), read: t[0], page: read.totals.find((t) => t.kind === k)?.page });
  }

  // Opus reads each disagreement.
  const findings = [];
  for (let s = 0; s < diffs.length && s < 90; s += 30) {
    const batch = diffs.slice(s, s + 30);
    const want = new Set(batch.map((d) => d.page).filter(Boolean));
    const idx = pages.map((p, i) => (want.size === 0 || want.has(p) ? i : -1)).filter((i) => i >= 0).slice(0, 6);
    const lines = batch.map((d, i) => {
      if (d.kind === "not_read") return `${i + 1}. Is there a line "${d.item}"${d.page ? ` (around PDF page ${d.page})` : ""}? If so, its first-year annual amount.`;
      const c = [d.stored, d.read].filter((x) => x != null).sort(() => Math.random() - 0.5);
      return `${i + 1}. "${d.item}"${d.page ? ` (around PDF page ${d.page})` : ""}: the first-year annual amount. Candidate readings: ${c.join(" or ")}${c.length < 2 ? " or blank" : ""}.`;
    });
    const prompt = `Two transcriptions of this condominium budget disagree on the lines below. Read each one on the page images and report what is printed. A candidate may be wrong, or both may be. Report the print, even when it doesn't add up; never infer from other lines or arithmetic. If you can't make out the print, set "sure" to false.
Page images (read each with the Read tool): ${idx.map((i) => `${imgs[i]} (PDF PAGE ${pages[i]})`).join("; ")}.

${lines.join("\n")}

Reply with JSON only: {"answers": [{"n": 1, "printed": <the annual amount as printed, a number without $ or commas; null if blank or the line doesn't exist>, "line_exists": true|false, "sure": true|false, "why": "<short>"}, ...]}`;
    const ans = (jsonIn(await ask(tally, "opus", prompt, idx.map((i) => imgs[i]), dir).catch(() => "")) || {}).answers || [];
    batch.forEach((d, i) => {
      const a = ans.find((x) => Number(x.n) === i + 1);
      const printed = a ? numOrNull(a.printed) : null;
      let outcome;
      if (!a || a.sure === false) outcome = "unresolved";
      else if (d.kind === "not_read") outcome = a.line_exists === false ? "stored_line_not_in_budget" : sameAmt(printed, d.stored) ? "ok" : printed == null ? "unresolved" : "stored_wrong";
      else outcome = sameAmt(printed, d.stored) ? "ok" : printed == null ? "unresolved" : "stored_wrong";
      findings.push({ ...d, printed, outcome, why: a?.why || null });
    });
  }
  const errors = findings.filter((f) => f.outcome === "stored_wrong" || f.outcome === "stored_line_not_in_budget").length;
  const unresolved = findings.filter((f) => f.outcome === "unresolved").length + Math.max(0, diffs.length - 90);
  const verdict = errors ? "errors" : unresolved ? "unresolved" : "verified";
  return { plan_id: id, verdict, summary: `${agree}/${compared} agree, ${errors} errors, ${unresolved} unresolved`, pages, items_stored: stored.length,
    items_read: read.items.length, compared, agree, errors, unresolved, findings, read_problems: read.problems.slice(0, 15), read, ...tally };
}

if (REPORT) {
  const rs = await Promise.all((await readdir(OUT)).filter((f) => f.endsWith(".json")).map(async (f) => JSON.parse(await readFile(join(OUT, f), "utf8"))));
  const by = {}, kinds = {}; let c = 0, a = 0, tok = 0;
  for (const r of rs) { by[r.verdict] = (by[r.verdict] || 0) + 1; c += r.compared || 0; a += r.agree || 0; tok += r.tokens || 0;
    for (const f of r.findings || []) if (f.outcome !== "ok") kinds[`${f.kind}:${f.outcome}`] = (kinds[`${f.kind}:${f.outcome}`] || 0) + 1; }
  console.log(`${rs.length} budgets`, by, `| ${a}/${c} lines agreed on the blind reading | ${tok.toLocaleString()} tokens`); console.log(kinds);
  process.exit(0);
}
const rows = await all(`schedule_b?select=plan_id,pages,total_income,total_expenses,line_items&status=eq.${STATUS}&order=plan_id`);
const byId = new Map(rows.map((r) => [r.plan_id, r]));
const ids = ALL ? rows.map((r) => r.plan_id) : argv;
await pool(ids, CONC, OUT, (id) => qa(id, byId.get(id)));
