// Existing shape (index.html renderPassages): passages grouped by document, each with its document and page.
// Loop copy for web sources. Serves: fact/definition questions — the answer paragraph, then the passages it rests on.
import { esc, cite, caveats } from "./_lib.mjs";

export const name = "passages";
export const serves = ["fact"];
export const required = ["passages"];

// d.answer: the one-paragraph direct answer. d.passages: [{ quote, locator, source, url, as_of }] — short quotes, under 30 words.
export function render(d) {
  return `**Answer**

${esc(d.answer)}

${d.passages.map((p) => `> ${esc(p.quote)}
>
> — ${cite(p)}${p.locator ? `, ${esc(p.locator)}` : ""}`).join("\n\n")}
${caveats(d)}`;
}
