// Shared by every loop template. A figure is { value, prefix?, unit?, decimals?, label?, pivot?, basis?, n?, source, url, as_of }:
// the number itself plus where it came from and when. Templates render figures only through fig()/cite(), so a number
// can't reach the page without its source and date.

export const esc = (s) => String(s ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");

export function num(f) {
  if (f == null || f.value == null || f.value === "") return "—";
  // A source that shows only a rounded or partial figure: say so instead of rendering it as a real value.
  if (f.exact === false) return `not published exactly (page shows ${f.prefix || ""}${f.value}${f.unit || ""})`;
  const v = typeof f.value === "number"
    ? f.value.toLocaleString("en-US", { maximumFractionDigits: f.decimals ?? 2, minimumFractionDigits: f.decimals ?? (f.prefix === "$" && !Number.isInteger(f.value) ? 2 : 0) })
    : String(f.value);
  return `${f.prefix || ""}${v}${f.unit || ""}`;
}

// "Redfin, as of Aug 2026" — the source link sits beside the number, never in place of it.
export const cite = (f) => (f?.source ? `${f.url ? `[${esc(f.source)}](${f.url})` : esc(f.source)}, as of ${esc(f.as_of || "date not given")}` : "source missing");

// "$1,450/sqft (median, n = 23) — Redfin, as of Aug 2026"
export function fig(f, { withCite = true } = {}) {
  if (f == null) return "—";
  const basis = [f.basis, f.n != null ? `n = ${Number(f.n).toLocaleString("en-US")}` : null].filter(Boolean).join(", ");
  return `${num(f)}${basis ? ` (${esc(basis)})` : ""}${withCite ? ` — ${cite(f)}` : ""}`;
}

// A table cell: a figure renders with its citation, anything else as text.
export const cell = (x) => (x && typeof x === "object" && "value" in x ? fig(x) : esc(x ?? "—"));

export const bullets = (a) => (a || []).map((x) => `- ${typeof x === "object" && "value" in x ? fig(x) : esc(x)}`).join("\n");

// Where sources disagree, both figures show, each cited, with the reason; nothing is silently picked.
export function conflicts(d) {
  if (!d.conflicts?.length) return "";
  return "\n**Where sources disagree**\n\n" + d.conflicts.map((c) =>
    `- ${esc(c.label)}: ${c.figures.map((f) => fig(f)).join("; ")}.${c.resolution ? ` ${esc(c.resolution)}` : ""}`).join("\n") + "\n";
}

export const caveats = (d) => (d.caveats?.length ? `\n_${d.caveats.map(esc).join(" ")}_\n` : "");

// ---------- checks the renderer runs on every result ----------
// Every figure needs a source, a URL and a date; a value can't be a link or "see X"; dollar and percent amounts in
// free text must match a figure (so the headline sentence can't carry a number the figures don't back).
export function lint(d, required = []) {
  const problems = [], figures = [];
  for (const k of ["answer", ...required]) if (d[k] == null || (Array.isArray(d[k]) && !d[k].length)) problems.push(`missing required field "${k}"`);
  const texts = [];
  (function walk(x, path) {
    if (Array.isArray(x)) return x.forEach((y, i) => walk(y, `${path}[${i}]`));
    if (x && typeof x === "object") {
      if ("value" in x) {
        figures.push(x);
        for (const k of ["source", "url", "as_of"]) if (!x[k]) problems.push(`${path}: figure ${num(x)} has no ${k}`);
        if (/^\s*(https?:|see\b|check\b|visit\b)/i.test(String(x.value))) problems.push(`${path}: value is a pointer ("${x.value}"), not a number`);
      }
      for (const [k, v] of Object.entries(x)) if (!["source", "url", "as_of", "value", "prefix", "unit"].includes(k)) walk(v, `${path}.${k}`);
    } else if (typeof x === "string" && !["question", "question_id", "type", "template", "extractor"].includes(path.split(".").pop())) texts.push([path, x]);
  })({ ...d, notes: undefined }, "data"); // notes go to the log, not the page
  const known = figures.map((f) => Number(f.value)).filter(Number.isFinite);
  const mult = { k: 1e3, K: 1e3, M: 1e6, m: 1e6, B: 1e9, b: 1e9 };
  for (const [path, t] of texts) {
    for (const m of t.matchAll(/\$\s?([\d,]+(?:\.\d+)?)\s?([kKmMbB])?\b|([\d,]+(?:\.\d+)?)\s?%/g)) {
      const v = parseFloat((m[1] || m[3]).replace(/,/g, "")) * (mult[m[2]] || 1);
      if (!known.some((k) => Math.abs(k - v) <= Math.max(0.01, Math.abs(v) * 0.005)))
        problems.push(`${path}: "${m[0].trim()}" isn't one of the extracted figures`);
    }
  }
  if (/\b(see|visit|check) (redfin|zillow|streeteasy|the (site|website|source))\b/i.test(texts.map((x) => x[1]).join(" ")))
    problems.push("text sends the reader elsewhere for the answer");
  return problems;
}
