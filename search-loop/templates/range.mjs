// NEW. Range/estimate: low–typical–high, each end cited, with what pushes a case toward each end.
// Serves: range questions (what does X cost). A variant of metric where no single figure is honest.
import { esc, num, cite, conflicts, caveats } from "./_lib.mjs";

export const name = "range";
export const serves = ["range"];
export const required = ["low", "high", "scope"];

// d.low / d.typical / d.high: { figure, drivers: "what puts you here" }. d.scope: what the range covers. d.components: [{ label, figure }] — fee lines.
export function render(d) {
  const ends = [["Low", d.low], ["Typical", d.typical], ["High", d.high]].filter(([, x]) => x);
  return `**Answer**

# ${num(d.low.figure)} – ${num(d.high.figure)}${d.typical ? `  ·  typical ${num(d.typical.figure)}` : ""}
${esc(d.scope)}

${esc(d.answer)}

| | Figure | What puts you here | Source, as of |
|---|---:|---|---|
${ends.map(([k, x]) => `| ${k} | ${num(x.figure)} | ${esc(x.drivers || "—")} | ${cite(x.figure)} |`).join("\n")}
${d.components?.length ? `
**Cost lines**

${d.components.map((c) => `- ${esc(c.label)}: ${num(c.figure)} — ${cite(c.figure)}`).join("\n")}
` : ""}${conflicts(d)}${caveats(d)}`;
}
