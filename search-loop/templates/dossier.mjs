// Existing shape (index.html renderAnswer): one named thing, its key fields, where the record lives.
// Loop copy for extracted web facts. Serves: entity questions (person, company, agency, building, law).
import { esc, cell, cite, caveats } from "./_lib.mjs";

export const name = "dossier";
export const serves = ["entity"];
export const required = ["entity", "kind", "fields", "sources"];

// d.entity: name. d.kind: "agency", "company"... d.fields: [{ label, value: figure|text }]. d.sources: [{ source, url, as_of }].
export function render(d) {
  return `**${esc(d.kind)}**

## ${esc(d.entity)}

${esc(d.answer)}

| | |
|---|---|
${d.fields.map((f) => `| ${esc(f.label)} | ${cell(f.value)} |`).join("\n")}

Sources: ${d.sources.map(cite).join("; ")}
${caveats(d)}`;
}
