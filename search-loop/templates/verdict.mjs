// NEW. Yes/no with conditions: the verdict word first, then the conditions that flip it, then the rule it rests on.
// Serves: yesno questions.
import { esc, cite, caveats } from "./_lib.mjs";

export const name = "verdict";
export const serves = ["yesno"];
export const required = ["verdict", "conditions", "basis"];

// d.verdict: "Yes" | "No" | "Only if…". d.conditions: [{ when, then }]. d.basis: [{ source, url, as_of, section? }].
export function render(d) {
  return `**Answer**

# ${esc(d.verdict)}

${esc(d.answer)}

| When | Then |
|---|---|
${d.conditions.map((c) => `| ${esc(c.when)} | ${esc(c.then)} |`).join("\n")}

Based on: ${d.basis.map((b) => `${cite(b)}${b.section ? `, ${esc(b.section)}` : ""}`).join("; ")}
${caveats(d)}`;
}
