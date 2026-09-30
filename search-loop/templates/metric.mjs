// NEW. Pivoted metric: one extracted figure, big, with its pivot dimension, basis, sample size, source and as-of date.
// Serves: pivot questions (avg/median price, $/sqft, rent per bedroom, per unit, fee %, cost per kWh). Never a link in place of the number.
import { esc, num, fig, cite, conflicts } from "./_lib.mjs";

export const name = "metric";
export const serves = ["pivot"];
export const required = ["figure", "pivot", "scope", "asked", "shown"];

// d.figure: the headline figure (value, unit, basis "median"/"average", n, source, url, as_of).
// d.pivot: "per square foot" / "per bedroom". d.scope: "Carroll Gardens condos, closed sales, Jun–Aug 2026".
// d.asked / d.shown: { statistic, scope } — what the question asked for vs what the headline figure is. When they differ,
// a mismatch line sits right under the number, so nobody reads an all-types median as a condo average.
// d.cross_check: [figure] from other sources for the same thing. d.derived: [{ label, figure, formula }] — figures computed here
// from sourced components (formula names its inputs). d.breakdown: [{ label, figure }] — e.g. by bedroom count.
// Figures a source shows only rounded carry exact: false and render as "not published exactly".
export function render(d) {
  const all = [d.figure, ...(d.cross_check || [])];
  const diff = [["statistic", "the"], ["scope", "for"]].filter(([k]) => d.asked[k] && d.shown[k] && d.asked[k].toLowerCase() !== d.shown[k].toLowerCase());
  const mismatch = diff.length
    ? `\n> **Not exactly what you asked.** You asked for ${diff.map(([k, w]) => `${w} **${esc(d.asked[k])}**`).join(" ")}; this is ${diff.map(([k, w]) => `${w} **${esc(d.shown[k])}**`).join(" ")}.${d.asked_unavailable ? ` ${esc(d.asked_unavailable)}` : ""}\n`
    : "";
  return `**Answer**

# ${num(d.figure)}
**${esc(d.figure.basis || "")}, ${esc(d.pivot)}** · ${esc(d.scope)}${d.figure.n != null ? ` · n = ${Number(d.figure.n).toLocaleString("en-US")}` : ""}
Source: ${cite(d.figure)}
${mismatch}
${esc(d.answer)}
${d.caveats?.length ? `\n${d.caveats.map((c) => `- ${esc(c)}`).join("\n")}\n` : ""}${all.length > 1 ? `
| Source | Figure | Basis | As of |
|---|---:|---|---|
${all.map((f) => `| ${f.url ? `[${esc(f.source)}](${f.url})` : esc(f.source)} | ${num(f)} | ${esc([f.basis, f.n != null ? `n = ${f.n}` : null].filter(Boolean).join(", ") || "—")} | ${esc(f.as_of)} |`).join("\n")}
` : ""}${d.derived?.length ? `
**Computed here**

${d.derived.map((x) => `- ${esc(x.label)}: ${num(x.figure)} = ${esc(x.formula)} (inputs: ${cite(x.figure)})`).join("\n")}
` : ""}${d.breakdown?.length ? `
| ${esc(d.breakdown_label || "Breakdown")} | Figure |
|---|---:|
${d.breakdown.map((b) => `| ${esc(b.label)} | ${fig(b.figure)} |`).join("\n")}
` : ""}${conflicts(d)}`;
}
