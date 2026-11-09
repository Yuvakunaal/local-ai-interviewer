// "Export as PDF" builds a finished report and saves it as a file: a loader on the button, no print dialog, the summary is waited for.
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BASE, check, clickText, launch, reportIssues, shot, sleep, startBackend, textOf } from "./lib.mjs";
import { seedHistory } from "./seed.mjs";

const be = await startBackend({ OLLAMA_API_KEY: "" });
seedHistory(be.dataDir);
const { browser, page: firstPage, issues } = await launch({ width: 1280, height: 900 });
const dir = mkdtempSync(join(tmpdir(), "lai-pdf-"));
const session = await browser.target().createCDPSession();
await session.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: dir, });
let summary = "ready", pdfRequests = 0, slowPdfMs = 0;      // the seeded reports have no written summary (no model), so the test decides what the page is told
const prepare = async (p) => {
  await p.evaluateOnNewDocument(() => { window.__printed = 0; window.print = () => { window.__printed++; }; });
  await p.setRequestInterception(true);
  p.on("request", async (req) => {
    const url = req.url();
    if (url.includes("/report/export?format=pdf")) { pdfRequests++; if (slowPdfMs) await sleep(slowPdfMs); return void req.continue().catch(() => {}); }
    if (/\/api\/interviews\/\d+\/report$/.test(url) && req.method() === "GET") {
      const real = await (await fetch(url)).json();
      return void req.respond({ status: 200, contentType: "application/json", body: JSON.stringify({ ...real, narrative_status: summary }) }).catch(() => {});
    }
    req.continue().catch(() => {});
  });
};
let page = firstPage;
await prepare(page);
const files = () => readdirSync(dir).filter((f) => !f.endsWith(".crdownload"));
const buttonText = () => page.evaluate(() => [...document.querySelectorAll("button")].find((b) => /Export as PDF|Preparing PDF|Waiting for the summary/.test(b.textContent))?.textContent.trim());
try {
  const rep = (await (await fetch(`${BASE}/api/interviews`)).json()).find((i) => i.has_report).id;
  await page.goto(`${BASE}/#/report/${rep}`, { waitUntil: "networkidle0" });
  await page.waitForSelector('[data-testid="scorecard"]');

  // ---------------------------------------------------------------- the written summary is finished before the file is made
  summary = "pending"; pdfRequests = 0; await page.reload({ waitUntil: "networkidle0" }); await page.waitForSelector('[data-testid="scorecard"]');
  await clickText(page, "button", "Export as PDF", { exact: true });
  await page.waitForFunction(() => [...document.querySelectorAll("button")].some((b) => /Waiting for the summary/.test(b.textContent)), { timeout: 3000 });
  await sleep(1500);
  check(pdfRequests === 0 && /Waiting for the summary/.test((await buttonText()) || ""), "while the summary is still being written the button waits instead of exporting an unfinished report");
  summary = "ready";
  await page.waitForFunction(() => [...document.querySelectorAll("button")].some((b) => /^Export as PDF$/.test(b.textContent.trim()) && !b.disabled), { timeout: 15000 });
  for (let i = 0; i < 40 && files().length < 1; i++) await sleep(250);
  check(pdfRequests === 1 && files().length === 1, "once the summary is ready the PDF is built and saved (exactly one request)");

  files().forEach((f) => rmSync(join(dir, f)));                  // same file name each time: start the next check from an empty folder
  // ---------------------------------------------------------------- the click: loader, then a downloaded file
  summary = "ready"; slowPdfMs = 1200;
  page = await browser.newPage(); await page.setViewport({ width: 1280, height: 900 }); await prepare(page); await page.goto(`${BASE}/#/report/${rep}`, { waitUntil: "networkidle0" }); await page.waitForSelector('[data-testid="scorecard"]');
  await clickText(page, "button", "Export as PDF", { exact: true });
  await page.waitForFunction(() => { const b = [...document.querySelectorAll("button")].find((x) => /Preparing PDF/.test(x.textContent)); return b && b.disabled && b.getAttribute("aria-busy") === "true" && b.querySelector(".spinner"); }, { timeout: 3000 });
  check(true, "pressing Export as PDF turns the button into a disabled “Preparing PDF…” with a spinner");
  await shot(page, "pdf-loader");
  for (let i = 0; i < 60 && files().length < 1; i++) await sleep(250);
  const file = files()[0];
  check(!!file && /^interview-report-.*\.pdf$/.test(file), `a PDF file was saved with a sensible name (${file})`);
  const bytes = readFileSync(join(dir, file));
  const pages = (bytes.toString("latin1").match(/\/Type\s*\/Page[^s]/g) || []).length;
  check(bytes.subarray(0, 5).toString() === "%PDF-" && statSync(join(dir, file)).size > 4000 && pages >= 2, `it is a real multi-page PDF (${(bytes.length / 1024).toFixed(0)} KB, ${pages} pages)`);
  check((await page.evaluate(() => window.__printed)) === 0, "the browser's print dialog was never opened");
  await page.waitForFunction(() => [...document.querySelectorAll("button")].some((b) => /^Export as PDF$/.test(b.textContent.trim()) && !b.disabled), { timeout: 5000 });
  check(/Saved interview-report/.test(await textOf(page)), "the button returns to normal and a “Saved …” message confirms the download");
  slowPdfMs = 0;

  // ---------------------------------------------------------------- the other formats are untouched
  const links = await page.$$eval("a[download]", (a) => a.map((x) => x.textContent.trim()));
  check(links.includes("Export as JSON") && links.includes("Markdown"), "JSON and Markdown downloads are still there");
  reportIssues(issues, ["net::ERR_ABORTED"]);
} catch (e) { console.log("FAIL  exception: " + (e.stack || e)); process.exitCode = 1; }
finally { await browser.close(); be.proc.kill(); }
console.log(process.exitCode ? "\nSOME CHECKS FAILED" : "\nALL CHECKS PASSED");
