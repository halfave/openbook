// Reads who prepared each plan's real estate tax estimate from the page text, with no AI: pattern matching only.
//
//   node scripts/extract-tax-preparers.mjs                     all plans; writes data/tax-preparers.json
//   node scripts/extract-tax-preparers.mjs --test out.json     all plans, report only (every candidate and its evidence)
//   add --cache pages.json to either to reuse (or save, if the file doesn't exist) the downloaded pages
//
// A plan's first-year real estate tax projection is prepared by the sponsor's real estate tax counsel or consultant
// (usually a tax certiorari law firm or a tax consulting firm), whose letter is in Part II. The plan names them in a few
// set ways, each a candidate with the page it's on:
//   - a definition: Marcus & Pollack LLP (the "Real Estate Tax Counsel")
//   - an appositive: Marcus & Pollack LLP, Sponsor's real estate tax attorney / Sponsor's Real Estate Tax Counsel, Tuchman, ...
//   - "prepared by <firm>" in a sentence about real estate taxes (not income taxes)
// Definitions and appositives count 3, "prepared by" counts 1; the plan's preparer is the firm with the most weight, unless
// another firm comes close, when the plan is skipped.
// A plan that only says "prepared by Sponsor's attorney" or never names a firm gets nothing, so nothing unchecked is shown.
// Re-run after new plans are loaded, then run build-pages.mjs.
import { writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { all, ROOT } from "./site.mjs";
import { proKey } from "./pros.mjs";

const args = process.argv.slice(2);
const test = args[0] === "--test" ? args[1] : null;
const cacheAt = args.indexOf("--cache");
const cache = cacheAt >= 0 ? args[cacheAt + 1] : null;

// Pages that can name the preparer. One query per phrase keeps each under the statement timeout.
const QUERIES = [
  "'tax' & 'prepared' & ('estimate' | 'projection' | 'projected')",
  "'real' & 'estate' & 'tax' & ('consultant' | 'expert' | 'appraiser' | 'advisor')",
  "'real' & 'estate' & 'tax' & 'counsel'",
  "'real' & 'estate' & 'tax' & 'attorney'",
];
async function loadPages() {
  if (cache) try { return JSON.parse(await readFile(cache, "utf8")); } catch {}
  const seen = new Map();
  for (const q of QUERIES) {
    for (const r of await all(`pages?select=plan_id,page_no,body&tsv=fts(english).${encodeURIComponent(q)}&order=plan_id,page_no`, 500)) seen.set(`${r.plan_id}:${r.page_no}`, r);
  }
  const rows = [...seen.values()];
  if (cache) await writeFile(cache, JSON.stringify(rows));
  return rows;
}

// Scan fixes: curly quotes, "Sponsor ’ s", "lnc." for "Inc.", "Komgold" for "Korngold", and misspellings of one firm's
// partners in some filings ("Leibman", "Lippman", "Lindermann", "Schechner").
const clean = (s) => String(s).replace(/[“”″]/g, '"').replace(/[‘’`]/g, "'").replace(/\s+/g, " ")
  .replace(/\s+'\s*s\b/g, "'s").replace(/\blnc\b/g, "Inc").replace(/\bKomgold\b/g, "Korngold").replace(/\bKOMGOLD\b/g, "KORNGOLD")
  .replace(/\bTuclunan\b/g, "Tuchman").replace(/([a-z])(LLP|LLC)\b/g, "$1 $2")
  .replace(/\b(?:Leibman|Lippman)(?= (?:&|and) Gelles)/g, "Liebman").replace(/\bLinde(?:r?mann|man)\b/g, "Lindemann").replace(/\bSchechner\b/g, "Schechter");

// A firm name: capitalized words, "&", "and", "of", joined by spaces or commas, up to 12 words.
const W = String.raw`(?:[A-Z][A-Za-z'.\-]*|&|and|of|de)`;
const NAME = String.raw`(${W}(?:,? ${W}){0,11})`;
const ROLE = String.raw`(?:(?:real estate|property|r\.e\.) tax (?:certiorari )?(?:counsel|consultants?|attorneys?|experts?|appraisers?|advisors?)|tax certiorari (?:counsel|attorneys?)|(?<!income )tax consultants?)`;
const PATTERNS = [
  // Marcus & Pollack LLP, 633 Third Avenue, New York, NY 10017 (the "Real Estate Tax Counsel")
  // ... Marcus & Pollack, having an office at 633 Third Avenue, 9th Floor, New York, NY 10017 ("Real Estate Tax Counsel")
  { w: 3, how: "defined", re: new RegExp(String.raw`${NAME}(?:,?\s*(?:(?i:having an? (?:office|address) at|with (?:an address|offices?) at|located at|of)\s+)?\d[^()"]{0,70}?)?,?\s*\((?:the |its |hereinafter )?"(?:(?i:Sponsor's) )?(?i:${ROLE})"\)`, "g") },
  // Marcus & Pollack LLP, Sponsor's real estate tax attorney / ..., real estate tax counsel to Sponsor
  { w: 3, how: "appositive", re: new RegExp(String.raw`${NAME},\s*(?:(?i:the|its)\s+)?(?:(?i:Sponsor's)\s+)?(?i:${ROLE})(?![a-z])`, "g") },
  { w: 3, how: "appositive", re: new RegExp(String.raw`${NAME},\s*(?i:${ROLE}) (?i:to|for) (?:the )?(?i:Sponsor)`, "g") },
  // Sponsor's Real Estate Tax Counsel, Tuchman, Korngold, Weiss, Liebman & Gelles, LLP
  // Sponsor's real estate tax counsel, Martin Joseph with Metropolitan Realty Exemptions, Inc.: the firm, not the person.
  { w: 3, how: "appositive", re: new RegExp(String.raw`(?i:Sponsor's|its|the) (?i:${ROLE}),\s+(?:[A-Z][a-z]+(?: [A-Z]\.)? [A-Z][a-z]+,? (?:with|of|at) (?:the )?)?${NAME}`, "g") },
  // ...real estate taxes ... prepared by Goldberg Weprin Finkel Goldstein LLP
  { w: 1, how: "prepared by", re: new RegExp(String.raw`(?i:prepared|furnished|provided|computed|calculated|estimated|projected) (?i:by) (?:the )?${NAME}`, "g"), about: true },
];

// Words that can't start or be a firm name; leading ones are trimmed ("The", "Sponsor's", "Messrs.").
const LEAD = /^(?:the|a|an|and|of|by|its|messrs\.?|sponsor's|sponsor|tax|counsel|consultant|expert|appraiser|attorneys?|real|estate|property|from|in|letter|opinion|dated|see|with|to)$/i;
// A legal suffix ends a firm's name.
const SUFFIX = /\b(?:LLP|L\.L\.P\.|LLC|L\.L\.C\.|Inc\.?|Corp\.?|P\.C\.|PLLC|Esq\.?)(?![A-Za-z])/;
const FIRM_SUFFIX = /\b(?:LLP|L\.L\.P\.|LLC|L\.L\.C\.|Inc\.?|Corp\.?|P\.C\.|PLLC)(?![A-Za-z])/;
const NOT_NAME = /^(?:january|february|march|april|may|june|july|august|september|october|november|december|consultants?|counselor|experts?|law offices?|law firm|sponsor|purchaser|seller|selling agent|board|condominium|city|new york|nyc|department|finance|assessor|assessment|schedule|part|plan|exhibit|document|note|notes|budget|attorney general|dof|internal revenue|irs|state|county|agent|managing agent|architect|engineer|management|unit owners?|owners?|accountants?)$/i;
const FIRMISH = /\b(?:LLP|L\.L\.P|LLC|L\.L\.C|Inc|Corp|Corporation|P\.C|PC|PLLC|Esq|CPA|Associates|Group|Company|Co|Consult\w*|Valuation|Exemptions|Appraisal\w*|Advisors|Partners|Ltd)\b\.?/i;
// "SJP Tax Consultants Inc" is a firm; "Real Estate Tax Counsel" is a role.
const ROLEWORD = /\b(?:counsel|counselor|attorneys?|experts?|appraiser|sponsors?|purchaser|plan|schedule|budget|condominium|unit|dated|set forth|real estate tax|property tax|opinion|operation|year|income)\b/i;
// An address caught before a definition's parentheses ("Third Avenue, 9th Floor, New York, NY 10017").
const PLACE = /\b(?:street|st|avenue|ave|floor|place|road|plaza|boulevard|blvd|broadway|suite|new york|ny)\.?$/i;

function tidy(raw) {
  let s0 = raw.replace(/[,\s]+$/, "");
  // "Paul Korngold of Tuchman, Korngold, ..." or "Jerome Mazursky of The Mazursky Group": the firm.
  // "Amanda Aaron, MAI, of Aaron Valuation Inc.", "Paul Korngold, Esq., of Tuchman, ..." and "Jerome Mazursky, MAI. The Mazursky Group, Inc." too.
  const of = s0.match(/^(.+?)(?:,? of (?:the |The )?|\. (?=The ))(.+)$/);
  if (of && FIRMISH.test(of[2]) && !FIRM_SUFFIX.test(of[1])) s0 = of[2];
  // Nothing after the last legal suffix: "Metropolitan Realty Exemptions, Inc., Sp", "..., Esq. The".
  const cut = [...s0.matchAll(new RegExp(SUFFIX.source, "g"))].at(-1);
  if (cut) s0 = s0.slice(0, cut.index + cut[0].length);
  let ws = s0.split(" ");
  while (ws.length && LEAD.test(ws[0].replace(/[,.]$/, ""))) ws.shift();
  // "dated", "and" or "&" can't end a name.
  while (ws.length && /^(?:and|&|of|de|dated|Dated|DATED)$/.test(ws.at(-1).replace(/,$/, ""))) ws.pop();
  const s = ws.join(" ").replace(/[,\s]+$/, "").trim();
  if (s.length < 4 || s.length > 90 || NOT_NAME.test(s) || ROLEWORD.test(s) || PLACE.test(s)) return null;
  // One word ("Accordingly", "East") only if it's an acronym like MGNY; an all-caps phrase only with a legal suffix.
  if (!s.includes(" ") && !/^[A-Z]{3,}$/.test(s)) return null;
  if (s === s.toUpperCase() && s.includes(" ") && !SUFFIX.test(s)) return null;
  // Cut off at the end of a page: "Metropolitan Realty Exemptions, In", "Metropolitan Realty Ex".
  if (/^(?:In|Ex|Co|L|LL|P)$/.test(ws.at(-1))) return null;
  if (!/[A-Za-z]{3}/.test(s) || !proKey(s)) return null;
  return s;
}

// The sentence a match is in, so "prepared by" counts only in a sentence about real estate taxes.
const sentence = (t, i) => {
  const a = Math.max(0, i - 300), b = Math.min(t.length, i + 60);
  return t.slice(a, b);
};
const TAX_ABOUT = /real estate tax|property tax|tax (?:estimate|projection)|projected (?:real estate )?taxes|estimated (?:real estate )?taxes|real estate taxes/i;

function candidates(page) {
  const t = clean(page.body), out = [];
  for (const p of PATTERNS) {
    for (const m of t.matchAll(p.re)) {
      if (p.about) {
        const ctx = sentence(t, m.index);
        if (!TAX_ABOUT.test(ctx) || /income tax/i.test(ctx.slice(-200))) continue;
        // "the 421-a Tax Benefit Opinion prepared by ...": the exemption, not the tax estimate.
        const just = t.slice(Math.max(0, m.index - 50), m.index);
        if (/421-?a|J-?51|benefit|exemption|abatement/i.test(just) && !/estimate|projection/i.test(just)) continue;
      }
      const name = tidy(m[1]);
      if (!name) continue;
      // "prepared by" must name a firm, not a person or a phrase.
      if (p.about && !FIRMISH.test(name)) continue;
      out.push({ name, w: p.w, how: p.how, page: page.page_no, text: m[0].slice(0, 200) });
    }
  }
  return out;
}

const pages = await loadPages();
const byPlan = new Map();
for (const pg of pages) {
  if (!byPlan.has(pg.plan_id)) byPlan.set(pg.plan_id, []);
  byPlan.get(pg.plan_id).push(...candidates(pg));
}
const result = {}, report = {};
for (const [id, cands] of [...byPlan].sort()) {
  if (!cands.length) continue;
  const groups = new Map();
  for (const c of cands) {
    const k = proKey(c.name);
    if (!groups.has(k)) groups.set(k, { w: 0, list: [] });
    const g = groups.get(k);
    g.w += c.w;
    g.list.push(c);
  }
  // "Pollack LLP" (a line break took "Marcus &") joins "Marcus & Pollack LLP": all its key's words are in the longer key.
  const keys = [...groups.keys()].sort((a, b) => a.split(" ").length - b.split(" ").length);
  for (const short of keys) for (const long of keys) {
    if (short === long || !groups.has(short) || !groups.has(long) || !short.split(" ").every((w) => long.split(" ").includes(w))) continue;
    const a = groups.get(long), b = groups.get(short);
    a.w += b.w; a.list.push(...b.list);
    groups.delete(short);
  }
  const ranked = [...groups.values()].sort((a, b) => b.w - a.w);
  const best = ranked[0];
  // Two firms named about as often (a tax firm and the sponsor's counsel, say): skip rather than guess.
  if (ranked[1] && ranked[1].w >= best.w * 0.8) { if (test) report[id] = { skipped: ranked.map((g) => g.list) }; continue; }
  // The spelling filed most often, then the one with a legal suffix, then the longest.
  const names = new Map();
  for (const c of best.list) names.set(c.name, (names.get(c.name) || 0) + 1);
  const name = [...names].sort((a, b) => b[1] - a[1] || FIRMISH.test(b[0]) - FIRMISH.test(a[0]) || b[0].length - a[0].length)[0][0];
  const page = best.list.find((c) => c.name === name).page;
  result[id] = { name, page };
  if (test) report[id] = { name, page, weight: best.w, others: ranked.slice(1).map((g) => ({ w: g.w, names: [...new Set(g.list.map((c) => c.name))] })), evidence: best.list.slice(0, 4) };
}
if (test) {
  await writeFile(test, JSON.stringify(report, null, 1));
  console.log(`${Object.keys(result).length} plans with a preparer, ${Object.keys(report).length - Object.keys(result).length} skipped; report in ${test}`);
} else {
  await writeFile(join(ROOT, "data", "tax-preparers.json"), JSON.stringify(result, null, 1) + "\n");
  console.log(`${Object.keys(result).length} plans with a preparer; wrote data/tax-preparers.json`);
}
