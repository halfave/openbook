// Tells Bing (and the other IndexNow engines: Yandex, Seznam, Naver, Yep) which pages are new or changed, so they
// crawl them now instead of on their next sitemap read. Google doesn't use IndexNow; it keeps reading sitemap.xml.
//
//   node scripts/indexnow.mjs            submit URLs that are new or have a newer <lastmod> than last time
//   node scripts/indexnow.mjs --dry-run  list what would be submitted, send nothing
//   node scripts/indexnow.mjs --all      submit every URL in the sitemaps
//
// Run it AFTER the deploy is live: it reads the live sitemaps, so it only ever announces pages that exist.
// What was sent is kept in scripts/indexnow-state.json (url -> lastmod); commit it with the rest.
// The key is public by design: the engines check that ${SITE_URL}/<key>.txt contains it.
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SITE_URL, ROOT } from "./site.mjs";

const KEY = "3bbeb846faf8ffbf620a09e7eb0287cd";
const KEY_LOCATION = `${SITE_URL}/${KEY}.txt`;
const SITEMAPS = ["sitemap-pages.xml", "sitemap-buildings.xml"];
const STATE = join(ROOT, "scripts", "indexnow-state.json");
const BATCH = 10000; // IndexNow's per-request limit

const dry = process.argv.includes("--dry-run");
const everything = process.argv.includes("--all");

async function get(url) {
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r.text();
}

// The key file must be live, or every submission is rejected with 403.
const keyLive = await get(KEY_LOCATION).then((t) => t.trim() === KEY, () => false);
if (!keyLive) {
  const msg = `${KEY_LOCATION} isn't live yet; deploy it first`;
  if (!dry) throw new Error(msg);
  console.log(`warning: ${msg}`);
}

const live = new Map(); // url -> lastmod ("" when the sitemap gives none)
for (const s of SITEMAPS) {
  for (const [, block] of (await get(`${SITE_URL}/${s}`)).matchAll(/<url>([\s\S]*?)<\/url>/g)) {
    const loc = block.match(/<loc>([^<]+)<\/loc>/)?.[1].trim();
    if (loc) live.set(loc, block.match(/<lastmod>([^<]+)<\/lastmod>/)?.[1].trim() ?? "");
  }
}

let state = {};
try { state = JSON.parse(await readFile(STATE, "utf8")); } catch {}

const todo = [...live].filter(([u, mod]) => everything || !(u in state) || state[u] !== mod).map(([u]) => u);
console.log(`${live.size} URLs in the live sitemaps, ${todo.length} to submit${dry ? " (dry run)" : ""}`);
if (dry) { todo.slice(0, 50).forEach((u) => console.log("  " + u)); if (todo.length > 50) console.log(`  … and ${todo.length - 50} more`); }
if (dry || !todo.length) process.exit(0);

const host = new URL(SITE_URL).host;
for (let i = 0; i < todo.length; i += BATCH) {
  const urlList = todo.slice(i, i + BATCH);
  const r = await fetch("https://api.indexnow.org/indexnow", {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({ host, key: KEY, keyLocation: KEY_LOCATION, urlList }),
  });
  // 200 = accepted, 202 = accepted, key check pending. Anything else: stop and keep the state as it was for these.
  if (r.status !== 200 && r.status !== 202) throw new Error(`IndexNow HTTP ${r.status}: ${await r.text()}`);
  for (const u of urlList) state[u] = live.get(u);
  console.log(`submitted ${urlList.length} URLs (HTTP ${r.status})`);
}

// Forget pages that left the sitemaps, so they're announced again if they come back.
for (const u of Object.keys(state)) if (!live.has(u)) delete state[u];
await writeFile(STATE, JSON.stringify(state, null, 0).replace(/,"/g, ',\n"') + "\n");
