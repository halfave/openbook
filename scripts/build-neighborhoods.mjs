// Builds neighborhoods.json, the neighborhood lines drawn on the home page map.
//
//   node scripts/build-neighborhoods.mjs
//
// Source: 2020 Neighborhood Tabulation Areas (NTAs), NYC Department of City Planning, via NYC Open Data.
// Output is simplified [lng, lat] rings; the page projects them with the same function as the dots.
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

const SRC = "https://data.cityofnewyork.us/resource/9nt8-h7nd.geojson?$limit=1000";
const ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const TOL = 0.00025; // degrees, about 20 m
const MIN_AREA = 2e-7; // drop slivers and tiny islands (square degrees)

// Douglas–Peucker
function simplify(pts, tol) {
  if (pts.length < 4) return pts;
  const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
  // A closed ring starts and ends on the same point, so split it at the vertex farthest from the start.
  let far = 1;
  for (let i = 1; i < pts.length - 1; i++) if (Math.hypot(pts[i][0] - pts[0][0], pts[i][1] - pts[0][1]) > Math.hypot(pts[far][0] - pts[0][0], pts[far][1] - pts[0][1])) far = i;
  keep[far] = 1;
  const stack = [[0, far], [far, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop(); const [ax, ay] = pts[a], [bx, by] = pts[b];
    const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy) || 1e-12;
    let max = 0, idx = -1;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs(dy * pts[i][0] - dx * pts[i][1] + bx * ay - by * ax) / len;
      if (d > max) { max = d; idx = i; }
    }
    if (max > tol) { keep[idx] = 1; stack.push([a, idx], [idx, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}
const area = (r) => { let s = 0; for (let i = 0, j = r.length - 1; i < r.length; j = i++) s += (r[j][0] + r[i][0]) * (r[j][1] - r[i][1]); return Math.abs(s / 2); };
const centroid = (r) => { let x = 0, y = 0, a = 0; for (let i = 0, j = r.length - 1; i < r.length; j = i++) { const f = r[j][0] * r[i][1] - r[i][0] * r[j][1]; x += (r[j][0] + r[i][0]) * f; y += (r[j][1] + r[i][1]) * f; a += f; } return [x / (3 * a), y / (3 * a)]; };
const round = ([x, y]) => [+x.toFixed(4), +y.toFixed(4)];

const r = await fetch(SRC);
if (!r.ok) throw new Error(`NTA download: ${r.status}`);
const src = await r.json();

const out = [];
for (const f of src.features) {
  const p = f.properties, polys = f.geometry.type === "Polygon" ? [f.geometry.coordinates] : f.geometry.coordinates;
  const rings = [];
  let best = null;
  for (const poly of polys) {
    const outer = poly[0]; const a = area(outer);
    if (a < MIN_AREA) continue;
    const s = simplify(outer, TOL).map(round);
    if (s.length >= 4) rings.push(s);
    if (!best || a > best.a) best = { a, ring: outer };
  }
  if (!rings.length) continue;
  // ntatype 0 is a residential neighborhood; the others are parks, cemeteries, airports and the like.
  out.push({ n: p.ntaname, b: p.boroname, r: p.ntatype === "0", l: round(centroid(best.ring)), g: rings });
}
out.sort((a, b) => a.n.localeCompare(b.n));
await writeFile(join(ROOT, "neighborhoods.json"), JSON.stringify(out));
console.log(`${out.length} neighborhoods, ${out.reduce((s, x) => s + x.g.reduce((t, g) => t + g.length, 0), 0)} points`);
