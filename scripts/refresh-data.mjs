// Rebuilds everything that depends on the Schedule A data, in order, and says what changed on the homepage.
//
//   node scripts/refresh-data.mjs
//
//  1. extract-schedule-a.mjs   pattern-matched tables, merged with model results (data/schedule-a-llm) → data/schedule-a
//  2. extract-re-taxes.mjs     per-unit property taxes from those tables → data/re-taxes
//  3. build-buildings.mjs      buildings/*.html
//  4. build-pages.mjs          stats pages, directories and the homepage numbers (index.html, between <!-- stats --> markers)
// extract-schedule-a-llm.mjs runs this at the end of each batch. Nothing is committed or deployed.
import { spawn } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { ROOT } from "./site.mjs";

const node = (script) => new Promise((res, rej) => {
  const p = spawn(process.execPath, [join(ROOT, "scripts", script)], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  p.stdout.on("data", (d) => (out += d)); p.stderr.on("data", (d) => (out += d));
  p.on("close", (c) => (c === 0 ? res(out) : rej(Object.assign(new Error(`${script} exited ${c}`), { out }))));
});
const lastLine = (s) => s.split(/\r?\n/).filter((l) => l.trim() && !/LF will be replaced/.test(l)).at(-1) || "";
const stats = async () => [...(await readFile(join(ROOT, "index.html"), "utf8")).matchAll(/<a class="stat"[^>]*>([\s\S]*?)<\/a>/g)]
  .map((m) => m[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
const count = async (dir) => (await readdir(join(ROOT, ...dir.split("/"))).catch(() => [])).length;

const before = { stats: await stats(), tables: await count("data/schedule-a"), taxes: await count("data/re-taxes") };

console.log("1/4", lastLine(await node("extract-schedule-a.mjs")));
console.log("2/4", lastLine(await node("extract-re-taxes.mjs")));
// build-buildings.mjs empties buildings/ before writing it; on Windows a file held open by another program makes that
// fail partway, so it is retried. A failed attempt leaves the folder partly empty until one succeeds.
for (let t = 1; ; t++) {
  try { console.log("3/4", lastLine(await node("build-buildings.mjs"))); break; }
  catch (e) {
    if (t === 3 || !/EBUSY|ENOTEMPTY|EPERM/.test(e.out || "")) { console.error(lastLine(e.out || e.message)); throw new Error("build-buildings.mjs failed; buildings/ may be incomplete until it is re-run"); }
    console.log(`3/4 build-buildings.mjs: a file was in use, retrying (${t})`);
    await new Promise((r) => setTimeout(r, 5000));
  }
}
console.log("4/4", lastLine(await node("build-pages.mjs")).slice(0, 100));

const after = { stats: await stats(), tables: await count("data/schedule-a"), taxes: await count("data/re-taxes") };
console.log(`\nSchedule A tables: ${before.tables} → ${after.tables}; buildings with property taxes: ${before.taxes} → ${after.taxes}`);
after.stats.forEach((s, i) => console.log(s === before.stats[i] ? `  ${s}` : `  ${before.stats[i]}  →  ${s}`));
