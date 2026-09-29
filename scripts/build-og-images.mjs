// Renders the 1200×630 social-sharing cards (og:image) for pages that aren't building pages:
//   img/og/site.png                       the site card, used by every page without its own image
//   img/og/<dir>/<slug>.png               a firm's logo card, for profiles listed in data/logos.json
//   img/logos/<dir>/<slug>.png            the same logo, trimmed, shown on the profile page
//
//   PLAYWRIGHT=<folder with node_modules/playwright> node scripts/build-og-images.mjs
//
// Logos come only from data/logos.json ({kind: {slug: {file, source, bg}}}): taken from the firm's own
// website (the one in data/websites.json) and checked by eye. bg "dark" is for white or partly white logos.
// Needs Playwright with Chromium; it isn't a site dependency, so point PLAYWRIGHT at any install.
import { createRequire } from "node:module";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { ROOT, SITE_NAME } from "./site.mjs";

const PW = process.env.PLAYWRIGHT || join(ROOT, "..", "openbook-search-loop", ".loop", "tools");
const { chromium } = createRequire(join(PW, "package.json"))("playwright");
const LOGOS = JSON.parse(await readFile(join(ROOT, "data", "logos.json"), "utf8"));
const DIR = { managers: "managing-agents", attorneys: "offering-plan-attorneys", architects: "architects", sellers: "selling-agents" };
const ROLE = { managers: "Property manager", attorneys: "Sponsor's counsel", architects: "Architect", sellers: "Selling agent" };
const MIME = { svg: "image/svg+xml", png: "image/png", webp: "image/webp", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", avif: "image/avif" };

// The site mark, as in the favicon (see HEAD in site.mjs).
const MARK = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><rect width="40" height="40" rx="9" fill="#65153B"/><g fill="#FAF8F2"><rect x="13.4" y="4.5" width="1.2" height="4.5"/><rect x="9" y="9" width="10" height="22"/><path d="M21 31V15h5v-3h5v19z"/></g><g fill="#65153B"><rect x="11" y="12" width="2.4" height="2.4"/><rect x="14.6" y="12" width="2.4" height="2.4"/><rect x="11" y="16.2" width="2.4" height="2.4"/><rect x="14.6" y="16.2" width="2.4" height="2.4"/><rect x="11" y="20.4" width="2.4" height="2.4"/><rect x="14.6" y="20.4" width="2.4" height="2.4"/><rect x="27.3" y="15" width="2.2" height="2.4"/><rect x="23" y="18.6" width="2.2" height="2.4"/><rect x="27.3" y="18.6" width="2.2" height="2.4"/><rect x="23" y="22.4" width="2.2" height="2.4"/><rect x="27.3" y="22.4" width="2.2" height="2.4"/><path d="M3 27.2C10 25 16 25.4 20 28.4 24 25.4 30 25 37 27.2V29C30 27 24 27.4 20 30.4 16 27.4 10 27 3 29z"/></g><path fill="#FAF8F2" d="M4 29.2C10 27.2 16 27.6 20 30.6 24 27.6 30 27.2 36 29.2V33.2C30 31.2 24 31.6 20 34.6 16 31.6 10 31.2 4 33.2z"/></svg>`;
const FONTS = `<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@500&family=IBM+Plex+Sans:wght@400;500&family=Libre+Caslon+Text:wght@400;700&display=swap">`;
const BASE = `*{margin:0;box-sizing:border-box}html,body{width:1200px;height:630px;overflow:hidden}`;

const siteCard = () => `${FONTS}<style>${BASE}
body{background:#65153B;color:#FAF8F2;display:flex;flex-direction:column;justify-content:center;padding:0 96px;font-family:"IBM Plex Sans",sans-serif}
.mark{width:132px;height:132px;margin-bottom:40px}.mark svg{width:100%;height:100%}
h1{font:700 72px/1.05 "Libre Caslon Text",serif;letter-spacing:.01em}
p{font-size:34px;margin-top:22px;opacity:.9}
.url{position:absolute;left:96px;bottom:56px;font:500 22px "IBM Plex Mono",monospace;letter-spacing:.08em;opacity:.75}
</style><div class="mark">${MARK}</div><h1>The Condo Book Project</h1><p>Search NYC condo offering plans, cited to the page.</p><div class="url">CONDOBOOKNYC.COM</div>`;

const logoCard = (src, dark, role) => `${FONTS}<style>${BASE}
body{background:${dark ? "#1E1E20" : "#FFFFFF"};font-family:"IBM Plex Sans",sans-serif;position:relative}
.logo{position:absolute;left:120px;right:120px;top:70px;height:360px;display:flex;align-items:center;justify-content:center}
.logo img{max-width:100%;max-height:100%;object-fit:contain}
.foot{position:absolute;left:80px;right:80px;bottom:0;height:128px;border-top:2px solid ${dark ? "#3A3A3E" : "#E4E0D6"};display:flex;align-items:center;gap:22px}
.foot svg{width:56px;height:56px;flex:none}
.name{font:500 24px "IBM Plex Mono",monospace;letter-spacing:.08em;color:${dark ? "#FAF8F2" : "#65153B"}}
.role{margin-left:auto;font-size:24px;color:${dark ? "#B9B6AE" : "#6B6860"}}
</style><div class="logo"><img src="${src}"></div><div class="foot">${MARK}<span class="name">${SITE_NAME.toUpperCase()}</span><span class="role">${role} · NYC condo offering plans</span></div>`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 630 } });
// Trim a logo's empty margins (transparent, or white on a white card) so it fills its box.
async function trimmed(dataUrl, dark) {
  return page.evaluate(async ({ dataUrl, dark }) => {
    const img = new Image(); img.src = dataUrl; await img.decode();
    let w = img.naturalWidth || 1600, h = img.naturalHeight || 400;
    const k = Math.max(1, 1600 / Math.max(w, h)); w = Math.round(w * k); h = Math.round(h * k); // vector logos draw large
    const c = Object.assign(document.createElement("canvas"), { width: w, height: h }), g = c.getContext("2d");
    g.drawImage(img, 0, 0, w, h);
    const d = g.getImageData(0, 0, w, h).data;
    let x0 = w, y0 = h, x1 = -1, y1 = -1;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4, a = d[i + 3];
      const blank = a < 16 || (!dark && d[i] > 245 && d[i + 1] > 245 && d[i + 2] > 245);
      if (!blank) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    }
    if (x1 < 0) return dataUrl;
    const t = Object.assign(document.createElement("canvas"), { width: x1 - x0 + 1, height: y1 - y0 + 1 });
    t.getContext("2d").drawImage(c, x0, y0, t.width, t.height, 0, 0, t.width, t.height);
    return t.toDataURL("image/png");
  }, { dataUrl, dark });
}
async function shoot(html, out) {
  await page.setContent(html, { waitUntil: "networkidle" });
  await page.evaluate(() => document.fonts.ready);
  await mkdir(join(out, ".."), { recursive: true });
  await page.screenshot({ path: out, clip: { x: 0, y: 0, width: 1200, height: 630 } });
}

await shoot(siteCard(), join(ROOT, "img", "og", "site.png"));
let n = 0;
for (const [kind, m] of Object.entries(LOGOS)) for (const [slug, x] of Object.entries(m)) {
  const ext = x.file.split(".").pop().toLowerCase();
  const raw = `data:${MIME[ext]};base64,${(await readFile(join(ROOT, "data", "logos", x.file))).toString("base64")}`;
  const logo = await trimmed(raw, x.bg === "dark");
  await shoot(logoCard(logo, x.bg === "dark", ROLE[kind]), join(ROOT, "img", "og", DIR[kind], `${slug}.png`));
  // The same trimmed logo, at most 640×200, for the profile page itself.
  const small = await page.evaluate(async (src) => {
    const img = new Image(); img.src = src; await img.decode();
    const k = Math.min(1, 640 / img.naturalWidth, 200 / img.naturalHeight);
    const c = Object.assign(document.createElement("canvas"), { width: Math.round(img.naturalWidth * k), height: Math.round(img.naturalHeight * k) });
    c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL("image/png");
  }, logo);
  await mkdir(join(ROOT, "img", "logos", DIR[kind]), { recursive: true });
  await writeFile(join(ROOT, "img", "logos", DIR[kind], `${slug}.png`), Buffer.from(small.split(",")[1], "base64"));
  n++;
}
await browser.close();
console.log(`img/og/site.png and ${n} logo cards`);
