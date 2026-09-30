// NEW. Regulation/rule: what the rule says, its threshold numbers, effective dates, who it applies to, and the citation.
// Serves: regulation questions (RGB increases, Good Cause cap, LL97 limits).
import { esc, num, cite, caveats } from "./_lib.mjs";

export const name = "rule";
export const serves = ["regulation"];
export const required = ["rule_name", "citation", "thresholds", "applies_to"];

// d.rule_name, d.citation: { source, url, as_of, section }. d.thresholds: [{ label, figure, period? }].
// d.effective: text date(s). d.applies_to / d.exempt: text. d.applies_here: optional one-line verdict for the asker's case.
export function render(d) {
  return `**Rule · ${esc(d.rule_name)}**

${esc(d.answer)}
${d.applies_here ? `\n**For your case: ${esc(d.applies_here)}**\n` : ""}
| Threshold | Figure | Period | Source, as of |
|---|---:|---|---|
${d.thresholds.map((t) => `| ${esc(t.label)} | ${num(t.figure)} | ${esc(t.period || "—")} | ${cite(t.figure)} |`).join("\n")}

- **Applies to:** ${esc(d.applies_to)}
${d.exempt ? `- **Doesn't apply to:** ${esc(d.exempt)}\n` : ""}${d.effective ? `- **Effective:** ${esc(d.effective)}\n` : ""}- **Rule text:** ${cite(d.citation)}${d.citation.section ? `, ${esc(d.citation.section)}` : ""}
${caveats(d)}`;
}
