// Existing shape (index.html renderCards): a titled, ordered list with a status line saying how it's ranked.
// Loop copy for extracted web figures. Serves: list/ranking questions — top N with the number that ranks them.
import { esc, num, cite, conflicts, caveats } from "./_lib.mjs";

export const name = "list";
export const serves = ["list"];
export const required = ["rank_by", "items"];

// d.rank_by: "median condo price per sq ft". d.items: [{ name, figure, note? }] in rank order.
export function render(d) {
  return `**Top ${d.items.length} · ranked by ${esc(d.rank_by)}**

${esc(d.answer)}

| # | ${esc(d.item_label || "Name")} | ${esc(d.rank_by)} | Source, as of |
|---:|---|---:|---|
${d.items.map((it, i) => `| ${i + 1} | ${esc(it.name)}${it.note ? ` _(${esc(it.note)})_` : ""} | ${num(it.figure)} | ${cite(it.figure)} |`).join("\n")}
${d.basis ? `\nBasis: ${esc(d.basis)}\n` : ""}${conflicts(d)}${caveats(d)}`;
}
