// FALLBACK. Plain direct answer for questions no template fits. Not one of the 10: the loop counts how often it's used.
// Over ~20% of iterations means the question-type set is wrong, not the templates.
import { esc, cite, caveats } from "./_lib.mjs";

export const name = "direct";
export const serves = [];
export const required = ["sources"];

// d.answer: the answer paragraph. d.more: [text] — up to 3 supporting sentences. d.sources: [{ source, url, as_of }].
export function render(d) {
  return `**Answer**

${esc(d.answer)}
${d.more?.length ? `\n${d.more.map(esc).join(" ")}\n` : ""}
Sources: ${d.sources.map(cite).join("; ")}
${caveats(d)}`;
}
