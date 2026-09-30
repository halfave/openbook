// NEW. How-to: numbered steps, each with where it happens, and the fees and deadlines as cited figures.
// Serves: howto questions (HPD registration, filings).
import { esc, num, cite, caveats } from "./_lib.mjs";

export const name = "steps";
export const serves = ["howto"];
export const required = ["steps", "sources"];

// d.steps: [{ do, where?, fee?: figure, time? }]. d.needs: [text] — what to have ready. d.deadline: text. d.sources: [{ source, url, as_of }].
export function render(d) {
  const fees = d.steps.filter((s) => s.fee);
  return `**How to**

${esc(d.answer)}
${fees.length ? `\n**Fees:** ${fees.map((s) => `${num(s.fee)} (${cite(s.fee)})`).join("; ")}${d.deadline ? ` · **Deadline:** ${esc(d.deadline)}` : ""}\n` : d.deadline ? `\n**Deadline:** ${esc(d.deadline)}\n` : ""}${d.needs?.length ? `
**Have ready:** ${d.needs.map(esc).join("; ")}
` : ""}
${d.steps.map((s, i) => `${i + 1}. ${esc(s.do)}${s.where ? ` — _${esc(s.where)}_` : ""}${s.time ? ` (${esc(s.time)})` : ""}`).join("\n")}

Sources: ${d.sources.map(cite).join("; ")}
${caveats(d)}`;
}
