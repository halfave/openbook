// Property managers and sponsor's counsel, grouped across spellings. Shared by build-pages.mjs (the directories and
// profile pages) and build-buildings.mjs (which links each building's manager and counsel to their profile).
import { tc, boro } from "./site.mjs";

// A firm gets a profile page (managing-agents/<slug>.html, offering-plan-attorneys/<slug>.html) at this many NYC plans.
export const PROFILE_MIN = 2;
const NYC = (p) => boro(p.borough) !== "Outside New York City";

// ---------- managing agents ----------
// From the first-year management agreement in each offering plan (facts.managing_agent). Spellings vary
// ("FirstService Residential New York, Inc." / "FirstService Residential"), so names are grouped by a key.
const SUFFIX_WORDS = new Set(["inc", "llc", "l", "c", "corp", "corporation", "co", "company", "ltd", "the", "pc"]);
export const agentKey = (v) => String(v).toLowerCase().replace(/\([^)]*\)/g, " ").replace(/&/g, " and ").replace(/[^a-z0-9 ]+/g, " ")
  .split(/\s+/).filter((w) => w && !SUFFIX_WORDS.has(w)).join(" ");
// What to type in the search box: the name without "(Sponsor)" notes and company suffixes, so every spelling matches.
export const agentQuery = (v) => String(v).replace(/\([^)]*\)/g, "").trim().replace(/[,\s]+(inc|llc|l\.l\.c|corp|corporation|co|company|ltd)\.?$/i, "").replace(/[,\s]+(inc|llc|corp)\.?$/i, "").trim();
// The sponsor, its affiliate or principal, or the board manages the building instead of an outside company.
const selfManaged = (v) => /^\s*sponsor\b|\(\s*sponsor|affiliate of (the )?sponsor|sponsor affiliate|principal of (the )?sponsor|self-managed/i.test(v);
// Also when the manager named is the sponsor itself ("82 Sterling Place, LLC" managing 82 Sterling Place).
export const isSelf = (v, p) => selfManaged(v) || (!!p.sponsor && agentKey(v) === agentKey(p.sponsor));

// agentFacts: facts rows {plan_id, value_text} for field managing_agent. byId: plan_id -> plan.
// Returns [{name, query, plans, slug, names}], most plans first; names is every spelling filed.
export function groupAgents(agentFacts, byId) {
  const groups = new Map();
  for (const f of agentFacts) {
    const p = byId.get(f.plan_id);
    if (!p || !NYC(p) || isSelf(f.value_text, p)) continue;
    const k = agentKey(f.value_text);
    if (!k) continue;
    if (!groups.has(k)) groups.set(k, { key: k, names: new Map(), plans: new Map() });
    const g = groups.get(k);
    g.names.set(f.value_text.trim(), (g.names.get(f.value_text.trim()) || 0) + 1);
    g.plans.set(p.plan_id, p);
  }
  // "firstservice residential" absorbs "firstservice residential new york", and "akam" absorbs "akam associates":
  // a key that starts another key, unless it's a single generic word ("management", "realty").
  const GENERIC = new Set(["management", "property", "properties", "realty", "real", "estate", "residential", "group", "services", "service",
    "new", "york", "ny", "nyc", "city", "brooklyn", "manhattan", "queens", "bronx", "first", "best", "prime", "park", "east", "west", "north", "south", "american", "global"]);
  const keys = [...groups.keys()].sort((a, b) => a.split(" ").length - b.split(" ").length);
  for (const short of keys) {
    if (!groups.has(short)) continue;
    if (short.split(" ").length < 2 && (short.length < 4 || GENERIC.has(short))) continue;
    for (const long of keys) {
      if (long === short || !groups.has(long) || !long.startsWith(short + " ")) continue;
      const a = groups.get(short), b = groups.get(long);
      for (const [n, c] of b.names) a.names.set(n, (a.names.get(n) || 0) + c);
      for (const [id, p] of b.plans) a.plans.set(id, p);
      groups.delete(long);
    }
  }
  return [...groups.values()].map((g) => {
    const name = [...g.names].sort((a, b) => b[1] - a[1] || a[0].length - b[0].length)[0][0];
    const plansList = [...g.plans.values()].sort((a, b) => (b.accepted_date || "").localeCompare(a.accepted_date || ""));
    // Search with the shortest spelling, so the search matches every variant in the group.
    const query = [...g.names.keys()].map(agentQuery).filter(Boolean).sort((a, b) => a.length - b.length)[0] || agentQuery(name);
    return { name, query, plans: plansList, slug: g.key.replace(/ /g, "-"), names: new Set(g.names.keys()) };
  }).sort((a, b) => b.plans.length - a.plans.length || a.name.localeCompare(b.name));
}

// ---------- offering plan attorneys ----------
// Sponsor's counsel from the AG plan record (plans.law_firm). Spellings vary ("Harold L. Gruber, P.C." / "Harold Gruber, P.C."),
// so names are grouped by a key without initials, suffixes and "Law Office of".
const FIRM_STOP = new Set(["the", "law", "office", "offices", "of", "esq", "esquire", "attorney", "attorneys", "at", "pc", "llp", "llc", "pllc", "lpa", "inc",
  "and", "associates", "assoc", "group", "firm", "counselors", "counsel", "pa"]);
export const firmKey = (v) => String(v).toLowerCase().replace(/\([^)]*\)/g, " ").replace(/[^a-z0-9]+/g, " ")
  .split(" ").filter((w) => w.length > 1 && !FIRM_STOP.has(w)).join(" ");
const firmCore = (v) => String(v).trim().replace(/([,\s]+(p\.?\s?c|l\.?l\.?p|l\.?l\.?c|pllc|esq|inc|attorneys? at law)\.?)+$/i, "").trim();

// Returns [{name, plans, years, slug, query}], most plans first.
export function groupFirms(plans) {
  const groups = new Map();
  for (const p of plans) {
    if (!p.law_firm || !NYC(p)) continue;
    const k = firmKey(p.law_firm);
    if (!k) continue;
    if (!groups.has(k)) groups.set(k, { key: k, names: new Map(), plans: [] });
    const g = groups.get(k);
    g.names.set(p.law_firm.trim(), (g.names.get(p.law_firm.trim()) || 0) + 1);
    g.plans.push(p);
  }
  // The search box matches counsel by substring, so pick the spelling that finds the most of this firm's plans
  // and the fewest of anyone else's.
  const firms = plans.filter((p) => p.law_firm).map((p) => ({ lf: p.law_firm.toLowerCase(), k: firmKey(p.law_firm) }));
  const bestQuery = (g) => {
    const cands = new Set([...g.names.keys()].map(firmCore).filter((c) => c.length >= 3));
    const last = g.key.split(" ").pop();
    if (last.length >= 5) cands.add(last);
    let best = null;
    for (const c of cands) {
      const lc = c.toLowerCase();
      let hit = 0, miss = 0;
      for (const f of firms) if (f.lf.includes(lc)) f.k === g.key ? hit++ : miss++;
      const score = hit - 3 * miss;
      if (!best || score > best.score || (score === best.score && c.length < best.c.length)) best = { c, score };
    }
    return best ? best.c : firmCore([...g.names][0][0]);
  };
  return [...groups.values()].map((g) => {
    const name = [...g.names].sort((a, b) => b[1] - a[1] || a[0].length - b[0].length)[0][0];
    const list = g.plans.sort((a, b) => (b.accepted_date || "").localeCompare(a.accepted_date || "") || b.plan_id.localeCompare(a.plan_id));
    const years = g.plans.map((p) => p.accepted_date?.slice(0, 4)).filter(Boolean).sort();
    return { name, plans: list, years, slug: g.key.replace(/ /g, "-"), group: g };
  }).sort((a, b) => b.plans.length - a.plans.length || a.name.localeCompare(b.name))
    .map(({ group, ...f }) => ({ ...f, query: tc(bestQuery(group)) }));
}

// For building pages: plan_id -> {name as filed: manager slug} and plan_id -> counsel slug, only for firms with a profile.
export function profileLinks(agents, firms) {
  const managers = new Map(), counsel = new Map();
  for (const g of agents) {
    if (g.plans.length < PROFILE_MIN) continue;
    for (const p of g.plans) {
      if (!managers.has(p.plan_id)) managers.set(p.plan_id, {});
      // Only the spellings in this group, so a second manager named in the same plan isn't linked to this one.
      for (const nm of g.names) managers.get(p.plan_id)[nm] = g.slug;
    }
  }
  for (const f of firms) if (f.plans.length >= PROFILE_MIN) for (const p of f.plans) counsel.set(p.plan_id, f.slug);
  return { managers, counsel };
}
