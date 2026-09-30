// Downloads the firm logos queued in data/logo-queue.json ([{kind, slug, source, bg}], from the firms website check)
// into data/logos/<kind>/<slug>.<ext> and adds each one to data/logos.json. Then run build-og-images.mjs and
// build-pages.mjs. Look over the new logos before publishing: bg "dark" (white logos) was guessed from the file name.
//
//   node scripts/fetch-logos.mjs
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { ROOT } from "./site.mjs";

const QUEUE = join(ROOT, "data", "logo-queue.json"), LOGOS_FILE = join(ROOT, "data", "logos.json");
const queue = JSON.parse(await readFile(QUEUE, "utf8"));
const logos = JSON.parse(await readFile(LOGOS_FILE, "utf8"));
const EXT = { "image/svg+xml": "svg", "image/png": "png", "image/webp": "webp", "image/jpeg": "jpg", "image/gif": "gif", "image/avif": "avif" };

const left = [];
for (const q of queue) {
  if (logos[q.kind]?.[q.slug]) continue;
  try {
    const r = await fetch(q.source, { headers: { "User-Agent": "Mozilla/5.0", Accept: "image/*" }, redirect: "follow" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const type = (r.headers.get("content-type") || "").split(";")[0].trim();
    const ext = EXT[type] || q.source.split("?")[0].split(".").pop().toLowerCase();
    if (!Object.values(EXT).includes(ext)) throw new Error(`not an image (${type || "no type"})`);
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length < 200) throw new Error("too small");
    const file = `${q.kind}/${q.slug}.${ext}`;
    await mkdir(join(ROOT, "data", "logos", q.kind), { recursive: true });
    await writeFile(join(ROOT, "data", "logos", file), buf);
    (logos[q.kind] ||= {})[q.slug] = { file, source: q.source, bg: q.bg };
    console.log(`ok   ${file}`);
  } catch (e) {
    left.push(q);
    console.log(`skip ${q.kind}/${q.slug}: ${e.message}`);
  }
}
await writeFile(LOGOS_FILE, JSON.stringify(logos, null, 2) + "\n");
await writeFile(QUEUE, JSON.stringify(left, null, 2) + "\n");
console.log(`${queue.length - left.length} logos added, ${left.length} left in data/logo-queue.json`);
