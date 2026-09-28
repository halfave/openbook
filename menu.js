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

// Pinned header: the masthead stays at the top at one height.
// --head-h holds that height, for anything pinned under it and for anchor offsets.
(() => {
  const mast = document.querySelector("header.mast");
  if (!mast) return;
  const update = () => document.documentElement.style.setProperty("--head-h", mast.offsetHeight + "px");
  new ResizeObserver(update).observe(mast);
  update();
})();
