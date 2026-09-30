// Hamburger menu: mark the current page, close on outside click or Escape.
(() => {
  const menu = document.getElementById("menu");
  if (!menu) return;
  const norm = (p) => p.replace(/\/index\.html$/, "/").replace(/\.html$/, "");
  const here = norm(location.pathname);
  document.querySelectorAll("#menu nav a, .mastnav a").forEach((a) => {
    if (a.protocol === location.protocol && !a.search && norm(a.pathname) === here) a.setAttribute("aria-current", "page");
  });
  document.addEventListener("click", (e) => { if (menu.open && !menu.contains(e.target)) menu.open = false; });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && menu.open) { menu.open = false; menu.querySelector("summary").focus(); }
  });
})();

// Data dropdown in the masthead: underline it on its own pages, close on outside click or Escape.
(() => {
  const data = document.querySelector(".datamenu");
  if (!data) return;
  if (data.querySelector('a[aria-current="page"]')) data.classList.add("current");
  document.addEventListener("click", (e) => { if (data.open && !data.contains(e.target)) data.open = false; });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && data.open) { data.open = false; data.querySelector("summary").focus(); }
  });
})();

// Every link opens in a new tab, including ones the page draws later. Jumps within the page, email and phone links stay put.
document.addEventListener("click", (e) => {
  const a = e.target.closest?.("a[href]");
  if (!a || a.target || !/^https?:$/.test(a.protocol)) return;
  if (a.hash && a.origin === location.origin && a.pathname === location.pathname && a.search === location.search) return;
  a.target = "_blank"; a.rel = (a.rel + " noopener").trim();
}, true);

// Pinned header: the masthead stays at the top at one height.
// --head-h holds that height, for anything pinned under it and for anchor offsets.
(() => {
  const mast = document.querySelector("header.mast");
  if (!mast) return;
  const update = () => document.documentElement.style.setProperty("--head-h", mast.offsetHeight + "px");
  new ResizeObserver(update).observe(mast);
  update();
})();
