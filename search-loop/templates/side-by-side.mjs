// Existing shape (index.html renderSide): one column per item, one row per attribute, rows that match across items shown faint.
// Loop copy for extracted web figures. Serves: comparison questions (A vs B vs C on the same metrics).
import { esc, cell, conflicts, caveats } from "./_lib.mjs";

export const name = "side-by-side";
export const serves = ["comparison"];
export const required = ["items", "rows"];

// d.items: ["Buildium", "AppFolio", ...]. d.rows: [{ label, cells: [figure|text per item] }]. d.winner: optional one-line verdict.
export function render(d) {
  const same = (r) => r.cells.every((c) => JSON.stringify(c?.value ?? c) === JSON.stringify(r.cells[0]?.value ?? r.cells[0]));
  return `**Side by side · ${d.items.length}**

${esc(d.answer)}
${d.winner ? `\n**${esc(d.winner)}**\n` : ""}
| | ${d.items.map(esc).join(" | ")} |
|---|${d.items.map(() => "---").join("|")}|
${d.rows.map((r) => `| ${same(r) ? `_${esc(r.label)} (same)_` : `**${esc(r.label)}**`} | ${r.cells.map(cell).join(" | ")} |`).join("\n")}
${conflicts(d)}${caveats(d)}`;
}
