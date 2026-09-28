// Core checks every overnight track must keep passing: links, sitemaps, head tags, structured data,
// and the CLAUDE.md guardrails (Supabase URL/key, allowed RPCs, no paid AI calls, ids, ?q=, themes).
import { execSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { ROOT, SITE, SB, KEY, htmlFiles, rel, read, urlPath, attr, head, resolveHref, exists, report } from "./lib.mjs";

const checks = [];
const add = (name, pass, detail = "") => checks.push({ name, pass: !!pass, detail });

const files = htmlFiles();
const pages = new Map(); // rel -> { html, head }
for (const f of files) { const html = read(f); pages.set(rel(f), { f, html, h: head(html) }); }

// ---- links ----
const broken = new Map();
for (const [r, { f, html }] of pages) {
  for (const m of html.matchAll(/<(a|link|img|script|source)\b[^>]*>/gi)) {
    const tag = m[0];
    for (const a of ["href", "src"]) {
      const v = attr(tag, a); if (!v || v.includes("${")) continue;
      if (/rel\s*=\s*["'](canonical|alternate|preconnect|dns-prefetch)["']/i.test(tag)) continue;
      const t = resolveHref(f, v);
      if (t && !exists(t)) { const k = `${r} -> ${v}`; broken.set(k, true); }
    }
  }
}
for (const k of broken.keys()) add(`broken-link: ${k}`, false);

// ---- sitemaps ----
const smIndex = existsSync(join(ROOT, "sitemap.xml")) ? read(join(ROOT, "sitemap.xml")) : "";
const smFiles = [...smIndex.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1].replace(SITE + "/", ""));
const listed = new Set();
for (const s of smFiles) {
  if (!existsSync(join(ROOT, s))) { add(`sitemap-missing-file: ${s}`, false); continue; }
  for (const m of read(join(ROOT, s)).matchAll(/<loc>([^<]+)<\/loc>/g)) {
    const u = m[1].replace(SITE + "/", "");
    listed.add(u);
    const r = u === "" ? "index.html" : u.endsWith("/") ? u + "index.html" : u;
    const p = pages.get(r);
    if (!p) add(`sitemap-url-missing: ${u}`, false);
    else if (p.h.noindex) add(`sitemap-url-noindex: ${u}`, false);
  }
}
add("sitemap: index lists sitemaps", smFiles.length > 0);

// ---- head tags on indexable pages ----
const titles = new Map();
const NOT_PAGES = /^(404|google[0-9a-f]+)\.html$/;
for (const [r, { html, h }] of pages) {
  if (h.noindex || NOT_PAGES.test(r)) continue;
  const u = urlPath(r);
  if (!listed.has(u)) add(`not-in-sitemap: ${u || "/"}`, false);
  if (!h.title) add(`no-title: ${r}`, false);
  if (!h.description) add(`no-description: ${r}`, false);
  if (h.canonical !== `${SITE}/${u}`) add(`bad-canonical: ${r}`, false, `${h.canonical}`);
  const h1 = (html.match(/<h1\b/gi) || []).length;
  if (h1 !== 1) add(`h1-count: ${r}`, false, `${h1} h1`);
  if (h.title) { if (!titles.has(h.title)) titles.set(h.title, []); titles.get(h.title).push(r); }
  for (const m of html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try { JSON.parse(m[1]); } catch { add(`bad-jsonld: ${r}`, false); }
  }
}
for (const [t, rs] of titles) if (rs.length > 1) add(`duplicate-title: ${t}`, false, rs.slice(0, 5).join(", "));

// ---- guardrails ----
const indexHtml = read(join(ROOT, "index.html"));
const siteMjs = existsSync(join(ROOT, "scripts/site.mjs")) ? read(join(ROOT, "scripts/site.mjs")) : "";
add("guard: Supabase URL and publishable key unchanged in index.html", indexHtml.includes(SB) && indexHtml.includes(KEY));
add("guard: Supabase URL and publishable key unchanged in scripts/site.mjs", siteMjs.includes(SB) && siteMjs.includes(KEY));
const ALLOWED_RPC = new Set(["search_plans_v2", "map_points", "plan_detail", "plan_thumbs", "plan_sections", "log_search"]);
const clientJs = [indexHtml, ...readdirSync(ROOT).filter((f) => f.endsWith(".js")).map((f) => read(join(ROOT, f)))].join("\n");
const rpcs = new Set([...clientJs.matchAll(/rpc\/([a-z_0-9]+)|rpc\(\s*["']([a-z_0-9]+)/g)].map((m) => m[1] || m[2]));
const extra = [...rpcs].filter((x) => !ALLOWED_RPC.has(x));
add("guard: only the existing RPCs are called from the site", extra.length === 0, extra.join(", "));
let changed = [];
try { changed = execSync("git diff --name-only origin/main -- . \":(exclude)buildings\"", { cwd: ROOT, encoding: "utf8" }).split("\n").filter(Boolean); } catch {}
try { changed.push(...execSync("git ls-files --others --exclude-standard", { cwd: ROOT, encoding: "utf8" }).split("\n").filter(Boolean)); } catch {}
const SECRET = /sk-ant-[A-Za-z0-9_-]{10,}|sk-[A-Za-z0-9]{20,}|sb_secret_[A-Za-z0-9_-]+|service_role|SUPABASE_SERVICE/;
const PAID = /api\.anthropic\.com|api\.openai\.com|@anthropic-ai\/sdk|from ["']openai["']/;
for (const f of changed) {
  if (!existsSync(join(ROOT, f)) || /\.(webp|png|jpg|ico|pdf)$/.test(f)) continue;
  const t = read(join(ROOT, f));
  if (SECRET.test(t)) add(`guard: no secrets or new keys (${f})`, false);
  if (!f.startsWith("api/") && PAID.test(t)) add(`guard: no paid AI calls (${f})`, false);
  if (/\/rest\/v1\/(?!rpc\/)/.test(t) && /method\s*:\s*["'](POST|PATCH|PUT|DELETE)["']/i.test(t) && !/rpc/.test(t)) add(`guard: no database writes (${f})`, false);
  if (f.startsWith("supabase/")) add(`guard: no database changes (${f})`, false);
}
add("guard: no new files under api/", !changed.some((f) => f.startsWith("api/")), changed.filter((f) => f.startsWith("api/")).join(", "));
let baseIds = [];
try { baseIds = [...new Set([...execSync("git show origin/main:index.html", { cwd: ROOT, encoding: "utf8", maxBuffer: 1 << 26 }).matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]))]; } catch {}
const lost = baseIds.filter((id) => !indexHtml.includes(`id="${id}"`));
add("guard: index.html keeps its element ids", lost.length === 0, lost.join(", "));
add("guard: ?q= search-on-load still wired", /[?&]q=|get\(\s*["']q["']\s*\)/.test(indexHtml));
const css = read(join(ROOT, "bureau.css"));
add("guard: light and dark themes present", /prefers-color-scheme:\s*dark/.test(css) && /data-theme="dark"/.test(css) && /data-theme="light"/.test(css));

report("core", checks);
