// Google Analytics 4 for every Open Book page. Loaded in <head> on all pages.
//
// Off until GA_ID is set to the site's measurement ID (Admin > Data streams > Web, "G-…").
// Pages call window.obTrack(name, params) for events only they know about (searches, results);
// everything else (links, tabs, menu, scroll depth, copy, print, page speed) is tracked here.
(() => {
  const GA_ID = "G-Q70SZZCRFV";
  const on = /^G-[A-Z0-9]{6,}$/.test(GA_ID) && GA_ID !== "G-XXXXXXXXXX" && location.protocol !== "file:";

  window.dataLayer = window.dataLayer || [];
  function gtag() { window.dataLayer.push(arguments); }
  window.obTrack = (name, params = {}) => { if (on) gtag("event", name, params); };
  if (!on) return;

  const s = document.createElement("script");
  s.async = true;
  s.src = "https://www.googletagmanager.com/gtag/js?id=" + GA_ID;
  document.head.appendChild(s);
  gtag("js", new Date());

  // What kind of page this is, so reports can be split by page type.
  const path = location.pathname;
  const file = path.split("/").pop() || "index.html";
  const inBuildings = /\/buildings\//.test(path);
  const pageType = inBuildings ? (file === "index.html" || file === "" ? "directory" : "building")
    : file === "index.html" || file === "" ? "search" : file.replace(/\.html$/, "");

  function config() {
    const main = document.querySelector("main.bldg");
    const params = { content_group: pageType, page_type: pageType };
    if (main) {
      params.plan_id = main.dataset.plan;
      params.borough = main.dataset.borough;
      params.plan_searchable = main.dataset.searchable;
    }
    gtag("config", GA_ID, params);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", config, { once: true });
  else config();

  const track = window.obTrack;
  const text = (el) => (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 100);
  const where = (el) => el.closest("header.mast") ? "masthead" : el.closest("#menu") ? "menu" : el.closest("footer") ? "footer"
    : el.closest("nav.crumbs") ? "breadcrumb" : el.closest("nav.tabs") ? "tabs" : el.closest("nav.toc") ? "borough_index"
    : el.closest("ul.near") ? "nearby" : el.closest("ul.dir") ? "directory" : el.closest("#answer") ? "answer"
    : el.closest("#detail") ? "detail" : el.closest("#results, #rview") ? "results" : "body";

  // ---------- links ----------
  document.addEventListener("click", (e) => {
    const a = e.target.closest?.("a[href]");
    if (!a) return;
    const href = a.getAttribute("href");
    const params = { link_text: text(a), link_location: where(a), link_url: a.href };
    if (href.startsWith("mailto:")) {
      track(/error/i.test(href) ? "report_error" : "contact_email", params);
    } else if (/offeringplandatasearch\.ag\.ny\.gov/.test(a.href)) {
      track("view_source", { ...params, source_type: /#tabs-6/.test(a.href) ? "ag_documents" : "ag_record" });
    } else if (/google\.[a-z.]+\/maps/.test(a.href)) {
      track("view_street", params);
    } else if (a.host && a.host !== location.host) {
      track("click_outbound", params);
    } else if (a.closest("nav.tabs")) {
      track("view_tab", { tab: href.replace(/^#/, ""), link_location: "tabs" });
    } else if (/\/buildings\/[^/]+-cd\d+\.html/i.test(a.href) || (inBuildings && /-cd\d+\.html$/i.test(href))) {
      track("select_building", { ...params, item_id: (href.match(/(cd\d+)\.html$/i) || [])[1]?.toUpperCase() });
    } else {
      track("click_internal", params);
    }
  }, true);

  // ---------- menu ----------
  document.addEventListener("toggle", (e) => {
    const d = e.target;
    if (d.id === "menu" && d.open) track("open_menu");
    else if (d.tagName === "DETAILS" && d.open && d.querySelector("summary")) track("open_faq", { question: text(d.querySelector("summary")) });
  }, true);

  // ---------- building page: the tab shown on arrival ----------
  window.addEventListener("load", () => {
    if (pageType === "building" && location.hash) track("view_tab", { tab: location.hash.slice(1), link_location: "arrival" });
  });

  // ---------- scroll depth (25/50/75/100) ----------
  const marks = [25, 50, 75, 100], seen = new Set();
  let ticking = false;
  window.addEventListener("scroll", () => {
    if (ticking) return; ticking = true;
    requestAnimationFrame(() => {
      ticking = false;
      const h = document.documentElement.scrollHeight - innerHeight;
      if (h < 200) return;
      const pct = Math.round((scrollY / h) * 100);
      for (const m of marks) if (pct >= m && !seen.has(m)) { seen.add(m); track("scroll_depth", { percent_scrolled: m }); }
    });
  }, { passive: true });

  // ---------- copy and print ----------
  document.addEventListener("copy", () => {
    const sel = String(getSelection() || "");
    if (sel.trim()) track("copy_text", { characters: sel.length, text_location: where(getSelection().anchorNode?.parentElement || document.body) });
  });
  window.addEventListener("beforeprint", () => track("print_page"));

  // ---------- errors ----------
  window.addEventListener("error", (e) => track("exception", { description: String(e.message || "error").slice(0, 150), fatal: false }));
  window.addEventListener("unhandledrejection", (e) => track("exception", { description: String(e.reason?.message || e.reason || "rejection").slice(0, 150), fatal: false }));

  // ---------- page speed (Core Web Vitals: LCP, CLS, INP), sent once when the page is hidden ----------
  const vitals = {};
  const observe = (type, fn, opts = {}) => { try { new PerformanceObserver((l) => l.getEntries().forEach(fn)).observe({ type, buffered: true, ...opts }); } catch (err) { /* unsupported */ } };
  observe("largest-contentful-paint", (en) => { vitals.LCP = en.startTime; });
  observe("layout-shift", (en) => { if (!en.hadRecentInput) vitals.CLS = (vitals.CLS || 0) + en.value; });
  observe("event", (en) => { if (en.interactionId) vitals.INP = Math.max(vitals.INP || 0, en.duration); }, { durationThreshold: 40 });
  let sent = false;
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "hidden" || sent) return;
    sent = true;
    for (const [name, v] of Object.entries(vitals)) {
      track("web_vitals", { metric_name: name, value: name === "CLS" ? Math.round(v * 1000) : Math.round(v), transport_type: "beacon" });
    }
  });
})();
