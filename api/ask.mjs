// POST /api/ask — AI help for searches the in-page parser can't fully read.
//   { q }              -> tier 1 (filter spec) and, when the question asks for a fact inside the plans, tier 2 (answers with quotes)
//   { q, log: {...} }  -> no AI; records a tier 0 search in search_log
// Env: OPENAI_API_KEY (The Condo Book Project's own key, in a project with a monthly budget set in the OpenAI dashboard),
//      SUPABASE_SERVICE_ROLE_KEY, optional SUPABASE_URL, AI_DAILY_BUDGET_USD (default 2), AI_HOURLY_LIMIT (default 20).
import OpenAI from "openai";
import { createHash } from "node:crypto";
import {
  MODEL, MAX_COST_USD, T1_MAX_OUT, T2_MAX_OUT, T2_MAX_PLANS, T2_PAGES_PER_PLAN, SPEC_SCHEMA, T1_SYSTEM, T2_SCHEMA, T2_SYSTEM,
  costOf, worstCase, normalize, validateSpec, rpcArgs, tsq, fitPages, t2UserMessage, checkAnswers, factField,
} from "./_lib/ai.mjs";

const SB = process.env.SUPABASE_URL || "https://dvywgltjqpntldlztapu.supabase.co";
const DAILY_BUDGET = Number(process.env.AI_DAILY_BUDGET_USD || 2);
const HOURLY_LIMIT = Number(process.env.AI_HOURLY_LIMIT || 20);
const CACHE_DAYS = 30;

async function sb(path, { method = "GET", body, prefer } = {}) {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const r = await fetch(`${SB}/rest/v1/${path}`, {
    method,
    headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json", ...(prefer ? { Prefer: prefer } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new Error(`supabase ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.status === 204 || r.headers.get("content-length") === "0" ? null : r.json().catch(() => null);
}

const log = (row) => sb("search_log", { method: "POST", body: row, prefer: "return=minimal" }).catch(() => {});

function ipHash(req) {
  const ip = String(req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "").split(",")[0].trim();
  // Salted with the date, so the hash can't follow a visitor past one day.
  return createHash("sha256").update(ip + "|" + new Date().toISOString().slice(0, 10) + "|" + (process.env.SUPABASE_SERVICE_ROLE_KEY || "").slice(-12)).digest("hex").slice(0, 24);
}

async function callJson(client, { system, user, schema, maxOut }) {
  const res = await client.chat.completions.create({
    model: MODEL,
    // No reasoning: these are short, well-specified tasks, and reasoning tokens are billed as output.
    reasoning_effort: "none",
    max_completion_tokens: maxOut,
    messages: [{ role: "developer", content: system }, { role: "user", content: user }],
    response_format: { type: "json_schema", json_schema: { name: "result", strict: true, schema } },
  });
  const cost = costOf(res.usage);
  const choice = res.choices?.[0];
  let data = null;
  if (choice?.finish_reason === "stop" && choice.message?.content && !choice.message.refusal) {
    try { data = JSON.parse(choice.message.content); } catch { data = null; }
  }
  return { data, cost };
}

export default async function handler(req, res) {
  if (req.method !== "POST") { res.status(405).json({ error: "POST only" }); return; }
  const t0 = Date.now();
  const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
  const raw = String(body.q || "").slice(0, 300);
  const q = normalize(raw);
  if (!q) { res.status(400).json({ error: "empty" }); return; }
  const ip = ipHash(req);

  // Tier 0 log only (no AI).
  if (body.log) {
    await log({ query: raw, tier: 0, parsed: body.log.parsed ?? null, results: Number.isInteger(body.log.results) ? body.log.results : null,
      ms: Number.isInteger(body.log.ms) ? body.log.ms : null, source: "web", ip_hash: ip, cost_usd: 0 });
    res.status(204).end(); return;
  }

  if (!process.env.OPENAI_API_KEY || !process.env.SUPABASE_SERVICE_ROLE_KEY) { res.status(503).json({ fallback: true, reason: "not_configured" }); return; }

  let cost = 0;
  try {
    // Cached answer: free.
    const key = "q:" + q;
    const [hit] = await sb(`ai_cache?key=eq.${encodeURIComponent(key)}&created_at=gte.${new Date(Date.now() - CACHE_DAYS * 864e5).toISOString()}&select=tier,spec,answer`);
    if (hit) {
      log({ query: raw, tier: hit.tier, parsed: hit.spec, ms: Date.now() - t0, source: "web", ip_hash: ip, cost_usd: 0, cached: true });
      res.status(200).json({ spec: hit.spec, answer: hit.answer, tier: hit.tier, cached: true, cost_usd: 0 }); return;
    }

    // Limits: per visitor per hour, and a daily budget across everyone.
    const since = new Date(Date.now() - 3600e3).toISOString();
    const today = new Date().toISOString().slice(0, 10) + "T00:00:00Z";
    const [mine, spent] = await Promise.all([
      sb(`search_log?select=id&ip_hash=eq.${ip}&tier=gte.1&cached=eq.false&at=gte.${since}&limit=${HOURLY_LIMIT}`),
      sb(`search_log?select=cost_usd&at=gte.${today}&cost_usd=gt.0&limit=10000`),
    ]);
    const spentToday = spent.reduce((a, r) => a + Number(r.cost_usd || 0), 0);
    if (mine.length >= HOURLY_LIMIT) { res.status(429).json({ fallback: true, reason: "rate_limited" }); return; }
    if (spentToday + MAX_COST_USD > DAILY_BUDGET) { res.status(503).json({ fallback: true, reason: "daily_budget" }); return; }

    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, maxRetries: 1, timeout: 25000 });

    // ---------- tier 1: read the question ----------
    const t1User = `Today is ${new Date().toISOString().slice(0, 10)}.\nSearch: ${raw}`;
    const t1 = await callJson(client, { system: T1_SYSTEM, user: t1User, schema: SPEC_SCHEMA, maxOut: T1_MAX_OUT });
    cost = t1.cost;
    if (!t1.data) {
      log({ query: raw, tier: 1, ms: Date.now() - t0, source: "web", ip_hash: ip, cost_usd: cost });
      res.status(502).json({ fallback: true, reason: "unreadable", cost_usd: cost }); return;
    }
    const spec = validateSpec(t1.data);
    let answer = null, tier = 1;

    // ---------- tier 2: read the pages (only when the question asks for a fact inside the plans) ----------
    if (spec.shape === "extract") {
      tier = 2;
      const field = factField(spec.extract_question);
      const cands = (await sb("rpc/search_plans_v3", { method: "POST", body: { ...rpcArgs(spec, { withTopics: false }), q: tsq(spec.extract_terms), p_limit: T2_MAX_PLANS } }))
        .filter((r) => r.docs_indexed > 0);
      const plans = cands.map((r) => ({ plan_id: r.plan_id, name: r.name, address: r.address, borough: r.borough }));
      if (!plans.length) {
        answer = { question: spec.extract_question, rows: [], note: "No searchable plan mentions this, so there is nothing to read." };
      } else {
        const ids = plans.map((p) => p.plan_id);
        // Answers saved from earlier questions cost nothing.
        const known = await sb(`facts?field=eq.${encodeURIComponent(field)}&method=eq.ai&plan_id=in.(${ids.map((i) => `"${i}"`).join(",")})&select=plan_id,value_text,quote,file_id,page_no`);
        const knownBy = new Map(known.map((f) => [f.plan_id, f]));
        const todo = plans.filter((p) => !knownBy.has(p.plan_id));
        let fresh = [];
        if (todo.length) {
          const pages = await sb("rpc/ai_pages", { method: "POST", body: { p_ids: todo.map((p) => p.plan_id), q: tsq(spec.extract_terms), p_per_plan: T2_PAGES_PER_PLAN, p_chars: 4000 } });
          const { kept, chars } = fitPages(pages, MAX_COST_USD - cost - 0.002);
          const user = t2UserMessage(spec.extract_question, todo, kept);
          if (worstCase(T2_SYSTEM.length + user.length, T2_MAX_OUT) + cost > MAX_COST_USD) throw new Error(`tier 2 over budget (${chars} chars)`);
          const t2 = await callJson(client, { system: T2_SYSTEM, user, schema: T2_SCHEMA, maxOut: T2_MAX_OUT });
          cost += t2.cost;
          fresh = checkAnswers(t2.data, todo, kept);
          const docOf = new Map(kept.map((p) => [p.file_id, p.doc]));
          if (t2.data) {
            await sb("facts", { method: "POST", prefer: "return=minimal", body: fresh.map((a) => ({
              plan_id: a.plan_id, field, value_text: a.answer, quote: a.quote, file_id: a.file_id, page_no: a.page_no, method: "ai", verified: false })) }).catch(() => {});
          }
          fresh.forEach((a) => { if (a.file_id) a.doc = docOf.get(a.file_id) || a.doc; });
        }
        const rows = plans.map((p) => {
          const f = knownBy.get(p.plan_id);
          const a = f ? { plan_id: p.plan_id, stated: !!f.value_text, answer: f.value_text, quote: f.quote, file_id: f.file_id, page_no: f.page_no }
            : fresh.find((x) => x.plan_id === p.plan_id);
          return { ...p, ...a };
        });
        answer = { question: spec.extract_question, rows,
          note: `Read up to ${T2_PAGES_PER_PLAN} matching pages in each of the ${plans.length} plans that mention this most. “Not stated” means those pages don’t say, not that the plan doesn’t.` };
      }
    }

    await Promise.all([
      sb("ai_cache", { method: "POST", prefer: "resolution=merge-duplicates,return=minimal", body: { key, tier, spec, answer, cost_usd: cost, created_at: new Date().toISOString() } }).catch(() => {}),
      log({ query: raw, tier, parsed: spec, ms: Date.now() - t0, source: "web", ip_hash: ip, cost_usd: cost, results: answer?.rows?.length ?? null }),
    ]);
    res.status(200).json({ spec, answer, tier, cached: false, cost_usd: Number(cost.toFixed(5)) });
  } catch (e) {
    console.error("ask failed:", e?.message || e);
    if (cost) log({ query: raw, tier: 1, ms: Date.now() - t0, source: "web", ip_hash: ip, cost_usd: cost });
    res.status(502).json({ fallback: true, reason: "error" });
  }
}
