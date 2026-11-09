// Resumes end to end in real Chrome, with a FAKE local model (e2e/fakellm.mjs): upload -> progress -> ready -> edit -> save -> preview ->
// a second resume -> duplicate warning -> Interview setup (Resume only, then Both with interleave) -> generate -> edit/remove a question ->
// start -> answer -> the report shows "Resume claims". Then phone width, dark theme and keyboard-only checks. Isolated data dir, port 3100.
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BASE, ROOT, VENV_PYTHON, check, clickText, launch, overflow, reportIssues, setText, shot, sleep, startBackend, textOf, waitText } from "./lib.mjs";
import { startFakeLlm } from "./fakellm.mjs";

const dir = mkdtempSync(join(tmpdir(), "lai-resume-pdfs-"));
execFileSync(VENV_PYTHON, ["-c", `import sys; sys.path.insert(0, "tests")
from resume_fixtures import text_pdf, two_column_pdf
open(sys.argv[1], "wb").write(text_pdf()); open(sys.argv[2], "wb").write(two_column_pdf())`, join(dir, "jane-cv.pdf"), join(dir, "two-col.pdf")], { cwd: join(ROOT, "backend") });
const PDF1 = join(dir, "jane-cv.pdf"), PDF2 = join(dir, "two-col.pdf");

const llm = await startFakeLlm();
const be = await startBackend({ OLLAMA_HOST_URL: llm.url, TTS_PROVIDER: "system", STT_ENABLED: "0", OLLAMA_API_KEY: "" });
const { browser, page, issues } = await launch();
const api = async (p, init) => (await fetch(`${BASE}${p}`, init)).json();
const post = (p, b) => api(p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
const waitFor = (fn, timeout = 20000, ...args) => page.waitForFunction(fn, { timeout }, ...args);
const upload = async (file) => { const input = await page.waitForSelector('[data-testid="resume-file"]'); await input.uploadFile(file); };

try {
  // ---------------------------------------------------------------- empty state, first upload with live progress
  await page.goto(`${BASE}/#/resumes`, { waitUntil: "networkidle0" });
  await waitText(page, "No resumes yet");
  const empty = await textOf(page, ".rz-empty");
  check(empty.includes("Press Add resume at the top right") && !(await page.$(".rz-empty .rz-drop")), "empty state: a short centred message pointing to Add resume (no upload box)");
  check(await page.$eval(".sb-item.active", (a) => a.textContent.includes("Resumes")), "sidebar: Resumes is the active item");
  await shot(page, "resumes-empty");
  await clickText(page, ".pagehead button", "Add resume");
  await waitText(page, "Drop your resume here");
  check((await textOf(page, ".modal")).includes("Stays on this computer"), "the Add resume dialog states the privacy line (local mode)");
  const overlay = await page.$eval(".overlay", (o) => { const s = getComputedStyle(o); const m = o.querySelector(".modal").getBoundingClientRect(); return { bg: s.backgroundColor, cx: m.left + m.width / 2, cy: m.top + m.height / 2 }; });
  check((overlay.bg === "rgba(0, 0, 0, 0)" || overlay.bg === "transparent") && Math.abs(overlay.cx - 640) < 4, `the Add resume dialog is centred and the page behind is not dimmed (${overlay.bg})`);
  await upload(PDF1);
  await waitFor(() => /Reading text|Organising with AI|Uploading/.test(document.querySelector(".rz-steps")?.innerText ?? ""), 10000);
  check(true, "the stepper shows progress while the resume is read and organised");
  await waitText(page, "Review it", 30000);
  const stepsText = await textOf(page, ".rz-steps");
  check(!stepsText.includes("Running OCR"), "a text PDF skips the OCR step");
  await shot(page, "resumes-upload-ready");
  await clickText(page, ".modal a", "Review it");

  // ---------------------------------------------------------------- detail: edit, guard, save, preview, original text
  await waitText(page, "Contact & links");
  const company = await page.$$eval(".rz-field input", (els) => els.map((e) => e.value));
  check(company.includes("Acme Corp") && company.includes("Senior Backend Engineer"), "Content tab: the organised experience is shown as editable fields");
  check((await textOf(page)).includes("Organised by AI from your PDF – please check it."), "the AI note is shown");
  check(await page.$eval(".rz-savebar .btn.primary", (b) => b.disabled), "Save is disabled while nothing changed");
  await setText(page, 'textarea[aria-label="Summary"]', "Backend engineer who loves fast APIs.");
  await waitText(page, "Unsaved changes in Summary");
  await page.click('a.sb-item[href="#/questions"]');
  await waitText(page, "Leave without saving?");
  check(page.url().endsWith("#/resumes/1"), "in-app navigation is held back while there are unsaved changes");
  await clickText(page, ".modal button", "Cancel");
  await clickText(page, ".rz-savebar button", "Save changes");
  await waitText(page, "All changes saved");
  const saved = await api("/api/resumes/1");
  check(saved.profile.summary === "Backend engineer who loves fast APIs.", "the edit was saved on the server");
  await shot(page, "resume-detail-content");
  await clickText(page, '[role="tab"]', "Preview");
  const src = await page.waitForSelector("iframe.rz-pdf").then((f) => f.evaluate((e) => e.getAttribute("src")));
  const pdf = await fetch(`${BASE}${src}`);
  check(src === "/api/resumes/1/file" && pdf.headers.get("content-type") === "application/pdf" && pdf.headers.get("content-disposition").startsWith("inline"), "Preview tab: the original PDF is shown inline from the app");
  check((await textOf(page)).includes("Open in new tab"), "Preview tab has an Open in new tab link");
  await clickText(page, '[role="tab"]', "Original text");
  await waitText(page, "Text read from your PDF");
  const raw = await textOf(page, ".rz-raw");
  check(raw.includes("Cut p95 API latency by 40%") && /page 1/.test(raw), "Original text tab: the raw text with page markers, and the method is stated");

  // ---------------------------------------------------------------- second resume, duplicate warning, list polling
  await page.goto(`${BASE}/#/resumes`, { waitUntil: "networkidle0" });
  await clickText(page, "button", "Add resume");
  await upload(PDF2);
  await waitText(page, "Review it", 30000);
  await clickText(page, ".modal button", "Done");
  await waitFor(() => document.querySelectorAll('[data-testid="resume-card"]').length === 2);
  const cards = await textOf(page, ".rz-grid");
  check(cards.includes("Resume 1") && cards.includes("Resume 2") && cards.includes("Ready") && cards.includes("Text"), "two resume cards with name, status chip and method chip");
  check(cards.includes("Python") && cards.includes("Kafka"), "cards show top skills as chips");
  await clickText(page, "button", "Add resume");
  await upload(PDF1);
  await waitText(page, "You already added this file");
  check((await textOf(page, ".modal")).includes("Resume 1") && (await textOf(page, ".modal")).includes("Add anyway"), "a duplicate file is recognised and the user is asked");
  await clickText(page, ".modal button", "Cancel");
  await page.keyboard.press("Escape");
  await shot(page, "resumes-grid");

  // ---------------------------------------------------------------- Interview setup: Resume only
  await clickText(page, ".rz-card button", "Practice");
  await page.waitForSelector('[data-testid="resume-panel"]');
  check(await page.$eval('[role="radiogroup"][aria-label="Question source"] [aria-checked="true"]', (b) => b.textContent.includes("Resume")), "Practice opens the setup with the Resume source chosen");
  const picked = await page.$$eval(".rz-pick-row input", (els) => els.filter((e) => e.checked).length);
  check(picked === 1, "and that resume preselected");
  await page.click('[aria-label="Fewer questions"]'); await page.click('[aria-label="Fewer questions"]'); await page.click('[aria-label="Fewer questions"]'); await page.click('[aria-label="Fewer questions"]');
  check(await page.$eval('[aria-label="Number of resume questions"]', (e) => e.value) === "4", "the question-count stepper works");
  check((await textOf(page, ".rz-gen")).includes("on this computer"), "the time estimate says it runs on this computer");
  await clickText(page, ".rz-gen button", "Generate questions");
  await waitFor(() => document.querySelectorAll(".rz-q").length === 4, 30000);
  const chips = await page.$$eval(".rz-from", (els) => els.map((e) => e.textContent));
  check(chips.every((c) => c.startsWith("From: Resume")), `each question says where it came from (${chips[0]})`);
  await page.click('[aria-label="Edit question 1"]');
  await setText(page, 'textarea[aria-label="Question 1"]', "How did you cut p95 latency at Acme Corp, and how did you measure it?");
  await clickText(page, ".rz-q button", "Done");
  await page.click('[aria-label="Remove question 2"]');
  await waitFor(() => document.querySelectorAll(".rz-q").length === 3);
  const sum = await textOf(page, ".summary");
  check(/From resume\s*3/.test(sum) && /Questions\s*3 in total/.test(sum), "the session summary counts the resume questions");
  await shot(page, "setup-resume");
  await clickText(page, "button", "Start Interview");
  await page.waitForSelector("#answer", { timeout: 20000 });
  check((await textOf(page)).includes("From your resume"), "the question card shows a small From your resume chip");
  check((await page.$eval(".interview-q", (e) => e.textContent)).startsWith("How did you cut p95 latency at Acme Corp"), "the edited question is asked as written");
  for (let i = 0; i < 3; i++) {
    const before = await page.$eval(".interview-q", (e) => e.textContent).catch(() => "");
    await page.type("#answer", `I owned this: I measured p95 before and after with our tracing, chose Redis over a CDN because reads were per-user (${i}).`);
    await clickText(page, "button", "Submit Answer");
    if (i < 2) await waitFor((p) => { const q = document.querySelector(".interview-q"), a = document.querySelector("#answer"); return q && a && !a.disabled && q.textContent !== p; }, 30000, before);
  }
  await waitText(page, "Interview complete", 30000);
  await clickText(page, "a", "View the full report");
  await page.waitForSelector('[data-testid="resume-claims"]', { timeout: 20000 });
  const claims = await textOf(page, '[data-testid="resume-claims"]');
  check(claims.includes("Resume claims") && /Solid|Shaky|Weak/.test(claims) && /Resume \d/.test(claims), "the report shows Resume claims with verdict pills");
  check((await textOf(page)).includes("Resume"), "resume-sourced questions carry a Resume tag in the report");
  await shot(page, "report-resume-claims");
  const md = await (await fetch(`${BASE}/api/interviews/1/report/export?format=md`)).text();
  check(md.includes("## Resume claims"), "the Markdown export includes Resume claims");

  // ---------------------------------------------------------------- Both, interleaved with the question bank
  await post("/api/sets/1/questions", { text: "What is a B-tree index?", topic: "Databases" });
  await post("/api/sets/1/questions", { text: "Explain eventual consistency.", topic: "Distributed systems" });
  await page.goto(`${BASE}/#/setup`, { waitUntil: "networkidle0" });
  await clickText(page, '[aria-label="Question source"] button', "Both");
  await page.waitForSelector('[data-testid="resume-panel"]');
  await clickText(page, '[aria-label="Order of bank and resume questions"] button', "Interleave");
  if (!(await page.$$eval(".rz-q", (e) => e.length))) {
    await page.click(".rz-pick-row input");
    await clickText(page, ".rz-gen button", "Generate questions");
  }
  await waitFor(() => document.querySelectorAll(".rz-q").length >= 3, 30000);
  const nRes = await page.$$eval(".rz-q", (e) => e.length);
  const sum2 = await textOf(page, ".summary");
  check(/From question bank\s*2/.test(sum2) && /Order\s*Interleave/.test(sum2), "Both: the summary shows counts per source and the order");
  await clickText(page, "button", "Start Interview");
  await page.waitForSelector("#answer", { timeout: 20000 });
  const st = await api(`/api/interviews/2`);
  const seq = st.items.map((i) => (i.source === "resume" ? "R" : "B")).join("");
  const expect = Array.from({ length: Math.max(2, nRes) }, (_, i) => (i < nRes ? "R" : "") + (i < 2 ? "B" : "")).join("");
  check(seq === expect, `Both + Interleave alternates resume and bank questions, remainder appended (${seq})`);
  await post("/api/interviews/2/end", {});

  // ---------------------------------------------------------------- palette and keyboard
  await page.goto(`${BASE}/#/home`, { waitUntil: "networkidle0" });
  await page.waitForSelector('[data-testid="resume-tile"]');
  check((await textOf(page, '[data-testid="resume-tile"]')).includes("Interview from resume"), "Home has the Interview from resume tile");
  await page.keyboard.press("g"); await page.keyboard.press("e");
  await waitFor(() => location.hash === "#/resumes");
  check(true, "g then e opens Resumes");
  await page.keyboard.down(process.platform === "darwin" ? "Meta" : "Control"); await page.keyboard.press("k"); await page.keyboard.up(process.platform === "darwin" ? "Meta" : "Control");
  await page.waitForSelector(".palette input");
  await page.type(".palette input", "upload resume");
  await page.keyboard.press("Enter");
  await waitText(page, "Drop your resume here");
  check(true, "the palette's Upload resume opens the Add resume dialog");
  await page.keyboard.press("Escape");
  await waitFor(() => !document.querySelector(".modal"));
  // keyboard only: Tab to "Add resume", Enter opens it, Escape closes it
  await page.evaluate(() => document.activeElement?.blur());
  let reached = false;
  for (let i = 0; i < 40 && !reached; i++) { await page.keyboard.press("Tab"); reached = await page.evaluate(() => document.activeElement?.textContent?.trim() === "Add resume" && document.activeElement.classList.contains("primary")); }
  const ring = await page.evaluate(() => getComputedStyle(document.activeElement).outlineStyle);
  check(reached && ring !== "none", "keyboard: Tab reaches Add resume with a visible focus ring");
  await page.keyboard.press("Enter");
  await waitText(page, "Drop your resume here");
  await page.keyboard.press("Escape");
  await waitFor(() => !document.querySelector(".modal"));
  check(true, "keyboard: Enter opens the dialog and Escape closes it");

  // ---------------------------------------------------------------- phone width and dark theme
  await page.setViewport({ width: 390, height: 844 });
  for (const [hash, name] of [["#/resumes", "phone-resumes"], ["#/resumes/1", "phone-resume-detail"], ["#/setup", "phone-setup"]]) {
    await page.goto(`${BASE}/${hash}`, { waitUntil: "networkidle0" });
    if (hash === "#/setup") { await clickText(page, '[aria-label="Question source"] button', "Resume"); await page.waitForSelector('[data-testid="resume-panel"]'); }
    await sleep(300);
    const o = await overflow(page);
    check(o.doc <= 0 && o.body <= 0, `phone width (390 px): no sideways scrolling on ${hash}`);
    await shot(page, name);
  }
  await page.setViewport({ width: 1280, height: 900 });
  await page.evaluate(() => localStorage.setItem("lai.theme", "dark"));
  for (const [hash, name] of [["#/resumes", "dark-resumes"], ["#/resumes/1", "dark-resume-detail"], ["#/report/1", "dark-report"]]) {
    await page.goto(`${BASE}/${hash}`, { waitUntil: "networkidle0" });
    await page.reload({ waitUntil: "networkidle0" });              // a hash-only navigation keeps the document: reload so the saved theme applies
    await page.waitForSelector(".rz-card, .rz-sec, .card");
    await sleep(300);
    const dark = await page.evaluate(() => document.documentElement.dataset.theme === "dark" && getComputedStyle(document.querySelector(".rz-card, .rz-sec, .card")).backgroundColor);
    check(dark && dark !== "rgb(255, 255, 255)", `dark theme applies to ${hash} (${dark})`);
    await shot(page, name);
  }
  await page.evaluate(() => localStorage.setItem("lai.theme", "light"));
  // Chrome's own PDF viewer runs as a built-in extension page inside the preview frame: not a network request, nothing leaves the computer
  const viewer = (x) => x.startsWith("chrome-extension://") || x.includes(" chrome-extension://");
  issues.external = issues.external.filter((x) => !viewer(x));
  issues.failedRequests = issues.failedRequests.filter((x) => !viewer(x));
  check(llm.state.parses >= 2 && llm.state.writes >= 1, `the fake local model was used for organising (${llm.state.parses}) and question writing (${llm.state.writes})`);
  reportIssues(issues);
} catch (e) {
  console.log("FAIL  exception:", e.message); process.exitCode = 1;
  await shot(page, "resumes-failure").catch(() => {});
  console.log("body:", (await textOf(page).catch(() => "")).slice(0, 400));
  issues.external = issues.external.filter((x) => !x.startsWith("chrome-extension://"));
  issues.failedRequests = issues.failedRequests.filter((x) => !x.includes(" chrome-extension://"));
  reportIssues(issues);
} finally { await browser.close(); be.proc.kill(); await llm.stop(); }
