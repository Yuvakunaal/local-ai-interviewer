// Full interview in real Chrome against the REAL local models (qwen3.5:4b + Phonon). Slow: evaluations take a while.
import { BASE, OUT, check, clickText, launch, reportIssues, shot, sleep, startBackend, textOf, waitText } from "./lib.mjs";

const health = await (await fetch("http://127.0.0.1:11434/api/tags")).json().catch(() => ({ models: [] }));
if (!health.models.some((m) => m.name === "qwen3.5:4b")) { console.log("SKIP  qwen3.5:4b is not installed"); process.exit(0); }

const be = await startBackend();
const { browser, page, issues } = await launch();
const post = (p, b) => fetch(`${BASE}${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
// after a submitted answer the next question (or a follow-up) appears on its own; nothing about the score is shown in between
const waitNext = async (label, prev) => {
  const t0 = Date.now();
  await page.waitForFunction((p) => { const q = document.querySelector(".interview-q"), a = document.querySelector("#answer"); return q && a && !a.disabled && q.textContent !== p; }, { timeout: 240000 }, prev);
  const s = ((Date.now() - t0) / 1000).toFixed(1);
  const text = await textOf(page);
  check(!/Verdict|Strengths|Graded by|\/ 10/.test(text) && !text.includes("couldn’t be evaluated"), `${label}: evaluated by the local model in ${s}s and the page moved on without showing a score`);
};
try {
  await post("/api/sets/1/questions", { text: "What is idempotency in an ETL pipeline and how do you achieve it?", rubric: "A rerun yields the same final state: upsert/MERGE on a business key, partition overwrite, dedupe, track processed batches/watermarks.", topic: "ETL", difficulty: "medium" });
  await post("/api/sets/1/questions", { text: "How does data skew hurt a Spark join and how do you mitigate it?", topic: "Spark", difficulty: "hard" });
  await post("/api/sets/1/questions", { text: "What is a slowly changing dimension type 2?", topic: "Data modeling", difficulty: "easy" });

  await page.goto(`${BASE}/#/setup`, { waitUntil: "networkidle0" });
  await page.waitForFunction(() => document.querySelectorAll(".vchip").length > 30);
  await page.click('[aria-label="Max follow-ups: 2"]');
  await clickText(page, "button", "Start Interview");
  await waitText(page, "Your Answer");
  check((await textOf(page)).includes("Question 1 of 3"), "interview started with 3 questions, up to 2 follow-ups");

  // Q1: partial answer -> evaluated quietly; a follow-up (if one is worth asking) simply appears
  const q1 = await page.$eval(".interview-q", (e) => e.textContent);
  await page.type("#answer", "Idempotency means that if I run the pipeline twice I do not get duplicate data. I would use upserts instead of plain inserts.");
  await clickText(page, "button", "Submit Answer");
  await waitText(page, "Evaluating your answer with the local model");
  check(await page.$eval("button.primary.big", (b) => b.disabled).catch(() => true), "submit is disabled while evaluating (no double submit)");
  await waitNext("Q1", q1);
  let followups = 0, current = await page.$eval(".interview-q", (e) => e.textContent);
  while (!/data skew/.test(current) && followups < 3) {
    followups++;
    console.log(`INFO  follow-up ${followups}: ${current}`);
    check(current.length > 15 && !current.startsWith("What is idempotency in an ETL pipeline and how"), `follow-up #${followups} is a new, specific question`);
    await shot(page, `full-q1-followup${followups}`);
    await page.type("#answer", "For late or retried batches I keep a processed-batch table keyed by batch id and MERGE on the business key, so reprocessing overwrites rather than appends.");
    await clickText(page, "button", "Submit Answer");
    await waitNext(`follow-up ${followups}`, current);
    current = await page.$eval(".interview-q", (e) => e.textContent);
  }
  check(followups <= 2, `follow-ups asked (${followups}) never exceed the configured limit of 2`);
  check((await page.$$eval(".plist .badge.ok, .plist .badge.warn, .plist .badge.bad", (b) => b.length)) === 0, "the progress list shows no scores while the interview runs");

  // Q2: skip -> must not be scored
  await waitText(page, "data skew");
  await clickText(page, "button", "Skip");
  await waitText(page, "Skip?");
  await clickText(page, ".modal button", "Skip", { exact: true });
  await waitText(page, "slowly changing dimension");

  // Q3: reload mid-question to verify resume, then answer and finish
  await page.reload({ waitUntil: "networkidle0" });
  await waitText(page, "Question 3 of 3");
  await page.type("#answer", "SCD type 2 keeps history by inserting a new row for each change, with effective start and end dates and a current flag, and a surrogate key so facts point at the version valid at the time.");
  await clickText(page, "button", "Submit Answer");
  await waitText(page, "Interview complete", 240000);
  await page.waitForSelector('[data-testid="final-score"] .ring', { timeout: 20000 });
  check(/final score/.test(await textOf(page, '[data-testid="final-score"]')), "the final score appears as soon as the interview ends");
  await clickText(page, "a", "View the full report");
  await waitText(page, "Topic-wise Performance");
  await page.waitForFunction(() => !document.body.innerText.includes("Writing summary"), { timeout: 240000 });
  await shot(page, "full-report");
  const rep = await textOf(page);
  check(rep.includes("Skipped") && rep.includes("Total Questions"), "report shows the storyboard stat cards incl. Skipped");
  const rows = await page.$$eval('[data-testid="scorecard"] .sc-row', (r) => r.map((x) => x.innerText.replace(/\s+/g, " ")));
  check(rows.length === 3 && /Answer \d/.test(rows[0]) && /Skipped/.test(rows[1]) && /Answer \d/.test(rows[2]), `the scorecard lists every question with its answer score (${rows.map((x) => x.slice(0, 50)).join(" | ")})`);
  const q1chips = await page.$$eval('[data-testid="scorecard"] .sc-row:first-child .sc-chip', (c) => c.length);
  check(q1chips === 1 + followups, `question 1 shows its answer and ${followups} follow-up score(s) (${q1chips} chips)`);
  check(/Final score/.test(await textOf(page, ".sc-final")) && /\d\.\d|\d/.test(await textOf(page, ".sc-final b")), "the scorecard ends with the final score");
  check((await page.$('[data-testid="skills"]')) !== null, "the report has a skills breakdown");
  const data = await (await fetch(`${BASE}/api/interviews/1/report`)).json();
  check(data.summary.skipped === 1 && data.summary.scored === 2, `skipped excluded from scoring (scored=${data.summary.scored}, avg=${data.summary.average_score})`);
  check(data.questions[1].score === null && data.questions[1].status === "skipped", "skipped question has no score");
  console.log(`INFO  narrative_status=${data.narrative_status} source=${data.insights_source}`);
  console.log("INFO  insights:", JSON.stringify(data.insights).slice(0, 700));
  const md = await (await fetch(`${BASE}/api/interviews/1/report/export?format=md`)).text();
  check(md.startsWith("# Interview report") && md.includes("Scoring rules") && md.includes("## Scorecard"), "Markdown export works and includes the scorecard");
  const pdf = await fetch(`${BASE}/api/interviews/1/report/export?format=pdf`);
  const pdfBytes = Buffer.from(await pdf.arrayBuffer());
  check(pdf.headers.get("content-type") === "application/pdf" && pdfBytes.subarray(0, 5).toString() === "%PDF-" && pdfBytes.length > 5000, `the PDF report of this real interview is a real PDF (${(pdfBytes.length / 1024).toFixed(0)} KB)`);
  // ERR_ABORTED on /synthesize is the app deliberately cancelling obsolete audio when you move on
  reportIssues(issues, ["/api/speech/synthesize net::ERR_ABORTED"]);
} catch (e) {
  console.log("FAIL  exception:", e.message); process.exitCode = 1;
  await shot(page, "full-failure").catch(() => {});
  console.log("body:", (await textOf(page).catch(() => "")).slice(0, 800));
  reportIssues(issues, ["/api/speech/synthesize net::ERR_ABORTED"]);
} finally { await browser.close(); be.proc.kill(); console.log("screenshots:", OUT); }
