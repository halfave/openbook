// AI search helpers shared by api/ask.mjs. No network calls here, so they can be tested for free.
//
// Tier 1: OpenAI GPT-6 Luna turns a question into a filter spec (JSON, validated here, never SQL).
// Tier 2: GPT-6 Luna reads a few pages per plan and answers with a quote and page.
// Every search is held under MAX_COST_USD (5 cents) by capping what goes in and what can come out.

export const MODEL = "gpt-6-luna";
export const PRICE_IN = 0.10 / 1e6;        // $ per input token
export const PRICE_CACHED = 0.01 / 1e6;    // $ per cached input token
export const PRICE_OUT = 0.50 / 1e6;       // $ per output token (reasoning tokens count as output)
export const MAX_COST_USD = 0.05;  // hard ceiling per search, tier 1 + tier 2 together
export const T1_MAX_OUT = 600;
export const T2_MAX_OUT = 1500;
export const T2_MAX_PLANS = 10;
export const T2_PAGES_PER_PLAN = 3;
export const CHARS_PER_TOKEN = 3;  // conservative (English runs ~4), so estimates overshoot, never undershoot

// Chat Completions usage: prompt_tokens includes the cached ones; completion_tokens includes reasoning.
export const costOf = (u) => {
  const cached = u?.prompt_tokens_details?.cached_tokens || 0;
  return ((u?.prompt_tokens || 0) - cached) * PRICE_IN + cached * PRICE_CACHED + (u?.completion_tokens || 0) * PRICE_OUT;
};
export const worstCase = (inChars, maxOut) => Math.ceil(inChars / CHARS_PER_TOKEN) * PRICE_IN + maxOut * PRICE_OUT;

export const normalize = (q) => String(q || "").toLowerCase().replace(/[’']/g, "'").replace(/[^a-z0-9$%'".\-/ ]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 300);

const BOROS = ["MANHATTAN", "BROOKLYN", "QUEENS", "BRONX", "STATEN ISLAND"];
const SHAPES = ["buildings", "passages", "documents", "prices", "extract"];
const FOCUS = ["floor_plans", "schedule_a", "schedule_b", "declaration", "bylaws", "management_agreement"];
const CONSTRUCTION = ["NEW", "REHAB", "CONVERSION"];
const STATUS = ["ACCEPTED", "PENDING", "WITHDRAWN", "ABANDONED", "REJECTED"];
const OPS = ["none", "count", "average", "min", "max"];
const FIELDS = ["units_residential", "units_parking"];

const nul = (s) => ({ anyOf: [s, { type: "null" }] });
const intOrNull = nul({ type: "integer" });
const strOrNull = nul({ type: "string" });
export const SPEC_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    borough: nul({ type: "string", enum: BOROS }),
    zips: { type: "array", items: { type: "string" } },
    area_label: strOrNull,
    min_units: intOrNull, max_units: intOrNull,
    min_parking: intOrNull, max_parking: intOrNull,
    min_commercial: intOrNull, min_storage: intOrNull,
    accepted_from: strOrNull, accepted_to: strOrNull,
    construction: nul({ type: "string", enum: CONSTRUCTION }),
    status: nul({ type: "string", enum: STATUS }),
    sponsor: strOrNull, counsel: strOrNull,
    topics: { type: "array", items: { type: "object", additionalProperties: false,
      properties: { label: { type: "string" }, terms: { type: "array", items: { type: "string" } } }, required: ["label", "terms"] } },
    shape: { type: "string", enum: SHAPES },
    doc_focus: nul({ type: "string", enum: FOCUS }),
    extract_question: strOrNull,
    extract_terms: { type: "array", items: { type: "string" } },
    analytic_op: { type: "string", enum: OPS },
    analytic_field: nul({ type: "string", enum: FIELDS }),
    note: strOrNull,
  },
  required: ["borough", "zips", "area_label", "min_units", "max_units", "min_parking", "max_parking", "min_commercial", "min_storage",
    "accepted_from", "accepted_to", "construction", "status", "sponsor", "counsel", "topics", "shape", "doc_focus",
    "extract_question", "extract_terms", "analytic_op", "analytic_field", "note"],
};

export const T1_SYSTEM = `You read one search typed into The Condo Book Project, a site that searches New York condominium offering plans filed with the NY Attorney General. Turn it into the JSON filter spec. Never answer the question yourself.

Database fields you can filter on (use null when the search doesn't say):
- borough: MANHATTAN, BROOKLYN, QUEENS, BRONX, STATEN ISLAND. A neighborhood implies its borough.
- zips: 5-digit ZIP codes, only for a named neighborhood you are sure of (e.g. Park Slope 11215, 11217; Williamsburg 11211, 11249; Tribeca 10007, 10013; Long Island City 11101, 11109; Astoria 11102, 11103, 11105, 11106). Otherwise []. area_label: the neighborhood as typed, or null.
- min_units / max_units: residential units. "6 unit" = 6 and 6. "under 10" = max 9. "small" or "boutique" = max 10.
- min_parking / max_parking: parking units. "more than 1 parking" = min 2. "with parking" = min 1. "no parking" = max 0.
- min_commercial, min_storage: commercial / storage units, "with retail" = min_commercial 1.
- accepted_from / accepted_to: YYYY-MM-DD, the date the AG accepted the plan. "since 2020" = from 2020-01-01. "last year" is relative to today, given below.
- construction: NEW, REHAB or CONVERSION ("converted", "rental conversion" = CONVERSION; "gut renovation" = REHAB).
- status: ACCEPTED, PENDING, WITHDRAWN, ABANDONED, REJECTED. Only if the search asks.
- sponsor: developer/sponsor name. counsel: sponsor's law firm or attorney name.

topics: things to look for in the plan text. Each has a short label and 2-6 search terms: the phrase, its synonyms, abbreviations. Terms are ORed and used for ranking; none is required as an exact phrase. Examples:
- MIH: "mandatory inclusionary housing", inclusionary, MIH, "affordable housing units"
- 421-a: 421-a, "421a", "tax exemption", "real estate tax exemption"
- parking license: "parking license", "license to use", "parking space license"
- reserve fund: "reserve fund", "working capital fund", "capital reserve"
- managing agent: "managing agent", "management agreement"
Words about how parking or units are sold, leased or licensed are topics, not filters. Don't make a topic out of words already used as a filter (units, parking counts, borough, dates), and not out of filler like "condos", "buildings", "show me", "for sale".

shape: what the answer should look like.
- buildings: a list of buildings (default).
- passages: they want to see what plans say about something.
- documents: they want pages or a section (floor plans, Schedule A/B, declaration, by-laws, management agreement); set doc_focus.
- prices: prices, total offering price, comparing prices.
- extract: they ask for a specific fact written inside each plan that no filter holds, e.g. "which let parking be licensed rather than sold", "reserve fund amount", "who is the managing agent", "is there a doorman". Then set extract_question to one plain question to ask of each building's pages ("Does the plan offer parking spaces by license rather than sale?") and extract_terms to 2-6 search terms that find those pages.
Otherwise extract_question null and extract_terms [].

analytic_op / analytic_field: for "how many", "average", "largest", "smallest" over units_residential or units_parking; otherwise none / null. "Which" and "compare" are lists, not analytics.

note: one short sentence, only if you had to set something aside (e.g. "Sold" isn't in a plan; a plan shows what was offered). Otherwise null.`;

// ---------- validation: nothing from the model reaches the database unchecked ----------
const int = (v, lo = 0, hi = 100000) => (Number.isInteger(v) && v >= lo && v <= hi ? v : null);
const pick = (v, list) => (typeof v === "string" && list.includes(v.toUpperCase()) ? v.toUpperCase() : typeof v === "string" && list.includes(v) ? v : null);
const day = (v) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v + "T00:00:00Z")) ? v : null);
const text = (v, max = 80) => (typeof v === "string" && v.trim() ? v.replace(/[^\p{L}\p{N} &.,'\-]/gu, " ").replace(/\s+/g, " ").trim().slice(0, max) || null : null);
// A search term goes into websearch_to_tsquery, so strip anything that syntax treats specially except the phrase quotes we add.
const term = (v) => { const t = typeof v === "string" ? v.replace(/["()\\:&|!<>*]/g, " ").replace(/\bor\b/gi, " ").replace(/\s+/g, " ").trim().slice(0, 60) : ""; return t || null; };
const NYC_ZIP = /^1(0[0-4]|1[0-6])\d\d$/;

export function validateSpec(raw) {
  const s = raw && typeof raw === "object" ? raw : {};
  const out = {
    borough: pick(s.borough, BOROS),
    zips: Array.isArray(s.zips) ? [...new Set(s.zips.filter((z) => typeof z === "string" && NYC_ZIP.test(z)))].slice(0, 12) : [],
    area_label: text(s.area_label, 40),
    min_units: int(s.min_units), max_units: int(s.max_units),
    min_parking: int(s.min_parking), max_parking: int(s.max_parking),
    min_commercial: int(s.min_commercial), min_storage: int(s.min_storage),
    accepted_from: day(s.accepted_from), accepted_to: day(s.accepted_to),
    construction: pick(s.construction, CONSTRUCTION), status: pick(s.status, STATUS),
    sponsor: text(s.sponsor), counsel: text(s.counsel),
    topics: (Array.isArray(s.topics) ? s.topics : []).slice(0, 4).map((t) => ({
      label: text(t?.label, 40), terms: [...new Set((Array.isArray(t?.terms) ? t.terms : []).map(term).filter(Boolean))].slice(0, 6),
    })).filter((t) => t.label && t.terms.length),
    shape: SHAPES.includes(s.shape) ? s.shape : "buildings",
    doc_focus: FOCUS.includes(s.doc_focus) ? s.doc_focus : null,
    extract_question: typeof s.extract_question === "string" && s.extract_question.trim() ? s.extract_question.trim().slice(0, 200) : null,
    extract_terms: [...new Set((Array.isArray(s.extract_terms) ? s.extract_terms : []).map(term).filter(Boolean))].slice(0, 6),
    analytic_op: OPS.includes(s.analytic_op) ? s.analytic_op : "none",
    analytic_field: FIELDS.includes(s.analytic_field) ? s.analytic_field : null,
    note: typeof s.note === "string" && s.note.trim() ? s.note.trim().slice(0, 200) : null,
  };
  if (out.min_units != null && out.max_units != null && out.min_units > out.max_units) [out.min_units, out.max_units] = [out.max_units, out.min_units];
  if (out.min_parking != null && out.max_parking != null && out.min_parking > out.max_parking) [out.min_parking, out.max_parking] = [out.max_parking, out.min_parking];
  if (out.shape === "extract" && (!out.extract_question || !out.extract_terms.length)) out.shape = out.topics.length ? "passages" : "buildings";
  if (out.shape !== "extract") { out.extract_question = null; out.extract_terms = []; }
  if (out.analytic_op === "none" || !out.analytic_field) { out.analytic_op = "none"; out.analytic_field = null; }
  return out;
}

// websearch_to_tsquery text: terms ORed, a term's words ANDed. Not quoted: a phrase check re-reads every page and times out.
export const tsq = (terms) => terms.join(" OR ");
export const topicQuery = (spec) => tsq(spec.topics.flatMap((t) => t.terms)) || null;

// Arguments for search_plans_v3 (the same RPC the browser calls).
export function rpcArgs(spec, { withTopics = true, limit = 60 } = {}) {
  return {
    q: withTopics ? topicQuery(spec) : null,
    p_borough: spec.borough, p_zips: spec.zips.length ? spec.zips : null,
    p_min_units: spec.min_units, p_max_units: spec.max_units,
    p_min_parking: spec.min_parking, p_max_parking: spec.max_parking,
    p_min_commercial: spec.min_commercial, p_min_storage: spec.min_storage,
    p_accepted_from: spec.accepted_from, p_accepted_to: spec.accepted_to,
    p_construction: spec.construction, p_status: spec.status,
    p_sponsor: spec.sponsor, p_counsel: spec.counsel, p_limit: limit,
  };
}

// ---------- tier 2 ----------
export const T2_SCHEMA = {
  type: "object", additionalProperties: false,
  properties: {
    answers: { type: "array", items: { type: "object", additionalProperties: false,
      properties: {
        plan_id: { type: "string" },
        stated: { type: "boolean" },
        answer: strOrNull,
        quote: strOrNull,
        file_id: intOrNull,
        page_no: intOrNull,
      },
      required: ["plan_id", "stated", "answer", "quote", "file_id", "page_no"] } },
  },
  required: ["answers"],
};

export const T2_SYSTEM = `You answer one question about each New York condominium offering plan, using only the pages given for that plan.
For every plan listed, return one entry.
- If the pages answer the question: stated true, answer in one short sentence (under 25 words, plain words), quote copied exactly from the page (10-40 words, no changes, no ellipses), and the file_id and page_no of that page.
- If they don't: stated false, answer, quote, file_id and page_no null. Never guess, and never use knowledge from outside the pages.`;

// Fit pages into the budget left after tier 1. Pages come ranked, best first per plan; drop from the end.
export function fitPages(pages, budgetUsd, maxOut = T2_MAX_OUT, overheadChars = 2500) {
  const allowedChars = Math.floor(((budgetUsd - maxOut * PRICE_OUT) / PRICE_IN) * CHARS_PER_TOKEN) - overheadChars;
  // Round-robin by rank so every plan keeps its best page before any plan gets a third.
  const byPlan = new Map();
  for (const p of pages) { if (!byPlan.has(p.plan_id)) byPlan.set(p.plan_id, []); byPlan.get(p.plan_id).push(p); }
  const order = [];
  for (let r = 0; r < T2_PAGES_PER_PLAN; r++) for (const list of byPlan.values()) if (list[r]) order.push(list[r]);
  const kept = []; let used = 0;
  for (const p of order) { const c = p.body.length + 80; if (used + c > allowedChars) continue; kept.push(p); used += c; }
  return { kept, chars: used + overheadChars, allowedChars };
}

export function t2UserMessage(question, plans, pages) {
  const blocks = plans.map((pl) => {
    const ps = pages.filter((p) => p.plan_id === pl.plan_id);
    return `<plan plan_id="${pl.plan_id}" name="${String(pl.name || "").replace(/"/g, "'")}">\n` +
      (ps.length ? ps.map((p) => `<page file_id="${p.file_id}" page_no="${p.page_no}">\n${p.body}\n</page>`).join("\n") : "(no pages found)") + "\n</plan>";
  });
  return `Question: ${question}\n\n${blocks.join("\n\n")}`;
}

const squash = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
// Keep an answer only if its quote really is on the page it cites. Anything else becomes "not stated".
export function checkAnswers(raw, plans, pages) {
  const got = new Map((Array.isArray(raw?.answers) ? raw.answers : []).map((a) => [a?.plan_id, a]));
  return plans.map((pl) => {
    const a = got.get(pl.plan_id);
    const page = a && pages.find((p) => p.plan_id === pl.plan_id && p.file_id === a.file_id && p.page_no === a.page_no);
    const ok = a?.stated === true && page && typeof a.answer === "string" && a.answer.trim()
      && typeof a.quote === "string" && squash(a.quote).length >= 12 && squash(page.body).includes(squash(a.quote));
    return ok
      ? { plan_id: pl.plan_id, stated: true, answer: a.answer.trim().slice(0, 300), quote: a.quote.trim().slice(0, 600), file_id: page.file_id, doc: page.doc, page_no: page.page_no }
      : { plan_id: pl.plan_id, stated: false, answer: null, quote: null, file_id: null, doc: null, page_no: null, searched: pages.filter((p) => p.plan_id === pl.plan_id).length };
  });
}

export const factField = (question) => "ai:" + normalize(question).replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 80);
