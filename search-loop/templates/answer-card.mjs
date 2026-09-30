// Existing shape (index.html renderStat): a number, what it covers, a breakdown, a by-year view.
// Loop copy for extracted web figures. Serves: trend questions (metric over time), and aggregates with a breakdown.
import { esc, fig, num, cite, conflicts, caveats } from "./_lib.mjs";

export const name = "answer-card";
export const serves = ["trend"];
export const required = ["figure", "covers"];

// d.figure: the headline figure (latest value). d.change: { figure (a % figure), from, to } — the YoY/QoQ move.
// d.breakdown: [{ label, figure }] — one row per period (oldest first) or per group.
export function render(d) {
  const rows = d.breakdown || [];
  const ch = d.change ? `\n**${num(d.change.figure)}** ${esc(d.change.from)} → ${esc(d.change.to)} — ${cite(d.change.figure)}\n` : "";
  const spark = rows.length && rows.every((r) => typeof r.figure?.value === "number") ? sparkline(rows.map((r) => r.figure.value)) : "";
  return `**Answer**

# ${num(d.figure)}
${esc(d.covers)}${d.figure.n != null ? ` · n = ${Number(d.figure.n).toLocaleString("en-US")}` : ""}
Source: ${cite(d.figure)}
${ch}
${esc(d.answer)}
${rows.length ? `
${spark ? `\`${spark}\`\n` : ""}
| ${esc(d.breakdown_label || "Period")} | ${esc(d.metric_label || "Value")} | Source, as of |
|---|---:|---|
${rows.map((r) => `| ${esc(r.label)} | ${num(r.figure)} | ${cite(r.figure)} |`).join("\n")}
` : ""}${conflicts(d)}${caveats(d)}`;
}

const BARS = "▁▂▃▄▅▆▇█";
function sparkline(v) {
  const lo = Math.min(...v), hi = Math.max(...v);
  return v.map((x) => BARS[hi === lo ? 3 : Math.round(((x - lo) / (hi - lo)) * 7)]).join("");
}
