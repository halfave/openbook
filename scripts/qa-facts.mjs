// QA for the text facts in the database: consultants (architect, selling agent, managing agent, tax consultant, sponsor's
// counsel), the other text facts (sponsor address, working capital, reserve fund, parking, tax program, affordable
// housing), sponsor principals, and each plan's sponsor and law firm, checked against the offering plan's own pages.
// Runs through the local `claude` CLI on your Claude subscription login (any API key in the environment is removed).
//
//   node scripts/qa-facts.mjs PLAN_ID ...       a few plans
//   node scripts/qa-facts.mjs --all             every plan with facts or sponsor principals
//   options: --concurrency 4   --force (redo finished plans)   --limit N   --call-timeout 600
//            --python PATH (PyMuPDF, for page images when the text layer is garbled)   --cache DIR (downloaded PDFs)
//   node scripts/qa-facts.mjs --report          summary + data/facts-corrections.json (no model calls)
//
// Per plan:
//  1. Quotes: each fact's quote must be on the page it cites (the stored page text); if not, find the page it is on.
//  2. Blind reading: Sonnet, not shown the stored values, names each consultant and the sponsor from the cited pages,
//     the cover pages and the pages that introduce each role.
//  3. Claim check: Sonnet checks every stored text value against its cited page, strictly.
//  4. Every disagreement (blind name ≠ stored, or a claim not marked correct) goes to Opus with the pages and the
//     candidate values unlabelled, in random order. Opus decides; when the text layer is too garbled to tell, it is
//     asked again with the page images.
// Writes data/facts-qa/<ID>.json. The database is never changed; --report writes proposed corrections, each with the
// value it replaces, the printed value, page and quote.
import { spawn } from "node:child_process";
import { mkdir, writeFile, readFile, readdir, access } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rest, all, ROOT } from "./site.mjs";

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv.splice(i, 2)[1] : d; };
const flag = (k) => { const i = argv.indexOf(k); return i >= 0 ? (argv.splice(i, 1), true) : false; };
const OUT = join(ROOT, "data", "facts-qa");
const CONC = Number(opt("--concurrency", 4));
const PY = opt("--python", process.env.PYTHON || "python");
const CACHE = opt("--cache", join(tmpdir(), "openbook-plans"));
const CALL_TIMEOUT = Number(opt("--call-timeout", 600)) * 1000;
const LIMIT = Number(opt("--limit", 0));
const FORCE = flag("--force"), ALL = flag("--all"), REPORT = flag("--report");

// ---------- model calls (same setup as qa-schedule-a.mjs) ----------
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

async function ask(tally, model, prompt, images = [], dir = null) {
  const args = ["-p", "--model", model, "--system-prompt", SYSTEM, "--strict-mcp-config", "--no-session-persistence",
    "--setting-sources", "", "--output-format", "json"];
  if (images.length) args.push("--tools", "Read", "--allowedTools", "Read", "--max-turns", String(images.length + 3), "--add-dir", dir);
  else args.push("--tools", "", "--max-turns", "1");
  let j;
  for (let t = 0; ; t++) {
    try { j = JSON.parse(await run(CLAUDE, args, prompt, { MAX_THINKING_TOKENS: "0" }, CALL_TIMEOUT)); if (!j.is_error) break; throw new Error(`model error: ${String(j.result).slice(0, 200)}`); }
    catch (e) {
      // Usage limits: wait them out rather than burn through the list.
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

// ---------- names ----------
const SUFFIX = new Set(["inc", "llc", "l", "c", "corp", "corporation", "co", "company", "ltd", "the", "pc", "p", "llp", "pllc", "lp", "ra", "aia", "pe", "esq", "and", "of"]);
const nkey = (v) => String(v ?? "").toLowerCase().replace(/\([^)]*\)/g, " ").replace(/&/g, " and ").replace(/[’']/g, "").replace(/[^a-z0-9 ]+/g, " ")
  .split(/\s+/).filter((w) => w && !SUFFIX.has(w)).join(" ");
// Same name: equal keys, or every word of the shorter one in the longer one (at least two words, or one long one).
function sameName(a, b) {
  const x = nkey(a), y = nkey(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const [s, l] = x.length <= y.length ? [x, y] : [y, x];
  const sw = s.split(" "), lw = new Set(l.split(" "));
  return sw.every((w) => lw.has(w)) && (sw.length >= 2 || s.length >= 6);
}
const norm = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
// Share of the quote's 4-word shingles found on the page (OCR noise and "..." joins make exact matching too strict).
function quoteOn(quote, body) {
  const parts = String(quote ?? "").split(/\s*(?:\.\.\.|…)\s*/).map(norm).filter((p) => p.split(" ").length >= 3);
  if (!parts.length) return 1;
  const page = " " + norm(body).replace(/ /g, "") + " ";
  let hit = 0, tot = 0;
  for (const p of parts) {
    const w = p.split(" ");
    for (let i = 0; i + 4 <= w.length || (i === 0 && w.length < 4); i++) {
      tot++;
      if (page.includes(w.slice(i, i + 4).join(""))) hit++;
      if (w.length < 4) break;
    }
  }
  return tot ? hit / tot : 1;
}

// ---------- what we check ----------
const LABEL = {
  architect: "the architect (who prepared the description of the property / architect's report / floor plans)",
  selling_agent: "the selling agent",
  managing_agent: "the managing agent for the first year (or who manages the condominium if no outside agent)",
  tax_consultant: "the real estate tax consultant / expert whose opinion supports the projected real estate taxes",
  sponsor_attorney: "the Sponsor's counsel (attorneys for the Sponsor)",
  sponsor_address: "the Sponsor's address",
  working_capital: "the working capital fund contribution",
  reserve_fund: "the reserve fund",
  parking_arrangement: "the parking arrangement (sold, licensed, leased... and how many spaces)",
  tax_program: "the real estate tax exemption/abatement program",
  affordable_housing: "the affordable housing component",
  sponsor: "the Sponsor (name of the sponsoring entity)",
  law_firm: "the Sponsor's counsel (attorneys for the Sponsor)",
};
const ROLES = ["architect", "selling_agent", "managing_agent", "tax_consultant", "sponsor_attorney"];
// Pages that introduce a role: searched in the plan's main offering plan document.
const ROLE_SEARCH = {
  architect: ["architect", /(sponsor'?s? architect|architect'?s? report|retained [^.]{0,80}architect|as (the )?architect|architect:)/gi],
  selling_agent: ["selling agent", /(selling agent (is|will be|for)|retained [^.]{0,80}selling agent|as (the |exclusive )?selling agent|selling agent:|exclusive (sales|selling) agent)/gi],
  managing_agent: ["managing agent", /(managing agent (is|will be|for)|retained [^.]{0,80}managing agent|as (the )?managing agent|managing agent:|management agreement)/gi],
  tax_consultant: ["real estate tax", /(tax (consultant|expert|counsel|certiorari)|real estate tax (opinion|projection)|opinion (letter )?(of|concerning) [^.]{0,60}tax|projected real estate taxes)/gi],
  sponsor_attorney: ["counsel", /(counsel (to|for) (the )?sponsor|sponsor'?s? (counsel|attorneys?)|attorneys? for (the )?sponsor|represents the sponsor)/gi],
};
const MAX_PAGE = 6000, MAX_PAGES = 16;

async function pageBodies(keys) {
  const byFile = new Map();
  for (const [f, p] of keys) { if (!byFile.has(f)) byFile.set(f, new Set()); byFile.get(f).add(p); }
  const out = new Map();
  for (const [f, ps] of byFile) {
    const rows = await rest(`pages?select=file_id,page_no,body&file_id=eq.${f}&page_no=in.(${[...ps].join(",")})`);
    for (const r of rows) out.set(`${r.file_id}:${r.page_no}`, r.body || "");
  }
  return out;
}
async function rolePages(fileId) {
  const picks = new Map();
  for (const [role, [term, re]] of Object.entries(ROLE_SEARCH)) {
    const rows = await rest(`pages?select=page_no,body&file_id=eq.${fileId}&body=ilike.*${encodeURIComponent(term)}*`).catch(() => []);
    const scored = rows.map((r) => ({ p: r.page_no, body: r.body, s: (r.body.match(re) || []).length })).filter((r) => r.s > 0)
      .sort((a, b) => b.s - a.s || a.p - b.p).slice(0, 2);
    picks.set(role, scored);
  }
  return picks;
}

// ---------- page images (for garbled text) ----------
async function pdfFor(fileId) {
  const f = join(CACHE, `file-${fileId}.pdf`);
  if (await exists(f)) return f;
  const d = await rest(`documents?select=pdf_url&file_id=eq.${fileId}`);
  if (!d[0]?.pdf_url) return null;
  const r = await fetch(d[0].pdf_url);
  if (!r.ok) return null;
  await mkdir(CACHE, { recursive: true });
  await writeFile(f, Buffer.from(await r.arrayBuffer()));
  return f;
}
async function images(fileId, nums) {
  const pdf = await pdfFor(fileId).catch(() => null);
  if (!pdf) return [];
  const dir = join(CACHE, `file-${fileId}`);
  return (await run(PY, [join(ROOT, "scripts", "render-pages.py"), pdf, dir, "150", ...nums.map(String)])).trim().split(/\r?\n/).filter(Boolean);
}

// ---------- prompts ----------
const pageBlock = (pages) => pages.map((p) => `===== ${p.tag}: ${p.kind}, PDF page ${p.page_no} =====\n${p.body.slice(0, MAX_PAGE)}`).join("\n\n");

function blindPrompt(pages) {
  return `Below are pages from a New York condominium offering plan (text extracted from the PDF; OCR may have errors). Using ONLY these pages, name each of the following. Do not guess: if these pages don't say, answer null.

- architect: ${LABEL.architect}
- selling_agent: ${LABEL.selling_agent}
- managing_agent: ${LABEL.managing_agent}
- tax_consultant: ${LABEL.tax_consultant}
- sponsor_attorney: ${LABEL.sponsor_attorney}
- sponsor: ${LABEL.sponsor}
- sponsor_address: ${LABEL.sponsor_address}

Write names exactly as printed (fix only obvious OCR spacing like "TU CH MAN" -> "TUCHMAN"). If the plan says the Sponsor itself (or the Board) fills a role, set "by_sponsor": true (or "by_board": true) and put the sponsor's name in "value" if printed. If the pages name different firms for the same role, list the main one in "value" and the others in "others".

${pageBlock(pages)}

Reply with JSON only:
{"architect": {"value": "...", "by_sponsor": false, "by_board": false, "others": [], "page": "<P#>", "quote": "<short exact quote>"} or null, "selling_agent": ..., "managing_agent": ..., "tax_consultant": ..., "sponsor_attorney": ..., "sponsor": ..., "sponsor_address": ...}`;
}

function claimPrompt(pages, claims) {
  return `Below are pages from a New York condominium offering plan (text extracted from the PDF; OCR may have errors), then claims a database makes about this plan. Check each claim strictly against the pages.

For each claim answer:
- "correct": the pages state it; names spelled as printed (ignoring capitalization, punctuation and suffixes like LLC/Inc.).
- "minor": right fact, but the wording/spelling differs from the print in a way a reader would notice (misspelled name, truncated name). Give the printed form in "fix".
- "wrong": the pages contradict it, it names the wrong party or the wrong role, it adds something the pages don't say, or it omits a qualification that changes the meaning. Give the correct value in "fix" if the pages show it, else null.
- "unverifiable": these pages say nothing either way.
A parenthetical note in a value, like "(Sponsor)" or "(engineer)", is part of the claim and must be supported too.

${pageBlock(pages)}

===== CLAIMS =====
${claims.map((c) => `${c.n}. ${c.text}`).join("\n")}

Reply with JSON only: {"claims": [{"n": 1, "verdict": "correct|minor|wrong|unverifiable", "fix": "..." or null, "page": "<P#>" or null, "quote": "<short exact quote>" or null, "why": "<short>"}, ...]}`;
}

function judgePrompt(pages, items, withImages) {
  return `Below are pages from a New York condominium offering plan${withImages ? " (as page images, listed below; the text layer was unreliable)" : " (text extracted from the PDF; OCR may have errors)"}. For each question, a database value and other readings disagree. Read the pages carefully and decide what the plan actually says. A candidate may be wrong, or all may be. Never infer from outside knowledge; report only what these pages state.

${withImages ? pages.map((p) => `${p.tag}: ${p.kind}, PDF page ${p.page_no} — image ${p.img}`).join("\n") : pageBlock(pages)}

===== QUESTIONS =====
${items.map((it, i) => `${i + 1}. ${it.question}\n   Candidates: ${it.cands.map((c, k) => `(${String.fromCharCode(65 + k)}) "${c}"`).join("  ")}`).join("\n")}

For each question:
- "accurate": the letters of every candidate that is an accurate statement of what the pages say (right party, right role, name spelled as printed apart from capitalization, punctuation and LLC/Inc.-type suffixes). Empty if none.
- "close": letters of candidates that name the right party/fact but with a noticeable spelling or wording difference.
- "printed": the correct value as printed on the pages, or null if the pages don't say.
- "sure": false if you can't tell (unreadable text, pages don't cover it).

Reply with JSON only: {"answers": [{"n": 1, "accurate": ["A"], "close": [], "printed": "...", "page": "<P#>", "quote": "<short exact quote>", "sure": true, "why": "<short>"}, ...]}`;
}

// ---------- one plan ----------
const shuffle = (a) => a.map((x) => [Math.random(), x]).sort((p, q) => p[0] - q[0]).map((p) => p[1]);
function claimText(c) {
  if (c.kind === "fact") return `${LABEL[c.field] || c.field}: "${c.value}"${c.num != null ? ` (number stored with it: ${c.num})` : ""} — cited ${c.tag}`;
  if (c.kind === "principal") return `Sponsor principal: ${c.p.kind === "person" ? "person" : "entity"} "${c.p.name}"${c.p.role ? `, role "${c.p.role}"` : ""}${c.p.parent_entity ? `, of "${c.p.parent_entity}"` : ""} — cited ${c.tag}`;
  return `${LABEL[c.field]}: "${c.value}" — (from the state's filing index; check against the cover page)`;
}

async function qa(id, ctx) {
  const tally = { calls: 0, tokens: 0 };
  const facts = ctx.facts.get(id) || [], princ = ctx.princ.get(id) || [], plan = ctx.plans.get(id) || {};
  const main = ctx.mainDoc.get(id);
  const kindOf = (f) => ctx.docKind.get(f) || "document";
  // Pages: cited, cover (1-2 of the offering plan), and role pages.
  const keys = new Map();
  const add = (f, p, why) => { if (f == null || p == null) return; const k = `${f}:${p}`; if (!keys.has(k)) keys.set(k, { file_id: f, page_no: p, why: new Set() }); keys.get(k).why.add(why); };
  for (const f of facts) add(f.file_id, f.page_no, "cited");
  for (const p of princ) add(p.file_id, p.page_no, "cited");
  if (main) { add(main, 1, "cover"); add(main, 2, "cover"); }
  const roleHits = main ? await rolePages(main) : new Map();
  for (const [role, hits] of roleHits) for (const h of hits) add(main, h.p, role);
  const bodies = await pageBodies([...keys.values()].map((k) => [k.file_id, k.page_no]));
  for (const [role, hits] of roleHits) for (const h of hits) bodies.set(`${main}:${h.p}`, h.body);
  // Keep every cited page; drop role pages beyond the cap (lowest priority last).
  let pages = [...keys.values()].filter((k) => bodies.has(`${k.file_id}:${k.page_no}`));
  pages.sort((a, b) => (b.why.has("cited") - a.why.has("cited")) || (b.why.has("cover") - a.why.has("cover")) || a.file_id - b.file_id || a.page_no - b.page_no);
  const cited = pages.filter((k) => k.why.has("cited"));
  pages = [...cited, ...pages.filter((k) => !k.why.has("cited")).slice(0, Math.max(4, MAX_PAGES - cited.length))];
  pages.sort((a, b) => a.file_id - b.file_id || a.page_no - b.page_no);
  pages.forEach((p, i) => { p.tag = `P${i + 1}`; p.kind = kindOf(p.file_id); p.body = bodies.get(`${p.file_id}:${p.page_no}`) || ""; });
  const tagOf = (f, n) => pages.find((p) => p.file_id === f && p.page_no === n)?.tag || "(page not loaded)";
  const pageOfTag = (t) => pages.find((p) => p.tag === String(t || "").trim());

  // 1. Quotes on the cited page.
  const quoteChecks = [];
  for (const f of facts) {
    const body = bodies.get(`${f.file_id}:${f.page_no}`) ?? "";
    const s = quoteOn(f.quote, body);
    const qc = { id: f.id, field: f.field, page_no: f.page_no, score: Number(s.toFixed(2)) };
    if (s < 0.5) {
      // Look for the quote elsewhere in the same document by its longest run of words.
      const words = norm(f.quote).split(" ").filter((w) => w.length > 3).slice(0, 6);
      if (words.length >= 3) {
        const rows = await rest(`pages?select=page_no,body&file_id=eq.${f.file_id}&body=ilike.*${encodeURIComponent(words.slice(0, 3).join("%"))}*`).catch(() => []);
        const best = rows.map((r) => ({ p: r.page_no, s: quoteOn(f.quote, r.body) })).sort((a, b) => b.s - a.s)[0];
        if (best && best.s >= 0.7) { qc.found_on = best.p; qc.found_score = Number(best.s.toFixed(2)); }
      }
    }
    quoteChecks.push(qc);
  }

  const noPage = princ.filter((p) => p.file_id == null).map((p) => ({ table: "sponsor_principals", id: p.id, field: "principal", method: p.method,
    stored: { name: p.name, kind: p.kind, role: p.role, parent_entity: p.parent_entity }, quote: p.quote, verdict: "not_from_plan" }));
  // No plan text in the database for this plan: nothing to check against.
  if (pages.reduce((s, p) => s + p.body.trim().length, 0) < 300) {
    const results = [...facts.map((f) => ({ table: "facts", id: f.id, field: f.field, stored: f.value_text, page_no: f.page_no, file_id: f.file_id, verdict: "no_plan_text" })),
      ...princ.filter((p) => p.file_id != null).map((p) => ({ table: "sponsor_principals", id: p.id, field: "principal", stored: { name: p.name, role: p.role }, verdict: "no_plan_text" })), ...noPage];
    return { plan_id: id, checked_at: new Date().toISOString(), pages: [], quote_checks: quoteChecks, results, calls: 0, tokens: 0 };
  }

  // 2. Blind reading.
  const blind = json(await ask(tally, "sonnet", blindPrompt(pages)));

  // 3. Claim check.
  const claims = [];
  for (const f of facts) claims.push({ kind: "fact", id: f.id, field: f.field, value: f.value_text, num: f.value_num, tag: tagOf(f.file_id, f.page_no), f });
  // Principals filed from the state's website (no page) can't be checked against the plan; they're listed, not judged.
  for (const p of princ) if (p.file_id != null) claims.push({ kind: "principal", id: p.id, tag: tagOf(p.file_id, p.page_no), p });
  if (main && plan.sponsor) claims.push({ kind: "plan", field: "sponsor", value: plan.sponsor });
  if (main && plan.law_firm) claims.push({ kind: "plan", field: "law_firm", value: plan.law_firm });
  claims.forEach((c, i) => { c.n = i + 1; c.text = claimText(c); });
  const checked = claims.length ? (json(await ask(tally, "sonnet", claimPrompt(pages, claims))).claims || []) : [];
  for (const c of claims) c.check = checked.find((x) => Number(x.n) === c.n) || { verdict: "no_answer" };

  // Blind vs stored for names.
  const sponsorName = plan.sponsor || blind.sponsor?.value || "";
  const items = [];
  for (const c of claims) {
    const field = c.kind === "plan" ? (c.field === "law_firm" ? "sponsor_attorney" : "sponsor") : c.field;
    const b = c.kind !== "principal" ? blind[field] : null;
    c.blind = b ?? null;
    let agree = null;
    if (b && (ROLES.includes(field) || field === "sponsor")) {
      const names = [b.value, ...(b.others || [])].filter(Boolean);
      agree = names.some((n) => sameName(n, c.value)) ||
        (b.by_sponsor && (/\bsponsor\b/i.test(c.value) || sameName(c.value, sponsorName))) ||
        (b.by_board && /board|self/i.test(c.value));
    } else if (b && field === "sponsor_address") agree = norm(b.value).replace(/\b(new york|ny|suite|ste|floor|fl)\b/g, "").replace(/ +/g, " ").slice(0, 25) === norm(c.value).replace(/\b(new york|ny|suite|ste|floor|fl)\b/g, "").replace(/ +/g, " ").slice(0, 25);
    c.blind_agrees = agree;
    const v = c.check.verdict;
    const needs = v !== "correct" || (agree === false) || (ROLES.includes(field) && c.kind === "fact" && b == null && v !== "correct");
    if (!needs) continue;
    const cands = [c.kind === "principal" ? `${c.p.name}${c.p.role ? ` — ${c.p.role}` : ""}${c.p.parent_entity ? ` — of ${c.p.parent_entity}` : ""}` : c.value];
    const alt = [];
    if (c.check.fix) alt.push(String(c.check.fix));
    if (b?.value && c.kind !== "principal") alt.push(b.by_sponsor ? `${b.value} (the Sponsor itself)` : b.by_board ? "the Board / self-managed" : String(b.value));
    for (const a of alt) if (!cands.some((x) => norm(x) === norm(a))) cands.push(a);
    const q = c.kind === "principal"
      ? `Is this an accurate description of a principal of the Sponsor (name, role, and the entity they belong to)? (database cites ${c.tag})`
      : `What does the plan give as ${LABEL[field]}? ${c.kind === "fact" ? `(database cites ${c.tag})` : ""}`;
    const order = shuffle(cands.map((x, k) => ({ x, stored: k === 0 })));
    items.push({ claim: c, question: q, cands: order.map((o) => o.x), storedIdx: order.findIndex((o) => o.stored) });
  }

  // 4. Opus decides.
  const decide = async (list, withImages) => {
    let pgs = pages;
    if (withImages) {
      const byFile = new Map(); for (const p of pages) { if (!byFile.has(p.file_id)) byFile.set(p.file_id, []); byFile.get(p.file_id).push(p); }
      pgs = [];
      for (const [f, ps] of byFile) {
        const imgs = await images(f, ps.map((p) => p.page_no)).catch(() => []);
        ps.forEach((p, i) => { if (imgs[i]) pgs.push({ ...p, img: imgs[i] }); });
      }
      if (!pgs.length) return [];
    }
    const ans = [];
    for (let i = 0; i < list.length; i += 12) {
      const chunk = list.slice(i, i + 12);
      const imgs = withImages ? pgs.map((p) => p.img) : [];
      const r = json(await ask(tally, "opus", judgePrompt(pgs, chunk, withImages), imgs, withImages ? CACHE : null)).answers || [];
      chunk.forEach((it, k) => ans.push(r.find((a) => Number(a.n) === k + 1) || null));
    }
    return ans;
  };
  if (items.length) {
    const first = await decide(items, false);
    items.forEach((it, k) => (it.judge = first[k]));
    const unsure = items.filter((it) => !it.judge || it.judge.sure === false);
    if (unsure.length && pages.length <= 20) {
      const second = await decide(unsure, true).catch(() => []);
      unsure.forEach((it, k) => { if (second[k]) { it.judge_text = it.judge; it.judge = { ...second[k], from_images: true }; } });
    }
  }

  // Verdicts.
  const L = (k) => String.fromCharCode(65 + k);
  const results = claims.map((c) => {
    const it = items.find((x) => x.claim === c);
    const base = c.kind === "fact" ? { table: "facts", id: c.id, field: c.field, column: "value_text", stored: c.value, page_no: c.f.page_no, file_id: c.f.file_id }
      : c.kind === "principal" ? { table: "sponsor_principals", id: c.id, field: "principal", stored: { name: c.p.name, kind: c.p.kind, role: c.p.role, parent_entity: c.p.parent_entity }, page_no: c.p.page_no, file_id: c.p.file_id }
      : { table: "plans", id, field: c.field, column: c.field, stored: c.value };
    const r = { ...base, check: c.check, blind: c.blind, blind_agrees: c.blind_agrees };
    if (!it) return { ...r, verdict: "verified" };
    const j = it.judge;
    r.judge = j; r.candidates = it.cands; r.stored_letter = L(it.storedIdx);
    if (!j) return { ...r, verdict: "unresolved" };
    const acc = (j.accurate || []).map(String), close = (j.close || []).map(String);
    const pg = pageOfTag(j.page);
    r.printed = j.printed ?? null; r.printed_page = pg ? { file_id: pg.file_id, page_no: pg.page_no } : null; r.printed_quote = j.quote ?? null;
    if (acc.includes(r.stored_letter)) r.verdict = "verified";
    else if (j.sure === false) r.verdict = "unresolved";
    else if (close.includes(r.stored_letter)) r.verdict = "minor";
    else if (j.printed == null && !acc.length) r.verdict = "unsupported";
    else r.verdict = "wrong";
    return r;
  });
  return { plan_id: id, checked_at: new Date().toISOString(), pages: pages.map((p) => ({ tag: p.tag, file_id: p.file_id, page_no: p.page_no, why: [...p.why] })),
    blind, quote_checks: quoteChecks, results: [...results, ...noPage], calls: tally.calls, tokens: tally.tokens };
}

// ---------- report ----------
async function report() {
  const files = (await readdir(OUT).catch(() => [])).filter((f) => f.endsWith(".json"));
  const tot = {}, byField = {}, corrections = [], citations = [], agDiffers = [];
  let plans = 0, tokens = 0;
  for (const f of files) {
    const r = JSON.parse(await readFile(join(OUT, f), "utf8"));
    if (!r.results) continue;
    plans++; tokens += r.tokens || 0;
    for (const x of r.results) {
      tot[x.verdict] = (tot[x.verdict] || 0) + 1;
      const k = x.table === "facts" ? x.field : x.table === "plans" ? `plans.${x.field}` : "sponsor_principals";
      byField[k] ??= {}; byField[k][x.verdict] = (byField[k][x.verdict] || 0) + 1;
      // plans.sponsor / plans.law_firm come from the state's filing index, not the plan: a difference is listed for the
      // user to decide (the index may name the current filer), not proposed as a correction.
      if (["wrong", "minor", "unsupported"].includes(x.verdict) && x.table === "plans")
        agDiffers.push({ plan_id: r.plan_id, field: x.field, verdict: x.verdict, ag_record: x.stored, plan_says: x.printed ?? null, page: x.printed_page, quote: x.printed_quote, why: x.judge?.why });
      else if (["wrong", "minor", "unsupported"].includes(x.verdict))
        corrections.push({ plan_id: r.plan_id, table: x.table, id: x.id, field: x.field, verdict: x.verdict, from: x.stored, to: x.printed ?? null,
          page: x.printed_page, quote: x.printed_quote, why: x.judge?.why, from_images: !!x.judge?.from_images });
    }
    for (const q of r.quote_checks || []) if (q.score < 0.5) citations.push({ plan_id: r.plan_id, ...q });
  }
  await writeFile(join(ROOT, "data", "facts-corrections.json"), JSON.stringify({ generated: new Date().toISOString(), corrections, ag_record_differs: agDiffers, citations }, null, 1));
  console.log(`${plans} plans, ${(tokens / 1e6).toFixed(1)}M tokens`);
  console.log(tot);
  console.table(byField);
  console.log(`${corrections.length} proposed corrections, ${agDiffers.length} AG-record fields that differ from the plan, ${citations.length} quotes not found on the cited page (${citations.filter((c) => c.found_on).length} found on another page) → data/facts-corrections.json`);
}

// ---------- main ----------
if (REPORT) { await report(); process.exit(0); }
await mkdir(OUT, { recursive: true });
console.log("loading facts, principals, plans, documents...");
const factRows = await all("facts?select=id,plan_id,field,value_text,value_num,file_id,page_no,quote&value_text=not.is.null&order=id");
const princRows = await all("sponsor_principals?select=id,plan_id,name,kind,role,parent_entity,file_id,page_no,quote,method&order=id");
const group = (rows) => { const m = new Map(); for (const r of rows) { if (!m.has(r.plan_id)) m.set(r.plan_id, []); m.get(r.plan_id).push(r); } return m; };
const ctx = { facts: group(factRows), princ: group(princRows), plans: new Map(), mainDoc: new Map(), docKind: new Map() };
let ids = ALL ? [...new Set([...ctx.facts.keys(), ...ctx.princ.keys()])].sort() : argv.filter((a) => /^[A-Z]{2}\d+$/.test(a));
const fileIds = new Set([...factRows, ...princRows].map((r) => r.file_id).filter(Boolean));
for (let i = 0; i < ids.length; i += 150) {
  const chunk = ids.slice(i, i + 150).join(",");
  for (const p of await rest(`plans?select=plan_id,sponsor,law_firm&plan_id=in.(${chunk})`)) ctx.plans.set(p.plan_id, p);
  for (const d of await all(`documents?select=file_id,plan_id,doc_kind,amendment_no&plan_id=in.(${chunk})&order=file_id`)) {
    if (fileIds.has(d.file_id) || d.doc_kind === "offering_plan") ctx.docKind.set(d.file_id, d.doc_kind === "amendment" ? `Amendment ${d.amendment_no ?? ""}`.trim() : "Offering Plan");
    if (d.doc_kind === "offering_plan" && !ctx.mainDoc.has(d.plan_id)) ctx.mainDoc.set(d.plan_id, d.file_id);
  }
}
if (!FORCE) {
  const done = new Set((await readdir(OUT)).map((f) => f.replace(/\.json$/, "")));
  ids = ids.filter((id) => !done.has(id));
}
if (LIMIT) ids = ids.slice(0, LIMIT);
console.log(`${ids.length} plans to check (${factRows.length} facts, ${princRows.length} principals loaded)`);
let next = 0, n = 0, tokens = 0;
const t0 = Date.now();
await Promise.all(Array.from({ length: CONC }, async () => {
  while (next < ids.length) {
    const id = ids[next++];
    try {
      const r = await qa(id, ctx);
      await writeFile(join(OUT, id + ".json"), JSON.stringify(r, null, 1));
      tokens += r.tokens;
      const v = {}; for (const x of r.results) v[x.verdict] = (v[x.verdict] || 0) + 1;
      console.log(`${++n}/${ids.length} ${id} ${JSON.stringify(v)} ${r.calls} calls ${(r.tokens / 1000).toFixed(0)}k  [${((Date.now() - t0) / 60000).toFixed(0)} min, ${(tokens / 1e6).toFixed(1)}M]`);
    } catch (e) {
      console.log(`${++n}/${ids.length} ${id} ERROR ${e.message.slice(0, 200)}`);
    }
  }
}));
console.log("done");
