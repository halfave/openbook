// Accessibility checks over every published page, no dependencies, a few seconds:
//   node scripts/a11y-check.mjs            all pages
//   node scripts/a11y-check.mjs about.html buildings/index.html
// Exits 1 if any page fails. Run after build-buildings.mjs / build-pages.mjs.
//
// Static HTML only: what index.html draws after a search, color contrast and focus order need a browser.
// For those, open the page and run axe-core (https://github.com/dequelabs/axe-core) from the console:
//   await import("https://cdnjs.cloudflare.com/ajax/libs/axe-core/4.10.2/axe.min.js"); (await axe.run()).violations
import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { ROOT } from "./site.mjs";

const SKIP = new Set([".git", ".claude", "node_modules", "search-loop", "supabase", "scripts", "content", "data", "api", "img"]);
async function* walk(dir) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (e.isDirectory()) { if (!SKIP.has(e.name)) yield* walk(join(dir, e.name)); }
    else if (e.name.endsWith(".html") && !e.name.startsWith("_")) yield join(dir, e.name);
  }
}

const text = (h) => h.replace(/<[^>]+>/g, "").replace(/&[a-z#0-9]+;/gi, "x").trim();
const attr = (tag, name) => tag.match(new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i"))?.slice(2).find((v) => v != null);
const has = (tag, name) => new RegExp(`\\s${name}(\\s|=|>|/)`, "i").test(tag);

function check(html) {
  const out = [];
  const body = html.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<!--[\s\S]*?-->/g, "");
  if (!/<html[^>]*\slang="[a-z]/i.test(html)) out.push("<html> has no lang");
  if (!text(body.match(/<title>([\s\S]*?)<\/title>/i)?.[1] || "")) out.push("no <title>");
  const mains = (body.match(/<main[\s>]/gi) || []).length;
  if (mains !== 1) out.push(`${mains} <main> landmarks (want 1)`);
  if (!/<h1[\s>]/i.test(body)) out.push("no <h1>");

  for (const t of body.match(/<img\b[^>]*>/gi) || []) if (!has(t, "alt")) out.push(`image without alt: ${t.slice(0, 80)}`);

  // A <summary> is the disclosure button; links or buttons inside it can't be reached by screen readers.
  for (const [, s] of body.matchAll(/<summary\b[^>]*>([\s\S]*?)<\/summary>/gi))
    if (/<(a\s[^>]*href|button|input|select|textarea)\b/i.test(s)) out.push(`link or control inside <summary>: ${text(s).slice(0, 60)}`);

  // role="img" makes its contents invisible to screen readers, so nothing in it may take keyboard focus.
  for (const [svg] of body.matchAll(/<(svg|div)\b[^>]*role="img"[^>]*>[\s\S]*?<\/\1>/gi))
    for (const t of svg.match(/<(a\s[^>]*href|button|[a-z]+\s[^>]*tabindex="0")[^>]*>/gi) || [])
      if (attr(t, "tabindex") !== "-1") { out.push(`focusable element inside role="img": ${t.slice(0, 80)}`); break; }

  // Form fields need a label: <label for>, aria-label(ledby), title, or a wrapping <label>.
  const labelled = new Set([...body.matchAll(/<label\b[^>]*\sfor="([^"]+)"/gi)].map((m) => m[1]));
  const wrapped = [...body.matchAll(/<label\b[^>]*>([\s\S]*?)<\/label>/gi)].map((m) => m[1]).join(" ");
  for (const t of body.match(/<(input|select|textarea)\b[^>]*>/gi) || []) {
    if (/type="(hidden|submit|button|reset|image)"/i.test(t)) continue;
    const id = attr(t, "id");
    if (!(id && labelled.has(id)) && !has(t, "aria-label") && !has(t, "aria-labelledby") && !has(t, "title") && !wrapped.includes(t)) out.push(`form field without a label: ${t.slice(0, 80)}`);
  }

  for (const [t, inner] of body.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/gi))
    if (!text(inner) && !has(t, "aria-label") && !has(t, "aria-labelledby") && !has(t, "title")) out.push(`button without a name: ${t.slice(0, 80)}`);
  for (const [t, inner] of body.matchAll(/<a\b[^>]*href[^>]*>([\s\S]*?)<\/a>/gi))
    if (!text(inner) && !/<img\b[^>]*alt="[^"]+/i.test(inner) && !/<title>[^<]+/i.test(inner) && !has(t, "aria-label") && attr(t, "tabindex") !== "-1") out.push(`link without text: ${t.slice(0, 80)}`);

  const seen = new Set(), dup = new Set();
  for (const [, id] of body.matchAll(/\sid="([^"]+)"/g)) (seen.has(id) ? dup : seen).add(id);
  if (dup.size) out.push(`duplicate ids: ${[...dup].slice(0, 5).join(", ")}`);
  return out;
}

const args = process.argv.slice(2);
const files = args.length ? args.map((f) => join(ROOT, f)) : await Array.fromAsync(walk(ROOT));
let failed = 0;
for (const f of files) {
  const html = await readFile(f, "utf8").catch(() => null); // a build running alongside can remove pages
  if (html == null || /http-equiv="refresh"/i.test(html)) continue; // redirect stubs
  const problems = check(html);
  if (!problems.length) continue;
  failed++;
  console.log(relative(ROOT, f).replace(/\\/g, "/"));
  for (const p of [...new Set(problems)].slice(0, 8)) console.log("  " + p);
}
console.log(`${files.length} pages checked, ${failed} with problems`);
process.exit(failed ? 1 : 0);
