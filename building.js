// Building pages: show one section at a time as tabs, and search inside this plan.
// Without JS every section shows in order and the tab bar works as in-page links.
(() => {
  const main = document.querySelector("main.bldg");
  if (!main) return;

  // ---------- tabs ----------
  const tabs = [...main.querySelectorAll("section.tab")];
  const links = [...main.querySelectorAll("nav.tabs a")];
  main.classList.add("js-tabs");
  function show(id, scroll) {
    if (!tabs.some((t) => t.id === id)) id = tabs[0].id;
    tabs.forEach((t) => { t.hidden = t.id !== id; });
    links.forEach((a) => a.setAttribute("aria-current", a.getAttribute("href") === "#" + id ? "true" : "false"));
    if (scroll) main.querySelector("nav.tabs").scrollIntoView({ block: "nearest" });
  }
  links.forEach((a) => a.addEventListener("click", (e) => {
    e.preventDefault(); const id = a.getAttribute("href").slice(1);
    history.replaceState(null, "", "#" + id); show(id, true);
  }));
  window.addEventListener("hashchange", () => show(location.hash.slice(1), true));
  show(location.hash.slice(1), false);

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
      return (budgets.size > 1 ? `<h3>${esc(b)} budget</h3>` : "") +
        `<div class="tscroll"><table class="budget"><thead><tr><th>Item</th><th class="amt">Amount</th><th>Source</th></tr></thead><tbody>${rows}</tbody></table></div>`;
    }).join("");

    const head = [];
    if (row.budget_period) head.push(`<b>Budget period:</b> ${esc(row.budget_period)}`);
    if (row.total_income != null) head.push(`<b>Total income:</b> ${fmt(row.total_income)}`);
    if (row.total_expenses != null) head.push(`<b>Total expenses:</b> ${fmt(row.total_expenses)}`);
    const caution = row.status === "partial"
      ? `<p class="bcaution"><b>Partly extracted.</b> ${esc(row.status_note || "Some of this budget could not be read. Check the plan pages cited.")}</p>` : "";
    const noteList = notes.length ? `<h3>Notes to the budget</h3><ol class="bnotes">${notes.map((n, i) =>
      `<li id="bn-${i}"><span class="n">${esc(n.n)}</span><b>${esc(n.title || "")}</b>${n.title ? ". " : ""}${esc(n.summary || "")}${n.page ? ` <span class="pg">${cite(n.page)}</span>` : ""}</li>`).join("")}</ol>` : "";

    box.innerHTML = `<p class="src">Schedule B of the offering plan: the sponsor's projected first-year budget. Extracted from the offering plan.</p>` +
      (head.length ? `<p class="bperiod">${head.join(" · ")}</p>` : "") + caution + tables + noteList;

    // Footnote links stay inside this tab (the tab code treats any hash change as a tab switch).
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
