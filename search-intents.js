// Structured searches the page answers without AI: distance from a building, unit prices by bedroom count (Schedule A),
// on-site MIH / Inclusionary Housing units, parking licenses, and average offering prices.
// No DOM here: index.html renders the result, and scripts/search-eval.mjs runs the same code against the live data.
// Reads only public tables and RPCs with the site's publishable key; never writes.
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.CondoIntents = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // ---------- parsing ----------
  const WORDNUM = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
    fifteen: 15, twenty: 20, thirty: 30, forty: 40, fifty: 50, hundred: 100 };
  const BOROUGHS = [["MANHATTAN", /\bmanhattan\b/], ["BROOKLYN", /\bbrooklyn\b/], ["QUEENS", /\bqueens\b/], ["BRONX", /\b(the )?bronx\b/], ["STATEN ISLAND", /\bstaten island\b/]];
  const numOf = (t) => (t in WORDNUM ? WORDNUM[t] : parseFloat(t));
  const titleCase = (s) => String(s || "").toLowerCase().replace(/\b([a-z])/g, (c) => c.toUpperCase());

  // "$900,000", "900k", "1m", "$1.2 million" -> dollars. Bare numbers under 10,000 aren't prices.
  function money(tok) {
    const m = String(tok).toLowerCase().replace(/\s+/g, "").match(/^\$?(\d+(?:,\d{3})*(?:\.\d+)?)(k|m|mm|mil|million|thousand)?$/);
    if (!m) return null;
    let v = parseFloat(m[1].replace(/,/g, ""));
    if (m[2] === "k" || m[2] === "thousand") v *= 1e3;
    else if (m[2]) v *= 1e6;
    if (!/\$|k|m|thousand/.test(String(tok).toLowerCase()) && v < 10000) return null;
    return v;
  }
  const MONEY = "\\$?\\s?\\d+(?:,\\d{3})*(?:\\.\\d+)?\\s?(?:k|mm|m|mil|million|thousand)?";

  // Returns a spec when the question needs one of the structured searches, else null (the page's own parser handles it).
  function parse(input, today) {
    const now = today ? new Date(today + "T12:00:00Z") : new Date();
    let s = " " + String(input || "").toLowerCase().replace(/[’‘]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, "-").replace(/\s+/g, " ") + " ";
    // "1mi" -> "1 mi", "10units" -> "10 units", "1beds" -> "1 beds"
    s = s.replace(/(\d)(mi|miles?|km|blocks?|units?|apartments?|beds?|bedrooms?|br|bd|yrs?|years?|months?)\b/g, "$1 $2");
    const spec = { text: String(input || "").trim(), near: null, mih: false, parking: null, beds: null, price: null, units: null,
      construction: null, borough: null, since: null, until: null, stats: null, wantsSales: false, notes: [] };
    const cut = (re) => { s = s.replace(re, " "); };

    // average / median offering (or "sales") price -> a table, not a list
    const statM = s.match(/\b(average|avg|mean|median|typical)\b/);
    if (statM && /\b(price|prices|priced|cost|sales?|sold|ppsf|per square foot|\$\/sf)\b/.test(s)) {
      spec.stats = { measure: statM[1] === "median" ? "median" : "average" };
      spec.wantsSales = /\b(sales?|sold|closings?|closed)\b/.test(s);
    }

    // time window: "last 2 years", "past 18 months", "since 2023", "in 2024"
    let m = s.match(/\b(?:in the |over the |within the )?(?:last|past|previous|recent)\s+(\d+|one|two|three|four|five|six|seven|eight|nine|ten|twelve|eighteen|twenty)?\s*(years?|months?)\b/);
    if (m) {
      const n = m[1] ? numOf(m[1]) || 18 : 1;
      const d = new Date(now); if (/year/.test(m[2])) d.setUTCFullYear(d.getUTCFullYear() - n); else d.setUTCMonth(d.getUTCMonth() - n);
      spec.since = d.toISOString().slice(0, 10); spec.window = { n, unit: /year/.test(m[2]) ? "year" : "month" }; cut(m[0]);
    } else if ((m = s.match(/\bsince (19[6-9]\d|20\d\d)\b/))) { spec.since = `${m[1]}-01-01`; cut(m[0]); }
    else if ((m = s.match(/\bin (19[6-9]\d|20\d\d)\b/))) { spec.since = `${m[1]}-01-01`; spec.until = `${m[1]}-12-31`; cut(m[0]); }

    // distance: "within 1 mi of X", "within half a mile of X", "within 10 blocks of X", "near X"
    const DIST = "(\\d+(?:\\.\\d+)?|one|two|three|four|five|a half|half(?: a)?|a quarter|quarter(?: of a)?|a)";
    m = s.match(new RegExp(`\\b(?:within|in|inside|under)\\s+(?:a\\s+)?${DIST}\\s*(?:-\\s*)?(mi|miles?|km|kilometers?|kilometres?|blocks?|ft|feet)\\b\\s*(?:radius\\s+)?(?:of|from|around|to)\\s+(.+)$`));
    let anchorRest = null, miles = null;
    if (m) {
      const q = m[1].trim();
      let v = /half/.test(q) ? 0.5 : /quarter/.test(q) ? 0.25 : q === "a" ? 1 : numOf(q);
      const unit = m[2];
      if (/^km|kilomet/.test(unit)) v *= 0.621371; else if (/^block/.test(unit)) v *= 0.05; else if (/^f/.test(unit)) v /= 5280;
      miles = Math.round(v * 1000) / 1000; anchorRest = m[3];
      s = s.slice(0, m.index) + " ";
    } else if ((m = s.match(/\b(?:near|nearby|around|close to|next to|surrounding)\s+(.+)$/))) {
      miles = 0.5; anchorRest = m[1]; s = s.slice(0, m.index) + " ";
      spec.notes.push("“Near” was read as within half a mile. Change the distance above.");
    }
    if (anchorRest != null) {
      // The anchor ends where the next clause starts ("... of 1 Prospect Park West that are priced with 1 beds ...").
      const stop = anchorRest.search(/\s(?:that|which|who|where|priced|pricing|with|having|has|have|and|under|below|between|from|for|offering|selling|built|accepted|filed|in the last|since|,|;|\?)(?=\s|$)|[,;?]/);
      let anchor = (stop >= 0 ? anchorRest.slice(0, stop) : anchorRest).trim();
      const rest = stop >= 0 ? anchorRest.slice(stop) : "";
      anchor = anchor.replace(/^(the|a|an)\s+/, "").replace(/\s+(building|condo(minium)?s?|tower|development)$/, "").replace(/[.!]+$/, "").trim();
      if (anchor) spec.near = { miles, anchorText: anchor };
      s += " " + rest + " ";
    }

    // bedrooms: "1 beds", "one-bedroom", "2br", "studios", "3+ bedrooms"
    m = s.match(/\b(\d|one|two|three|four|five)\s*(\+|or more)?\s*-?\s*(?:bed(?:room)?s?|br|bd|bdrm?s?)\b/);
    if (m) { const k = numOf(m[1]); spec.beds = m[2] ? { min: k, max: null } : { min: k, max: k }; cut(m[0]); }
    else if (/\bstudios?\b/.test(s)) { spec.beds = { min: 0, max: 0 }; cut(/\bstudios?\b/); }

    // unit prices: "between $900,000 and $1,000,000", "$900k-$1m", "under $1m", "over 2 million"
    const P = MONEY;
    if ((m = s.match(new RegExp(`\\b(?:between|from)\\s+(${P})\\s+(?:and|to|-)\\s+(${P})`))) || (m = s.match(new RegExp(`(${P})\\s*(?:-|to)\\s*(${P})`)))) {
      const a = money(m[1]), b = money(m[2]);
      if (a != null && b != null) { spec.price = { min: Math.min(a, b), max: Math.max(a, b) }; cut(m[0]); }
    }
    if (!spec.price && (m = s.match(new RegExp(`\\b(under|below|less than|up to|at most|max(?:imum)?|no more than)\\s+(${P})`))) && money(m[2]) != null) { spec.price = { min: null, max: money(m[2]) }; cut(m[0]); }
    if (!spec.price && (m = s.match(new RegExp(`\\b(over|above|more than|at least|min(?:imum)?|starting at)\\s+(${P})`))) && money(m[2]) != null) { spec.price = { min: money(m[2]), max: null }; cut(m[0]); }

    // building size: "below 10 units", "under 10 units", "fewer than 10 units", "10 units or fewer", "<10 units"
    const NUM = "(\\d{1,4}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|fifty|hundred)";
    const U = "(?:residential\\s+)?(?:units?|apartments?|apts?|residences|homes)";
    const rules = [
      [new RegExp(`(?:\\b(?:under|fewer than|less than|below)|<)\\s*${NUM}\\s+${U}`), (k) => ({ min: null, max: k - 1 })],
      [new RegExp(`\\b${NUM}\\s+${U}\\s+or\\s+(?:fewer|less)`), (k) => ({ min: null, max: k })],
      [new RegExp(`\\b(?:at most|no more than|up to|max(?:imum)?(?: of)?)\\s+${NUM}\\s+${U}`), (k) => ({ min: null, max: k })],
      [new RegExp(`(?:\\b(?:over|more than|above)|>)\\s*${NUM}\\s+${U}`), (k) => ({ min: k + 1, max: null })],
      [new RegExp(`\\b(?:at least|minimum of)\\s+${NUM}\\s+${U}`), (k) => ({ min: k, max: null })],
    ];
    for (const [re, fn] of rules) { const mm = s.match(re); if (mm) { spec.units = fn(numOf(mm[1])); cut(mm[0]); break; } }

    // parking sold as licenses
    if (/\bparking\s+licen[cs]es?\b|\blicen[cs]ed\s+parking\b|\blicen[cs]es?\s+(?:to|for)\s+(?:use\s+)?(?:a\s+|the\s+)?parking\b|\bparking\b[^.]{0,30}\blicen[cs]/.test(s)) spec.parking = "licensed";

    // on-site MIH / Inclusionary Housing units
    if (/\bmih\b|\bmandatory inclusionary\b|\binclusionary\b|\baffordable (?:housing )?(?:units?|apartments?)\b|\bincome[- ]restricted (?:units?|apartments?)\b/.test(s)) spec.mih = true;

    // AG categories and borough
    if (/\bnew (?:construction|development|build|condos?|buildings?|developments?|projects?)\b|\bnewly built\b/.test(s)) spec.construction = "NEW";
    else if (/\bconver(?:sions?|ted)\b/.test(s)) spec.construction = "CONVERSION";
    for (const [b, re] of BOROUGHS) if (re.test(s)) { spec.borough = b; break; }

    const structured = spec.near || spec.mih || spec.parking || spec.beds || spec.price || spec.stats;
    return structured ? spec : null;
  }

  // Chips for "How the search was read"; each names the spec field it removes.
  function chipsOf(spec) {
    const c = [];
    const fmt = (v) => (v >= 1e6 ? `$${+(v / 1e6).toFixed(2)}M` : `$${Math.round(v / 1000).toLocaleString("en-US")}K`);
    if (spec.stats) c.push({ k: "stats", label: `${spec.stats.measure === "median" ? "Median" : "Average"} offering price` });
    if (spec.near) c.push({ k: "near", label: `Within ${fmtMiles(spec.near.miles)} of ${spec.near.label || titleCase(spec.near.anchorText)}` });
    if (spec.mih) c.push({ k: "mih", label: "On-site MIH / Inclusionary Housing units" });
    if (spec.beds) c.push({ k: "beds", label: spec.beds.max === 0 ? "Studios" : spec.beds.max == null ? `${spec.beds.min}+ bedrooms` : `${spec.beds.min}-bedroom units` });
    if (spec.price) c.push({ k: "price", label: spec.price.min != null && spec.price.max != null ? `Unit priced ${fmt(spec.price.min)}–${fmt(spec.price.max)}` : spec.price.max != null ? `Unit priced up to ${fmt(spec.price.max)}` : `Unit priced ${fmt(spec.price.min)}+` });
    if (spec.units) c.push({ k: "units", label: spec.units.max != null && spec.units.min == null ? `Under ${spec.units.max + 1} units` : spec.units.min != null && spec.units.max == null ? `${spec.units.min}+ units` : `${spec.units.min}–${spec.units.max} units` });
    if (spec.parking) c.push({ k: "parking", label: "Parking offered by license" });
    if (spec.construction) c.push({ k: "construction", label: spec.construction === "NEW" ? "New construction" : titleCase(spec.construction) });
    if (spec.borough) c.push({ k: "borough", label: titleCase(spec.borough) });
    if (spec.since || spec.until) c.push({ k: "since", label: spec.window ? `Accepted in the last ${spec.window.n} ${spec.window.unit}${spec.window.n === 1 ? "" : "s"}` : spec.until ? `Accepted in ${spec.since.slice(0, 4)}` : `Accepted since ${spec.since.slice(0, 4)}` });
    return c;
  }
  function fmtMiles(mi) { return mi === 0.25 ? "¼ mile" : mi === 0.5 ? "½ mile" : mi === 1 ? "1 mile" : `${+mi.toFixed(2)} miles`; }

  // ---------- data helpers ----------
  const COLS = "plan_id,name,address,borough,zip,plan_type,status,construction,units_residential,units_parking,units_commercial,units_storage,accepted_date,submitted_date,docs_posted,amendments_listed,latest_amendment_no,lat,lng,price_current,price_initial,sponsor";
  const inList = (ids) => `(${ids.map((id) => `"${id}"`).join(",")})`;
  const chunk = (a, n) => { const out = []; for (let i = 0; i < a.length; i += n) out.push(a.slice(i, i + n)); return out; };
  // PostgREST stops at 1,000 rows; page through.
  async function restAll(io, path, max = 20000) {
    const out = [];
    for (let off = 0; off < max; off += 1000) {
      const rows = await io.rest(`${path}${path.includes("?") ? "&" : "?"}limit=1000&offset=${off}`);
      out.push(...rows); if (rows.length < 1000) break;
    }
    return out;
  }
  async function byIds(io, table, select, ids, extra = "", size = 150) {
    const parts = await Promise.all(chunk([...new Set(ids)], size).map((c) => restAll(io, `${table}?select=${select}&plan_id=in.${inList(c)}${extra}`)));
    return parts.flat();
  }
  const R = 3958.8;
  function milesBetween(a, b) {
    const toR = (d) => (d * Math.PI) / 180, dLat = toR(b.lat - a.lat), dLng = toR(b.lng - a.lng);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(toR(a.lat)) * Math.cos(toR(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }
  // "CHARLIE WEST CONDOMINIUM (THE) - *SEE CD160304*" -> "The Charlie West"
  function cleanName(n) {
    let t = String(n || "").replace(/\s*-?\s*\*?see [a-z]{2}\d{6}\*?/i, "").replace(/\s*\(f\.?k\.?a\.?[^)]*\)/i, "").trim();
    const the = /\(THE\)/i.test(t); t = t.replace(/\s*\(THE\)/i, "").replace(/\s+CONDOMINIUM\b.*$/i, "").trim();
    return (the ? "The " : "") + titleCase(t);
  }
  const isCondo = (p) => p.plan_type === "CONDOMINIUM" || p.plan_type === "COOPERATIVE/CONDOMINIUM";

  // ---------- anchor: the building a distance is measured from ----------
  const SFX = { street: "st", st: "st", avenue: "av", ave: "av", av: "av", road: "rd", rd: "rd", place: "pl", pl: "pl", boulevard: "b", blvd: "b",
    drive: "dr", dr: "dr", lane: "l", ln: "l", court: "c", ct: "c", parkway: "p", pkwy: "p", terrace: "te", ter: "te", square: "sq", sq: "sq", plaza: "pl" };
  const DIRW = { north: "n", south: "s", east: "e", west: "w", n: "n", s: "s", e: "e", w: "w", sw: "s", se: "s", nw: "n", ne: "n", southwest: "s" };
  const ORDW = ["first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth"];
  function addressPatterns(text) {
    const m = String(text).toLowerCase().match(/^(\d+[a-z]?(?:-\d+[a-z]?)?)\s+(.+)$/);
    if (!m) return [];
    const words = m[2].replace(/[.,]/g, " ").split(/\s+/).filter(Boolean);
    // Each word becomes one or more spellings; a trailing * lets "w" match "West" and "12" match "12TH",
    // while words stay separated by a space, so "Park W" never matches "Park SW".
    const alts = words.map((w, i) => {
      const o = ORDW.indexOf(w); if (o >= 0) return [`${o + 1}*`, w];
      const n = w.match(/^(\d+)(st|nd|rd|th)?$/); if (n) return +n[1] >= 1 && +n[1] <= 10 ? [`${n[1]}*`, ORDW[+n[1] - 1]] : [`${n[1]}*`];
      if (i > 0 && SFX[w]) return [SFX[w] + "*"];
      if (DIRW[w] && (i === 0 || i === words.length - 1)) return [DIRW[w] + "*"];
      return [w];
    });
    let pats = [""];
    for (const a of alts) pats = pats.flatMap((p) => a.map((x) => (p ? p + " " : "") + x)).slice(0, 8);
    return pats.map((p) => `${m[1]} ${p}`.replace(/\*$/, ""));
  }
  async function resolveAnchor(io, text) {
    const t = String(text).trim();
    const cols = "plan_id,name,address,borough,lat,lng,accepted_date,status";
    let rows = [], how = "";
    const pid = t.match(/\b([a-z]{2}\d{6})\b/i);
    if (pid) { rows = await io.rest(`plans?select=${cols}&plan_id=eq.${pid[1].toUpperCase()}`); how = "plan ID"; }
    if (!rows.length) {
      const pats = addressPatterns(t);
      if (pats.length) {
        const ors = pats.flatMap((p) => [`address.ilike.${p}*`, `address.ilike.* ${p}*`]);
        rows = await io.rest(`plans?select=${cols}&lat=not.is.null&or=(${encodeURIComponent(ors.join(","))})&order=accepted_date.desc.nullslast&limit=20`);
        how = "address";
      }
    }
    if (!rows.length) {
      const name = t.replace(/[^a-z0-9 &'-]/gi, " ").replace(/\s+/g, " ").trim();
      if (name.length >= 3) {
        const words = name.split(" ").filter(Boolean).join("*");
        rows = await io.rest(`plans?select=${cols}&lat=not.is.null&name=ilike.${encodeURIComponent(`*${words}*`)}&order=accepted_date.desc.nullslast&limit=20`);
        how = "building name";
      }
    }
    rows = rows.filter((r) => r.lat != null);
    // Prefer the accepted plan with a clean name over cross-referenced or withdrawn records at the same place.
    const rank = (r) => (/\*see|see cd/i.test(r.name || "") ? 2 : 0) + (r.status === "ACCEPTED" ? 0 : 1);
    rows.sort((a, b) => rank(a) - rank(b));
    if (rows.length) {
      const a = rows[0];
      const spread = rows.filter((r) => milesBetween(a, r) > 0.15);
      return { lat: a.lat, lng: a.lng, plan_id: a.plan_id, label: cleanName(a.name || a.address),
        address: a.address, how, others: spread.slice(0, 4).map((r) => ({ plan_id: r.plan_id, name: r.name, address: r.address })) };
    }
    // Not a building on file: ask NYC's public geocoder (no key) when the caller provides it.
    if (io.geocode) {
      const g = await io.geocode(t).catch(() => null);
      if (g) return { lat: g.lat, lng: g.lng, plan_id: null, label: g.label, address: g.label, how: "NYC GeoSearch", others: [] };
    }
    return null;
  }

  // ---------- Schedule A: unit prices and bedrooms ----------
  const SKIP_LINE = /\b(totals?|sub-?total|parking|storage|commercial|retail|garage|locker|bike|cabana|wine|assess|tax rate|for example|if the|resident manager|super(intendent)?'?s)\b/i;
  const PRICE_TOK = /\$?\s?(\d{1,3}(?:,\d{3}){1,3})(?:\.\d{2})?(?![\d%])/g;
  // Reads unit rows from the text of consecutive Schedule A pages of one document.
  // Bedrooms are taken only from what the row says ("1 BR", "Studio", "2 Bedrooms"), a bed/bath pair ("1/1") under a
  // header that says bed/bath, or a numeric column under a header that puts bedrooms first. Otherwise the row is skipped.
  // What a page's table header says about where bedrooms are: "bb" (1/1 = bed/bath), "rb" (4/2 = rooms/bedrooms),
  // "col" (a bedrooms column), "colR" (a rooms column, then bedrooms), or null.
  const NARRATIVE = /(used|serve|utilized|occupied) as an? (bedroom|living room)[^.]*|master bedroom|number of bedrooms in each unit[^.]*|bedroom windows?/g;
  const OTHER_ROOMS = /\b(bed|bath|living|dining|family|powder|mechanical|mail|trash|laundry|storage|utility|compactor|refuse|meter|boiler|bicycle|bike|package|media|game|play|fitness|club|screening|party|locker|computer|electrical|sprinkler|pump|machine|elevator|lounge|board|conference|garbage|recycling|service|common|amenity)\s?-?rooms?\b/g;
  function headerMode(body) {
    const h = String(body).toLowerCase().replace(/\s+/g, " ").replace(NARRATIVE, " ");
    if (/\brooms?\s*\/\s*(bed(room)?s?|bedrms?|bdrms?|br)\b/.test(h)) return "rb";
    if (/\b(bed(room)?s?|bedrms?|bdrms?|br|bd)\s*\.?\s*\/\s*(bath(room)?s?|ba|bth|bths?)\b|\bbed\s*&\s*bath/.test(h)) return "bb";
    const iBed = h.search(/\b(bedrooms?|bedrms?|bdrms?)\b/);
    if (iBed < 0 || !/price/.test(h)) return null;
    const iRooms = h.search(/\b(no\.? of |number of |total )?rooms\b/);
    return iRooms >= 0 && iRooms < iBed && iBed - iRooms < 200 ? "colR" : "col";
  }
  // Bed and bath words on the page and no separate rooms column: a pair like "2/2.5" is bedrooms/baths.
  const bedBathPage = (body) => { const h = String(body).toLowerCase().replace(/\s+/g, " ").replace(NARRATIVE, " "); return /\bbed/.test(h) && /\bbath/.test(h) && !/\brooms?\b/.test(h.replace(OTHER_ROOMS, " ")); };
  // What the table header says about square footage: null (no area column), "one" (one area column), or with terrace,
  // outdoor or limited-common columns too, "main" (the unit's own area comes first) or "mixed" (it can't be told apart).
  const AREA_WORD = /\bsq\.?\s*f(?:ee)?t|\bsquare\s+f(?:ee|oo)t|\(sf\)|\bs\.f\.|\bsf\b|\bfloor area\b|\bhabitable area\b|\binterior area\b/i;
  const AREA_OTHER = /\b(?:terrace|balcon(?:y|ies)|outdoor|exterior|limited common|l\.?c\.?e\.?|storage|cellar|uninhabitable|roof|garden|patio|yard)\b/i;
  function areaMode(body) {
    const h = String(body).replace(/\s+/g, " ").replace(NARRATIVE, " ").slice(0, 2500);
    const a = h.search(AREA_WORD);
    if (a < 0) return null;
    const o = h.search(AREA_OTHER);
    return o < 0 ? "one" : a < o ? "main" : "mixed";
  }
  // Square feet from the numbers between the unit and its price. Never the unit number, a dollar amount or a percentage;
  // with more than one area-sized number, only when the header puts the unit's own area first. Otherwise null.
  function areaOf(before, amode) {
    if (!amode) return null;
    const vals = [];
    for (let i = 0; i < before.length; i++) {
      const t = before[i];
      if (/^\$/.test(t) || before[i - 1] === "$" || /%$/.test(t)) continue;
      const m = t.match(/^(\d{1,2},\d{3}|\d{3,5})(\.\d+)?$/);
      if (!m) continue;
      const v = +(m[1].replace(/,/g, "") + (m[2] || ""));
      if (v >= 250 && v <= 15000) vals.push(v);
    }
    if (vals.length === 1) return vals[0];
    if (vals.length > 1 && amode === "main") return vals[0];
    return null;
  }
  function parseScheduleA(pages) {
    if (!pages.length) return [];
    const out = []; let carry = null, carryArea = null;
    for (const pg of [...pages].sort((a, b) => a.file_id - b.file_id || a.page_no - b.page_no)) {
      const body = String(pg.body || "");
      let mode = headerMode(body) || carry;
      const amode = areaMode(body) || carryArea;
      if ((mode == null || mode === "col") && bedBathPage(body)) mode = mode === "col" ? "col+bb" : "bb";
      const rows = [];
      for (const raw of body.split(/\n/)) {
        const line = raw.replace(/\s+/g, " ").trim();
        if (line.length < 8 || SKIP_LINE.test(line)) continue;
        PRICE_TOK.lastIndex = 0;
        let pm, price = null, pIdx = -1;
        while ((pm = PRICE_TOK.exec(line))) { const v = +pm[1].replace(/,/g, ""); if (v >= 100000 && v <= 80000000) { price = v; pIdx = pm.index; break; } }
        if (price == null || pIdx < 1) continue;
        const toks = line.split(" ");
        let k = 0, unit = toks[0].replace(/[*†]+$/, "");
        if (/^(unit|apt\.?|apartment)$/i.test(unit)) { k = 1; unit = (toks[1] || "").replace(/[*†]+$/, ""); }
        if (!/^(ph|th|gh|r|c|d|u)?-?[0-9a-z]{1,5}(-[0-9a-z]{1,3})?$/i.test(unit) || /^\$|^(19|20)\d\d$/.test(unit)) continue;
        const before = line.slice(0, pIdx).split(" ").slice(k + 1).filter(Boolean);
        let beds = null, how = null;
        const ex = line.match(/\b(\d)\s*-?\s*(?:br|bd|bdr|bdrm|bed|beds|bedroom|bedrooms)\b/i) || line.match(/\b(one|two|three|four|five)[\s-]+bed(?:room)?s?\b/i);
        if (ex) { beds = numOf(ex[1].toLowerCase()); how = "row"; }
        else if (/\bstudio\b/i.test(line)) { beds = 0; how = "row"; }
        else {
          const sl = /bb|rb/.test(mode || "") && line.slice(0, pIdx).match(/(?:^|\s)(\d)\s?\/\s?(\d(?:\.5)?)(?=\s|$|[a-z])/i);
          const halfBath = sl && sl[1] === "1" && sl[2] === "2" && /^\s*(bath|ba\b)/i.test(line.slice(sl.index + sl[0].length)); // "1/2 bath" is a half bath
          if (sl && !halfBath) { const a = +sl[1], b = +sl[2]; beds = mode === "rb" ? b : a; how = mode === "rb" ? "rooms/bed" : "bed/bath"; if (beds > 6 || (mode === "rb" && a <= b) || (mode !== "rb" && (b < 1 || b > 7))) beds = null; }
          else if (/^col/.test(mode || "")) {
            // The first run of two or more small numbers after the unit: bedrooms, baths (and half baths).
            let run = [];
            for (const x of before) { if (/^\d(\.5)?$/.test(x)) run.push(+x); else if (run.length >= 2) break; else run = []; }
            if (mode !== "colR" && run.length >= 2 && Number.isInteger(run[0]) && run[0] <= 6 && run[1] >= 1) { beds = run[0]; how = "column"; }
            if (mode === "colR" && run.length >= 2 && run[1] <= 6 && run[0] > run[1]) { beds = run[1]; how = "column"; }
          }
        }
        if (beds == null) continue;
        const sf = areaOf(before, amode);
        rows.push({ unit, beds, price, sf, how, line, file_id: pg.file_id, page_no: pg.page_no });
      }
      // A bare numeric column is trusted only when several rows on the page read the same way.
      const colRows = rows.filter((r) => r.how === "column");
      out.push(...(colRows.length >= 2 ? rows : rows.filter((r) => r.how !== "column")));
      carry = rows.length ? mode : null;
      carryArea = rows.length ? amode : null;
    }
    // The same unit repeated on a later page (a second table) keeps its first reading.
    const seen = new Set();
    return out.filter((u) => { const k = u.file_id + ":" + u.unit; if (seen.has(k)) return false; seen.add(k); return true; });
  }
  // Pages that look like a Schedule A table: a price, a common-interest percentage and a bedroom or bath word.
  const SA_PAGE_FILTER = "&body=match." + encodeURIComponent("[0-9]{3},[0-9]{3}") + "&body=match." + encodeURIComponent("[0-9][.][0-9]{2,5} ?%") + "&body=imatch." + encodeURIComponent("(bed|bdrm|br|bath|studio)");
  async function scheduleAUnits(io, ids, onProgress) {
    const by = new Map(ids.map((id) => [id, { units: [] }]));
    if (!ids.length) return by;
    const groups = chunk(ids, 60);
    const pages = []; let done = 0;
    await pool(groups.map((g) => async () => {
      pages.push(...await restAll(io, `pages?select=plan_id,file_id,page_no,body&plan_id=in.${inList(g)}${SA_PAGE_FILTER}`));
      done++; onProgress?.(done / groups.length);
    }), 4);
    const docs = await byIds(io, "documents", "file_id,plan_id,doc_kind,amendment_no,pdf_url", [...new Set(pages.map((p) => p.plan_id))]);
    const docOf = new Map(docs.map((d) => [d.file_id, d]));
    const byFile = new Map();
    // Original plans only: amendments reprice units and would double count.
    for (const p of pages) { if (docOf.get(p.file_id)?.doc_kind === "amendment") continue; if (!byFile.has(p.file_id)) byFile.set(p.file_id, []); byFile.get(p.file_id).push(p); }
    for (const [fid, pgs] of byFile) {
      const d = docOf.get(fid);
      by.get(pgs[0].plan_id)?.units.push(...parseScheduleA(pgs).map((u) => ({ ...u, pdf_url: d?.pdf_url || null, doc: "Offering Plan" })));
    }
    return by;
  }
  async function pool(tasks, n) {
    let i = 0; const run = async () => { while (i < tasks.length) { const t = tasks[i++]; await t(); } };
    await Promise.all(Array.from({ length: Math.min(n, tasks.length) }, run));
  }

  // ---------- MIH / Inclusionary Housing: units in the building, not a mention ----------
  const CNT = "(?:\\d{1,4}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred)(?:[\\s-](?:one|two|three|four|five|six|seven|eight|nine))?";
  const COUNT_UNITS = new RegExp(`\\b(${CNT})\\s*(?:\\([^)]{1,8}\\)\\s*)?(?:(?:permanently\\s+)?affordable|inclusionary|mih|income[- ]restricted|low[- ]income)\\s+(?:housing\\s+)?(?:rental\\s+)?(?:condo(?:minium)?\\s+)?(units?|apartments?|dwelling units?|homes?)\\b`, "i");
  const INCLUDING = new RegExp(`\\bincluding\\s+(${CNT})\\s+affordable\\s+(?:rental\\s+)?(?:units?|apartments?)\\b`, "i");
  // Capitalized defined terms: "the MIH Unit", "an Inclusionary Unit", "the “Affordable Unit”", "Affordable Rental Apartments".
  const DEFINED = /\b(?:the|an?|each|any|such)\s+[“"]?(?:MIH|Inclusionary|Affordable)\s+(?:Housing\s+)?(?:Rental\s+)?(?:Condo\s+)?(?:Unit|Units|Apartment|Apartments)\b[”"]?|\bAffordable Rental Apartments?\b|\bMIH Units?\b/;
  const RENTAL_IH = /\brental (?:unit|apartments)\b[^.]{0,220}\binclusionary housing program\b|\binclusionary housing program\b[^.]{0,120}\brental apartments\b/i;
  // Pages about bonus floor area bought from elsewhere: their "Inclusionary Housing Units" are market-rate units built with the bonus.
  const OFFSITE = /\boff[- ]?site\b|\binclusionary (?:air )?rights\b|\b(?:IAR|IR) (?:seller|agreement)\b|\btransfer certificate\b|\bfloor area bonus\b|\bbonus floor area\b|\bgenerating site\b|\bcompensated (?:development|lot)\b/i;
  const DENIAL = /\b(?:does not (?:have|include|contain)|not required to (?:comply|provide|include)|not applicable|no (?:affordable|inclusionary) (?:housing )?units?|is not (?:located )?in an? (?:mandatory )?inclusionary|without inclusionary|if no inclusionary)\b/i;
  // "Unit 2E ... shall be an Affordable Housing Unit", "Residential Unit 2E (the “Affordable Unit”)": one named unit.
  const NAMED_UNIT = /\bUnit\s+[0-9]{1,3}[A-Z]{0,2}\b[^.]{0,80}?\b(?:the|an?)\s+[“"]?(?:MIH|Inclusionary|Affordable)\s+(?:Housing\s+)?Unit\b/;
  const IH_TERM = /\b(?:MIH|Inclusionary)\s+(?:Housing\s+)?Units?\b/;
  const sentences = (body) => String(body).replace(/\s+/g, " ").split(/(?<=[.;:])\s+(?=[A-Z(“"])/);
  // The part of a long sentence around the words that matched, cut at spaces, so the quote shows what qualified it.
  // text stays a verbatim slice of the page; cutBefore / cutAfter say where words were left out.
  const EXCERPT = 420;
  function excerpt(snt, re, max = EXCERPT) {
    const s = snt.trim();
    if (s.length <= max) return { text: s };
    const m = re ? s.match(re) : null;
    const at = m ? m.index : 0, len = m ? m[0].length : 0;
    let a = Math.max(0, Math.min(at - 120, s.length - max));
    if (len > max - 20) a = at;
    if (a > 0) { const sp = s.indexOf(" ", a); a = sp >= 0 && sp < at ? sp + 1 : at; }
    let b = Math.min(s.length, a + max);
    if (b < s.length) { const sp = s.lastIndexOf(" ", b); if (sp > at + len) b = sp; }
    return { text: s.slice(a, b).trim(), ...(a > 0 && { cutBefore: true }), ...(b < s.length && { cutAfter: true }) };
  }
  // The assertion that puts affordable units in the building: a count, a named unit, rental IH units, or a defined term.
  const MIH_ASSERT = [COUNT_UNITS, INCLUDING, NAMED_UNIT, RENTAL_IH, DEFINED];
  const mihAssertion = (text) => MIH_ASSERT.some((re) => re.test(String(text || "")));
  // Scores one plan's matching pages. Returns { onsite, program, evidence, strong, denial }.
  // Listed when the pages count affordable units in the building, name one, or keep referring to "the MIH/Inclusionary Unit(s)".
  function classifyMIH(pages) {
    const ev = []; let offsite = 0, denial = 0, strong = 0, ihTerms = 0, ihOnSite = false;
    const progText = [];
    for (const pg of pages) {
      const body = String(pg.body || "");
      const pageOff = OFFSITE.test(body);
      if (pageOff) offsite++;
      for (const snt of sentences(body)) {
        if (snt.length > 900 || /#\w/.test(snt)) continue; // zoning-text definitions are marked with #
        if (DENIAL.test(snt) && /inclusionary|mih|affordable/i.test(snt)) { denial++; continue; }
        // The plan ties its own rental or affordable units to Inclusionary Housing (not a zoning-district mention or bought bonus).
        if (/inclusionary/i.test(snt) && /\b(rental|affordable|units?|apartments|requirements)\b/i.test(snt) && !OFFSITE.test(snt) && !/designated area|district|zon(e|ing) (lot|district)/i.test(snt)) ihOnSite = true;
        const neg = /\b(may be constructed|if (?:any|such)|in the event|would|off[- ]?site|purchaser'?s bona fide)\b/i.test(snt);
        let w = 0;
        if ((COUNT_UNITS.test(snt) || INCLUDING.test(snt) || NAMED_UNIT.test(snt)) && !neg && !(pageOff && /bonus|transfer certificate|IAR/i.test(snt))) w = 3;
        else if (RENTAL_IH.test(snt) && !pageOff) w = 3;
        else if (DEFINED.test(snt) && !pageOff && !neg) { w = 1; if (IH_TERM.test(snt)) ihTerms++; }
        if (w === 3) strong++;
        if (w) { ev.push({ w, ...excerpt(snt, MIH_ASSERT.find((re) => re.test(snt))), file_id: pg.file_id, page_no: pg.page_no }); progText.push(body); }
      }
    }
    ev.sort((a, b) => b.w - a.w || a.page_no - b.page_no);
    const onsite = (strong >= 1 || ihTerms >= 3) && denial <= strong;
    // Which program the units are under, from the pages that describe them.
    const around = progText.join(" ");
    const program = /\bMIH\b|mandatory inclusionary/i.test(around) ? "MIH" : /inclusionary/i.test(around) || ihOnSite ? "Inclusionary Housing" : "Other program";
    return { onsite, program, evidence: ev.slice(0, 3), strong, ihTerms, offsite, denial };
  }
  const MIH_Q = 'mih OR "mandatory inclusionary" OR inclusionary';
  const MIH_UNIT_Q = '"affordable rental apartments" OR "affordable apartments" OR "affordable housing units" OR "affordable housing unit" OR "affordable units" OR "affordable unit" OR "affordable condo units" OR "inclusionary housing unit" OR "inclusionary housing units" OR "inclusionary unit" OR "mih unit" OR "mih units" OR "low income units" OR "rental apartments"';

  // ---------- parking licenses: an offering in this building, not a mention ----------
  // True when one sentence ties a license to parking, says it is offered, sold, priced or granted, isn't negated,
  // and isn't about another building or a blank form.
  const PARK_LIC = /\bparking\b[^.]{0,60}\blicen[cs]|\blicen[cs]\w*\b[^.]{0,60}\bparking\b/i;
  const PARK_OFFER = /\b(?:offer(?:s|ed|ing)?|available|purchas(?:e|es|ed|er|ers|ing)|acquir(?:e|es|ed|ing)|sell|sells|sold|sale|buy|price|priced|grant(?:s|ed)?|obtain(?:s|ed|ing)?|(?:be|are|is) licensed to (?:the )?(?:purchasers?|(?:residential )?unit owners?|owners?|residents?))\b|\$\s?\d/i;
  const PARK_NEG = /\b(?:no|not|never|none|neither|nor|without|cannot|can't|won't)\b[^.]{0,50}?\b(?:parking|licen[cs]\w*|offer\w*|available|sold|sell|provided)\b/i;
  const PARK_ELSEWHERE = /\b(?:adjacent|adjoining|neighbou?ring|nearby|another|other|separate|third[- ]party|unaffiliated|off[- ]?site)\s+(?:building|property|premises|garage|parcel|lot|site|owner|entity|condominium)s?\b|\bnot (?:located )?(?:in|at|on) the (?:building|property|premises)\b/i;
  const PARK_OTHER_LIC = /\b(?:driver'?s|real estate|broker|salesperson|professional|architect|engineer)\b[^.]{0,20}licen/i;
  function parkingOffer(snt) {
    const s = String(snt || "").replace(/\s+/g, " ").replace(/\(?\bbut\s+not\s+limited\s+to\b\)?|\bnot\s+limited\s+to\b/gi, " ");
    if (s.length > 600 || /_{3,}/.test(s) || !PARK_LIC.test(s) || PARK_OTHER_LIC.test(s)) return false;
    return PARK_OFFER.test(s) && !PARK_NEG.test(s) && !PARK_ELSEWHERE.test(s);
  }

  // Filings whose record points at another plan: "CHARLIE WEST CONDOMINIUM (THE) - *SEE CD160304*".
  const seeRef = (name) => (String(name || "").match(/\*?\bsee\s+([a-z]{2}\d{6})\b/i) || [])[1]?.toUpperCase() || null;

  // ---------- run ----------
  // io: { rest(path) -> json, rpc(fn, args) -> json, geocode?(text) -> {lat,lng,label}, today? }
  async function run(spec, io, onProgress) {
    const today = io.today || new Date().toISOString().slice(0, 10);
    const res = { spec, kind: spec.stats ? "table" : "list", rows: [], notes: [...(spec.notes || [])], coverage: [], excluded: [], title: "", anchor: null };
    const step = (msg) => onProgress?.(msg);

    // 1. Candidate plans from the plan records.
    let plans = null, sets = [];
    if (spec.near) {
      step("Finding the building…");
      const a = await resolveAnchor(io, spec.near.anchorText);
      if (!a) { res.error = `Couldn’t find “${spec.near.anchorText}”. Try its street address or plan ID.`; return res; }
      res.anchor = a; spec.near.label = a.label;
      if (a.others.length) res.notes.push(`“${spec.near.anchorText}” also matches ${a.others.map((o) => titleCase(o.name || o.address)).join(", ")}. Distances are from ${a.label}, ${titleCase(a.address)}.`);
      if (a.how === "NYC GeoSearch") res.notes.push(`${a.label} isn’t a plan on file, so its location comes from NYC’s GeoSearch.`);
      const dLat = spec.near.miles / 69.0, dLng = spec.near.miles / (69.172 * Math.cos((a.lat * Math.PI) / 180));
      step("Measuring distances…");
      const box = await restAll(io, `plans?select=${COLS}&lat=gte.${a.lat - dLat}&lat=lte.${a.lat + dLat}&lng=gte.${a.lng - dLng}&lng=lte.${a.lng + dLng}`);
      plans = box.map((p) => ({ ...p, distance: milesBetween(a, p) })).filter((p) => p.distance <= spec.near.miles + 1e-9);
    }
    const f = [];
    if (spec.units?.max != null) f.push(`units_residential=lte.${spec.units.max}`, "units_residential=gte.1");
    if (spec.units?.min != null) f.push(`units_residential=gte.${spec.units.min}`);
    if (spec.construction) f.push(`construction=eq.${spec.construction}`);
    if (spec.borough) f.push(`borough=eq.${encodeURIComponent(spec.borough)}`);
    if (spec.since) f.push(`accepted_date=gte.${spec.since}`);
    if (spec.until) f.push(`accepted_date=lte.${spec.until}`);
    const keep = (p) => isCondo(p) && (spec.units?.max == null || (p.units_residential >= 1 && p.units_residential <= spec.units.max)) && (spec.units?.min == null || (p.units_residential ?? -1) >= spec.units.min)
      && (!spec.construction || p.construction === spec.construction) && (!spec.borough || p.borough === spec.borough)
      && (!spec.since || (p.accepted_date && p.accepted_date >= spec.since)) && (!spec.until || (p.accepted_date && p.accepted_date <= spec.until));
    if (plans) plans = plans.filter(keep);

    // 2. MIH: plans whose pages mention MIH / Inclusionary Housing, then only those whose pages put affordable units in the building.
    const why = new Map();
    if (spec.mih) {
      step("Reading plans that mention MIH or Inclusionary Housing…");
      // plan_tsv holds one word list per searchable plan, so this finds the candidates without reading pages.
      let ids = (await restAll(io, `plan_tsv?select=plan_id&tsv=wfts(english).${encodeURIComponent(MIH_Q)}`)).map((h) => h.plan_id);
      if (plans) { const inSet = new Set(plans.map((p) => p.plan_id)); ids = ids.filter((id) => inSet.has(id)); }
      const pages = (await Promise.all(chunk(ids, 40).map((c) => restAll(io, `pages?select=plan_id,file_id,page_no,body&plan_id=in.${inList(c)}&tsv=wfts(english).${encodeURIComponent(MIH_UNIT_Q + " OR " + MIH_Q)}`)))).flat();
      const docs = ids.length ? await byIds(io, "documents", "file_id,plan_id,doc_kind,amendment_no,pdf_url", ids) : [];
      const docOf = new Map(docs.map((d) => [d.file_id, d]));
      const byPlan = new Map(ids.map((id) => [id, []]));
      pages.forEach((p) => byPlan.get(p.plan_id)?.push(p));
      const yes = [], no = [];
      for (const [id, pgs] of byPlan) {
        const c = classifyMIH(pgs);
        c.evidence = c.evidence.map((e) => ({ ...e, pdf_url: docOf.get(e.file_id)?.pdf_url || null, doc: docOf.get(e.file_id)?.doc_kind === "amendment" ? `Amendment ${docOf.get(e.file_id).amendment_no ?? ""}` : "Offering Plan" }));
        (c.onsite ? yes : no).push(id); why.set(id, c);
      }
      sets.push(new Set(yes));
      res.mihChecked = ids.length;
      res.excludedIds = no;
      res.notes.push("Only plans whose documents are searchable in full text can be checked. A plan is listed when its pages put affordable units in the building (a count or a designated unit); plans that only mention the program, or bought Inclusionary Housing bonus floor area from another site, are listed separately below.");
    }

    // 3. Parking licenses: the extracted parking fact, then plans whose pages mention a parking license.
    if (spec.parking === "licensed") {
      step("Checking parking arrangements…");
      const facts = await restAll(io, "facts?select=plan_id,value_text,quote,file_id,page_no&field=eq.parking_arrangement");
      // The extracted fact counts only when its own quote says license; otherwise the pages must say it.
      const lic = facts.filter((x) => (x.value_text === "licensed" || x.value_text === "sold_or_licensed") && /licen[cs]/i.test(x.quote || ""));
      const factOf = new Map(facts.map((x) => [x.plan_id, x]));
      // Plans whose word list has both words, narrowed to the size asked for, then the sentences that say it.
      let tids = (await restAll(io, `plan_tsv?select=plan_id&tsv=fts(english).${encodeURIComponent("park & licens")}`)).map((h) => h.plan_id);
      const uf = [spec.units?.max != null ? `&units_residential=lte.${spec.units.max}&units_residential=gte.1` : "", spec.units?.min != null ? `&units_residential=gte.${spec.units.min}` : ""].join("");
      if (uf && tids.length) tids = (await byIds(io, "plans", "plan_id", tids, uf)).map((p) => p.plan_id);
      if (plans) { const inSet = new Set(plans.map((p) => p.plan_id)); tids = tids.filter((id) => inSet.has(id)); }
      const PQ = '"parking license" OR "parking licenses" OR "license to use" OR "licensed parking" OR "parking space license" OR "parking licensee" OR "license agreement"';
      const tpages = tids.length ? (await Promise.all(chunk(tids, 60).map((c) => restAll(io, `pages?select=plan_id,file_id,page_no,body&plan_id=in.${inList(c)}&tsv=wfts(english).${encodeURIComponent(PQ)}`)))).flat() : [];
      // Per plan: sentences that offer a parking license in the building, and sentences that only mention one.
      const textHit = new Map();
      for (const p of tpages) for (const snt of sentences(p.body)) {
        if (snt.length < 600 && /\bparking\b/i.test(snt) && /\blicen[cs]/i.test(snt) && !PARK_OTHER_LIC.test(snt)) {
          if (!textHit.has(p.plan_id)) textHit.set(p.plan_id, { offer: [], mention: [] });
          const h = textHit.get(p.plan_id), ev = parkingOffer(snt) ? h.offer : h.mention;
          if (ev.length < 2) ev.push({ text: snt.trim().slice(0, 420), file_id: p.file_id, page_no: p.page_no });
        }
      }
      const docs = await byIds(io, "documents", "file_id,plan_id,doc_kind,amendment_no,pdf_url", [...lic.map((x) => x.plan_id), ...textHit.keys()]);
      const urlOf = new Map(docs.map((d) => [d.file_id, d.pdf_url]));
      const cite = (e) => ({ ...e, pdf_url: urlOf.get(e.file_id) || null, doc: "Offering Plan" });
      for (const x of lic) why.set(x.plan_id, { parking: "fact", fact: x.value_text, evidence: [cite({ text: x.quote, file_id: x.file_id, page_no: x.page_no })] });
      // Listed from the text only when a sentence offers the license and the extracted arrangement doesn't say otherwise
      // (sold, or a limited common element). Every other plan whose pages name parking and a license is shown apart, uncounted.
      const offered = [], mentioned = [];
      for (const [id, h] of textHit) if (!why.has(id)) {
        const other = factOf.get(id)?.value_text || null;
        if (h.offer.length && (!other || /licen/.test(other))) { offered.push(id); why.set(id, { parking: "text", fact: other, evidence: h.offer.map(cite) }); }
        else { mentioned.push(id); why.set(id, { parking: "mention", fact: other, evidence: (h.offer.length ? h.offer : h.mention).map(cite) }); }
      }
      sets.push(new Set([...lic.map((x) => x.plan_id), ...offered]));
      res.mentionIds = mentioned;
      res.notes.push("“Licensed” parking comes from the parking arrangement extracted from each plan (checked against the quoted page), plus plans whose pages say a parking license is offered, sold or priced in the building. Plans whose pages only mention parking and a license are listed separately below and not counted. Plans without searchable documents can’t be checked.");
    }

    // 4. Assemble candidates.
    if (!plans) {
      if (sets.length) {
        const ids = [...sets.reduce((a, b) => new Set([...a].filter((x) => b.has(x))))];
        plans = ids.length ? (await byIds(io, "plans", COLS, ids, f.length ? "&" + f.join("&") : "")).filter(keep) : [];
      } else {
        step("Loading plan records…");
        plans = (await restAll(io, `plans?select=${COLS}${f.length ? "&" + f.join("&") : ""}&plan_type=eq.CONDOMINIUM`)).filter(keep);
      }
    } else for (const s of sets) plans = plans.filter((p) => s.has(p.plan_id));

    // 5. Stats: a pivot table instead of a list.
    if (spec.stats) return statsTable(res, plans, spec, io, today, step);

    // 6. Unit prices by bedrooms from Schedule A.
    if (spec.beds || spec.price) {
      step("Reading Schedule A unit prices…");
      const ids = plans.map((p) => p.plan_id);
      const [sa, withText] = await Promise.all([
        scheduleAUnits(io, ids, (fr) => step(`Reading Schedule A unit prices… ${Math.round(fr * 100)}%`)),
        ids.length ? byIds(io, "documents", "plan_id", ids, "&status=eq.done").then((d) => new Set(d.map((x) => x.plan_id))) : new Set(),
      ]);
      const fits = (u) => (!spec.beds || (u.beds >= spec.beds.min && (spec.beds.max == null || u.beds <= spec.beds.max))) && (!spec.price || ((spec.price.min == null || u.price >= spec.price.min) && (spec.price.max == null || u.price <= spec.price.max)));
      let read = 0, noTable = 0, noDocs = 0;
      for (const p of plans) {
        const s = sa.get(p.plan_id);
        if (s?.units.length) read++;
        else if (withText.has(p.plan_id)) noTable++;
        else noDocs++;
        p.units = (s?.units || []).filter(fits);
        p.unitsRead = s?.units.length || 0;
      }
      res.coverage = [
        { k: "read", n: read, label: "Schedule A unit prices and bedrooms read" },
        { k: "unreadable", n: noTable, label: "Documents searchable, but no Schedule A table with bedrooms could be read (scanned pages, or no bedroom column)" },
        { k: "nodocs", n: noDocs, label: "No searchable documents yet" },
      ];
      res.candidates = plans.length;
      plans = plans.filter((p) => p.units.length);
      res.notes.push("Prices are the sponsor’s offering prices in the original plan’s Schedule A, before any amendment or negotiation. They are not sale prices. Each unit shows the Schedule A line it was read from.");
    }

    // 7. Rows: images, searchable-document counts and evidence.
    const ids = plans.map((p) => p.plan_id);
    const [done] = await Promise.all([ids.length ? byIds(io, "documents", "plan_id", ids, "&status=eq.done") : []]);
    const cnt = new Map(); done.forEach((d) => cnt.set(d.plan_id, (cnt.get(d.plan_id) || 0) + 1));
    res.rows = plans.map((p) => ({ ...p, docs_indexed: cnt.get(p.plan_id) || 0, why: why.get(p.plan_id) || null }));
    res.rows.sort(spec.near ? (a, b) => a.distance - b.distance : (a, b) => String(b.accepted_date || "").localeCompare(String(a.accepted_date || "")));
    if (spec.mih) {
      const ex = res.excludedIds || [];
      res.excluded = ex.length ? (await byIds(io, "plans", "plan_id,name,address,borough,plan_type", ex)).map((p) => ({ ...p, why: why.get(p.plan_id) })) : [];
      res.excluded.sort((a, b) => String(a.name).localeCompare(String(b.name)));
    }
    if (spec.parking && res.mentionIds?.length) {
      res.mentions = (await byIds(io, "plans", "plan_id,name,address,borough,plan_type,units_residential", res.mentionIds)).filter(isCondo).map((p) => ({ ...p, why: why.get(p.plan_id) }));
      res.mentions.sort((a, b) => String(a.name).localeCompare(String(b.name)));
    }
    // Related filings: a record that points at another plan ("*SEE CD160304*") is the same building filed again,
    // so each side names the other and the unit counts aren't read as two buildings.
    const byId = new Map(res.rows.map((r) => [r.plan_id, r]));
    const refs = res.rows.filter((r) => seeRef(r.name) && seeRef(r.name) !== r.plan_id);
    const missing = [...new Set(refs.map((r) => seeRef(r.name)).filter((id) => !byId.has(id)))];
    const outside = new Map((missing.length ? await byIds(io, "plans", "plan_id,name", missing) : []).map((p) => [p.plan_id, p]));
    for (const r of refs) {
      const to = seeRef(r.name), t = byId.get(to) || outside.get(to);
      r.relatedTo = { plan_id: to, name: t ? cleanName(t.name) : null, listed: byId.has(to) };
      if (byId.has(to)) (byId.get(to).relatedFrom ||= []).push({ plan_id: r.plan_id, name: cleanName(r.name) });
    }
    res.relatedCount = refs.length;
    res.facets = facetsOf(res.rows, spec);
    res.title = titleOf(spec, res);
    return res;
  }

  const SIZE_BANDS = [["1–9 units", 1, 9], ["10–49 units", 10, 49], ["50–99 units", 50, 99], ["100+ units", 100, Infinity]];
  const sizeBand = (n) => (n == null ? "Unknown size" : (SIZE_BANDS.find(([, a, b]) => n >= a && n <= b) || ["Unknown size"])[0]);
  const LIVE = ["ACCEPTED", "PENDING"];
  const PROGRAM_LABEL = { MIH: "Mandatory Inclusionary Housing (MIH)", "Inclusionary Housing": "Inclusionary Housing (voluntary)", "Other program": "Other program (421-a, 80/20) — not MIH" };
  // Filters offered beside the results: only facets with more than one value, each value with its count.
  function facetsOf(rows, spec) {
    const count = (fn) => { const m = new Map(); rows.forEach((r) => { const k = fn(r); m.set(k, (m.get(k) || 0) + 1); }); return [...m].sort((a, b) => b[1] - a[1]); };
    const f = [];
    const status = count((r) => r.status || "UNKNOWN");
    if (status.length > 1) f.push({ k: "status", label: "Filing status", values: status.map(([v, n]) => ({ v, n, label: titleCase(v), on: LIVE.includes(v) })) });
    if (!spec.construction) { const c = count((r) => r.construction || "UNKNOWN"); if (c.length > 1) f.push({ k: "construction", label: "Construction", values: c.map(([v, n]) => ({ v, n, label: v === "NEW" ? "New construction" : titleCase(v), on: true })) }); }
    if (!spec.units) { const s = count((r) => sizeBand(r.units_residential)); if (s.length > 1) f.push({ k: "size", label: "Building size", values: SIZE_BANDS.map(([l]) => l).concat("Unknown size").filter((l) => s.some(([v]) => v === l)).map((l) => ({ v: l, n: s.find(([v]) => v === l)[1], label: l, on: true })) }); }
    const dec = count((r) => (r.accepted_date ? r.accepted_date.slice(0, 3) + "0s" : "Not accepted"));
    if (dec.length > 1) f.push({ k: "decade", label: "Accepted", values: dec.sort((a, b) => b[0].localeCompare(a[0])).map(([v, n]) => ({ v, n, label: v === "Not accepted" ? "Not yet accepted" : v, on: true })) });
    if (spec.mih) { const p = count((r) => r.why?.program || "Inclusionary Housing"); if (p.length > 1) f.push({ k: "program", label: "Affordability program", values: ["MIH", "Inclusionary Housing", "Other program"].filter((v) => p.some(([x]) => x === v)).map((v) => ({ v, n: p.find(([x]) => x === v)[1], label: PROGRAM_LABEL[v], on: v !== "Other program" })) }); }
    if (spec.parking) { const p = count((r) => (r.why?.parking === "fact" ? "fact" : "text")); if (p.length > 1) f.push({ k: "evidence", label: "Evidence", values: p.map(([v, n]) => ({ v, n, label: v === "fact" ? "Parking arrangement: licensed" : "Pages offer a parking license", on: true })) }); }
    if (spec.beds || spec.price) { const b = count((r) => Math.min(...r.units.map((u) => u.beds))); if (b.length > 1) f.push({ k: "beds", label: "Bedrooms", values: b.sort((x, y) => x[0] - y[0]).map(([v, n]) => ({ v, n, label: v === 0 ? "Studio" : `${v} BR`, on: true })) }); }
    return f;
  }
  function facetKey(k, r) {
    return { status: r.status || "UNKNOWN", construction: r.construction || "UNKNOWN", size: sizeBand(r.units_residential), decade: r.accepted_date ? r.accepted_date.slice(0, 3) + "0s" : "Not accepted",
      program: r.why?.program || "Inclusionary Housing", evidence: r.why?.parking === "fact" ? "fact" : "text", beds: r.units ? Math.min(...r.units.map((u) => u.beds)) : null }[k];
  }
  function titleOf(spec, res) {
    const n = res.rows.length;
    // Counts are plan filings; a building filed twice counts twice, and its cards say so.
    const where = spec.near ? ` within ${fmtMiles(spec.near.miles)} of ${spec.near.label}` : spec.borough ? ` in ${titleCase(spec.borough)}` : "";
    const plans = `condo plan${n === 1 ? "" : "s"}`;
    if (spec.beds || spec.price) return `${n} ${plans}${where} with matching units`;
    if (spec.mih) return `${n} ${plans} with MIH / Inclusionary Housing units on site${where}`;
    if (spec.parking) return `${n} ${plans}${spec.units?.max != null ? ` under ${spec.units.max + 1} units` : ""} offering parking by license${where}`;
    return `${n} ${plans}${where}`;
  }

  // ---------- averages ----------
  async function statsTable(res, plans, spec, io, today, step) {
    const measure = spec.stats.measure;
    const agg = (vals) => { if (!vals.length) return null; const s = [...vals].sort((a, b) => a - b); return measure === "median" ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : s.reduce((a, b) => a + b, 0) / s.length; };
    const accepted = plans.filter((p) => p.status === "ACCEPTED");
    const priced = accepted.filter((p) => Number(p.price_current) > 0 && p.units_residential > 0);
    // Per plan: total offering price ÷ units offered (residential + commercial + parking + storage), so a garage or shop doesn't inflate the per-home figure.
    const perUnit = (p) => Number(p.price_current) / (p.units_residential + (p.units_commercial || 0) + (p.units_parking || 0) + (p.units_storage || 0));
    const pure = priced.filter((p) => !(p.units_commercial > 0));
    res.plansAll = plans.length; res.plansAccepted = accepted.length; res.plansPriced = priced.length;
    const yearOf = (p) => p.accepted_date.slice(0, 4);
    const years = [...new Set(priced.map(yearOf))].sort();
    const boros = [...new Set(priced.map((p) => p.borough))].sort();
    const cell = (list, fn) => { const v = list.map(fn).filter((x) => Number.isFinite(x)); return { v: agg(v), n: v.length }; };
    const pivot = (rowsBy, rowKeys, colBy, colKeys, list, fn) => ({
      rows: rowKeys.map((rk) => ({ key: rk, cells: colKeys.map((ck) => cell(list.filter((p) => rowsBy(p) === rk && colBy(p) === ck), fn)), total: cell(list.filter((p) => rowsBy(p) === rk), fn) })),
      totals: colKeys.map((ck) => cell(list.filter((p) => colBy(p) === ck), fn)), grand: cell(list, fn), cols: colKeys,
    });
    const M = measure === "median" ? "Median" : "Average";
    // Two price bases: the AG record's current total offering (after any amendments), and the original plan's Schedule A unit prices.
    const changed = priced.filter((p) => Number(p.price_initial) > 0 && Number(p.price_initial) !== Number(p.price_current)).length;
    res.priceBasis = { current: "Current total offering (AG record)", scheduleA: "Original plan’s Schedule A", changed };
    res.tables = [];
    res.tables.push({ id: "boro-year", basis: "current", title: `${M} current offering price per unit (AG record), by borough and year accepted`, unit: "money",
      note: "Each plan’s current total offering price as recorded by the AG ÷ every unit it offers, including parking, storage and commercial units. n = plans.",
      ...pivot((p) => titleCase(p.borough), boros.map(titleCase), yearOf, years, priced, perUnit) });
    const bands = SIZE_BANDS.map(([l]) => l).filter((l) => priced.some((p) => sizeBand(p.units_residential) === l));
    res.tables.push({ id: "boro-size", basis: "current", title: `${M} current offering price per unit (AG record), by borough and building size`, unit: "money",
      note: "Same measure, split by residential unit count.", ...pivot((p) => titleCase(p.borough), boros.map(titleCase), (p) => sizeBand(p.units_residential), bands, priced, perUnit) });
    res.tables.push({ id: "boro-year-total", basis: "current", title: `${M} current total offering price per plan (AG record), by borough and year accepted`, unit: "money",
      note: "The whole plan’s current offering price as recorded by the AG.", ...pivot((p) => titleCase(p.borough), boros.map(titleCase), yearOf, years, priced, (p) => Number(p.price_current)) });
    res.pureCount = pure.length;
    res.rows = priced.map((p) => ({ ...p, per_unit: perUnit(p) })).sort((a, b) => String(b.accepted_date).localeCompare(String(a.accepted_date)));
    res.title = `${measure === "median" ? "Median" : "Average"} offering price, ${spec.construction === "NEW" ? "new construction " : ""}condos accepted ${spec.window ? `in the last ${spec.window.n} ${spec.window.unit}${spec.window.n === 1 ? "" : "s"}` : spec.since ? `since ${spec.since}` : ""}`.trim();
    if (spec.wantsSales) res.notes.unshift("The Condo Book Project has no closed-sale records, so sale prices can’t be averaged. These are the sponsors’ offering prices from the plans filed with the Attorney General.");
    res.notes.push(`${priced.length} of ${plans.length} plans are counted: accepted by the AG and with a total offering price on record.${spec.since ? ` Window: accepted ${spec.since} to ${spec.until || today}.` : ""}`);
    res.notes.push(`The plan tables use each plan’s current total offering price in the AG record; the bedroom tables use unit prices from the original plan’s Schedule A. They are different price bases and don’t reconcile: for ${changed} of ${priced.length} plans the AG’s current total differs from its initial total.`);
    // Unit-level breakdown from Schedule A, when the pages can be read.
    step("Reading Schedule A unit prices…");
    const sa = await scheduleAUnits(io, priced.map((p) => p.plan_id), (fr) => step(`Reading Schedule A unit prices… ${Math.round(fr * 100)}%`));
    const units = []; let read = 0;
    for (const p of priced) { const s = sa.get(p.plan_id); if (s?.units.length) { read++; s.units.forEach((u) => units.push({ ...u, borough: titleCase(p.borough), plan_id: p.plan_id })); } }
    const bedKey = (u) => (u.beds === 0 ? "Studio" : u.beds >= 4 ? "4+ BR" : `${u.beds} BR`);
    const bedKeys = ["Studio", "1 BR", "2 BR", "3 BR", "4+ BR"].filter((k) => units.some((u) => bedKey(u) === k));
    const ub = [...new Set(units.map((u) => u.borough))].sort();
    if (units.length) {
      res.tables.push({ id: "beds-boro", basis: "scheduleA", title: `${M} original Schedule A unit price, by bedrooms and borough`, unit: "money", countNoun: "units",
        note: `Unit prices from the original offering plan’s Schedule A, before any amendment, read in ${read} of ${priced.length} plans. n = units.`, ...pivot(bedKey, bedKeys, (u) => u.borough, ub, units, (u) => u.price) });
      const ppsf = units.filter((u) => u.sf);
      if (ppsf.length) res.tables.push({ id: "ppsf-boro", basis: "scheduleA", title: `${M} original Schedule A price per square foot, by bedrooms and borough`, unit: "ppsf", countNoun: "units",
        note: "Only units whose square footage is read from the table’s area column; units with no area, or more than one area column that can’t be told apart, are left out. n = units.", ...pivot(bedKey, bedKeys, (u) => u.borough, ub, ppsf, (u) => u.price / u.sf) });
    }
    res.saRead = read;
    return res;
  }

  return { cleanName, headerMode, areaMode, areaOf, parkingOffer, mihAssertion, excerpt, seeRef, parse, run, chipsOf, facetsOf, facetKey, fmtMiles, parseScheduleA, classifyMIH, milesBetween, resolveAnchor, addressPatterns, money, restAll, titleCase, sizeBand, LIVE };
});
