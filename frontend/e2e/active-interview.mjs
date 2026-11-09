// One interview at a time: the unfinished interview is shown as a bar at the top of the Interview page, a new one cannot start until it is
// continued to the end or ended, and the sidebar no longer carries a "resume" card. Needs no LLM (nothing is answered).
import { BASE, check, clickText, launch, reportIssues, shot, sleep, startBackend, textOf, waitText } from "./lib.mjs";
import { SWEEP } from "./sweep-lib.mjs";

const be = await startBackend();
const { browser, page, issues } = await launch({ width: 1280, height: 900 });
const api = async (path, opts) => { const r = await fetch(`${BASE}${path}`, opts); return { status: r.status, body: await r.json().catch(() => null) }; };
const post = (path, body) => api(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
try {
  const setId = (await api("/api/sets")).body[0].id;
  for (const t of ["One", "Two", "Three"]) await post(`/api/sets/${setId}/questions`, { text: `Question ${t}: explain idempotency?`, topic: "ETL" });

  // nothing active yet: no bar, Start is enabled
  await page.goto(`${BASE}/#/setup`, { waitUntil: "networkidle0" }); await page.waitForSelector(".sec"); await sleep(500);
  check((await page.$('[data-testid="active-interview"]')) === null, "no active interview: no bar on the Interview page");
  check(!(await page.$eval(".summary .btn.primary.big", (b) => b.disabled)), "…and Start Interview is available");

  // start the first interview, then leave with Exit Interview
  await clickText(page, "button", "Start Interview");
  await page.waitForSelector("#answer", { timeout: 20000 });
  const first = Number((await page.evaluate(() => location.hash)).split("/").pop());
  await clickText(page, "a", "Exit Interview");
  await page.waitForFunction(() => location.hash === "#/setup"); await page.waitForSelector('[data-testid="active-interview"]');
  check(true, "Exit Interview lands on the Interview page, where the active interview is waiting");
  const bar = await textOf(page, '[data-testid="active-interview"]');
  check(/Active interview/.test(bar) && /In progress/.test(bar) && /0 of 3 questions done/.test(bar) && /Continue interview/.test(bar) && /End interview/.test(bar), `the bar shows the title, state, progress and both actions (${bar.replace(/\s+/g, " ").slice(0, 110)})`);
  const pos = await page.evaluate(() => { const h = document.querySelector(".pagehead").getBoundingClientRect(), a = document.querySelector('[data-testid="active-interview"]').getBoundingClientRect(), f = document.querySelector(".setup-grid").getBoundingClientRect(); return { belowHeader: a.top >= h.bottom - 1, aboveForm: a.bottom <= f.top + 1, wide: a.width > 700 }; });
  check(pos.belowHeader && pos.aboveForm && pos.wide, "it is a wide horizontal bar directly under 'Start New Interview', above the form");
  check((await page.$(".sb-resume")) === null && !/\bResume\b(?!s)/.test(await textOf(page, ".sidebar nav")), "the sidebar has no active-interview card");

  // Start is blocked, in the page and on the server
  check(await page.$eval(".summary .btn.primary.big", (b) => b.disabled) && /still active/.test(await textOf(page, ".summary")), "Start Interview is disabled with the reason shown");
  const refused = await post("/api/interviews", { set_id: setId, config: { title: "Second" } });
  check(refused.status === 409 && refused.body.error.code === "interview_active" && refused.body.error.interview_id === first, "the server refuses a second interview as well (409 interview_active)");
  check((await api("/api/interviews")).body.length === 1, "…and created nothing");
  const sweep = await page.evaluate(SWEEP);
  check(sweep.length === 0, `Interview page with the bar passes the accessibility sweep${sweep.length ? ": " + sweep.join(" | ") : ""}`);
  await shot(page, "active-bar-light");
  await page.evaluate(() => localStorage.setItem("lai.theme", "dark")); await page.reload({ waitUntil: "networkidle0" }); await page.waitForSelector('[data-testid="active-interview"]'); await sleep(400);
  await shot(page, "active-bar-dark");
  await page.evaluate(() => localStorage.setItem("lai.theme", "light")); await page.reload({ waitUntil: "networkidle0" }); await page.waitForSelector('[data-testid="active-interview"]');

  // Continue goes back into the same interview
  await clickText(page, "a", "Continue interview");
  await page.waitForSelector("#answer", { timeout: 20000 });
  check(Number((await page.evaluate(() => location.hash)).split("/").pop()) === first && (await textOf(page)).includes("Question 1 of 3"), "Continue interview returns to the same interview, same question");

  // a paused interview still counts as active
  await clickText(page, "button", "Pause"); await waitText(page, "Paused");
  await page.goto(`${BASE}/#/setup`, { waitUntil: "networkidle0" }); await page.waitForSelector('[data-testid="active-interview"]');
  check(/Paused/.test(await textOf(page, '[data-testid="active-interview"]')) && await page.$eval(".summary .btn.primary.big", (b) => b.disabled), "a paused interview still blocks a new one and is labelled Paused");

  // End interview: cancel keeps it, confirm ends it, then a new one can start
  await clickText(page, '[data-testid="active-interview"] button', "End interview");
  await page.waitForSelector("[role=dialog]");
  await clickText(page, "[role=dialog] button", "Cancel");
  check((await page.$('[data-testid="active-interview"]')) !== null && (await api(`/api/interviews/${first}`)).body.status === "paused", "Cancel keeps the interview");
  await clickText(page, '[data-testid="active-interview"] button', "End interview");
  await page.waitForSelector("[role=dialog]"); await clickText(page, "[role=dialog] button", "End interview");
  await page.waitForFunction(() => !document.querySelector('[data-testid="active-interview"]'), { timeout: 10000 });
  check((await api(`/api/interviews/${first}`)).body.status === "ended" && !(await page.$eval(".summary .btn.primary.big", (b) => b.disabled)), "ending removes the bar and re-enables Start Interview");

  await clickText(page, "button", "Start Interview");
  await page.waitForSelector("#answer", { timeout: 20000 });
  const second = Number((await page.evaluate(() => location.hash)).split("/").pop());
  check(second !== first, "a new interview can now be started");
  await page.goto(`${BASE}/#/home`, { waitUntil: "networkidle0" }); await sleep(500);
  check(/Interview/.test(await textOf(page, ".sidebar nav")) && (await page.$(".sb-resume")) === null, "elsewhere in the app the sidebar still has no resume card");
  reportIssues(issues, ["api/speech/synthesize net::ERR_ABORTED"]);
} catch (e) { console.log("FAIL  exception: " + (e.stack || e)); process.exitCode = 1; }
finally { await browser.close(); be.proc.kill(); }
console.log(process.exitCode ? "\nSOME CHECKS FAILED" : "\nALL CHECKS PASSED");
