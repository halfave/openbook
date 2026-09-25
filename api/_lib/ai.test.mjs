// node --test api/_lib/ai.test.mjs  (free: no network, no model calls)
import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_COST_USD, T1_MAX_OUT, T2_MAX_OUT, T1_SYSTEM, T2_SYSTEM, T2_MAX_PLANS, T2_PAGES_PER_PLAN,
  validateSpec, rpcArgs, topicQuery, fitPages, t2UserMessage, checkAnswers, worstCase, costOf, normalize, factField,
} from "./ai.mjs";

const blank = { borough: null, zips: [], area_label: null, min_units: null, max_units: null, min_parking: null, max_parking: null,
  min_commercial: null, min_storage: null, accepted_from: null, accepted_to: null, construction: null, status: null, sponsor: null,
  counsel: null, topics: [], shape: "buildings", doc_focus: null, extract_question: null, extract_terms: [], analytic_op: "none", analytic_field: null, note: null };

test("acceptance 1: 6 units, 2+ parking, license/lease is a topic, not a filter", () => {
  const s = validateSpec({ ...blank, min_units: 6, max_units: 6, min_parking: 2,
    topics: [{ label: "parking license or lease", terms: ["parking license", "license", "lease"] }] });
  const a = rpcArgs(s);
  assert.equal(a.p_min_units, 6); assert.equal(a.p_max_units, 6); assert.equal(a.p_min_parking, 2);
  assert.equal(a.q, "parking license OR license OR lease");
  assert.equal(rpcArgs(s, { withTopics: false }).q, null);
});

test("acceptance 2: MIH synonyms become an OR query", () => {
  const s = validateSpec({ ...blank, topics: [{ label: "MIH", terms: ["mandatory inclusionary housing", "inclusionary", "MIH"] }] });
  assert.equal(topicQuery(s), "mandatory inclusionary housing OR inclusionary OR MIH");
});

test("model output is cleaned before it reaches the database", () => {
  const s = validateSpec({ ...blank, borough: "brooklyn", zips: ["11215", "90210", "abc", 11217], min_units: -3, max_units: 2.5,
    accepted_from: "2020-13-45", accepted_to: "2024-01-01", construction: "conversion", status: "SOLD", sponsor: "Acme; DROP TABLE plans",
    topics: [{ label: "x", terms: ['a") OR (b', "c:*", "or"] }, { label: "", terms: ["y"] }], shape: "weird", analytic_op: "count", analytic_field: null });
  assert.equal(s.borough, "BROOKLYN");
  assert.deepEqual(s.zips, ["11215"]);
  assert.equal(s.min_units, null); assert.equal(s.max_units, null);
  assert.equal(s.accepted_from, null); assert.equal(s.accepted_to, "2024-01-01");
  assert.equal(s.construction, "CONVERSION"); assert.equal(s.status, null);
  assert.equal(s.sponsor, "Acme DROP TABLE plans");
  assert.deepEqual(s.topics, [{ label: "x", terms: ["a b", "c"] }]);
  assert.equal(s.shape, "buildings"); assert.equal(s.analytic_op, "none");
});

test("extract without terms falls back to a list", () => {
  assert.equal(validateSpec({ ...blank, shape: "extract", extract_question: "Reserve fund?" }).shape, "buildings");
  const ok = validateSpec({ ...blank, shape: "extract", extract_question: "How big is the reserve fund?", extract_terms: ["reserve fund", "working capital fund"] });
  assert.equal(ok.shape, "extract");
});

test("every search stays under 5 cents, worst case", () => {
  // Tier 1: the whole system prompt plus a 300-character search, with the longest possible reply.
  const t1 = worstCase(T1_SYSTEM.length + 400, T1_MAX_OUT);
  assert.ok(t1 < 0.01, `tier 1 worst case ${t1}`);
  // Tier 2: 10 plans x 3 pages x 4000 characters offered; fitPages trims to what's left.
  const pages = [];
  for (let i = 0; i < T2_MAX_PLANS; i++) for (let j = 0; j < T2_PAGES_PER_PLAN; j++)
    pages.push({ plan_id: "CD00000" + i, file_id: i, page_no: j, doc: "x.pdf", body: "w".repeat(4000) });
  const left = MAX_COST_USD - t1 - 0.002;
  const { kept } = fitPages(pages, left);
  const plans = [...new Set(pages.map((p) => p.plan_id))].map((plan_id) => ({ plan_id, name: "N" }));
  const user = t2UserMessage("A question of normal length about the plan?", plans, kept);
  const total = t1 + worstCase(T2_SYSTEM.length + user.length, T2_MAX_OUT);
  assert.ok(total <= MAX_COST_USD, `worst case ${total}`);
  // Every plan keeps at least its best page.
  assert.equal(new Set(kept.map((p) => p.plan_id)).size, T2_MAX_PLANS);
});

test("an answer counts only if its quote is on the cited page", () => {
  const pages = [{ plan_id: "A", file_id: 1, page_no: 7, doc: "A_Offering Plan.pdf", body: "Parking Spaces will be licensed, not sold, to Unit Owners for a monthly fee." }];
  const plans = [{ plan_id: "A" }, { plan_id: "B" }];
  const out = checkAnswers({ answers: [
    { plan_id: "A", stated: true, answer: "Licensed, not sold.", quote: "Parking  Spaces will be licensed, not sold, to Unit Owners", file_id: 1, page_no: 7 },
    { plan_id: "B", stated: true, answer: "Sold.", quote: "Parking spaces are sold as units", file_id: 9, page_no: 1 },
  ] }, plans, pages);
  assert.equal(out[0].stated, true); assert.equal(out[0].doc, "A_Offering Plan.pdf");
  assert.equal(out[1].stated, false);
  const fake = checkAnswers({ answers: [{ plan_id: "A", stated: true, answer: "x", quote: "spaces are sold outright to purchasers", file_id: 1, page_no: 7 }] }, [{ plan_id: "A" }], pages);
  assert.equal(fake[0].stated, false);
  assert.equal(checkAnswers(null, [{ plan_id: "A" }], pages)[0].stated, false);
});

test("helpers", () => {
  assert.equal(normalize("  Show ME  condos!! "), "show me condos");
  assert.ok(Math.abs(costOf({ prompt_tokens: 1000, completion_tokens: 200 }) - 0.0002) < 1e-12);
  // 800 of the 1000 prompt tokens cached: 200 x $0.10 + 800 x $0.01 per million, plus output
  assert.ok(Math.abs(costOf({ prompt_tokens: 1000, completion_tokens: 200, prompt_tokens_details: { cached_tokens: 800 } }) - 0.000128) < 1e-12);
  assert.equal(factField("How big is the reserve fund?"), "ai:how_big_is_the_reserve_fund");
});
