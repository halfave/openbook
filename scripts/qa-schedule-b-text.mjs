// QA for the text in schedule_b (the first-year budget): the budget period, the line-item labels and the footnote
// summaries, checked against the budget pages of the offering plan. Numbers are not checked here.
// Runs through the local `claude` CLI on your Claude subscription login (any API key in the environment is removed).
//
//   node scripts/qa-schedule-b-text.mjs PLAN_ID ...   a few plans
//   node scripts/qa-schedule-b-text.mjs --all         every plan in schedule_b
//   options: --concurrency 4   --force   --limit N   --call-timeout 600
//   node scripts/qa-schedule-b-text.mjs --report      summary + data/schedule-b-text-corrections.json
//
// Per plan: Sonnet checks each claim against the budget pages; anything not marked correct goes to Opus, which sees the
// stored text and Sonnet's suggested fix unlabelled, in random order. Writes data/schedule-b-text-qa/<ID>.json.
// The database is never changed.
import { spawn } from "node:child_process";
import { mkdir, writeFile, readFile, readdir, access } from "node:fs/promises";
import { join } from "node:path";
import { rest, all, ROOT } from "./site.mjs";

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv.splice(i, 2)[1] : d; };
const flag = (k) => { const i = argv.indexOf(k); return i >= 0 ? (argv.splice(i, 1), true) : false; };
const OUT = join(ROOT, "data", "schedule-b-text-qa");
const CONC = Number(opt("--concurrency", 4));
const CALL_TIMEOUT = Number(opt("--call-timeout", 600)) * 1000;
const LIMIT = Number(opt("--limit", 0));
const FORCE = flag("--force"), ALL = flag("--all"), REPORT = flag("--report");

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
const exists = (f) => access(f).then(() => true, () => false);
const WIN_BIN = join(process.env.APPDATA || "", "npm", "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe");
const CLAUDE = process.env.CLAUDE_BIN || (process.platform === "win32" && (await exists(WIN_BIN)) ? WIN_BIN : "claude");
const SYSTEM = "You check facts against New York condominium offering plans. Report only what the pages say. Output only the JSON asked for.";
async function ask(tally, model, prompt) {
  const args = ["-p", "--model", model, "--system-prompt", SYSTEM, "--strict-mcp-config", "--no-session-persistence",
    "--setting-sources", "", "--output-format", "json", "--tools", "", "--max-turns", "1"];
  let j;
  for (let t = 0; ; t++) {
    try { j = JSON.parse(await run(CLAUDE, args, prompt, { MAX_THINKING_TOKENS: "0" }, CALL_TIMEOUT)); if (!j.is_error) break; throw new Error(`model error: ${String(j.result).slice(0, 200)}`); }
    catch (e) {
      if (/limit|rate|overloaded|529|429/i.test(e.message) && t < 30) { console.log(`  [${model}] ${e.message.slice(0, 120)}; waiting 10 min`); await new Promise((r) => setTimeout(r, 600000)); continue; }
      if (t >= 2) throw e;
      await new Promise((r) => setTimeout(r, 5000 * (t + 1)));
    }
  }
  const u = j.usage || {};
  tally.tokens += (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.output_tokens || 0);
  tally.calls++;
  return String(j.result || "");
}
// The first complete JSON object in the reply (models sometimes add a sentence after it, or fence it).
const json = (txt) => {
  const s = String(txt), i = s.indexOf("{");
  if (i < 0) throw new Error("no JSON in reply: " + s.slice(0, 200));
  let depth = 0, str = false, esc = false;
  for (let k = i; k < s.length; k++) {
    const ch = s[k];
    if (str) { if (esc) esc = false; else if (ch === "\\") esc = true; else if (ch === '"') str = false; continue; }
    if (ch === '"') str = true; else if (ch === "{") depth++; else if (ch === "}" && --depth === 0) return JSON.parse(s.slice(i, k + 1));
  }
  throw new Error("unterminated JSON in reply: " + s.slice(0, 200));
};
const shuffle = (a) => a.map((x) => [Math.random(), x]).sort((p, q) => p[0] - q[0]).map((p) => p[1]);
const pageBlock = (pages) => pages.map((p) => `===== ${p.tag}: PDF page ${p.page_no} =====\n${p.body.slice(0, 7000)}`).join("\n\n");

async function qa(row) {
  const tally = { calls: 0, tokens: 0 };
  const items = row.line_items || [], notes = row.notes || [];
  const nums = [...new Set([...(row.pages || []), ...items.map((i) => i.page), ...notes.map((n) => n.page)].filter((n) => Number.isInteger(n)))].sort((a, b) => a - b).slice(0, 14);
  const rows = nums.length ? await rest(`pages?select=page_no,body&file_id=eq.${row.file_id}&page_no=in.(${nums.join(",")})&order=page_no`) : [];
  const pages = rows.filter((r) => (r.body || "").trim()).map((r, i) => ({ tag: `P${i + 1}`, page_no: r.page_no, body: r.body }));
  const base = { plan_id: row.plan_id, checked_at: new Date().toISOString(), pages: pages.map((p) => ({ tag: p.tag, page_no: p.page_no })) };
  if (pages.reduce((s, p) => s + p.body.trim().length, 0) < 300) return { ...base, results: [{ field: "all", verdict: "no_plan_text" }], calls: 0, tokens: 0 };

  const claims = [];
  if (row.budget_period) claims.push({ field: "budget_period", stored: row.budget_period, text: `Budget period: "${row.budget_period}"` });
  const labels = items.map((i) => `${i.section || ""}${i.budget && i.budget !== "Condominium" ? ` (${i.budget} budget)` : ""}: ${i.item}${i.note ? ` [note ${i.note}]` : ""}`);
  labels.forEach((l, k) => claims.push({ field: "line_item", idx: k, stored: items[k].item, text: `Line item label — ${l}` }));
  notes.forEach((n, k) => claims.push({ field: "note", idx: k, stored: { n: n.n, title: n.title, summary: n.summary }, text: `Footnote ${n.n} "${n.title}" (p. ${n.page}): ${n.summary}` }));
  claims.forEach((c, i) => (c.n = i + 1));

  const prompt = `Below are the budget pages (Schedule B) of a New York condominium offering plan (text extracted from the PDF; OCR may have errors), then claims a database makes about that budget. Check each claim strictly against the pages. Ignore dollar amounts in line items (not checked here), but a footnote summary's numbers, names and facts must all match the footnote.

- "correct": the pages support it (labels may differ in capitalization/punctuation or be lightly shortened; footnote summaries may paraphrase).
- "minor": right idea, but noticeably misworded or a name misspelled. Give the correction in "fix".
- "wrong": contradicted, attributed to the wrong footnote/line, or states something the footnote doesn't say (wrong number, wrong firm, wrong date). Give the correction in "fix".
- "unverifiable": these pages don't cover it.

${pageBlock(pages)}

===== CLAIMS =====
${claims.map((c) => `${c.n}. ${c.text}`).join("\n")}

Reply with JSON only: {"claims": [{"n": 1, "verdict": "correct|minor|wrong|unverifiable", "fix": "..." or null, "why": "<short>"}, ...]}  (you may omit claims that are correct)`;
  const checked = json(await ask(tally, "sonnet", prompt)).claims || [];
  for (const c of claims) c.check = checked.find((x) => Number(x.n) === c.n) || { verdict: "correct", implicit: true };

  const flagged = claims.filter((c) => c.check.verdict !== "correct");
  for (let i = 0; i < flagged.length; i += 15) {
    const chunk = flagged.slice(i, i + 15).map((c) => {
      const stored = typeof c.stored === "string" ? c.stored : `${c.stored.title}: ${c.stored.summary}`;
      const cands = [stored]; if (c.check.fix && c.check.fix !== stored) cands.push(String(c.check.fix));
      const order = shuffle(cands.map((x, k) => ({ x, stored: k === 0 })));
      c.cands = order.map((o) => o.x); c.storedLetter = String.fromCharCode(65 + order.findIndex((o) => o.stored));
      return c;
    });
    const jp = `Below are the budget pages (Schedule B) of a New York condominium offering plan (text extracted from the PDF; OCR may have errors). For each question, readings disagree. Decide from the pages only; a candidate may be wrong, or all may be. Ignore dollar amounts of line items, but a footnote summary's numbers, names and facts must match the footnote.

${pageBlock(pages)}

===== QUESTIONS =====
${chunk.map((c, k) => `${k + 1}. ${c.field === "note" ? `Footnote ${c.stored.n} — which summary is accurate?` : c.field === "budget_period" ? "The budget period" : `Line item label (${c.text.replace(/^Line item label — /, "")})`}\n   Candidates: ${c.cands.map((x, m) => `(${String.fromCharCode(65 + m)}) "${x}"`).join("  ")}`).join("\n")}

For each: "accurate": letters of every accurate candidate (paraphrase is fine if every fact is right); "close": letters that are right but noticeably misworded/misspelled; "printed": the correct value (for a footnote, a short accurate summary) or null if the pages don't say; "sure": false if you can't tell.
Reply with JSON only: {"answers": [{"n": 1, "accurate": [], "close": [], "printed": "...", "sure": true, "why": "<short>"}, ...]}`;
    const ans = json(await ask(tally, "opus", jp)).answers || [];
    chunk.forEach((c, k) => (c.judge = ans.find((a) => Number(a.n) === k + 1) || null));
  }
  const results = claims.map((c) => {
    const r = { field: c.field, idx: c.idx, stored: c.stored, check: c.check };
    if (c.check.verdict === "correct") return { ...r, verdict: "verified" };
    const j = c.judge; r.judge = j; r.candidates = c.cands;
    if (!j) return { ...r, verdict: "unresolved" };
    const acc = (j.accurate || []).map(String), close = (j.close || []).map(String);
    r.printed = j.printed ?? null;
    r.verdict = acc.includes(c.storedLetter) ? "verified" : j.sure === false ? "unresolved" : close.includes(c.storedLetter) ? "minor" : j.printed == null ? "unsupported" : "wrong";
    return r;
  });
  return { ...base, results, calls: tally.calls, tokens: tally.tokens };
}

async function report() {
  const files = (await readdir(OUT).catch(() => [])).filter((f) => f.endsWith(".json"));
  const tot = {}, byField = {}, corrections = [];
  for (const f of files) {
    const r = JSON.parse(await readFile(join(OUT, f), "utf8"));
    for (const x of r.results || []) {
      tot[x.verdict] = (tot[x.verdict] || 0) + 1;
      byField[x.field] ??= {}; byField[x.field][x.verdict] = (byField[x.field][x.verdict] || 0) + 1;
      if (["wrong", "minor", "unsupported"].includes(x.verdict)) corrections.push({ plan_id: r.plan_id, field: x.field, idx: x.idx, verdict: x.verdict, from: x.stored, to: x.printed, why: x.judge?.why });
    }
  }
  await writeFile(join(ROOT, "data", "schedule-b-text-corrections.json"), JSON.stringify({ generated: new Date().toISOString(), corrections }, null, 1));
  console.log(`${files.length} plans`, tot); console.table(byField);
  console.log(`${corrections.length} proposed corrections → data/schedule-b-text-corrections.json`);
}

if (REPORT) { await report(); process.exit(0); }
await mkdir(OUT, { recursive: true });
let rows = await all("schedule_b?select=plan_id,file_id,pages,budget_period,line_items,notes&order=plan_id");
if (!ALL) rows = rows.filter((r) => argv.includes(r.plan_id));
if (!FORCE) { const done = new Set((await readdir(OUT)).map((f) => f.replace(/\.json$/, ""))); rows = rows.filter((r) => !done.has(r.plan_id)); }
if (LIMIT) rows = rows.slice(0, LIMIT);
console.log(`${rows.length} budgets to check`);
let next = 0, n = 0, tokens = 0;
const t0 = Date.now();
await Promise.all(Array.from({ length: CONC }, async () => {
  while (next < rows.length) {
    const row = rows[next++];
    try {
      const r = await qa(row);
      await writeFile(join(OUT, row.plan_id + ".json"), JSON.stringify(r, null, 1));
      tokens += r.tokens;
      const v = {}; for (const x of r.results) v[x.verdict] = (v[x.verdict] || 0) + 1;
      console.log(`${++n}/${rows.length} ${row.plan_id} ${JSON.stringify(v)} ${r.calls} calls ${(r.tokens / 1000).toFixed(0)}k  [${((Date.now() - t0) / 60000).toFixed(0)} min, ${(tokens / 1e6).toFixed(1)}M]`);
    } catch (e) { console.log(`${++n}/${rows.length} ${row.plan_id} ERROR ${e.message.slice(0, 200)}`); }
  }
}));
console.log("done");
