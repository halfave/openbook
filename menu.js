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

// Slim header: once the masthead scrolls away, a thin bar with the wordmark and main links stays on top.
// On the buildings directory it also carries the borough jump links.
(() => {
  const mast = document.querySelector("header.mast");
  const home = document.querySelector(".wordmark");
  if (!mast || !home || !("IntersectionObserver" in window)) return;
  const P = (home.getAttribute("href") || "index.html").replace(/index\.html$/, "");
  const bar = document.createElement("div");
  bar.className = "slimbar";
  bar.setAttribute("aria-hidden", "true");
  const toc = document.querySelector("main .toc");
  const links = [["index.html", "Search"], ["buildings/index.html", "Buildings"], ["blog/index.html", "Guides"], ["about.html", "About"], ["faq.html", "FAQ"]]
    .map(([h, t]) => `<a href="${P}${h}" tabindex="-1">${t}</a>`).join("");
  bar.innerHTML = `<div class="slim-in"><a class="slim-mark" href="${P}index.html" tabindex="-1">The Condo Book Project</a>` +
    `<nav class="slim-nav">${links}</nav></div>` +
    (toc ? `<nav class="slim-toc">${[...toc.querySelectorAll("a")].map((a) => `<a href="${a.getAttribute("href")}" tabindex="-1">${a.textContent}</a>`).join("")}</nav>` : "");
  document.body.appendChild(bar);
  new IntersectionObserver(([e]) => {
    const on = !e.isIntersecting;
    bar.classList.toggle("on", on);
    bar.setAttribute("aria-hidden", String(!on));
    bar.querySelectorAll("a").forEach((a) => (on ? a.removeAttribute("tabindex") : a.setAttribute("tabindex", "-1")));
    document.body.classList.toggle("slim-on", on);
    document.documentElement.style.setProperty("--slim-h", on ? bar.offsetHeight + "px" : "0px");
  }).observe(mast);
})();
