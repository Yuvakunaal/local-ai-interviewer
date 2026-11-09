// Whole-site quality sweep in real Chrome (light, dark and phone width): every page, tab and dialog is checked for the mistakes
// that make an app feel unfinished - unnamed buttons/fields, dead links, duplicate ids, missing headings, console errors, overflow.
import { BASE, check, clickText, launch, overflow, reportIssues, sleep, startBackend, textOf, waitText } from "./lib.mjs";
import { seedHistory } from "./seed.mjs";
import { SWEEP } from "./sweep-lib.mjs";

const be = await startBackend();
seedHistory(be.dataDir);
const { browser, page, issues } = await launch({ width: 1280, height: 900 });

const sets = await (await fetch(`${BASE}/api/sets`)).json();
for (let i = 1; i <= 3; i++) await fetch(`${BASE}/api/sets/${sets[0].id}/questions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: `Sweep question ${i}: how does ${["partitioning", "indexing", "caching"][i - 1]} work?`, topic: ["SQL", "Spark", null][i - 1], difficulty: ["easy", "medium", "hard"][i - 1] }) });
const latest = (await (await fetch(`${BASE}/api/interviews`)).json())[0].id;

// the sweep must be able to FAIL: inject known mistakes and make sure every kind is reported
await page.goto(BASE, { waitUntil: "networkidle0" });
const caught = await page.evaluate((fnSrc) => {
  const bad = document.createElement("div");
  bad.innerHTML = '<button class="x-bad"></button><input class="x-in"><a href="#/nowhere">Dead</a><a href="#/home"><span style="display:inline-block;width:12px;height:12px;background:red"></span></a><img src="/x.png"><svg role="img" width="4" height="4"></svg><span id="dup"></span><span id="dup"></span><div tabindex="3">t</div>';
  document.body.appendChild(bad);
  const found = new Function("return (" + fnSrc + ")()")();
  bad.remove();
  return found;
}, SWEEP.toString());
const expect = ["no accessible name: <button.x-bad>", "unlabelled field", "dead link: #/nowhere", "no accessible name: <a>", "image without alt", "svg role=img without a name", 'duplicate id "dup"', "positive tabindex"];
check(expect.every((e) => caught.some((c) => c.startsWith(e))), `self-test: the sweep detects every kind of injected mistake (${expect.filter((e) => !caught.some((c) => c.startsWith(e))).join(", ") || "all 8 caught"})`);

const problems = new Map();
const note = (ctx, list) => list.forEach((p) => problems.set(`${ctx}: ${p}`, true));
const sweep = async (ctx) => { await sleep(350); note(ctx, await page.evaluate(SWEEP)); const ov = await overflow(page); if (ov.doc > 1) note(ctx, [`horizontal overflow ${ov.doc}px`]); };

const PAGES = [["Home", "#/home"], ["Questions", "#/questions"], ["Resumes", "#/resumes"], ["Interview setup", "#/setup"], ["History", "#/history"], ["Reports", "#/reports"], ["Report", `#/report/${latest}`], ["Model usage", "#/usage"], ["Settings", "#/settings"]];
let swept = 0;
try {
  for (const [mode, viewport, theme] of [["desktop light", { width: 1280, height: 900 }, "light"], ["desktop dark", { width: 1280, height: 900 }, "dark"], ["phone", { width: 390, height: 844, isMobile: true }, "light"], ["tablet", { width: 820, height: 1100 }, "light"]]) {
    await page.setViewport(viewport);
    await page.goto(BASE, { waitUntil: "networkidle0" });
    await page.evaluate((t) => localStorage.setItem("lai.theme", t), theme);
    await page.reload({ waitUntil: "networkidle0" });
    for (const [name, hash] of PAGES) {
      await page.goto(`${BASE}/${hash}`, { waitUntil: "networkidle0" });
      await page.waitForSelector("main h1", { timeout: 8000 }).catch(() => {});
      await sweep(`[${mode}] ${name}`); swept++;
    }
    if (mode === "desktop light") {
      // tabs and dialogs: the places where unlabelled fields hide
      await page.goto(`${BASE}/#/settings`, { waitUntil: "networkidle0" });
      for (const tab of ["Profile", "Evaluation rubric", "AI models", "Local services"]) { await clickText(page, ".tabbar button", tab); await sweep(`[${mode}] Settings > ${tab}`); swept++; }
      await page.goto(`${BASE}/#/questions`, { waitUntil: "networkidle0" });
      await page.waitForSelector(".qrow");
      await clickText(page, "button", "Add Question"); await page.waitForSelector('[role=dialog]'); await sweep(`[${mode}] Add Question dialog`); swept++; await page.keyboard.press("Escape");
      await clickText(page, "button", "Import Questions"); await page.waitForSelector('[role=dialog]'); await sweep(`[${mode}] Import dialog`); swept++; await page.keyboard.press("Escape");
      await page.click('.qrow .btn.icon[aria-label="Edit question"]'); await page.waitForSelector('[role=dialog]'); await sweep(`[${mode}] Edit Question dialog`); swept++; await page.keyboard.press("Escape");
      await page.keyboard.down("Control"); await page.keyboard.press("k"); await page.keyboard.up("Control"); await page.waitForSelector(".palette"); await sweep(`[${mode}] Command palette`); swept++; await page.keyboard.press("Escape");
      await page.keyboard.press("?"); await page.waitForSelector('[aria-label="Keyboard shortcuts"]'); await sweep(`[${mode}] Shortcuts sheet`); swept++; await page.keyboard.press("Escape");
      await page.goto(`${BASE}/#/history`, { waitUntil: "networkidle0" }); await page.waitForSelector(".listrow");
      await clickText(page, "button", "Clear history"); await page.waitForSelector('[role=dialog]'); await sweep(`[${mode}] Confirm dialog`); swept++; await page.keyboard.press("Escape");
      // every sidebar link goes where it says, highlights itself and shows a heading
      const nav = await page.$$eval(".sidebar nav a.sb-item", (as) => as.map((a) => [a.textContent.trim().replace(/\d+$/, ""), a.getAttribute("href")]));
      for (const [label, href] of nav) {
        await page.click(`.sidebar nav a[href="${href}"]`); await page.waitForFunction((h) => location.hash === h, {}, href); await sleep(250);
        const active = await page.$eval(".sidebar nav a.sb-item.active", (a) => a.getAttribute("href")).catch(() => null);
        const h1 = await textOf(page, "main h1").catch(() => "");
        if (active !== href && !(href === "#/setup" && active === "#/setup")) note("sidebar", [`${label}: link not highlighted when open`]);
        if (!h1.trim()) note("sidebar", [`${label}: page has no heading`]);
      }
      check(nav.length === 7 && nav.map((n) => n[0]).join("|") === "Home|Questions|Resumes|Interview|History|Reports|Model usage", `sidebar lists the 7 pages in order, with no separate Settings item (${nav.map((n) => n[0]).join(", ")})`);
      await page.goto(`${BASE}/#/home`, { waitUntil: "networkidle0" }); await sleep(400);
      const foot = await textOf(page, ".sb-foot");
      check(!/Offline-ready/.test(foot) && (await page.$(".sb-user .sb-gear")) !== null, "the profile row shows the name and a settings icon, without the 'Offline-ready' line");
      await page.click(".sb-user"); await page.waitForSelector("main h1"); await sleep(300);
      check((await page.evaluate(() => location.hash)) === "#/settings" && (await page.$eval(".sb-user", (e) => e.classList.contains("active") && e.getAttribute("aria-current") === "page")), "pressing the profile row opens Settings and is highlighted while there");
    }
  }
  const list = [...problems.keys()];
  check(list.length === 0, `no accessibility / structure problems across ${swept} page states${list.length ? "\n        - " + list.slice(0, 25).join("\n        - ") : ""}`);
  reportIssues(issues);
} catch (e) { console.log("FAIL  exception: " + (e.stack || e)); process.exitCode = 1; }
finally { await browser.close(); be.proc.kill(); }
console.log(process.exitCode ? "\nSOME CHECKS FAILED" : "\nALL CHECKS PASSED");
