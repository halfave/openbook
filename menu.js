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
