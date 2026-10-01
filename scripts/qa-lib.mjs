// Shared by the QA scripts: model calls through the local `claude` CLI (subscription login; API keys are removed from
// the environment so nothing bills the API), offering plan PDFs, and page rendering.
import { spawn } from "node:child_process";
import { mkdir, writeFile, access } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rest, ROOT } from "./site.mjs";

export const CACHE = process.env.PLAN_CACHE || join(tmpdir(), "openbook-plans");
const { ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, ...BASE_ENV } = process.env;
export const run = (cmd, args, input, env = {}, timeout = 0) => new Promise((res, rej) => {
  const p = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"], env: { ...BASE_ENV, ...env } });
  let o = "", e = "", timedOut = false;
  const timer = timeout ? setTimeout(() => { timedOut = true; p.kill(); }, timeout) : null;
  p.stdout.on("data", (d) => (o += d)); p.stderr.on("data", (d) => (e += d));
  p.on("error", rej);
  p.on("close", (c) => {
    if (timer) clearTimeout(timer);
    if (timedOut) rej(Object.assign(new Error(`timed out after ${timeout / 1000}s`), { timeout: true }));
    else if (c === 0) res(o); else rej(new Error(`${cmd} exited ${c}: ${(e || o).slice(0, 300)}`));
  });
  if (input != null) p.stdin.end(input); else p.stdin.end();
});
export const exists = (f) => access(f).then(() => true, () => false);
const WIN_BIN = join(process.env.APPDATA || "", "npm", "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe");
const CLAUDE = process.env.CLAUDE_BIN || (process.platform === "win32" && (await exists(WIN_BIN)) ? WIN_BIN : "claude");
const SYSTEM = "You read tables in New York condominium offering plans exactly. Output only what is asked, no commentary.";

// One model call with page images readable through the Read tool. Thinking off. Usage limits are waited out.
export async function ask(tally, model, prompt, images = [], dir = null, timeout = 600000) {
  const args = ["-p", "--model", model, "--system-prompt", SYSTEM, "--strict-mcp-config", "--no-session-persistence",
    "--setting-sources", "", "--output-format", "json"];
  if (images.length) args.push("--tools", "Read", "--allowedTools", "Read", "--max-turns", String(images.length + 3), "--add-dir", dir);
  else args.push("--tools", "");
  let j;
  for (let t = 0; ; t++) {
    try { j = JSON.parse(await run(CLAUDE, args, prompt, { MAX_THINKING_TOKENS: "0" }, timeout)); if (!j.is_error) break; throw new Error(`model error: ${String(j.result).slice(0, 200)}`); }
    catch (e) {
      if (/limit|rate|overloaded|529|429/i.test(e.message) && t < 18) { console.log(`  [${model}] ${e.message.slice(0, 120)}; waiting 10 min`); await new Promise((r) => setTimeout(r, 600000)); continue; }
      if (e.timeout || t >= 2) throw e;
      await new Promise((r) => setTimeout(r, 5000 * (t + 1)));
    }
  }
  const u = j.usage || {};
  tally.tokens += (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.output_tokens || 0);
  tally.calls++;
  return String(j.result || "");
}
export const jsonIn = (s) => { try { return JSON.parse(s.match(/\{[\s\S]*\}/)[0]); } catch { return null; } };

export async function pdfFor(id) {
  const f = join(CACHE, id + ".pdf");
  if (await exists(f)) return f;
  const docs = await rest(`documents?select=pdf_url&plan_id=eq.${id}&doc_kind=eq.offering_plan&status=eq.done&pdf_url=not.is.null&limit=1`);
  const url = docs[0]?.pdf_url;
  if (!url) return null;
  const r = await fetch(url);
  if (!r.ok) return null;
  await mkdir(CACHE, { recursive: true });
  await writeFile(f, Buffer.from(await r.arrayBuffer()));
  return f;
}
const PY = process.env.PYTHON || "python";
export const pageCount = async (pdf) => Number((await run(PY, [join(ROOT, "scripts", "render-pages.py"), pdf, "count"])).trim());
export const render = async (pdf, id, dpi, nums) => (await run(PY, [join(ROOT, "scripts", "render-pages.py"), pdf, join(CACHE, id), String(dpi), ...nums.map(String)]))
  .trim().split(/\r?\n/).filter(Boolean);
export const numOrNull = (s) => { const t = String(s ?? "").replace(/[$,%\s]/g, "").replace(/^\((.*)\)$/, "-$1"); return t === "" || !/^-?\d*\.?\d+$/.test(t) ? null : Number(t); };

// Runs `fn` over ids with `conc` workers; skips ids whose output already exists unless it errored. Stops after 8 errors
// in a row (network or CLI down) so a supervisor can restart it.
export async function pool(ids, conc, outDir, fn) {
  await mkdir(outDir, { recursive: true });
  const { readFile } = await import("node:fs/promises");
  let i = 0, streak = 0, done = 0;
  const work = async () => {
    while (i < ids.length) {
      if (streak >= 8) { console.log("stopping: 8 errors in a row"); i = ids.length; process.exitCode = 3; break; }
      const id = ids[i++], f = join(outDir, id + ".json");
      if (await exists(f)) { const p = JSON.parse(await readFile(f, "utf8")); if (p.verdict !== "error") continue; }
      let r;
      try { r = await fn(id); streak = 0; } catch (e) { r = { plan_id: id, verdict: "error", reason: e.message.slice(0, 300) }; streak++; }
      await writeFile(f, JSON.stringify({ ...r, qa_date: new Date().toISOString() }, null, 1));
      console.log(`${String(++done).padStart(4)} ${id} ${r.verdict}${r.summary ? "  " + r.summary : ""}${r.reason ? "  (" + r.reason + ")" : ""}`);
    }
  };
  await Promise.all(Array.from({ length: conc }, work));
}
