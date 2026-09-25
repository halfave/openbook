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

  // ---------- search inside this plan ----------
  const form = document.getElementById("psearch");
  if (!form) return;
  const SB = "https://dvywgltjqpntldlztapu.supabase.co";
  const KEY = "sb_publishable_At7fyv-9Vp7ByNP3AXHZ7g_qphsg6Rw";
  const plan = form.dataset.plan;
  const docs = JSON.parse(document.getElementById("pdocs").textContent || "{}");
  const out = document.getElementById("presults"), input = document.getElementById("pq");
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

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
