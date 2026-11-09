// Questions, bulk import, reorder, voices/TTS playback, start + pause/resume/refresh, report, layout.
// Works with or without the LLM installed (without it, the 'answer saved, press Retry' path is checked instead).
import { BASE, OUT, check, clickText, launch, overflow, reportIssues, setText, shot, sleep, startBackend, textOf, waitText } from "./lib.mjs";

const be = await startBackend();
const { browser, page, issues } = await launch();
try {
  await page.goto(BASE, { waitUntil: "networkidle0" });
  await waitText(page, "scored when you finish");
  check((await textOf(page)).includes("Question Bank") && (await textOf(page)).includes("Recent Interviews"), "Home dashboard renders (storyboard screen 1)");
  await page.goto(`${BASE}/#/questions`, { waitUntil: "networkidle0" });
  await waitText(page, "No questions yet");
  check(true, "app loads from http://localhost; empty state shown");
  check((await page.$$('.status span[title] .dot')).length === 4, "service status pills rendered");

  // ---- one logo everywhere: favicon, sidebar, drawer
  const icon = await page.$eval('link[rel="icon"]', (l) => l.href);
  const iconRes = await fetch(icon);
  check(iconRes.ok && (iconRes.headers.get("content-type") || "").includes("svg") && icon.endsWith("/logo.svg"), "favicon is the app logo (served locally as SVG)");
  check((await page.$$(".sidebar svg.logo-mark")).length === 1 && (await page.title()) === "AI Interviewer", "sidebar uses the same logo; page title is 'AI Interviewer'");

  // ---- sidebar: collapse / expand / persistence / tooltips / shortcut
  const sbw = () => page.$eval(".sidebar", (e) => Math.round(e.getBoundingClientRect().width));
  const w0 = await sbw();
  check(w0 > 240 && (await page.$(".sb-section")) !== null && /workspace/i.test(await textOf(page, ".sidebar")), `sidebar is expanded by default (${w0}px) with section labels`);
  await page.click('button[aria-label="Collapse sidebar"]');
  await page.waitForFunction(() => document.querySelector(".sidebar").getBoundingClientRect().width < 90);
  await sleep(450);   // let the width transition settle
  check((await sbw()) < 90 && await page.$eval(".sb-label", (e) => e.offsetParent === null), `collapse button shrinks it to an icon rail (${await sbw()}px) and hides labels`);
  await page.reload({ waitUntil: "networkidle0" });
  check((await sbw()) < 90, "collapsed state persists across reload");
  await page.hover('a.sb-item[data-tip="Questions"]'); await sleep(350);
  const tip = await page.$eval('a.sb-item[data-tip="Questions"]', (e) => ({ o: getComputedStyle(e, "::after").opacity, c: getComputedStyle(e, "::after").content }));
  check(tip.o === "1" && tip.c.includes("Questions"), "hover tooltip appears on the icon rail");
  await page.mouse.move(700, 500); await page.keyboard.press("[");
  await page.waitForFunction(() => document.querySelector(".sidebar").getBoundingClientRect().width > 240);
  check((await sbw()) > 240, "pressing [ expands the sidebar again");
  check(await page.$eval(".shell", (e) => !e.classList.contains("collapsed")), "shell state in sync");

  // add a single question with rubric/topic/difficulty
  await page.click('button[aria-label="Add question"]');
  await page.locator("textarea").fill("What is idempotency in ETL?");
  await page.locator("textarea:nth-of-type(1)").wait();
  const areas = await page.$$("textarea"); await areas[1].type("A rerun must give the same result: upserts/merge keys, no duplicates.");
  await page.locator('input[list="topics"]').fill("ETL");
  await page.select("select", "medium");
  await clickText(page, ".modal button", "Save", { exact: true });
  await waitText(page, "What is idempotency in ETL?");
  check((await textOf(page)).includes("rubric") && (await textOf(page)).includes("ETL"), "added question shows topic + rubric badges");

  // bulk import using -- separators, ordinary hyphens must not split
  await clickText(page, "button", "Import Questions");
  const sample = `What is the difference between a data lake and a data warehouse?\n--\nHow would you handle duplicate records in a production pipeline?\n--\nExplain incremental data loading - and idempotency.\nInclude a multi-line example.\n--\nWhat is idempotency in ETL?\n--\n--\nHow would you investigate a failed Snowflake pipeline?`;
  await setText(page, '.modal textarea', sample);
  await waitText(page, "Detected");
  let txt = await textOf(page, ".modal");
  check(txt.includes("Detected 4 questions") && txt.includes("5 found"), "preview: 5 detected, 4 importable, duplicate excluded");
  check(txt.includes("Already in your queue"), "preview flags the duplicate of an existing question");
  await page.click('.modal button[aria-label="Remove question 2 from import"]');
  await waitText(page, "Detected 3 questions");
  check(true, "individual question removed from preview");
  await shot(page, "bulk-import");
  await clickText(page, ".modal button", "Import 3 Questions");
  await waitText(page, "Imported 3 question(s)");
  await page.waitForFunction(() => document.querySelectorAll(".qrow").length === 4);
  const rows = await page.$$eval(".qrow .qtext", (els) => els.map((e) => e.textContent));
  check(rows.length === 4 && rows[2].includes("- and idempotency.\nInclude a multi-line example."), "append kept the existing question; hyphen + multiline preserved");

  // replace needs explicit confirmation
  await clickText(page, "button", "Import Questions");
  await setText(page, '.modal textarea', "Only replacement?");
  await waitText(page, "Detected 1 question");
  await page.evaluate(() => [...document.querySelectorAll('.modal input[type=radio]')][1].click());
  check(await page.evaluate(() => [...document.querySelectorAll(".modal button")].find((b) => b.textContent.startsWith("Import"))?.disabled), "replace is blocked until confirmed");
  await clickText(page, ".modal button", "Cancel");
  check((await page.$$(".qrow")).length === 4, "cancelled replace left the queue intact");

  // reorder + duplicate + delete confirmation
  const rowBtn = async (i, label) => {
    const row = (await page.$$(".qrow"))[i];
    const direct = await row.$(`.qactions > button[aria-label="${label}"]`);
    if (direct) return direct.click();
    await (await row.$('button[aria-haspopup="menu"]')).click();     // secondary actions live in the "more" menu
    await page.waitForSelector(`.menu-pop button[aria-label="${label}"]`);
    await (await page.$(`.menu-pop button[aria-label="${label}"]`)).click();
  };
  await rowBtn(0, "Move down");
  await page.waitForFunction(() => document.querySelector(".qrow .qtext")?.textContent.startsWith("What is the difference"));
  check(true, "reorder (move down) persisted via API");
  await rowBtn(0, "Duplicate question");
  await page.waitForFunction(() => document.querySelectorAll(".qrow").length === 5);
  await rowBtn(1, "Delete question");
  await waitText(page, "Delete this question?");
  await clickText(page, ".modal button", "Delete", { exact: true });
  await page.waitForFunction(() => document.querySelectorAll(".qrow").length === 4);
  check(true, "duplicate + delete-with-confirmation work");

  // hear a question (real Phonon)
  await page.evaluate(() => (window.__audio.plays = 0));
  await rowBtn(0, "Hear question");
  await page.waitForFunction(() => window.__audio.plays === 1, { timeout: 20000 });
  check(true, "Phonon audio generated locally and played on click");

  // JSON export is a local download
  const exp = await page.evaluate(async () => (await fetch(document.querySelector('a[download]').href)).json());
  check(exp.version === 1 && exp.questions.length === 4, "JSON export contains the queue");

  // Setup page: voices from the model + preview
  await page.goto(`${BASE}/#/setup`, { waitUntil: "networkidle0" });
  await page.waitForFunction(() => document.querySelectorAll(".vchip").length > 30);
  const voices = await page.$$eval(".vchip .vn", (o) => o.map((x) => x.textContent));
  check(voices.includes("Harper") && voices.includes("default"), `voice picker lists Phonon's real voices (${voices.length})`);
  check(await page.$eval('.vchip[aria-checked="true"] .vn', (e) => e.textContent) === "Hadley", "storyboard default voice (Hadley) is preselected");
  await page.click('button[aria-label="Max follow-ups: 3"]'); await page.click('[role=radio][aria-label="Max follow-ups: 2"]').catch(() => {});
  check((await textOf(page, ".summary")).includes("Technical") && (await textOf(page, ".summary")).includes("Up to"), "live session summary reflects the choices");
  await page.evaluate(() => (window.__audio.plays = 0));
  await page.click('button[aria-label="Preview voice Harper"]');
  await page.waitForFunction(() => window.__audio.plays === 1, { timeout: 20000 });
  check(true, "voice preview plays");
  await shot(page, "setup");

  // start an interview, question is spoken once, refresh resumes the same state
  await page.evaluate(() => (window.__audio.plays = 0));
  await clickText(page, "button", "Start Interview");
  await page.waitForFunction(() => location.hash.startsWith("#/interview/"));
  await waitText(page, "Your Answer");
  await page.waitForFunction(() => window.__audio.plays >= 1, { timeout: 20000 });
  await sleep(1500);
  const plays = await page.evaluate(() => window.__audio.plays);
  check(plays === 1, `question audio auto-played exactly once (plays=${plays})`);
  await page.type("#answer", "Draft answer survives a refresh");
  await page.reload({ waitUntil: "networkidle0" });
  await waitText(page, "Your Answer");
  check((await page.$eval("#answer", (e) => e.value)) === "Draft answer survives a refresh", "unsent draft restored after refresh");
  check((await textOf(page)).includes("Question 1 of 4"), "interview resumes at the same question after refresh");
  await clickText(page, "button", "Pause");
  await waitText(page, "Your place is saved");
  await page.waitForFunction(() => window.__audio.active === 0, { timeout: 3000 }).then(() => check(true, "pause stops audio"), () => check(false, "pause stops audio"));
  await clickText(page, "button", "Resume");
  await waitText(page, "Your Answer");

  // submit with no LLM model installed: answer is kept, clear error + retry
  await clickText(page, "button", "Submit Answer");
  await page.waitForFunction(() => document.body.innerText.includes("couldn’t be evaluated") || /Question 3 of 4|Follow-up/.test(document.body.innerText), { timeout: 240000 }); // cold model load + evaluation can take ~1 min
  const body = await textOf(page);
  if (body.includes("couldn’t be evaluated")) {
    check(body.includes("Draft answer survives a refresh") && body.includes("Retry evaluation"), "evaluation failure keeps the answer and offers Retry");
  } else console.log("INFO  model answered (LLM installed) - failure path skipped");
  await shot(page, "interview");

  // end interview with confirmation, report exists
  await clickText(page, "button", "End interview");
  await waitText(page, "End the interview?");
  await clickText(page, ".modal button", "End & build report");
  await waitText(page, "Interview ended");
  await clickText(page, "a", "View the full report");
  await waitText(page, "Topic-wise Performance");
  const rep = await textOf(page);
  check(rep.includes("Not Reached") && rep.includes("How scores are calculated"), "report renders (skipped/unanswered separate from scores)");
  await shot(page, "report");

  // phone: sidebar is a drawer
  await page.setViewport({ width: 390, height: 844 }); await page.goto(`${BASE}/#/home`, { waitUntil: "networkidle0" });
  await page.waitForFunction(() => document.querySelector(".sidebar").getBoundingClientRect().right <= 1, { timeout: 4000 }).then(() => check(true, "on phones the sidebar is hidden off-canvas"), () => check(false, "on phones the sidebar is hidden off-canvas"));
  await page.click('button[aria-label="Open menu"]'); await page.waitForFunction(() => document.querySelector(".sidebar").getBoundingClientRect().left >= 0);
  check(true, "menu button opens the drawer");
  await page.mouse.click(370, 400); await page.waitForFunction(() => document.querySelector(".sidebar").getBoundingClientRect().right <= 1);
  check(true, "tapping the backdrop closes it");
  await page.setViewport({ width: 1280, height: 900 });

  // layout: no horizontal overflow on desktop and phone widths
  for (const [w, h] of [[1280, 900], [390, 844]]) {
    await page.setViewport({ width: w, height: h });
    for (const hash of ["home", "questions", "setup", "history", "reports", "settings"]) {
      await page.goto(`${BASE}/#/${hash}`, { waitUntil: "networkidle0" });
      const o = await overflow(page);
      check(o.doc <= 0 && o.body <= 0, `no horizontal overflow at ${w}px on #/${hash}`);
    }
  }
  await shot(page, "phone-settings");
  // history clear needs confirmation
  await page.goto(`${BASE}/#/history`, { waitUntil: "networkidle0" });
  await clickText(page, "button", "Clear history");
  await waitText(page, "Clear all history?");
  await clickText(page, ".modal button", "Cancel");
  check((await textOf(page)).includes("Every session saved on this computer"), "destructive actions ask first");

  const allow = ["/api/speech/synthesize net::ERR_ABORTED", ...(process.env.LLM_MISSING === "1" ? ["500", "503"] : [])];   // leaving a page mid-sentence cancels the question audio: harmless
  reportIssues(issues, allow);
} catch (e) {
  console.log("FAIL  exception:", e.message); process.exitCode = 1;
  await shot(page, "failure").catch(() => {});
  console.log("body:", (await textOf(page).catch(() => "")).slice(0, 600));
  reportIssues(issues, ["/api/speech/synthesize net::ERR_ABORTED"]);   // leaving a page mid-sentence cancels the question audio: harmless
} finally {
  await browser.close(); be.proc.kill();
  console.log("screenshots:", OUT);
}
