// Building pages (fact sheet): load the Schedule B budget and facts extracted from the plan, and search inside this plan.
(() => {
  const main = document.querySelector("main.bldg");
  if (!main) return;

  const SB = "https://dvywgltjqpntldlztapu.supabase.co";
  const KEY = "sb_publishable_At7fyv-9Vp7ByNP3AXHZ7g_qphsg6Rw";
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // ---------- Budget & charges (Schedule B) ----------
  const bbox = document.getElementById("schedb");
  if (bbox) loadBudget(bbox);
  async function loadBudget(box) {
    const where = document.getElementById("schedb-where");
    const fmt = (n) => {
      if (n === null || n === undefined || n === "" || isNaN(Number(n))) return "—";
      const v = Number(n), s = "$" + Math.abs(v).toLocaleString("en-US", { maximumFractionDigits: 2 });
      return v < 0 ? `(${s})` : s;
    };
    box.innerHTML = '<p class="faint">Loading the budget…</p>';
    let row;
    try {
      const r = await fetch(`${SB}/rest/v1/schedule_b?plan_id=eq.${encodeURIComponent(box.dataset.plan)}&select=budget_period,total_income,total_expenses,line_items,notes,status,status_note&limit=1`,
        { headers: { apikey: KEY, Accept: "application/json" } });
      if (!r.ok) throw new Error(String(r.status));
      row = (await r.json())[0];
    } catch (e) {
      box.innerHTML = "<p class=\"faint\">The budget didn't load. Try again in a moment.</p>";
      return;
    }
    const items = Array.isArray(row?.line_items) ? row.line_items : [];
    if (!row || row.status === "not_found" || row.status === "unreadable" || !items.length) {
      box.innerHTML = "<p>Budget not available for this plan.</p>";
      return;
    }
    if (where) where.hidden = true; // the table cites its own pages

    // Footnotes: one anchor per note number (first one wins if a number repeats).
    const notes = Array.isArray(row.notes) ? row.notes : [];
    const noteId = new Map();
    notes.forEach((n, i) => { const k = String(n.n ?? "").trim(); if (k && !noteId.has(k)) noteId.set(k, "bn-" + i); });
    // Each line shows its own notes beside it; notes no line refers to stay in a list below.
    const used = new Set();
    const noteText = (note) => String(note ?? "").split(/[,;\s]+/).filter((k) => noteId.has(k)).map((k) => {
      used.add(k);
      const n = notes[Number(noteId.get(k).slice(3))];
      // The note's title repeats the line's name, so only its text shows here.
      return `<span class="bnote">${esc(n.summary || n.title || "")}</span>`;
    }).join("");

    // Group by budget, then section, in the order they appear in the plan.
    const budgets = new Map();
    for (const it of items) {
      const b = it.budget || "Budget", sec = it.section || "Other";
      if (!budgets.has(b)) budgets.set(b, new Map());
      const secs = budgets.get(b);
      if (!secs.has(sec)) secs.set(sec, []);
      secs.get(sec).push(it);
    }
    const isTotal = (it) => /\btotal\b/i.test(it.item || "");
    const tables = [...budgets].map(([b, secs]) => {
      const rows = [...secs].map(([sec, list]) => `<tr class="sec"><th colspan="3">${esc(sec)}</th></tr>` + list.map((it) => {
        return `<tr${isTotal(it) ? ' class="total"' : ""}><td>${esc(String(it.item ?? "").replace(/\boperating expenses?\b/gi, "Opex"))}</td><td class="amt">${fmt(it.amount)}</td><td class="bnotes-cell">${noteText(it.note)}</td></tr>`;
      }).join("")).join("");
      return (budgets.size > 1 ? `<h3>${esc(b)} Budget</h3>` : "") +
        `<div class="tscroll"><table class="budget"><thead><tr><th>Item</th><th class="amt">Amount</th><th>Notes</th></tr></thead><tbody>${rows}</tbody></table></div>`;
    }).join("");

    const head = [];
    if (row.budget_period) head.push(`<b>Budget period:</b> ${esc(row.budget_period)}`);
    if (row.total_income != null) head.push(`<b>Total income:</b> ${fmt(row.total_income)}`);
    if (row.total_expenses != null) head.push(`<b>Total expenses:</b> ${fmt(row.total_expenses)}`);
    const caution = row.status === "partial"
      ? `<p class="bcaution"><b>Partly extracted.</b> ${esc(row.status_note || "Some of this budget could not be read. Check the offering plan.")}</p>` : "";
    const rest = notes.filter((n) => !used.has(String(n.n ?? "").trim()));
    const noteList = rest.length ? `<h3>Other Notes to the Budget</h3><ol class="bnotes">${rest.map((n) =>
      `<li><span class="n">${esc(n.n)}</span><b>${esc(n.title || "")}</b>${n.title ? ". " : ""}${esc(n.summary || "")}</li>`).join("")}</ol>` : "";

    box.innerHTML = `<p class="src">Schedule B of the offering plan: the sponsor's projected first-year budget. Extracted from the offering plan.</p>` +
      (head.length ? `<p class="bperiod">${head.join(" · ")}</p>` : "") + caution + tables + noteList;
  }


  // ---------- Units & prices (Schedule A) ----------
  // Read from the plan's Schedule A table by pattern matching (scripts/extract-schedule-a.mjs); a file exists
  // only for plans whose unit prices add up to the AG record's total offering price.
  const abox = document.getElementById("scheda");
  const aDone = abox ? loadScheduleA(abox) : null;
  async function loadScheduleA(box) {
    let row;
    try {
      const r = await fetch(`${box.dataset.src}`);
      if (!r.ok) return;
      row = await r.json();
    } catch { return; }
    const units = Array.isArray(row?.units) ? row.units : [];
    if (!units.length) return;
    const $ = (n) => n == null ? "—" : "$" + Math.round(n).toLocaleString("en-US");
    const sf = (n) => n == null ? "—" : Math.round(n).toLocaleString("en-US");
    // Home types as buyers compare them: Studio, 1BD/1BA, 2BD/1BA, 2BD/2BA… (a studio with one bath is just "Studio").
    const typeLabel = (b, ba) => b == null ? "Not stated"
      : b === 0 ? (ba == null || ba <= 1 ? "Studio" : `Studio/${ba}BA`)
      : ba == null ? `${b}BD (baths not stated)` : `${b}BD/${ba}BA`;
    // Parking, storage and commercial rows: a retail / commercial / storage / parking name, no bedroom count and a
    // P1 / S-2 / G3 / C1-style unit number, or too small or cheap to be a home. Listed after the homes, left out of the summary.
    const isOther = (u) => /^(retail|commercial|storage|parking|garage)/i.test(u.unit)
      || (u.beds == null && /^(p(?!h)|s|g|c|r|com|stor|park)[\s-]?\d/i.test(u.unit))
      || (u.sqft != null && u.sqft < 400) || u.price < 200000 || (u.sqft == null && u.beds == null);
    const homes = units.filter((u) => !isOther(u));
    const other = units.filter(isOther);
    const psf = (u) => (u.sqft ? u.price / u.sqft : null);

    // Summary by home type (bedrooms, then baths).
    const groups = new Map();
    for (const u of homes) { const k = typeLabel(u.beds, u.baths); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(u); }
    const order = ([, a]) => [a[0].beds ?? 99, a[0].beds == null ? 0 : a[0].baths ?? 99];
    const range = (a) => { const lo = Math.min(...a), hi = Math.max(...a); return lo === hi ? lo : [lo, hi]; };
    const fmtRange = (v, f) => Array.isArray(v) ? `${f(v[0])}–${f(v[1])}` : f(v);
    const avg = (a) => a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;
    const summary = [...groups].sort((a, b) => { const x = order(a), y = order(b); return x[0] - y[0] || x[1] - y[1]; }).map(([k, list]) => {
      const sizes = list.map((u) => u.sqft).filter((x) => x != null);
      const per = list.map(psf).filter((x) => x != null);
      return `<tr><th scope="row">${esc(k)}</th><td class="n">${list.length}</td>` +
        `<td class="n">${sizes.length ? fmtRange(range(sizes), sf) + " sf" : "—"}</td>` +
        `<td class="n">${fmtRange(range(list.map((u) => u.price)), $)}</td><td class="n">${per.length ? $(avg(per)) : "—"}</td></tr>`;
    }).join("");

    const pdf = box.dataset.pdf;
    const cite = [...new Set(units.map((u) => u.page))].sort((a, b) => a - b)
      .map((p) => pdf ? `<a href="${esc(pdf)}#page=${p}" rel="noopener">p. ${p}</a>` : `p. ${p}`).join(", ");
    const unitRow = (u) => `<tr><th scope="row">${esc(u.unit)}</th><td>${u.beds == null ? "—" : u.beds === 0 ? "Studio" : u.beds}</td><td>${u.baths ?? "—"}</td>` +
      `<td class="n">${sf(u.sqft)}</td><td class="n">${$(u.price)}</td><td class="n">${psf(u) ? $(psf(u)) : "—"}</td><td class="n">${u.pct != null ? u.pct + "%" : "—"}</td></tr>`;

    box.innerHTML = `<p class="src">The sponsor's offering prices from Schedule A of the original plan (${cite}). Amendments can change prices; this is the plan as first offered. ${homes.length} homes${other.length ? `, ${other.length} other units (parking, storage)` : ""}, ${$(row.price_total)} in total.</p>` +
      `<div class="tscroll"><table class="sa-sum"><thead><tr><th>Type</th><th class="n">Units</th><th class="n">Size</th><th class="n">Price</th><th class="n">Avg $/sf</th></tr></thead><tbody>${summary}</tbody></table></div>` +
      `<details class="sa-all"${units.length <= 12 ? " open" : ""}><summary>All ${units.length} units</summary>` +
      `<div class="tscroll"><table class="sa-units"><thead><tr><th>Unit</th><th>Beds</th><th>Baths</th><th class="n">Sq ft</th><th class="n">Price</th><th class="n">$/sf</th><th class="n">Common interest</th></tr></thead>` +
      `<tbody>${[...homes, ...other].map(unitRow).join("")}</tbody></table></div></details>`;
    box.closest("section").hidden = false;
  }

  // ---------- facts extracted from the offering plan ----------
  // Shown in the tab they belong to, each with its page. Only value_text is shown, except the managing
  // agent's fee (value_num is the annual fee for that field; other fields use it inconsistently).
  const fDone = loadFacts(main.dataset.plan);
  // Units & prices and the team rows load in above the lower sections, pushing a #documents-style link target down.
  // Once they're in, go back to the target, unless the reader has scrolled on their own.
  const target = location.hash && document.getElementById(decodeURIComponent(location.hash.slice(1)));
  if (target) {
    let moved = false;
    const own = () => { moved = true; };
    for (const ev of ["wheel", "touchmove", "keydown", "mousedown"]) addEventListener(ev, own, { once: true, passive: true });
    Promise.allSettled([aDone, fDone]).then(() => { if (!moved) target.scrollIntoView(); });
  }
  async function loadFacts(plan) {
    if (!plan) return;
    let rows;
    try {
      const r = await fetch(`${SB}/rest/v1/facts?plan_id=eq.${encodeURIComponent(plan)}&select=field,value_text,value_num,page_no,quote&order=field,page_no`,
        { headers: { apikey: KEY, Accept: "application/json" } });
      if (!r.ok) return;
      rows = await r.json();
    } catch { return; }
    if (!rows.length) return;
    const by = new Map();
    for (const f of rows) { if (!by.has(f.field)) by.set(f.field, []); by.get(f.field).push(f); }
    const P = (document.querySelector(".wordmark")?.getAttribute("href") || "../index.html").replace(/index\.html$/, "");
    // The agent's name links to its profile page when it has one (data-managers, from build-buildings.mjs),
    // otherwise to a search for every building it manages (sponsor-managed plans aren't linked).
    let profiles = {};
    try { profiles = JSON.parse(main.dataset.managers || "{}"); } catch {}
    const agentLink = (name) => {
      const slug = profiles[String(name).trim()];
      if (slug) return `<a href="${P}managing-agents/${encodeURIComponent(slug)}.html" title="Other buildings managed by ${esc(name)}">${esc(name)}</a>`;
      const q = String(name).replace(/\([^)]*\)/g, "").trim().replace(/[,\s]+(inc|llc|l\.l\.c|corp|corporation|co|company|ltd)\.?$/i, "").trim();
      return /\(\s*sponsor|affiliate/i.test(name) || !q ? esc(name) : `<a href="${P}index.html?q=${encodeURIComponent("managed by " + q)}" title="Other buildings managed by ${esc(q)}">${esc(name)}</a>`;
    };
    // Architect and selling agent names link to their profile pages (data-architects, data-sellers). A value can name
    // several firms ("Related Sales LLC and Corcoran Sunshine Marketing Group"), split as scripts/pros.mjs splits it.
    const proMaps = {};
    for (const [field, attr] of [["architect", "architects"], ["selling_agent", "sellers"]]) {
      try { proMaps[field] = JSON.parse(main.dataset[attr] || "{}"); } catch { proMaps[field] = {}; }
    }
    const PRO_DIR = { architect: "architects", selling_agent: "selling-agents" };
    const proLink = (field, value) => {
      const map = proMaps[field], link = (nm) => map[nm.trim()]
        ? `<a href="${P}${PRO_DIR[field]}/${encodeURIComponent(map[nm.trim()])}.html" title="Other buildings naming ${esc(nm.trim())}">${esc(nm)}</a>` : esc(nm);
      if (map[String(value).trim()]) return link(String(value));
      const sep = field === "selling_agent" ? /(\s*;\s*|\s+\/\s+|\s+and\s+(?![^(]*\)))/ : /(\s*;\s*)/;
      return String(value).split(sep).map((part, i) => i % 2 ? esc(part) : link(part)).join("");
    };
    // Returns HTML; every value is escaped here.
    const val = (field, f) => {
      if (PRO_DIR[field] && f.value_text) return proLink(field, f.value_text);
      if (field === "managing_agent") {
        // Fee (and fee per residential unit) sits under the name in small type, like counsel's contact.
        const n = Number(f.value_num), units = Number(main.dataset.units);
        const fee = f.value_num != null && !isNaN(n) ? [`Fee $${n.toLocaleString("en-US")} a year`,
          units > 0 && `$${Math.round(n / units).toLocaleString("en-US")} per residential unit a year`].filter(Boolean).join(" · ") : "";
        return (f.value_text ? agentLink(f.value_text) : "") + (fee ? `<span class="sub">${esc(fee)}</span>` : "");
      }
      return esc(f.value_text);
    };
    // Each fact becomes a row in the fact table, with the plan page it came from.
    const row = (label, field) => {
      const list = (by.get(field) || []).filter((f) => f.value_text || f.value_num != null);
      if (!list.length) return "";
      return `<div><dt>${esc(label)}</dt><dd>${list.map((f) => `<span class="fv">${val(field, f)}</span>`).join("")}</dd></div>`;
    };
    const sheet = document.getElementById("sheet");
    if (!sheet) return;
    const html = [["Tax program", "tax_program"], ["Affordable housing", "affordable_housing"]].map(([l, f]) => row(l, f)).join("");
    // Plan ID stays last.
    const last = sheet.lastElementChild;
    if (html) last ? last.insertAdjacentHTML("beforebegin", html) : sheet.insertAdjacentHTML("beforeend", html);
    // The rest of the team goes in its own box, after sponsor and counsel and before the tax estimate.
    const team = document.getElementById("teamsheet");
    const pros = [["Managing agent", "managing_agent"], ["Selling agent", "selling_agent"], ["Architect", "architect"]].map(([l, f]) => row(l, f)).join("");
    if (!team || !pros) return;
    const tax = [...team.children].find((d) => d.querySelector("dt")?.textContent === "Tax estimate");
    tax ? tax.insertAdjacentHTML("beforebegin", pros) : team.insertAdjacentHTML("beforeend", pros);
    team.closest("section").hidden = false;
  }

  // ---------- search inside this plan ----------
  const form = document.getElementById("psearch");
  if (!form) return;
  const plan = form.dataset.plan;
  const docs = JSON.parse(document.getElementById("pdocs").textContent || "{}");
  const out = document.getElementById("presults"), input = document.getElementById("pq");

  function excerpt(body, terms) {
    const text = String(body || "").replace(/\s+/g, " ");
    const lower = text.toLowerCase();
    let at = -1;
    for (const t of terms) { const i = lower.indexOf(t); if (i >= 0 && (at < 0 || i < at)) at = i; }
    const start = Math.max(0, at - 110), end = Math.min(text.length, (at < 0 ? 0 : at) + 190);
    let s = esc(text.slice(start, end));
    for (const t of terms) s = s.replace(new RegExp("(" + t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "[a-z]*)", "gi"), "<mark>$1</mark>");
    return (start > 0 ? "…" : "") + s + (end < text.length ? "…" : "");
  }

  const track = (name, params) => window.obTrack?.(name, { plan_id: plan, ...params });
  // A typed question becomes its topic words: "Are pets allowed?" searches for "pets". Quoted phrases and OR pass through.
  const FILLER = new Set(("is are was were be there a an the does do did can could will would should i we you my our what which who whom how much many " +
    "where when why this that these those building plan offering condo condominium apartment unit units allowed permitted include includes included " +
    "any have has it its for of in on at to and about tell me show find get please with by from").split(" "));
  const topic = (q) => /"|\bOR\b/.test(q) ? q : q.replace(/[?!.,;:]/g, " ").split(/\s+/).filter((w) => w && !FILLER.has(w.toLowerCase())).join(" ");
  const pagesFor = async (q) => {
    const r = await fetch(`${SB}/rest/v1/pages?plan_id=eq.${encodeURIComponent(plan)}&body=wfts(english).${encodeURIComponent(q)}&select=file_id,page_no,body&order=file_id,page_no&limit=30`,
      { headers: { apikey: KEY, Accept: "application/json" } });
    if (!r.ok) throw new Error(String(r.status));
    return r.json();
  };
  async function run(text, via) {
    text = text.trim(); if (!text) { input.focus(); return; }
    const q = topic(text) || text;
    out.innerHTML = '<p class="faint">Searching…</p>';
    // Stems for highlighting: first 5 letters of each word, skipping OR and quotes.
    const terms = q.toLowerCase().replace(/"/g, " ").split(/\s+/).filter((w) => w && w !== "or" && w.length > 2).map((w) => w.slice(0, 5));
    try {
      let rows = await pagesFor(q);
      // Every word on one page is strict; with none, pages with any of the words.
      const words = q.split(/\s+/);
      if (!rows.length && words.length > 1 && !/"|\bOR\b/.test(q)) rows = await pagesFor(words.join(" OR "));
      track("search_plan", { search_term: text, search_via: via, results: rows.length });
      if (!rows.length) { out.innerHTML = `<p class="faint">No pages in this plan mention “${esc(q)}”. Try other words.</p>`; return; }
      out.innerHTML = `<p class="faint">${rows.length}${rows.length === 30 ? "+" : ""} matching page${rows.length === 1 ? "" : "s"}</p><ol class="hits">` +
        rows.map((x) => `<li><span class="cite">${esc(docs[x.file_id] || "Document")} · p. ${x.page_no}</span><p>${excerpt(x.body, terms)}</p></li>`).join("") + "</ol>";
    } catch (e) {
      track("search_error", { search_term: q, description: String(e.message || e).slice(0, 150) });
      out.innerHTML = '<p class="faint">The search didn\'t run. Try again in a moment.</p>';
    }
  }
  // The box types out example questions, as on the home page. Clicking in clears it; an empty search runs the example showing.
  const typer = (() => {
    const list = ["Are pets allowed?", "Who is the managing agent?", "Is there a gym?", "What are the common charges?", "Is there a roof deck?", "Is storage available?"];
    let i = 0, n = 0, dir = 1, timer = null;
    const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const idle = () => !input.value && document.activeElement !== input;
    function tick() {
      if (!idle()) { timer = null; return; }
      const t = list[i];
      n += dir;
      input.placeholder = t.slice(0, n);
      let wait = dir > 0 ? 45 + Math.random() * 40 : 18;
      if (dir > 0 && n >= t.length) { dir = -1; wait = 1800; }
      else if (dir < 0 && n <= 0) { dir = 1; i = (i + 1) % list.length; wait = 350; }
      timer = setTimeout(tick, wait);
    }
    function start() {
      if (timer || !idle()) return;
      if (still) { input.placeholder = list[i]; return; }
      timer = setTimeout(tick, 250);
    }
    input.addEventListener("focus", () => { clearTimeout(timer); timer = null; input.placeholder = ""; });
    input.addEventListener("blur", () => { n = 0; dir = 1; start(); });
    start();
    return { current: () => list[i] };
  })();
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    if (!input.value.trim()) input.value = typer.current();
    run(input.value, "typed");
  });
})();
