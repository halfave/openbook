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
    const cite = (pg) => pg ? `Offering Plan, p. ${esc(pg)}` : "";
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
    const refs = (note) => String(note ?? "").split(/[,;\s]+/).filter(Boolean)
      .map((k) => noteId.has(k) ? `<a href="#${noteId.get(k)}" data-note>${esc(k)}</a>` : `<span>${esc(k)}</span>`).join(",");

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
        const r = refs(it.note);
        return `<tr${isTotal(it) ? ' class="total"' : ""}><td>${esc(it.item)}${r ? `<sup>${r}</sup>` : ""}</td><td class="amt">${fmt(it.amount)}</td><td class="pg">${cite(it.page)}</td></tr>`;
      }).join("")).join("");
      return (budgets.size > 1 ? `<h3>${esc(b)} Budget</h3>` : "") +
        `<div class="tscroll"><table class="budget"><thead><tr><th>Item</th><th class="amt">Amount</th><th>Source</th></tr></thead><tbody>${rows}</tbody></table></div>`;
    }).join("");

    const head = [];
    if (row.budget_period) head.push(`<b>Budget period:</b> ${esc(row.budget_period)}`);
    if (row.total_income != null) head.push(`<b>Total income:</b> ${fmt(row.total_income)}`);
    if (row.total_expenses != null) head.push(`<b>Total expenses:</b> ${fmt(row.total_expenses)}`);
    const caution = row.status === "partial"
      ? `<p class="bcaution"><b>Partly extracted.</b> ${esc(row.status_note || "Some of this budget could not be read. Check the plan pages cited.")}</p>` : "";
    const noteList = notes.length ? `<h3>Notes to the Budget</h3><ol class="bnotes">${notes.map((n, i) =>
      `<li id="bn-${i}"><span class="n">${esc(n.n)}</span><b>${esc(n.title || "")}</b>${n.title ? ". " : ""}${esc(n.summary || "")}${n.page ? ` <span class="pg">${cite(n.page)}</span>` : ""}</li>`).join("")}</ol>` : "";

    box.innerHTML = `<p class="src">Schedule B of the offering plan: the sponsor's projected first-year budget. Extracted from the offering plan.</p>` +
      (head.length ? `<p class="bperiod">${head.join(" · ")}</p>` : "") + caution + tables + noteList;

    // Footnote links scroll to the note without changing the address bar.
    box.addEventListener("click", (e) => {
      const a = e.target.closest("a[data-note]");
      if (!a) return;
      e.preventDefault();
      const li = document.getElementById(a.getAttribute("href").slice(1));
      if (!li) return;
      li.scrollIntoView({ block: "center" });
      li.animate?.([{ backgroundColor: "var(--mark)" }, { backgroundColor: "transparent" }], { duration: 1600 });
    });
  }


  // ---------- Units & prices (Schedule A) ----------
  // Read from the plan's Schedule A table by pattern matching (scripts/extract-schedule-a.mjs); a file exists
  // only for plans whose unit prices add up to the AG record's total offering price.
  const abox = document.getElementById("scheda");
  if (abox) loadScheduleA(abox);
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
    const bedLabel = (b) => b === 0 ? "Studio" : b == null ? "Not stated" : `${b} bedroom${b === 1 ? "" : "s"}`;
    // Parking, storage and commercial rows: no bedroom count and a P1 / S-2 / G3 / C1-style unit number,
    // or too small or cheap to be a home. They're listed after the homes and left out of the summary.
    const isOther = (u) => u.beds == null && (/^(p(?!h)|s|g|c|r|com|retail|stor|park)[\s-]?\d/i.test(u.unit) || /^(retail|commercial|storage|parking|garage)/i.test(u.unit)
      || (u.sqft != null && u.sqft < 400) || u.price < 200000 || (u.sqft == null && u.beds == null));
    const homes = units.filter((u) => !isOther(u));
    const other = units.filter(isOther);
    const psf = (u) => (u.sqft ? u.price / u.sqft : null);

    // Summary by bedroom count.
    const groups = new Map();
    for (const u of homes) { const k = u.beds ?? -1; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(u); }
    const range = (a) => { const lo = Math.min(...a), hi = Math.max(...a); return lo === hi ? lo : [lo, hi]; };
    const fmtRange = (v, f) => Array.isArray(v) ? `${f(v[0])}–${f(v[1])}` : f(v);
    const avg = (a) => a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;
    const summary = [...groups].sort((a, b) => (a[0] < 0) - (b[0] < 0) || a[0] - b[0]).map(([k, list]) => {
      const sizes = list.map((u) => u.sqft).filter((x) => x != null);
      const per = list.map(psf).filter((x) => x != null);
      return `<tr><th scope="row">${esc(bedLabel(k < 0 ? null : k))}</th><td class="n">${list.length}</td>` +
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
  loadFacts(main.dataset.plan);
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
    const PARKING = { sold: "Sold as separate units", licensed: "Licensed", leased: "Leased", sold_or_licensed: "Sold or licensed", limited_common_element: "Limited common element" };
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
    // Returns HTML; every value is escaped here.
    const val = (field, f) => {
      if (field === "parking_arrangement") return esc(PARKING[f.value_text] || f.value_text);
      if (field === "managing_agent") {
        const fee = f.value_num != null && !isNaN(Number(f.value_num)) ? `${f.value_text ? ", " : ""}fee $${Number(f.value_num).toLocaleString("en-US")} a year` : "";
        return (f.value_text ? agentLink(f.value_text) : "") + esc(fee);
      }
      return esc(f.value_text);
    };
    // Each fact becomes a row in the fact table, with the plan page it came from.
    const row = (label, field) => {
      const list = (by.get(field) || []).filter((f) => f.value_text || f.value_num != null);
      if (!list.length) return "";
      return `<div><dt>${esc(label)}</dt><dd>${list.map((f) => `<span class="fv">${val(field, f)}` +
        (f.page_no ? ` <span class="fcite"${f.quote ? ` title="${esc(f.quote)}"` : ""}>p. ${esc(f.page_no)}</span>` : "") + `</span>`).join("")}</dd></div>`;
    };
    const sheet = document.getElementById("sheet");
    if (!sheet) return;
    const html = [["Parking", "parking_arrangement"], ["Tax program", "tax_program"], ["Affordable housing", "affordable_housing"],
      ["Working capital", "working_capital"], ["Reserve fund", "reserve_fund"], ["Managing agent", "managing_agent"],
      ["Selling agent", "selling_agent"], ["Architect", "architect"], ["Sponsor's address", "sponsor_address"]].map(([l, f]) => row(l, f)).join("");
    // Plan ID stays last.
    const last = sheet.lastElementChild;
    if (html) last ? last.insertAdjacentHTML("beforebegin", html) : sheet.insertAdjacentHTML("beforeend", html);
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
  async function run(q, via) {
    q = q.trim(); if (!q) { input.focus(); return; }
    out.innerHTML = '<p class="faint">Searching…</p>';
    // Stems for highlighting: first 5 letters of each word, skipping OR and quotes.
    const terms = q.toLowerCase().replace(/"/g, " ").split(/\s+/).filter((w) => w && w !== "or" && w.length > 2).map((w) => w.slice(0, 5));
    try {
      const r = await fetch(`${SB}/rest/v1/pages?plan_id=eq.${encodeURIComponent(plan)}&body=wfts(english).${encodeURIComponent(q)}&select=file_id,page_no,body&order=file_id,page_no&limit=30`,
        { headers: { apikey: KEY, Accept: "application/json" } });
      if (!r.ok) throw new Error(String(r.status));
      const rows = await r.json();
      track("search_plan", { search_term: q, search_via: via, results: rows.length });
      if (!rows.length) { out.innerHTML = `<p class="faint">No pages in this plan match “${esc(q)}”. Try fewer or different words.</p>`; return; }
      out.innerHTML = `<p class="faint">${rows.length}${rows.length === 30 ? "+" : ""} matching page${rows.length === 1 ? "" : "s"}</p><ol class="hits">` +
        rows.map((x) => `<li><span class="cite">${esc(docs[x.file_id] || "Document")} · p. ${x.page_no}</span><p>${excerpt(x.body, terms)}</p></li>`).join("") + "</ol>";
    } catch (e) {
      track("search_error", { search_term: q, description: String(e.message || e).slice(0, 150) });
      out.innerHTML = '<p class="faint">The search didn\'t run. Try again in a moment.</p>';
    }
  }
  form.addEventListener("submit", (e) => { e.preventDefault(); run(input.value, "typed"); });
  form.querySelectorAll("[data-q]").forEach((b) => b.addEventListener("click", () => { input.value = b.dataset.q; run(b.dataset.q, "chip"); }));
})();
