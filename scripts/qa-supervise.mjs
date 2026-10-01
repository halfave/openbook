// Runs the QA jobs unattended, in two lanes, restarting a job until it finishes with no plan left in error.
//
//   node scripts/qa-supervise.mjs        logs to data/qa-runs/<lane>.log
//
// Lane A: new/changed published Schedule A tables → held readings (then their report).
// Lane B: plans where no Schedule A was found → Schedule B budgets.
// A job is done when it exits 0, didn't stop on an error streak, and its output folder has no "error" results.
// Otherwise it is started again after a pause (finished plans are skipped on a restart), up to 40 times.
import { spawn } from "node:child_process";
import { appendFile, mkdir, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { ROOT } from "./site.mjs";

const LOGS = join(ROOT, "data", "qa-runs");
await mkdir(LOGS, { recursive: true });
const job = (name, args, outDir) => ({ name, args, outDir });
const LANES = {
  a: [
    job("schedule-a new", ["scripts/qa-schedule-a.mjs", "--all", "--concurrency", "3"], "data/schedule-a-qa"),
    job("schedule-a held", ["scripts/qa-schedule-a.mjs", "--all", "--pub", "data/schedule-a-qa-held/input", "--out", "data/schedule-a-qa-held", "--concurrency", "3"], "data/schedule-a-qa-held"),
    job("schedule-a held report", ["scripts/qa-schedule-a-held.mjs", "report"], null),
  ],
  b: [
    job("schedule-a not found", ["scripts/qa-schedule-a-notfound.mjs", "--all", "--concurrency", "3"], "data/schedule-a-qa-notfound"),
    job("schedule-b", ["scripts/qa-schedule-b.mjs", "--all", "--concurrency", "3"], "data/schedule-b-qa"),
  ],
};
const log = (lane, s) => appendFile(join(LOGS, `${lane}.log`), `[${new Date().toISOString()}] ${s}\n`);
const errorsIn = async (dir) => {
  if (!dir) return 0;
  let n = 0;
  for (const f of (await readdir(join(ROOT, dir)).catch(() => [])).filter((f) => /^C[DC]\d+\.json$/.test(f))) {
    try { if (JSON.parse(await readFile(join(ROOT, dir, f), "utf8")).verdict === "error") n++; } catch { n++; }
  }
  return n;
};
const runOnce = (lane, j) => new Promise((res) => {
  let tail = "";
  const p = spawn(process.execPath, j.args, { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
  const out = (d) => { const s = String(d); tail = (tail + s).slice(-4000); appendFile(join(LOGS, `${lane}.log`), s); };
  p.stdout.on("data", out); p.stderr.on("data", out);
  p.on("close", (code) => res({ code, stopped: /stopping:/.test(tail) }));
  p.on("error", (e) => res({ code: -1, stopped: true, err: e.message }));
});
async function lane(name) {
  for (const j of LANES[name]) {
    for (let attempt = 1; ; attempt++) {
      await log(name, `start ${j.name} (attempt ${attempt})`);
      const r = await runOnce(name, j);
      const errs = await errorsIn(j.outDir);
      await log(name, `end ${j.name}: exit ${r.code}${r.stopped ? ", stopped on errors" : ""}, ${errs} plans in error`);
      if (r.code === 0 && !r.stopped && errs === 0) break;
      // A handful of plans that fail every time (a PDF the renderer can't open) shouldn't hold the lane forever.
      if (attempt >= 40 || (attempt >= 4 && r.code === 0 && !r.stopped)) { await log(name, `giving up on ${j.name} with ${errs} plans in error`); break; }
      await new Promise((s) => setTimeout(s, r.stopped ? 300000 : 60000));
    }
  }
  await log(name, "lane done");
}
await Promise.all(Object.keys(LANES).map(lane));
console.log("all QA lanes done; see data/qa-runs/");
