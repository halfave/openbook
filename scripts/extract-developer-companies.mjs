// Reads the development company behind each plan's sponsor from the plan text, with a model, and keeps only what the
// text supports. Runs through the local `claude` CLI (your Claude login, no API key in this repo).
//
//   node scripts/extract-developer-companies.mjs PLAN_ID ...      a few plans (report to stdout, nothing written)
//   node scripts/extract-developer-companies.mjs --all            every plan with searchable pages; writes data/developer-companies/<ID>.json
//   options: --concurrency 4   --force (redo plans already done)   --model sonnet   --call-timeout 300 (seconds)
//   node scripts/extract-developer-companies.mjs --merge          data/developer-companies/*.json -> data/developer-companies.json
//
// The sponsor is usually a company set up for the one building ("24 1st Avenue Project LLC"); the plan says who is behind it
// in its sections on the sponsor's principals, its affiliates and its prior experience ("Sponsor is an affiliate of Extell
// Development Company"). Per plan:
//  1. Pick pages without a model: the pages sponsor_principals cites, and the pages scoring highest on words those sections use.
//  2. Sonnet, thinking off, names the company and copies the sentence naming it, with the page.
//  3. Checks, not the model, decide: the quote must be on that page, the name must be in the quote, and the name can't be
//     the sponsor, a one-building company (a street address, "Member", "Mezz", "Owner" LLCs) or another party to the plan.
// A plan whose pages name only people, or only one-building companies, gets company: null.
import { spawn } from "node:child_process";
import { mkdir, writeFile, readFile, readdir, access } from "node:fs/promises";
import { join } from "node:path";
import { all, rest, ROOT } from "./site.mjs";
import { agentKey } from "./pros.mjs";

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv.splice(i, 2)[1] : d; };
const flag = (k) => { const i = argv.indexOf(k); return i >= 0 ? (argv.splice(i, 1), true) : false; };
const OUT = join(ROOT, "data", "developer-companies");
const CONC = Number(opt("--concurrency", 4));
const MODEL = opt("--model", "sonnet");
const CALL_TIMEOUT = Number(opt("--call-timeout", 300)) * 1000;
const FORCE = flag("--force"), ALL = flag("--all"), MERGE = flag("--merge");

// ---------- model ----------
// An API key in the environment would take precedence over the claude.ai (Max) login and bill API credits; never pass one on.
const { ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, ...BASE_ENV } = process.env;
const run = (cmd, args, input, env, timeout) => new Promise((res, rej) => {
  const p = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"], env: { ...BASE_ENV, ...env } });
  let o = "", e = "", timedOut = false;
  const timer = setTimeout(() => { timedOut = true; p.kill(); }, timeout);
  p.stdout.on("data", (d) => (o += d)); p.stderr.on("data", (d) => (e += d));
  p.on("error", rej);
  p.on("close", (c) => {
    clearTimeout(timer);
    if (timedOut) rej(new Error(`timed out after ${timeout / 1000}s`));
    else if (c === 0) res(o); else rej(new Error(`${cmd} exited ${c}: ${(e || o).slice(0, 300)}`));
  });
  p.stdin.end(input);
});
const exists = (f) => access(f).then(() => true, () => false);
// On Windows npm installs `claude` as a .cmd shim, which can't be spawned without a shell; use the binary behind it.
const WIN_BIN = join(process.env.APPDATA || "", "npm", "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe");
const CLAUDE = process.env.CLAUDE_BIN || (process.platform === "win32" && (await exists(WIN_BIN)) ? WIN_BIN : "claude");
const SYSTEM = "You read New York condominium offering plans and report only what the text says. Output only the JSON asked for.";

async function ask(prompt) {
  const args = ["-p", "--model", MODEL, "--system-prompt", SYSTEM, "--strict-mcp-config", "--no-session-persistence",
    "--setting-sources", "", "--output-format", "json", "--tools", ""];
  for (let t = 0; ; t++) {
    try {
      const j = JSON.parse(await run(CLAUDE, args, prompt, { MAX_THINKING_TOKENS: "0" }, CALL_TIMEOUT));
      const u = j.usage || {};
      return { text: j.result || "", tokens: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.output_tokens || 0) };
    } catch (e) {
      if (t === 2) throw e;
      await new Promise((r) => setTimeout(r, 5000 * (t + 1)));
    }
  }
}

// ---------- pages ----------
// Words the sponsor, principals, affiliates and prior experience sections use. A page's score is the sum of its hits.
const CUES = [[/\baffiliate[sd]? of\b/gi, 4], [/\bprincipals? of (?:the )?sponsor\b/gi, 4], [/\bprior experience\b/gi, 4], [/\bidentity of (?:the )?parties\b/gi, 3],
  [/\bcontrolled by\b/gi, 3], [/\b(?:managing |sole )?members? of (?:the )?sponsor\b/gi, 3], [/\bdeveloper\b/gi, 2], [/\bdeveloped\b/gi, 1],
  [/\bsponsor is\b/gi, 2], [/\bparent\b/gi, 2], [/\bformed (?:for|in order)\b/gi, 2], [/\bsubsidiary\b/gi, 3], [/\breal estate (?:development|investment)\b/gi, 2]];
const score = (body) => CUES.reduce((s, [re, w]) => s + (body.match(re) || []).length * w, 0);
const MAX_PAGES = 6, MAX_CHARS = 6000;
const FTS = encodeURIComponent("'sponsor' & ('affiliate' | 'principal' | 'developer' | 'experience' | 'controlled' | 'member' | 'subsidiary' | 'parent')");

async function pickPages(id, cited) {
  const rows = await all(`pages?select=page_no,body&plan_id=eq.${id}&tsv=fts(english).${FTS}&order=page_no`, 500);
  const byNo = new Map(rows.map((r) => [r.page_no, r]));
  // A cited page that doesn't match the search (a scan's odd text) is fetched on its own.
  for (const n of cited) if (!byNo.has(n)) { const [r] = await rest(`pages?select=page_no,body&plan_id=eq.${id}&page_no=eq.${n}&limit=1`); if (r) byNo.set(n, r); }
  const ranked = [...byNo.values()].map((r) => ({ ...r, s: score(r.body) + (cited.includes(r.page_no) ? 20 : 0) })).sort((a, b) => b.s - a.s);
  return ranked.filter((r) => r.s > 0).slice(0, MAX_PAGES).sort((a, b) => a.page_no - b.page_no);
}

const prompt = (p, pages) => `Offering plan ${p.plan_id} for ${p.name || p.address}. The sponsor on the Attorney General's record is "${p.sponsor || "not stated"}".

Below are pages from the plan. List every company (not a person) that these pages tie to the sponsor or to one of its principals: a company the sponsor is an affiliate, subsidiary or venture of, or is controlled or managed by; a company that is itself a principal, member or partner of the sponsor; a company a principal of the sponsor runs, owns or is a principal or member of; and the firm whose projects are given as the sponsor's prior experience. Leave out companies only mentioned as the builder of some other building.

For each, give the name exactly as printed, the one sentence (or clause) that ties it to the sponsor or principal, copied character for character from the page, that page's number (from the === PAGE n === line), and its type:
- "developer": a real estate development, construction, investment or property company with its own name ("Extell Development Company", "RNY Development Group", "The Naftali Group")
- "holding": a company with its own name (not this or another building's) that is itself a principal, member or partner of the sponsor ("The principals of Sponsor are ... and Bluefield Holdings LLC")
- "project": the sponsor itself, or a company formed for one building, this or another (named after an address or project, or a "Member", "Mezz", "Manager" or "Owner" company)
- "other": anything else (selling agent, managing agent, architect, contractor, lender, law firm, a business outside real estate)

Answer with JSON only: {"companies": [{"name": "...", "type": "developer", "page": 12, "quote": "..."}]} (an empty list if none)

${pages.map((r) => `=== PAGE ${r.page_no} ===\n${r.body.slice(0, MAX_CHARS)}`).join("\n\n")}`;

// ---------- checks ----------
const norm = (s) => String(s).replace(/[“”″]/g, '"').replace(/[‘’`]/g, "'").replace(/[­]/g, "").replace(/\s+/g, " ").trim().toLowerCase();
const SUFFIX = /[,\s]+(?:inc|llc|l\.l\.c|lp|l\.p|llp|corp|corporation|co|company|ltd|group)\.?$/i;
// A company formed for one building: starts with a street number, or is a project member / mezzanine / owner entity.
const oneBuilding = (name, p) => /^\s*\d/.test(name) || /\b(?:member|mezz(?:anine)?|owner|venture|manager|borrower|sponsor|condominium|condo)\b[\s,]*(?:llc|l\.l\.c|lp|l\.p|inc|corp)?\.?\s*$/i.test(name)
  || (p.address && name.toLowerCase().includes(String(p.address).toLowerCase().split(/\s+/).slice(0, 2).join(" ")));
const OTHER_PARTY = /\b(?:sotheby|corcoran|douglas elliman|compass|brown harris|halstead|firstservice|akam|bank|capital one|lender|architects?|engineering|law|llp|p\.c\.|pllc|esqs?)\b/i;

// Scans split words ("principal s"), so a match also ignores spaces.
const flat = (s) => norm(s).replace(/ /g, "");
const hasQuote = (body, q) => norm(body).includes(norm(q)) || flat(body).includes(flat(q));
// c.page is set to the page the quote is really on: the model sometimes gives the plan's printed page number instead.
function check(c, p, pages) {
  if (!c.name || !c.quote) return "missing name or quote";
  if (!["developer", "holding"].includes(c.type)) return `type ${c.type || "not given"}`;
  const page = [pages.find((r) => r.page_no === Number(c.page)), ...pages].find((r) => r && hasQuote(r.body, c.quote));
  if (!page) return "quote not on the pages";
  c.page = page.page_no;
  const core = norm(c.name).replace(SUFFIX, "").replace(/^the /, "");
  const ocr = (x) => x.replace(/[l1|]/g, "i");
  if (core.length < 3 || !ocr(flat(c.quote)).includes(ocr(core.replace(/ /g, "")))) return "name not in the quote";
  if (p.sponsor && agentKey(c.name) === agentKey(p.sponsor)) return "the sponsor itself";
  if (oneBuilding(c.name, p)) return "one-building company";
  if (OTHER_PARTY.test(c.name)) return "another party to the plan";
  if (!/[A-Z]/.test(c.name) || c.name.split(/\s+/).length > 12) return "not a company name";
  return null;
}

async function extract(p, cited) {
  const pages = await pickPages(p.plan_id, cited);
  if (!pages.length) return { plan_id: p.plan_id, companies: [], rejected: [], pages: [], tokens: 0, note: "no candidate pages" };
  const { text, tokens } = await ask(prompt(p, pages));
  let found = [];
  try { found = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)).companies || []; } catch { return { plan_id: p.plan_id, companies: [], rejected: [], pages: pages.map((r) => r.page_no), tokens, note: "unreadable answer", raw: text.slice(0, 500) }; }
  const companies = [], rejected = [];
  for (const c of found) {
    const why = check(c, p, pages);
    if (why) rejected.push({ ...c, why });
    else if (!companies.some((x) => agentKey(x.name) === agentKey(c.name))) companies.push({ name: c.name.trim().replace(/[,\s]+$/, ""), type: c.type, page: Number(c.page), quote: c.quote.trim() });
  }
  // The file the page is in, so the site can link the PDF page.
  const [pg] = companies.length ? await rest(`pages?select=file_id&plan_id=eq.${p.plan_id}&page_no=eq.${companies[0].page}&limit=1`) : [];
  return { plan_id: p.plan_id, file_id: pg?.file_id ?? null, companies, rejected, pages: pages.map((r) => r.page_no), tokens, answer: found };
}

// ---------- merge ----------
if (MERGE) {
  const out = {};
  for (const f of (await readdir(OUT)).filter((f) => f.endsWith(".json")).sort()) {
    const r = JSON.parse(await readFile(join(OUT, f), "utf8"));
    if (r.companies?.length) out[r.plan_id] = { file_id: r.file_id, companies: r.companies };
  }
  await writeFile(join(ROOT, "data", "developer-companies.json"), JSON.stringify(out, null, 1) + "\n");
  console.log(`${Object.keys(out).length} plans with a company; wrote data/developer-companies.json`);
  process.exit(0);
}

// ---------- run ----------
const plans = await all("plans?select=plan_id,name,address,sponsor&order=plan_id");
const byId = new Map(plans.map((p) => [p.plan_id, p]));
const citedBy = new Map();
for (const r of await all("sponsor_principals?select=plan_id,page_no&page_no=not.is.null&order=id")) {
  if (!citedBy.has(r.plan_id)) citedBy.set(r.plan_id, new Set());
  citedBy.get(r.plan_id).add(r.page_no);
}
let ids = argv.filter((a) => /^C[DC]\d+$/i.test(a)).map((a) => a.toUpperCase());
if (ALL) ids = [...new Set((await all("documents?select=plan_id&status=eq.done&order=plan_id")).map((d) => d.plan_id))].filter((id) => byId.has(id));
if (ALL) {
  await mkdir(OUT, { recursive: true });
  if (!FORCE) ids = (await Promise.all(ids.map(async (id) => ((await exists(join(OUT, id + ".json"))) ? null : id)))).filter(Boolean);
}
console.log(`${ids.length} plans, ${CONC} at a time, ${MODEL}`);
let done = 0, hits = 0, tok = 0, failed = 0;
const queue = [...ids];
async function worker() {
  for (let id; (id = queue.shift()); ) {
    try {
      const r = await extract(byId.get(id), [...(citedBy.get(id) || [])]);
      done++; tok += r.tokens; if (r.companies.length) hits++;
      if (ALL) await writeFile(join(OUT, id + ".json"), JSON.stringify(r, null, 1));
      else console.log(JSON.stringify(r, null, 1));
      if (ALL && done % 25 === 0) console.log(`${done}/${ids.length} done, ${hits} with a company, ${failed} failed, ${Math.round(tok / done)} tokens/plan`);
    } catch (e) { failed++; console.log(`${id}: ${e.message}`); }
  }
}
await Promise.all(Array.from({ length: CONC }, worker));
console.log(`${done} done, ${hits} with a company, ${failed} failed, ${done ? Math.round(tok / done) : 0} tokens/plan`);
