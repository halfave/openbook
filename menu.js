// Hamburger menu: mark the current page, close on outside click or Escape.
(() => {
  const menu = document.getElementById("menu");
  if (!menu) return;
  const here = location.pathname.split("/").pop() || "index.html";
  menu.querySelectorAll("nav a").forEach((a) => {
    if (a.getAttribute("href") === here) a.setAttribute("aria-current", "page");
  });
  document.addEventListener("click", (e) => { if (menu.open && !menu.contains(e.target)) menu.open = false; });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && menu.open) { menu.open = false; menu.querySelector("summary").focus(); }
  });
})();

// Pinned header: the masthead stays at the top and gets shorter once the page scrolls.
// --head-h holds its current height, for anything pinned under it and for anchor offsets.
(() => {
  const mast = document.querySelector("header.mast");
  if (!mast) return;
  const root = document.documentElement;
  let on = null;
  const update = () => {
    const now = window.scrollY > 24;
    if (now !== on) { on = now; root.classList.toggle("scrolled", now); }
    root.style.setProperty("--head-h", mast.offsetHeight + "px");
  };
  window.addEventListener("scroll", update, { passive: true });
  window.addEventListener("resize", update);
  mast.addEventListener("transitionend", update);
  update();
})();
