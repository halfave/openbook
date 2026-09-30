// Property managers and sponsor's counsel, grouped across spellings. Shared by build-pages.mjs (the directories and
// profile pages) and build-buildings.mjs (which links each building's manager and counsel to their profile).
import { tc, boro, slug } from "./site.mjs";

// A firm gets a profile page (managing-agents/<slug>.html, offering-plan-attorneys/<slug>.html) at this many NYC plans.
export const PROFILE_MIN = 2;
const NYC = (p) => boro(p.borough) !== "Outside New York City";

// ---------- managing agents ----------
// From the first-year management agreement in each offering plan (facts.managing_agent). Spellings vary
// ("FirstService Residential New York, Inc." / "FirstService Residential"), so names are grouped by a key.
const SUFFIX_WORDS = new Set(["inc", "llc", "l", "c", "corp", "corporation", "co", "company", "ltd", "the", "pc"]);
// Hand-checked: keys that name the same firm, mapped to the key whose profile page already exists.
const AGENT_ALIAS = {
  wayfinder: "wayfinderpm",
  "choice new york management": "choice ny property management", "choice ny management": "choice ny property management",
  "choice new york property management": "choice ny property management",
  "nyret services and property management": "nyret property management",
  "camelot realty group": "camelot property management services", "camelot realty management services": "camelot property management services",
  "penmark management": "penmark realty",
  "emerson property management": "emerson management",
  "redmane realty management": "redmane management",
};
export const agentKey = (v) => {
  const k = String(v).toLowerCase().replace(/\([^)]*\)/g, " ").replace(/&/g, " and ").replace(/[^a-z0-9 ]+/g, " ")
    .split(/\s+/).filter((w) => w && !SUFFIX_WORDS.has(w)).join(" ");
  return AGENT_ALIAS[k] || k;
};
// What to type in the search box: the name without "(Sponsor)" notes and company suffixes, so every spelling matches.
export const agentQuery = (v) => String(v).replace(/\([^)]*\)/g, "").trim().replace(/[,\s]+(inc|llc|l\.l\.c|corp|corporation|co|company|ltd)\.?$/i, "").replace(/[,\s]+(inc|llc|corp)\.?$/i, "").trim();
// The sponsor, its affiliate or principal, or the board manages the building instead of an outside company.
const selfManaged = (v) => /^\s*sponsor\b|\(\s*sponsor|affiliate of (the )?sponsor|sponsor affiliate|principal of (the )?sponsor|self-managed/i.test(v);
// Also when the manager named is the sponsor itself ("82 Sterling Place, LLC" managing 82 Sterling Place).
export const isSelf = (v, p) => selfManaged(v) || (!!p.sponsor && agentKey(v) === agentKey(p.sponsor));
// No manager named yet ("Management company (unnamed, to be engaged by Sponsor)"): not a firm, so no profile.
const unnamed = (v) => /\bunnamed\b|\bto be (engaged|determined|selected|named|retained|chosen)\b|\bTBD\b/i.test(v);

// agentFacts: facts rows {plan_id, value_text} for field managing_agent. byId: plan_id -> plan.
// Returns [{name, query, plans, slug, names}], most plans first; names is every spelling filed.
export function groupAgents(agentFacts, byId) {
  const groups = new Map();
  for (const f of agentFacts) {
    const p = byId.get(f.plan_id);
    if (!p || !NYC(p) || isSelf(f.value_text, p) || unnamed(f.value_text)) continue;
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
    // Search with the spelling found in the most filings ("WayFinder" is in "WayfinderPM, LLC" too), the shortest on a tie.
    const covers = (q) => { let c = 0; for (const [nm, n] of g.names) if (nm.toLowerCase().includes(q.toLowerCase())) c += n; return c; };
    const query = [...new Set([...g.names.keys()].map(agentQuery).filter(Boolean))]
      .map((q) => [q, covers(q)]).sort((a, b) => b[1] - a[1] || a[0].length - b[0].length)[0]?.[0] || agentQuery(name);
    return { name, query, plans: plansList, slug: g.key.replace(/ /g, "-"), names: new Set(g.names.keys()) };
  }).sort((a, b) => b.plans.length - a.plans.length || a.name.localeCompare(b.name));
}

// ---------- offering plan attorneys ----------
// Sponsor's counsel from the AG plan record (plans.law_firm). Spellings vary ("Harold L. Gruber, P.C." / "Harold Gruber, P.C."),
// so names are grouped by a key without initials, suffixes and "Law Office of".
const FIRM_STOP = new Set(["the", "law", "office", "offices", "of", "esq", "esquire", "attorney", "attorneys", "at", "pc", "llp", "llc", "pllc", "lpa", "inc",
  "and", "associates", "assoc", "group", "firm", "counselors", "counsel", "pa"]);
// Hand-checked: typos, "et al" and "Esqs." spellings, and a firm's former or short name (before or after a partner joined
// the name), mapped to the key with the profile.
const FIRM_ALIAS = {
  "agostino levine landesman": "agostino levine landesman lederman",
  "agostino levine landesman et al": "agostino levine landesman lederman", "agostino levine landesman etal": "agostino levine landesman lederman",
  "marans weisz": "marans weisz newman",
  "allen morris troisi": "allen morris troisi simon",
  "ganfer shore": "ganfer shore leeds zauderer",
  "stein farkas schwartz": "stein farkas",
  "rothkrug rothkrug": "rothkrug rothkrug spector", "rothkrug rothkrug weinberg spector": "rothkrug rothkrug spector",
  "silverman shin byrne": "silverman shin byrne gilchrest",
  "menicucci villa": "menicucci villa cilmi", "menicucci villa panzella calcagno": "menicucci villa cilmi",
  "drohan lee kelley": "drohan lee",
  "decker decker dito internicola": "decker decker",
  "berger sklaw esqs": "berger sklaw",
  "schwartz sladkus greenberg atlans": "schwartz sladkus reich greenberg atlas",
  "ganfer shore leads zauderer": "ganfer shore leeds zauderer",
  "steven ebbin atty": "steven ebbin",
  "pryor cashman sherman flynn": "pryor cashman",
  "bryan cave leighton paisner": "bryan cave",
  herrick: "herrick feinstein",
  "abrams fensterman": "abrams fensterman fensterman et al",
};
export const firmKey = (v) => {
  const k = String(v).toLowerCase().replace(/\([^)]*\)/g, " ").replace(/[^a-z0-9]+/g, " ")
    .split(" ").filter((w) => w.length > 1 && !FIRM_STOP.has(w)).join(" ");
  return FIRM_ALIAS[k] || k;
};
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
    // First and last name in the key too: a renamed firm's spellings share those ("Marans & Weisz" / "Marans Weisz & Newman").
    for (const w of [g.key.split(" ")[0], g.key.split(" ").pop()]) if (w.length >= 5) cands.add(w);
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

// ---------- architects and selling agents ----------
// From the offering plan text (facts.architect, facts.selling_agent). Spellings vary more than managers' do:
// "Karim Ahmed, R.A., Reform Architecture PLLC" / "Reform Architecture PLLC", "Urban Compass, Inc. d/b/a Compass" / "Compass",
// so the key drops suffixes, credentials and trade words, and a key whose words are all in a longer key absorbs it.
const PRO_STOP = new Set(["the", "and", "of", "inc", "llc", "llp", "pllc", "pc", "dpc", "lp", "corp", "corporation", "incorporated", "co", "company", "ltd", "limited", "dba",
  "ra", "aia", "pe", "jr", "esq", "registered", "licensed", "nys", "ny", "nyc", "new", "york",
  "architect", "architects", "architecture", "architectural", "engineer", "engineers", "engineering", "associates", "assoc", "design", "designs", "studio", "planning", "pa",
  "real", "estate", "realty", "marketing", "group", "development", "sales", "properties", "property", "residential", "brokerage", "re", "services", "international", "partners"]);
// Hand-checked against the filings: keys that name the same firm (PRO_ALIAS before grouping, PRO_JOIN after, for a person
// filed both alone and with the firm, "Chang Hwa Tan, R.A., Tan Architect P.C."), and keys that stay apart though a shorter
// key's words are all in them (Corcoran Sunshine isn't The Corcoran Group; Kane Architecture and Urban Design isn't Urban Architectural Design).
// Keys that differ only by spaces ("Hill West" / "Hillwest", "Cook+Fox" / "CookFox") are merged in groupPros; letters split
// apart in the plan text ("C ook F ox", "Kutnicki Ber n stein") are aliased here.
const PRO_ALIAS = { "issac stern": "isaac stern", sunshine: "corcoran sunshine", "highpoint incentives": "highpoint incentive",
  "hpl ngineer ing": "hpl", "ook ox": "cookfox", "kutnicki ber stein": "kutnicki bernstein", "urat mutlu": "murat mutlu",
  "hi lau": "chi lau", scaranoarchitect: "scarano", architectsalliance: "alliance", "sm tam": "tam" };
const PRO_JOIN = { "chang tan": "tan", "oscar walters": "demerara", "shiming tam": "tam", "wu chen": "infocus", "igor zaslavskiy": "zproekt" };
const PRO_KEEP = new Set(["corcoran sunshine", "mcclellan sotheby", "daniel gale sotheby", "theodore kane kane urban", "jorge mastropietro jma workshop", "marren newman", "meltzer costa"]);
// Not a firm: "Sponsor (no separate selling agent)", "None".
const notFirm = (v) => /^\s*(none|n\/?a|tbd|not (stated|named|applicable))\b|\bno (separate )?(selling|managing) agent|\bno .*agent used\b/i.test(v);
// A value can name several firms: "Related Sales LLC and Corcoran Sunshine Marketing Group (co-selling agents)".
// Architects split only on ";" since "and" is part of many of their names ("Hertzberg and Sanchez").
// A part that isn't a firm on its own ("Sales and Marketing LLC" -> "Marketing LLC") keeps the value whole. building.js splits the same way.
export const splitPros = (v, field) => {
  const parts = String(v).split(field === "selling_agent" ? /\s*;\s*|\s+\/\s+|\s+and\s+(?![^(]*\))/ : /\s*;\s*/).map((s) => s.trim()).filter(Boolean);
  return parts.length > 1 && parts.some((s) => !proKey(s)) ? [String(v).trim()] : parts;
};
export const proKey = (v) => {
  let s = String(v).replace(/\([^)]*\)/g, " ");
  const dba = s.match(/\bd\/?b\/?a\b\.?\s*(.+)$/i);
  if (dba) s = dba[1];
  const k = s.toLowerCase().replace(/&|\+/g, " and ").replace(/\./g, "").replace(/[^a-z0-9]+/g, " ")
    .split(" ").filter((w) => w.length > 1 && !PRO_STOP.has(w)).join(" ");
  return PRO_ALIAS[k] || k;
};
// The sponsor or its affiliate selling its own units, not an outside brokerage.
// Also a seller whose name is all words of the sponsor's ("Sky View Parc Sales LLC" for Sky View Parc II, L.P.).
const selfSold = (v, p) => {
  if (/\bsponsor\b|affiliate/i.test(v)) return true;
  if (!p.sponsor) return false;
  const k = proKey(v), s = proKey(p.sponsor).split(" ");
  return !!k && (agentKey(v) === agentKey(p.sponsor) || k.split(" ").every((w) => s.includes(w)));
};
// The name to show: the spelling without notes in parentheses, a "d/b/a" or trailing legal suffixes.
const cleanName = (v) => {
  let s = String(v).replace(/\([^)]*\)?/g, " ").replace(/\s+/g, " ").trim();
  const dba = s.match(/\bd\/?b\/?a\b\.?\s*(.+)$/i);
  if (dba) s = dba[1];
  return s.replace(/([,\s]+(inc|llc|l\.l\.c|llp|pllc|p\.?c|corp|co|ltd)\.?)+$/i, "").replace(/[,\s]+$/, "").trim();
};

// field: "architect" or "selling_agent". facts: rows {plan_id, value_text} for that field. A value naming several firms counts for each.
// Returns [{name, plans, slug, names}], most plans first; names is every spelling filed.
export function groupPros(facts, byId, field) {
  const groups = new Map();
  for (const f of facts) {
    const p = byId.get(f.plan_id);
    if (!p || !NYC(p)) continue;
    for (const nm of splitPros(f.value_text, field)) {
      if (notFirm(nm) || (field === "selling_agent" && selfSold(nm, p))) continue;
      const k = proKey(nm);
      if (!k) continue;
      if (!groups.has(k)) groups.set(k, { key: k, names: new Map(), plans: new Map() });
      const g = groups.get(k);
      g.names.set(nm, (g.names.get(nm) || 0) + 1);
      g.plans.set(p.plan_id, p);
    }
  }
  // "hill west" and "hillwest" are one firm: keys equal without spaces merge into the one with more plans.
  const compact = new Map();
  for (const k of [...groups.keys()].sort((a, b) => groups.get(b).plans.size - groups.get(a).plans.size)) {
    const c = k.replace(/ /g, ""), to = compact.get(c);
    if (!to) { compact.set(c, k); continue; }
    const a = groups.get(to), b = groups.get(k);
    for (const [nm, n] of b.names) a.names.set(nm, (a.names.get(nm) || 0) + n);
    for (const [id, p] of b.plans) a.plans.set(id, p);
    groups.delete(k);
  }
  // "reform" absorbs "karim ahmed reform", "compass" absorbs "urban compass": all of the shorter key's words are in the longer one.
  // A single short word ("tan", "one") can't absorb anything.
  const words = (k) => k.split(" ");
  const keys = [...groups.keys()].sort((a, b) => words(a).length - words(b).length || groups.get(b).plans.size - groups.get(a).plans.size);
  for (const short of keys) {
    if (!groups.has(short) || (words(short).length < 2 && short.length < 4)) continue;
    const ws = words(short);
    for (const long of keys) {
      if (long === short || !groups.has(long) || PRO_KEEP.has(long) || words(long).length <= ws.length) continue;
      if (!ws.every((w) => words(long).includes(w))) continue;
      const a = groups.get(short), b = groups.get(long);
      for (const [nm, c] of b.names) a.names.set(nm, (a.names.get(nm) || 0) + c);
      for (const [id, p] of b.plans) a.plans.set(id, p);
      groups.delete(long);
    }
  }
  for (const [from, to] of Object.entries(PRO_JOIN)) {
    const a = groups.get(to), b = groups.get(from);
    if (!a || !b) continue;
    for (const [nm, c] of b.names) a.names.set(nm, (a.names.get(nm) || 0) + c);
    for (const [id, p] of b.plans) a.plans.set(id, p);
    groups.delete(from);
  }
  const slugs = new Set();
  return [...groups.values()].map((g) => {
    const shown = new Map();
    for (const [nm, c] of g.names) { const s = cleanName(nm); if (s) shown.set(s, (shown.get(s) || 0) + c); }
    // A spelling run together ("Scaranoarchitect", "CitiHabitats") counts toward the spaced one, unless that one is letters
    // split apart in the plan text ("HPL E NGINEER ING").
    const flat = (s) => s.toLowerCase().replace(/ /g, "");
    for (const [s, c] of [...shown]) {
      const spaced = [...shown.keys()].find((t) => t !== s && flat(t) === flat(s) && t.split(" ").length > s.split(" ").length
        && t.split(" ").every((w) => w.length >= 3));
      if (spaced) { shown.set(spaced, shown.get(spaced) + c); shown.delete(s); }
    }
    const name = [...shown].sort((a, b) => b[1] - a[1] || a[0].length - b[0].length)[0]?.[0] || g.key;
    const plansList = [...g.plans.values()].sort((a, b) => (b.accepted_date || "").localeCompare(a.accepted_date || "") || b.plan_id.localeCompare(a.plan_id));
    return { name, plans: plansList, key: g.key, names: new Set(g.names.keys()) };
  }).sort((a, b) => b.plans.length - a.plans.length || a.name.localeCompare(b.name)).map((g) => {
    // Slug from the name shown ("the-marketing-directors", not the key "directors"); the key breaks a tie.
    let s = slug(g.name.replace(/,?\s*\b(r\.?\s?a|a\.?i\.?a|p\.?\s?e|cfm|registered architect)\b\.?/gi, "")) || g.key.replace(/ /g, "-");
    if (slugs.has(s)) s = `${s}-${g.key.replace(/ /g, "-")}`;
    slugs.add(s);
    const { key, ...rest } = g;
    return { ...rest, slug: s };
  });
}

// ---------- developers ----------
// The people behind each sponsor, read from the plan text into sponsor_principals ({plan_id, name, kind, role, file_id,
// page_no, quote}), each with the page and the sentence that names them. Only people: an entity row ("Rise Above III LLC")
// is a holding company, not a developer. Spellings vary ("Bruce A. Beal, Jr." / "Bruce Beal"), so the key drops
// punctuation, middle initials and generational suffixes.
const PERSON_STOP = new Set(["jr", "sr", "ii", "iii", "iv", "esq", "mr", "mrs", "ms", "dr"]);
export const personKey = (v) => String(v).toLowerCase().replace(/\([^)]*\)/g, " ").replace(/[^a-z0-9' -]+/g, " ").replace(/'/g, "")
  .split(/[\s-]+/).filter((w) => w.length > 1 && !PERSON_STOP.has(w)).join(" ");
// A row counts only when it names a person (two words or more) and its quote has their surname, so a name the reader
// got wrong or took from elsewhere isn't shown with a citation that doesn't support it.
const citedPerson = (r) => {
  if (r.kind !== "person" || !r.quote || /^\s*not stated\b/i.test(r.name)) return false;
  const k = personKey(r.name).split(" ");
  return k.length >= 2 && r.quote.toLowerCase().includes(k.at(-1));
};

// rows: sponsor_principals. Returns [{name, plans, slug, names, cites}], most plans first; cites is plan_id -> {file_id, page_no, quote, role}.
export function groupDevelopers(rows, byId) {
  const groups = new Map();
  for (const r of rows) {
    const p = byId.get(r.plan_id);
    if (!p || !NYC(p) || !citedPerson(r)) continue;
    const k = personKey(r.name);
    if (!groups.has(k)) groups.set(k, { key: k, names: new Map(), plans: new Map(), cites: new Map() });
    const g = groups.get(k), nm = r.name.trim();
    g.names.set(nm, (g.names.get(nm) || 0) + 1);
    g.plans.set(p.plan_id, p);
    if (!g.cites.has(p.plan_id)) g.cites.set(p.plan_id, { file_id: r.file_id, page_no: r.page_no, quote: r.quote, role: r.role });
  }
  const slugs = new Set();
  return [...groups.values()].map((g) => {
    // The spelling filed most often, the fuller one on a tie ("Bruce A. Beal, Jr." over "Bruce Beal"), without a trailing comma.
    const name = [...g.names].sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)[0][0].replace(/[,\s]+$/, "");
    const plansList = [...g.plans.values()].sort((a, b) => (b.accepted_date || "").localeCompare(a.accepted_date || "") || b.plan_id.localeCompare(a.plan_id));
    return { name, plans: plansList, key: g.key, names: new Set(g.names.keys()), cites: g.cites };
  }).sort((a, b) => b.plans.length - a.plans.length || a.name.localeCompare(b.name)).map(({ key, ...g }) => {
    let s = slug(key) || key.replace(/ /g, "-");
    if (slugs.has(s)) s = `${s}-${slugs.size}`;
    slugs.add(s);
    return { ...g, slug: s };
  });
}

// plan_id -> {name as filed: slug}, only for groups with a profile. Only the spellings in each group, so a second firm
// named in the same plan isn't linked to this one.
const nameLinks = (groups) => {
  const out = new Map();
  for (const g of groups) {
    if (g.plans.length < PROFILE_MIN) continue;
    for (const p of g.plans) {
      if (!out.has(p.plan_id)) out.set(p.plan_id, {});
      for (const nm of g.names) out.get(p.plan_id)[nm] = g.slug;
    }
  }
  return out;
};

// For building pages: plan_id -> {name as filed: slug} for managers, architects and selling agents, and plan_id -> counsel slug,
// only for firms with a profile.
export function profileLinks(agents, firms, architects = [], sellers = [], taxers = [], developers = []) {
  const counsel = new Map();
  for (const f of firms) if (f.plans.length >= PROFILE_MIN) for (const p of f.plans) counsel.set(p.plan_id, f.slug);
  // Developers: plan_id -> [{name, slug (null without a profile), cite}], every person named for the plan.
  const devs = new Map();
  for (const d of developers) for (const p of d.plans) {
    if (!devs.has(p.plan_id)) devs.set(p.plan_id, []);
    devs.get(p.plan_id).push({ name: d.name, slug: d.plans.length >= PROFILE_MIN ? d.slug : null, cite: d.cites.get(p.plan_id) });
  }
  return { managers: nameLinks(agents), counsel, architects: nameLinks(architects), sellers: nameLinks(sellers), taxers: nameLinks(taxers), developers: devs };
}
