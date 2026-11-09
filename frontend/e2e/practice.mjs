// "Practice my weakest topics" in the REAL situation that broke: questions with NO topic (reports call them "Uncategorized").
// It must say exactly what it will practice, preselect those questions, and explain clearly when something is missing.
import { BASE, check, clickText, launch, reportIssues, shot, sleep, startBackend, textOf, waitText } from "./lib.mjs";
import { seedHistory } from "./seed.mjs";

const be = await startBackend();
seedHistory(be.dataDir, "untagged");
const { browser, page, issues } = await launch();
const post = (path, body) => fetch(`${BASE}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const del = (path) => fetch(`${BASE}${path}`, { method: "DELETE" });
try {
  const setId = (await (await fetch(`${BASE}/api/sets`)).json())[0].id;
  const ids = [];
  for (let i = 1; i <= 4; i++) ids.push((await (await post(`/api/sets/${setId}/questions`, { text: `Question without a topic number ${i}?` })).json()).id);   // no topic, like the real bank

  await page.goto(BASE, { waitUntil: "networkidle0" });
  await waitText(page, "Focus areas");
  await page.waitForSelector(".focus-row");
  const rows = await page.$$eval(".focus-row .nm", (els) => els.map((e) => e.textContent.trim()));
  check(rows.includes("No topic set") && !rows.includes("Uncategorized"), `the placeholder topic is shown as "No topic set", never as "Uncategorized" (${rows.join(", ")})`);
  const body = await textOf(page);
  check(body.includes("None of your questions has a topic yet") || body.includes("give them a topic"), "it explains that questions have no topic and how to fix that");
  const cta = await textOf(page, ".focus-cta");
  check(/Practice my weakest topics/.test(cta) && /Will preselect your .*Kafka.*questions with no topic/.test(cta), `the button and the line under it say exactly what will be practiced (${cta.replace(/\s+/g, " ").slice(0, 160)})`);

  // main button: Kafka has no questions, but the untagged ones do -> goes ahead with those and says what was left out
  await clickText(page, ".focus-cta button", "Practice my weakest topics");
  await page.waitForFunction(() => location.hash === "#/setup");
  await page.waitForSelector(".sec");
  await sleep(600);
  let setup = await textOf(page);
  check(/Practicing questions with no topic — 4 questions preselected/.test(setup), "Setup says what you are practicing and how many questions were preselected");
  check(/Left out because you have no questions for “Kafka” yet/.test(setup), "…and names the weak topic it had to leave out");
  check(setup.includes("Selected (4)"), "the 4 questions are actually selected in step 2");
  check(!(await page.$eval(".summary .btn.primary", (b) => b.disabled)), "the interview can be started straight away");
  await shot(page, "practice-setup-banner");
  await clickText(page, ".notice button", "Use all questions instead");
  await sleep(300);
  check(!(await textOf(page)).includes("Practicing questions with no topic"), "'Use all questions instead' dismisses the banner");

  // one topic at a time
  await page.goto(`${BASE}/#/home`, { waitUntil: "networkidle0" });
  await page.waitForSelector(".focus-row");
  await page.click('.focus-go[aria-label="Practice questions with no topic"]');
  await page.waitForFunction(() => location.hash === "#/setup");
  await page.waitForSelector(".sec"); await sleep(500);
  check(/Practicing questions with no topic — 4 questions/.test(await textOf(page)), "the per-row Practice button practices just that row");

  // a weak topic nobody has questions for: say exactly which, and offer the exact fix
  await page.goto(`${BASE}/#/home`, { waitUntil: "networkidle0" });
  await page.waitForSelector(".focus-row");
  await page.click('.focus-go[aria-label="Practice “Kafka”"]');
  await page.waitForSelector(".focus-cta .notice");
  const msg = await textOf(page, ".focus-cta .notice");
  check(/Nothing to practice yet/.test(msg) && msg.includes("“Kafka”"), `it names the missing topic instead of a vague error (${msg.replace(/\s+/g, " ").slice(0, 120)})`);
  await clickText(page, ".focus-cta .notice button", "Add a “Kafka” question");
  await page.waitForSelector('[role=dialog][aria-label="Add Question"]');
  check((await page.$eval('[role=dialog] input[placeholder*="opic" i], [role=dialog] input[list]', (i) => i.value).catch(() => "")) === "Kafka", "the Add Question dialog opens with the topic already filled in");
  await page.keyboard.press("Escape");

  // no questions at all
  for (const id of ids) await del(`/api/questions/${id}`);
  await page.goto(`${BASE}/#/home`, { waitUntil: "networkidle0" });
  await page.waitForSelector(".focus-row");
  await clickText(page, ".focus-cta button", "Practice my weakest topics");
  await page.waitForSelector(".focus-cta .notice");
  const empty = await textOf(page, ".focus-cta .notice");
  check(/Nothing to practice yet/.test(empty) && /no .*questions with no topic/.test(empty), `an empty Question Bank is explained plainly (${empty.replace(/\s+/g, " ").slice(0, 130)})`);
  check(!(await textOf(page)).includes("Uncategorized"), "the word 'Uncategorized' never appears on the dashboard");
  reportIssues(issues);
} catch (e) { console.log("FAIL  exception: " + (e.stack || e)); process.exitCode = 1; }
finally { await browser.close(); be.proc.kill(); }
console.log(process.exitCode ? "\nSOME CHECKS FAILED" : "\nALL CHECKS PASSED");
