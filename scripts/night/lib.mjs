// Shared helpers for the overnight checkers. Read-only: static files in the worktree and the public
// Supabase REST API with the site's publishable key. Checkers write .night/<name>.json as
// { checks: [{ name, pass, detail }] } and print a summary.
import { readdirSync, readFileSync, statSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname, relative, normalize, sep } from "node:path";

export const SB = "https://dvywgltjqpntldlztapu.supabase.co";
export const KEY = "sb_publishable_At7fyv-9Vp7ByNP3AXHZ7g_qphsg6Rw";
export const SITE = "https://www.condobooknyc.com";
export const ROOT = process.cwd();

export async function rest(path, range) {
  const headers = { apikey: KEY, Accept: "application/json" };
  if (range) headers.Range = range;
  for (let t = 0; ; t++) {
    const r = await fetch(SB + "/rest/v1/" + path, { headers });
    if (r.ok) return r.json();
    if (t >= 3) throw new Error(`${path}: ${r.status} ${(await r.text()).slice(0, 200)}`);
    await new Promise((res) => setTimeout(res, 2000 * (t + 1)));
  }
}
export async function all(path, size = 1000) {
  const out = [];
  for (let from = 0; ; from += size) {
    const rows = await rest(path, `${from}-${from + size - 1}`);
    out.push(...rows);
    if (rows.length < size) return out;
  }
}

const SKIP = new Set(["node_modules", ".git", ".loop", ".night", "content", "scripts", "supabase", "api", "data", ".claude", ".vercel"]);
export function htmlFiles(dir = ROOT) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) { if (!SKIP.has(e.name) && e.name !== "img") out.push(...htmlFiles(join(dir, e.name))); }
    else if (e.name.endsWith(".html")) out.push(join(dir, e.name));
  }
  return out;
}
export const rel = (f) => relative(ROOT, f).split(sep).join("/");
export const read = (f) => readFileSync(f, "utf8");

// URL path of a file relative to the site root ("buildings/index.html" -> "buildings/").
export const urlPath = (r) => r.replace(/(^|\/)index\.html$/, "$1");

export function attr(tag, name) {
  const m = tag.match(new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i"));
  return m ? (m[2] ?? m[3]) : null;
}
export const decode = (s) => String(s ?? "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ");
export function head(html) {
  const title = (html.match(/<title>([\s\S]*?)<\/title>/i) || [])[1];
  const meta = [...html.matchAll(/<meta\b[^>]*>/gi)].map((m) => m[0]);
  const desc = meta.find((t) => /name\s*=\s*["']description["']/i.test(t));
  const robots = meta.find((t) => /name\s*=\s*["']robots["']/i.test(t));
  const canon = [...html.matchAll(/<link\b[^>]*>/gi)].map((m) => m[0]).find((t) => /rel\s*=\s*["']canonical["']/i.test(t));
  return {
    title: title ? decode(title.trim()) : null,
    description: desc ? decode(attr(desc, "content")) : null,
    noindex: robots ? /noindex/i.test(attr(robots, "content") || "") : false,
    canonical: canon ? attr(canon, "href") : null,
  };
}
export function visibleText(html) {
  return decode(html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}
export function mainHtml(html) {
  const m = html.match(/<main\b[\s\S]*<\/main>/i);
  return m ? m[0] : html;
}
// Resolve a relative href from a file to a local file path, or null if it isn't a local link.
export function resolveHref(fromFile, href) {
  if (!href) return null;
  href = decode(href).trim();
  if (/^(https?:|mailto:|tel:|javascript:|data:|#|\/\/)/i.test(href)) {
    if (href.startsWith(SITE + "/")) href = "/" + href.slice(SITE.length + 1); else return null;
  }
  const path = href.split("#")[0].split("?")[0];
  if (!path) return null;
  let f = path.startsWith("/") ? join(ROOT, path) : join(dirname(fromFile), path);
  f = normalize(f);
  if (path.endsWith("/")) f = join(f, "index.html");
  return f;
}
export function exists(f) {
  try { return statSync(f).isFile() || (statSync(f).isDirectory() && existsSync(join(f, "index.html"))); } catch { return false; }
}

export function report(name, checks) {
  mkdirSync(join(ROOT, ".night"), { recursive: true });
  writeFileSync(join(ROOT, ".night", name + ".json"), JSON.stringify({ checks }, null, 1));
  const fails = checks.filter((c) => !c.pass);
  for (const c of fails.slice(0, 60)) console.log(`FAIL  ${c.name}${c.detail ? "  " + c.detail : ""}`);
  if (fails.length > 60) console.log(`... ${fails.length - 60} more failures in .night/${name}.json`);
  console.log(`${name}: ${checks.length - fails.length}/${checks.length} checks pass`);
}

// Which plans are searchable, which are junk: same rules as scripts/build-buildings.mjs.
export const JUNK_NAME = /resubmit|withdrawn|\(\s*\d{1,2}\/\d{1,2}\/\d{2,4}|\bfiled\s*\)/i;
export const isJunk = (p, searchable) => JUNK_NAME.test(p.name || "") || (!searchable.has(p.plan_id) && !p.units_residential && !p.units_total);
export const slug = (s) => String(s ?? "").toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
export const fileFor = (p) => `${slug(p.address)}-${slug(p.borough)}-${p.plan_id.toLowerCase()}.html`;
export const BORO = { MANHATTAN: 1, MANHTTAN: 1, "NEW YORK": 1, NY: 1, BROOKLYN: 1, KINGS: 1, QUEENS: 1, FLUSHING: 1, BRONX: 1, "STATEN ISLAND": 1, RICHMOND: 1 };
export const isNYC = (p) => !!BORO[String(p.borough || "").trim().toUpperCase()];

export async function loadPlans() {
  const plans = (await all("plans?select=plan_id,name,address,zip,borough,accepted_date,units_residential,units_total,units_parking,sponsor,law_firm&order=plan_id")).filter((p) => p.address);
  const docs = await all("documents?select=plan_id,doc_kind,status,pdf_url&order=file_id");
  // searchableAny feeds isJunk (as ctx.searchable does); searchable (original plan read) decides indexing today.
  const searchableAny = new Set(docs.filter((d) => d.status === "done").map((d) => d.plan_id));
  const searchable = new Set(docs.filter((d) => d.status === "done" && d.doc_kind !== "amendment").map((d) => d.plan_id));
  const origDocs = new Set(docs.filter((d) => d.doc_kind !== "amendment" && d.pdf_url).map((d) => d.plan_id));
  return { plans, docs, searchable, searchableAny, origDocs, byId: new Map(plans.map((p) => [p.plan_id, p])) };
}
