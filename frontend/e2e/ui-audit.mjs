// Visual + accessibility audit of every page in BOTH themes, in real Chrome, against an isolated seeded backend:
//   * screenshots of each page (light and dark) for review
//   * computed text/background contrast on every visible text element (WCAG AA 4.5:1, 3:1 for large text)
//   * no horizontal overflow, no console errors, nothing leaves localhost
import { BASE, OUT, check, launch, overflow, reportIssues, shot, sleep, startBackend, waitText } from "./lib.mjs";
import { seedHistory } from "./seed.mjs";

const be = await startBackend();
seedHistory(be.dataDir);
const { browser, page, issues } = await launch({ width: 1280, height: 900 });

// contrast = (L1 + .05) / (L2 + .05) using the effective background (first opaque ancestor background colour)
const AUDIT = () => {
  const parse = (c) => { const m = c.match(/rgba?\(([^)]+)\)/); if (!m) return null; const [r, g, b, a = 1] = m[1].split(/[ ,\/]+/).filter(Boolean).map(Number); return { r, g, b, a }; };
  const lum = ({ r, g, b }) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  const blend = (top, bot) => ({ r: top.r * top.a + bot.r * (1 - top.a), g: top.g * top.a + bot.g * (1 - top.a), b: top.b * top.a + bot.b * (1 - top.a), a: 1 });
  const bgOf = (el) => {
    const stack = [];
    for (let e = el; e; e = e.parentElement) {
      const cs = getComputedStyle(e);
      if (cs.backgroundImage !== "none" && /gradient/.test(cs.backgroundImage) && !/rgba?\(\s*\d+,\s*\d+,\s*\d+,\s*0\)/.test(cs.backgroundImage)) {
        const cols = cs.backgroundImage.match(/rgba?\([^)]+\)/g) || []; if (cols.length) { const p = parse(cols[Math.floor(cols.length / 2)]); if (p && p.a > 0.5) { stack.push(p); break; } }
      }
      const c = parse(cs.backgroundColor); if (c && c.a > 0) { stack.push(c); if (c.a >= 1) break; }
    }
    let base = { r: 255, g: 255, b: 255, a: 1 };
    const body = parse(getComputedStyle(document.body).backgroundColor); if (body && body.a) base = body;
    if (document.documentElement.dataset.theme === "dark" && !stack.some((s) => s.a >= 1)) base = { r: 13, g: 16, b: 32, a: 1 };
    return stack.reverse().reduce((acc, c) => blend(c, acc), base);
  };
  const bad = [];
  for (const el of document.querySelectorAll("body *")) {
    if (!el.childNodes || ![...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === "hidden" || cs.display === "none" || +cs.opacity === 0) continue;
    const r = el.getBoundingClientRect(); if (r.width < 2 || r.height < 2) continue;
    if (el.closest("svg, [aria-hidden=true], .skel, script, style, option")) continue;
    const fg = parse(cs.color); if (!fg) continue;
    const bg = bgOf(el); const f = blend({ ...fg, a: fg.a }, bg);
    const L1 = lum(f), L2 = lum(bg); const ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
    const px = parseFloat(cs.fontSize), bold = parseInt(cs.fontWeight) >= 700; const large = px >= 24 || (px >= 18.66 && bold);
    if (ratio < (large ? 3 : 4.5) && !(el.disabled || el.closest(":disabled, [disabled], [aria-disabled=true]"))) bad.push(`${ratio.toFixed(2)} ${el.tagName.toLowerCase()}.${(el.className && el.className.baseVal === undefined ? el.className : "").toString().split(" ")[0]} "${el.textContent.trim().slice(0, 36)}"`);
  }
  // icons: every visible SVG must reach 3:1 (WCAG non-text contrast) against what is behind it
  for (const el of document.querySelectorAll("body svg")) {
    const cs = getComputedStyle(el);
    if (cs.visibility === "hidden" || cs.display === "none" || +cs.opacity === 0) continue;
    const r = el.getBoundingClientRect(); if (r.width < 6 || r.height < 6) continue;
    if (el.closest(".skel, script, style, option, :disabled, [disabled], [aria-disabled=true], .nodata, .ring, svg.trend, .logo, .sb-logo, .sb-brand") || el.closest("[class*=logo]")) continue;
    const paint = cs.stroke !== "none" && !/^url|none/.test(cs.stroke) ? cs.stroke : cs.fill !== "none" && !/^url/.test(cs.fill) ? cs.fill : cs.color;
    const fg = parse(paint); if (!fg || fg.a === 0) continue;
    const bg = bgOf(el); const f = blend({ ...fg, a: fg.a * (+cs.opacity || 1) }, bg);
    const L1 = lum(f), L2 = lum(bg); const ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
    if (ratio < 3) bad.push(`icon ${ratio.toFixed(2)} in ${el.parentElement ? el.parentElement.tagName.toLowerCase() + "." + String(el.parentElement.className?.baseVal ?? el.parentElement.className).split(" ")[0] : "?"}`);
  }
  return [...new Set(bad)];
};

const sets = await (await fetch(`${BASE}/api/sets`)).json();
for (const t of ["SQL", "Spark", "Kafka"]) for (let i = 0; i < 2; i++)
  await fetch(`${BASE}/api/sets/${sets[0].id}/questions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: `Explain ${t} concept number ${i + 1} and when you would use it in a production pipeline?`, topic: t, difficulty: ["easy", "medium", "hard"][i % 3] }) });
const reports = await (await fetch(`${BASE}/api/interviews`)).json();
const latest = reports[0].id;

const PAGES = [["home", "#/home"], ["questions", "#/questions"], ["setup", "#/setup"], ["history", "#/history"], ["reports", "#/reports"], ["report", `#/report/${latest}`], ["usage", "#/usage"], ["settings", "#/settings"]];
let total = 0;
const unique = new Map();   // finding -> pages where it occurs
try {
  for (const theme of ["light", "dark"]) {
    await page.goto(BASE, { waitUntil: "networkidle0" });
    await page.evaluate((t) => { localStorage.setItem("lai.theme", t); }, theme);
    await page.reload({ waitUntil: "networkidle0" });
    check((await page.$eval("html", (e) => e.dataset.theme)) === theme, `[${theme}] theme applied before first paint`);
    for (const [name, hash] of PAGES) {
      await page.goto(`${BASE}/${hash}`, { waitUntil: "networkidle0" });
      await sleep(550);
      const ov = await overflow(page);
      const low = await page.evaluate(AUDIT);
      total += low.length;
      low.forEach((f) => unique.set(`[${theme}] ${f}`, [...(unique.get(`[${theme}] ${f}`) ?? []), name]));
      check(ov.doc <= 1, `[${theme}] ${name}: no horizontal overflow`);
      check(low.length === 0, `[${theme}] ${name}: text contrast AA${low.length ? " — " + low.slice(0, 6).join(" | ") : ""}`);
      await shot(page, `audit-${theme}-${name}`);
    }
  }
  reportIssues(issues);
} catch (e) { console.log("FAIL  exception: " + (e.stack || e)); process.exitCode = 1; }
finally { await browser.close(); be.proc.kill(); }
if (unique.size) { console.log("\nDistinct low-contrast findings:"); for (const [f, pages] of unique) console.log(`  ${f}   (${[...new Set(pages)].join(", ")})`); }
console.log(`\n${process.exitCode ? "SOME CHECKS FAILED" : "ALL CHECKS PASSED"}  (${total} low-contrast findings)  screenshots in ${OUT}`);
