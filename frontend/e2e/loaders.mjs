// Waiting is never silent: skeletons for pages and data, a quiet bar at the top for slow requests, busy buttons, a recovery notice when a page
// file is missing. Also checks the app does not repeat the same request when you move between pages (credit and CPU friendly).
import { BASE, check, clickText, launch, reportIssues, sleep, startBackend, textOf } from "./lib.mjs";
import { seedHistory } from "./seed.mjs";

const be = await startBackend({ OLLAMA_API_KEY: "" });
seedHistory(be.dataDir);
const { browser, page, issues } = await launch({ width: 1280, height: 900 });
const delays = []; const blocked = []; const seen = [];
await page.setRequestInterception(true);
page.on("request", (req) => {
  const url = req.url();
  if (url.includes("/api/")) seen.push(url.replace(BASE, ""));
  if (blocked.some((b) => url.includes(b))) return void req.abort();
  const d = delays.find((x) => url.includes(x.match));
  if (d) setTimeout(() => req.continue().catch(() => {}), d.ms); else req.continue().catch(() => {});
});
const count = (path) => seen.filter((u) => u.split("?")[0] === path).length;
try {
  // ---------------------------------------------------------------- a slow request: skeleton on the page, bar on top, both gone afterwards
  await page.goto(BASE, { waitUntil: "networkidle0" });
  delays.push({ match: "/api/usage", ms: 1800 });
  await page.evaluate(() => (location.hash = "#/usage"));
  await page.waitForFunction(() => /Loading model usage/.test(document.body.textContent), { timeout: 4000 });
  check(true, "Model usage shows a skeleton while its data loads (instead of an empty page)");
  await page.waitForSelector(".netbar.on", { timeout: 3000 });
  check(true, "the progress bar appears at the top once a request is slow");
  await page.waitForSelector(".usage-tbl", { timeout: 8000 });
  await page.waitForFunction(() => !document.querySelector(".netbar.on"), { timeout: 3000 });
  check(!(await page.evaluate(() => /Loading model usage/.test(document.body.textContent))), "…and both disappear when the data arrives");

  // ---------------------------------------------------------------- fast requests never flash the bar
  delays.length = 0;
  let flashed = false;
  await page.exposeFunction("flash", () => { flashed = true; });
  await page.evaluate(() => { new MutationObserver(() => { if (document.querySelector(".netbar.on")) window.flash(); }).observe(document.body, { subtree: true, attributes: true, attributeFilter: ["class"] }); });
  for (const h of ["#/history", "#/reports", "#/home", "#/questions"]) { await page.evaluate((x) => (location.hash = x), h); await sleep(500); }
  check(!flashed, "quick page changes never flash the progress bar");

  // ---------------------------------------------------------------- the Refresh button shows it is working
  await page.evaluate(() => (location.hash = "#/usage")); await page.waitForSelector(".usage-tbl");
  delays.push({ match: "/api/usage", ms: 1500 });
  await page.evaluate(() => [...document.querySelectorAll("button")].find((b) => /^Refresh$/.test(b.textContent.trim())).click());
  await page.waitForFunction(() => { const b = [...document.querySelectorAll("button")].find((x) => /Refreshing/.test(x.textContent)); return b && b.disabled && b.querySelector(".spinner"); }, { timeout: 3000 });
  check(true, "Refresh turns into a disabled “Refreshing…” button with a spinner while it works");
  await page.waitForFunction(() => [...document.querySelectorAll("button")].some((b) => /^Refresh$/.test(b.textContent.trim()) && !b.disabled), { timeout: 8000 });
  check(true, "…and returns to normal afterwards");
  delays.length = 0;

  // ---------------------------------------------------------------- a page file that arrives late: page skeleton, not a blank screen
  delays.push({ match: "/assets/Settings-", ms: 1500 });
  await page.goto(`${BASE}/#/settings`, { waitUntil: "domcontentloaded" }); await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.querySelector(".page-skel"), { timeout: 4000 });
  check(true, "while a page's code is still arriving the page shows a skeleton");
  await page.waitForSelector(".tabbar", { timeout: 10000 });
  delays.length = 0;

  // ---------------------------------------------------------------- an interview that opens slowly
  const sid = (await (await fetch(`${BASE}/api/sets`)).json())[0].id;
  await fetch(`${BASE}/api/sets/${sid}/questions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: "Explain idempotency?" }) });
  const iv = (await (await fetch(`${BASE}/api/interviews`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ set_id: sid, config: { title: "Slow open", max_followups: 0 } }) })).json()).id;
  delays.push({ match: `/api/interviews/${iv}`, ms: 1500 });
  await page.evaluate((i) => (location.hash = `#/interview/${i}`), iv);
  await page.waitForFunction(() => /Opening your interview/.test(document.body.textContent), { timeout: 4000 });
  check(true, "an interview that opens slowly says “Opening your interview…” with a spinner");
  await page.waitForSelector("#answer", { timeout: 10000 });
  delays.length = 0;
  await fetch(`${BASE}/api/interviews/${iv}/end`, { method: "POST" });

  // ---------------------------------------------------------------- a page file that cannot be loaded at all: a way out
  blocked.push("/assets/Reports-"); await page.setCacheEnabled(false);
  await page.goto(`${BASE}/#/home`, { waitUntil: "domcontentloaded" }); await page.reload({ waitUntil: "domcontentloaded" });   // a fresh page, so the file really is requested
  await page.waitForSelector(".sidebar");
  await page.evaluate(() => (location.hash = "#/reports"));
  await page.waitForFunction(() => /could not be loaded/.test(document.body.textContent), { timeout: 5000 }).catch(async (e) => { console.log("DEBUG", page.url(), (await textOf(page, ".page")).replace(/\s+/g, " ").slice(0, 200)); throw e; });
  check((await textOf(page, ".page")).includes("Reload"), "if a page's code is missing (app updated), the page says so and offers Reload");
  blocked.length = 0; await page.setCacheEnabled(true);

  // ---------------------------------------------------------------- no repeated requests while moving around
  await page.goto(BASE, { waitUntil: "networkidle0" }); await sleep(600);
  seen.length = 0;
  for (const h of ["#/questions", "#/setup", "#/history", "#/reports", "#/home", "#/questions", "#/history"]) { await page.evaluate((x) => (location.hash = x), h); await sleep(350); }
  check(count("/api/health") <= 1 && count("/api/sets") <= 1 && count("/api/interviews") <= 1, `seven page changes in a few seconds re-ask for health ${count("/api/health")}×, sets ${count("/api/sets")}×, interviews ${count("/api/interviews")}× (was once per page)`);

  // ---------------------------------------------------------------- but never stale: a change you make shows up straight away
  await page.evaluate(() => (location.hash = "#/questions")); await page.waitForSelector(".qrow, .card"); await sleep(400);
  const before = await textOf(page, '.sidebar a[href="#/questions"]');
  await clickText(page, "button", "Add Question");
  await page.waitForSelector("textarea"); await page.type("textarea", "A brand new question about caching?");
  await clickText(page, "[role=dialog] button", "Save");
  await sleep(1200);
  const after = await textOf(page, '.sidebar a[href="#/questions"]');
  check(before !== after && /\d/.test(after), `adding a question updates the sidebar count at once (${before.replace(/\s+/g, " ")} → ${after.replace(/\s+/g, " ")})`);
  reportIssues(issues, ["net::ERR_FAILED", "Failed to load resource", "api/speech/synthesize net::ERR_ABORTED", "/assets/Reports-"]);
} catch (e) { console.log("FAIL  exception: " + (e.stack || e)); process.exitCode = 1; }
finally { await browser.close(); be.proc.kill(); }
console.log(process.exitCode ? "\nSOME CHECKS FAILED" : "\nALL CHECKS PASSED");
