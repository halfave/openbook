// Render an extractor's output through its template and write the iteration log file.
//   node search-loop/templates/render.mjs <data.json> <out.md>
// data.json carries question_id, question, type, extractor, template, answer, the template's required fields, and notes[].
// Exit code 2 when the render check finds problems (unsourced figure, pointer instead of number, missing field);
// the problems are also written under Notes, so the judge and the log both see them.
import { readFileSync, writeFileSync } from "node:fs";
import { lint } from "./_lib.mjs";

const [dataPath, outPath] = process.argv.slice(2);
if (!dataPath || !outPath) { console.error("usage: node render.mjs <data.json> <out.md>"); process.exit(1); }
const d = JSON.parse(readFileSync(dataPath, "utf8"));
const t = await import(new URL(`./${d.template}.mjs`, import.meta.url));

const problems = lint(d, t.required);
let rendered;
try { rendered = t.render(d).replace(/\n{3,}/g, "\n\n").trim(); }
catch (e) { rendered = `(render failed: ${e.message})`; problems.push(`render threw: ${e.message}`); }

const { notes = [], ...data } = d;
const out = `## Question
${d.question} (${d.question_id}, type: ${d.type})

## Template used
${d.template}${d.template === "direct" ? " (fallback)" : ""} · extractor: ${d.extractor || d.type}

## Rendered result

${rendered}

## Data extracted

\`\`\`json
${JSON.stringify(data, null, 2)}
\`\`\`

## Notes
${[...notes, ...problems.map((p) => `Render check: ${p}`)].map((n) => `- ${n}`).join("\n") || "- none"}
`;
writeFileSync(outPath, out);
console.log(`${outPath}: ${t.name}, ${problems.length} render-check problem(s)`);
problems.forEach((p) => console.log("  " + p));
process.exit(problems.length ? 2 : 0);
