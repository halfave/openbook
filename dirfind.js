// Buildings directory: filter the list by building name, address or plan (CD) number, as you type.
// The AG plan name is usually the building's marketing name, e.g. "Armorie (The)"; word order doesn't matter.
(() => {
  const box = document.getElementById("bfind"), note = document.getElementById("bfind-note");
  if (!box) return;

  const norm = (s) => String(s || "").toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").trim();
  // Abbreviations in the records are spelled out, so "east 18th" finds "10 E. 18th Street";
  // query words match the start of a word, so "e 18 st" finds it too.
  const LONG = { e: "east", w: "west", n: "north", s: "south", st: "street", str: "street", ave: "avenue", av: "avenue", blvd: "boulevard",
    pl: "place", rd: "road", pkwy: "parkway", dr: "drive", ln: "lane", sq: "square", ter: "terrace", ct: "court", hwy: "highway" };
  const words = (s) => norm(s).split(" ").map((w) => LONG[w] || w).join(" ");

  const sections = [...document.querySelectorAll("main h2[id]")].map((h) => {
    const ul = h.nextElementSibling, count = h.querySelector(".count");
    const rows = [...ul.querySelectorAll("li")].map((li) => {
      const a = li.querySelector("a"), span = li.querySelector("span");
      const id = ((a.getAttribute("href") || "").match(/-(cd\d+)\.html$/i) || [])[1] || "";
      const addr = span ? span.textContent.split(" · ")[0] : "";
      return { li, hay: " " + words(`${a.textContent} ${addr} ${id} ${id.slice(2)}`) + " " };
    });
    return { h, ul, count, total: count ? count.textContent : "", rows };
  });

  const run = () => {
    // "CD 24-0249" and "cd240249" are the same plan.
    const q = box.value.replace(/\bcd[\s-]*(\d{2})[\s-]*(\d{4})\b/gi, "cd$1$2");
    // "The" is dropped: plan names file it last ("Armorie (The)") and the list shows it without.
    const toks = norm(q).split(" ").filter((t) => t && t !== "the");
    let n = 0;
    for (const s of sections) {
      let m = 0;
      for (const r of s.rows) {
        const hit = toks.every((t) => r.hay.includes(" " + t));
        r.li.hidden = !hit;
        if (hit) m++;
      }
      n += m;
      s.h.hidden = s.ul.hidden = !m;
      if (s.count) s.count.textContent = toks.length ? m : s.total;
    }
    note.hidden = !toks.length;
    note.textContent = n ? `${n.toLocaleString("en-US")} ${n === 1 ? "building matches" : "buildings match"}.` : "No building matches. Try part of the name or address, or the CD number.";
    try {
      const u = new URL(location.href);
      toks.length ? u.searchParams.set("q", box.value.trim()) : u.searchParams.delete("q");
      history.replaceState(null, "", u);
    } catch {}
  };

  box.addEventListener("input", run);
  const q0 = new URLSearchParams(location.search).get("q");
  if (q0) { box.value = q0; run(); }
})();
