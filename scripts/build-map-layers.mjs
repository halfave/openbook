// Builds streets.json and parks.json, the street and park layers drawn on the home page map.
//
//   node scripts/build-map-layers.mjs
//
// Sources, both NYC Open Data:
//   Streets: NYC Street Centerline (CSCL), NYC Office of Technology and Innovation (inkn-q76z)
//   Parks:   Parks Properties, NYC Department of Parks and Recreation (enfh-gkve)
//
// Coordinates are packed to keep the files small: each line or ring is a flat list of integers in units of
// 1e-4 degrees (about 10 m), the first point absolute and the rest as differences from the point before.
// The page decodes them and projects them with the same function as the dots.
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const Q = 1e4;
const STREET_TOL = 0.00008; // degrees, about 8 m
const PARK_TOL = 0.0001;
const MIN_PARK = 5e-8; // square degrees, about 450 m²; smaller triangles and gardens are left off

async function socrata(id, select, where) {
  const rows = [];
  for (let off = 0; ; off += 50000) {
    const u = `https://data.cityofnewyork.us/resource/${id}.json?$select=${encodeURIComponent(select)}&$where=${encodeURIComponent(where)}&$order=objectid&$limit=50000&$offset=${off}`;
    const r = await fetch(u);
    if (!r.ok) throw new Error(`${id} download: ${r.status}`);
    const page = await r.json(); rows.push(...page);
    if (page.length < 50000) return rows;
  }
}

// Douglas–Peucker on an open line
function simplify(pts, tol) {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop(); const [ax, ay] = pts[a], [bx, by] = pts[b];
    const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy);
    let max = 0, idx = -1;
    for (let i = a + 1; i < b; i++) {
      const d = len ? Math.abs(dy * pts[i][0] - dx * pts[i][1] + bx * ay - by * ax) / len : Math.hypot(pts[i][0] - ax, pts[i][1] - ay);
      if (d > max) { max = d; idx = i; }
    }
    if (max > tol) { keep[idx] = 1; stack.push([a, idx], [idx, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}
const pack = (pts) => {
  const q = pts.map(([x, y]) => [Math.round(x * Q), Math.round(y * Q)]).filter((p, i, a) => !i || p[0] !== a[i - 1][0] || p[1] !== a[i - 1][1]);
  const out = [q[0][0], q[0][1]];
  for (let i = 1; i < q.length; i++) out.push(q[i][0] - q[i - 1][0], q[i][1] - q[i - 1][1]);
  return out;
};
const area = (r) => { let s = 0; for (let i = 0, j = r.length - 1; i < r.length; j = i++) s += (r[j][0] + r[i][0]) * (r[j][1] - r[i][1]); return Math.abs(s / 2); };

// ---------- streets ----------
// rw_type: 1 street, 2 highway, 3 bridge, 9 ramp. Paths, alleys, driveways, ferries and tunnels are left off.
// Classes: h highways, bridges and ramps; a avenues and other streets with three or more travel lanes; l everything else.
const segs = await socrata("inkn-q76z", "the_geom,rw_type,number_travel_lanes", "status='2' AND rw_type in('1','2','3','9')");
const byClass = { h: [], a: [], l: [] };
for (const s of segs) {
  const cls = s.rw_type === "1" ? (+s.number_travel_lanes >= 3 ? "a" : "l") : "h";
  for (const line of s.the_geom?.coordinates || []) if (line.length >= 2) byClass[cls].push(line);
}

// Join segments that meet end to end into longer strokes, carrying straight on through intersections,
// so a Manhattan avenue is one line instead of two hundred.
const key = ([x, y]) => `${Math.round(x * Q)},${Math.round(y * Q)}`;
const heading = (a, b) => Math.atan2(b[1] - a[1], b[0] - a[0]);
function strokes(lines) {
  const at = new Map(), used = new Uint8Array(lines.length);
  lines.forEach((l, i) => { for (const k of [key(l[0]), key(l[l.length - 1])]) { if (!at.has(k)) at.set(k, []); at.get(k).push(i); } });
  // From the end of `pts`, pick the unused line leaving that point closest to straight ahead (within 30°).
  const next = (pts) => {
    const end = pts[pts.length - 1], dir = heading(pts[pts.length - 2], end);
    let best = null, bestTurn = Math.PI / 6;
    for (const i of at.get(key(end)) || []) {
      if (used[i]) continue;
      const l = key(lines[i][0]) === key(end) ? lines[i] : [...lines[i]].reverse();
      let turn = Math.abs(heading(l[0], l[1]) - dir); if (turn > Math.PI) turn = 2 * Math.PI - turn;
      if (turn < bestTurn) { bestTurn = turn; best = [i, l]; }
    }
    return best;
  };
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (used[i]) continue;
    used[i] = 1; let pts = [...lines[i]];
    for (let n; (n = next(pts)); ) { used[n[0]] = 1; pts.push(...n[1].slice(1)); }
    pts.reverse();
    for (let n; (n = next(pts)); ) { used[n[0]] = 1; pts.push(...n[1].slice(1)); }
    out.push(pack(simplify(pts, STREET_TOL)));
  }
  return out;
}
const streets = Object.fromEntries(Object.entries(byClass).map(([c, lines]) => [c, strokes(lines)]));
await writeFile(join(ROOT, "streets.json"), JSON.stringify(streets));
console.log(`streets: ${segs.length} segments → ${Object.entries(streets).map(([c, l]) => `${l.length} ${c}`).join(", ")}`);

// ---------- parks ----------
const props = await socrata("enfh-gkve", "multipolygon,typecategory", "retired=false");
const parks = [];
for (const p of props) {
  for (const poly of p.multipolygon?.coordinates || []) {
    const outer = poly[0]; if (!outer || area(outer) < MIN_PARK) continue;
    const s = simplify(outer, PARK_TOL); if (s.length >= 4) parks.push(pack(s));
  }
}
await writeFile(join(ROOT, "parks.json"), JSON.stringify(parks));
console.log(`parks: ${props.length} properties → ${parks.length} rings`);
