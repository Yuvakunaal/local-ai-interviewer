// First run on a computer that is missing things: the app opens on a plain checklist in the middle of the page, says what to install and how,
// notices by itself when it is done, downloads the model with one click (with progress, cancel and retry), or lets the user choose cloud / continue.
import { BASE, check, clickText, launch, overflow, reportIssues, shot, sleep, startBackend, textOf, waitText } from "./lib.mjs";
import { startFakeOllama } from "./fakeollama.mjs";
import { SWEEP } from "./sweep-lib.mjs";

const fo = await startFakeOllama({ models: [], pullSteps: 8, pullDelayMs: 300 });
fo.state.up = false;                                           // Ollama is not running
const be = await startBackend({ OLLAMA_HOST_URL: fo.url, OLLAMA_API_KEY: "" });
const { browser, page, issues } = await launch({ width: 1280, height: 900, gate: true });
const api = async (p) => (await fetch(`${BASE}${p}`)).json();
const rowOf = (label) => page.evaluate((l) => { const r = [...document.querySelectorAll(".gate-row")].find((x) => x.querySelector("b")?.textContent.includes(l)); return r ? { text: r.innerText.replace(/\s+/g, " "), cls: r.className, buttons: [...r.querySelectorAll("button")].map((b) => b.textContent.trim()) } : null; }, label);
try {
  // ---------------------------------------------------------------- the first thing a new user sees
  await page.goto(BASE, { waitUntil: "networkidle0" });
  await page.waitForSelector(".gate-card");
  check((await page.$(".sidebar")) === null && /Let’s get you set up/.test(await textOf(page, "h1")), "the app opens on a setup page in the middle of the screen (no app around it) when something is missing");
  const intro = await textOf(page, ".gate-head");
  check(/more things|more thing/.test(intro) && /macOS|Windows|Linux/.test(intro), `it says how much is missing and names this computer's system (${intro.replace(/\s+/g, " ").slice(0, 110)})`);
  const ollama = await rowOf("Ollama");
  check(ollama && /Needed/.test(ollama.text) && /bad/.test(ollama.cls) && /(not installed|installed, but not running)/.test(ollama.text), `Ollama is marked Needed with the reason (${ollama?.text.slice(0, 90)})`);
  check(/ollama serve|Download|brew install|winget|install\.sh/.test(ollama.text) && (await page.$$(".gate-cmd code, .gate-help a")).length > 0, "…and exact install / start steps are shown, with commands you can copy");
  const python = await rowOf("Python");
  check(python && /Ready/.test(python.text) && /running this app/.test(python.text), "Python is checked too (ready: it is what runs this page)");
  const model = await rowOf("Interview model");
  check(model && /Needed/.test(model.text) && /needs Ollama running first/.test(model.text) && !model.buttons.some((b) => /Download the model/.test(b)), "the model row waits for Ollama and offers no download yet");
  const optional = await textOf(page, ".gate-card");
  check(/Nice to have/.test(optional) && /Voice/.test(optional) && /Microphone answers/.test(optional), "voice and microphone are listed as optional extras");
  const sweep = await page.evaluate(SWEEP);
  check(sweep.length === 0, `the setup page passes the accessibility sweep${sweep.length ? ": " + sweep.join(" | ") : ""}`);
  await shot(page, "gate-missing-light");
  await page.evaluate(() => localStorage.setItem("lai.theme", "dark")); await page.reload({ waitUntil: "networkidle0" }); await page.waitForSelector(".gate-card"); await shot(page, "gate-missing-dark");
  await page.evaluate(() => localStorage.setItem("lai.theme", "light")); await page.reload({ waitUntil: "networkidle0" }); await page.waitForSelector(".gate-card");

  // ---------------------------------------------------------------- the page notices when Ollama starts, with no click
  fo.state.up = true;
  await page.waitForFunction(() => [...document.querySelectorAll(".gate-row")].some((r) => /Ollama/.test(r.textContent) && /Ready/.test(r.textContent)), { timeout: 9000 });
  check(true, "once Ollama is running the checklist updates by itself (Ollama turns Ready)");
  const model2 = await rowOf("Interview model");
  check(model2.buttons.some((b) => /Download the model \(about 4 GB\)/.test(b)) && /Nothing is downloaded until you press this/.test(model2.text), "the model row now offers “Download the model (about 4 GB)” and promises nothing downloads until pressed");
  check(fo.state.pulls.length === 0, "nothing was downloaded yet");

  // ---------------------------------------------------------------- one-click download with progress, cancel, error and retry
  await clickText(page, "button", "Download the model");
  await page.waitForSelector('.gate-pull [role=progressbar]', { timeout: 5000 });
  await page.waitForFunction(() => { const b = document.querySelector('.gate-pull [role=progressbar]'); return b && Number(b.getAttribute("aria-valuenow")) > 0; }, { timeout: 5000 });
  check((await textOf(page, ".gate-pull")).includes("Cancel"), "a progress bar with a percentage and a Cancel button appears");
  await shot(page, "gate-downloading");
  await clickText(page, ".gate-pull button", "Cancel");
  await page.waitForFunction(() => /Download cancelled/.test(document.body.innerText), { timeout: 6000 });
  check(true, "Cancel stops the download and says it resumes where it stopped");
  fo.state.failNext = "pull model manifest: file does not exist";
  await clickText(page, "button", "Start again");
  await page.waitForFunction(() => /The download failed/.test(document.body.innerText), { timeout: 6000 });
  check(/file does not exist/.test(await textOf(page, ".gate-pull")), "a failed download says why and offers Try again");
  await clickText(page, "button", "Try again");
  await page.waitForFunction(() => /Everything is ready/.test(document.body.innerText), { timeout: 20000 });
  check(fo.state.models.includes("qwen3.5:4b") && /Start practicing/.test(await textOf(page, ".gate-foot")), "after the download the page switches to “Everything is ready” with a Start practicing button");
  await shot(page, "gate-ready");
  await clickText(page, "button", "Start practicing");
  await page.waitForSelector(".sidebar");
  check(true, "Start practicing opens the app");
  await page.evaluate(() => sessionStorage.clear()); await page.reload({ waitUntil: "networkidle0" }); await page.waitForSelector(".sidebar");
  check((await page.$(".gate-card")) === null, "on the next start, with everything installed, there is no setup page at all");

  // ---------------------------------------------------------------- the check can be opened again; the choices on a missing setup
  await page.evaluate(() => (location.hash = "#/welcome")); await page.waitForSelector(".gate-card");
  check(/Everything is ready/.test(await textOf(page, "h1")) && /Back to the app/.test(await textOf(page, ".gate-foot")), "#/welcome re-runs the check any time (and says all is well)");
  await clickText(page, "button", "Back to the app"); await page.waitForSelector(".sidebar");
  fo.state.models = []; fo.state.failNext = null;
  await page.evaluate(() => sessionStorage.clear()); await page.reload({ waitUntil: "networkidle0" }); await page.waitForSelector(".gate-card");
  check(/Interview model/.test(await textOf(page, ".gate-card")) && !/Everything is ready/.test(await textOf(page, "h1")), "removing the model brings the setup page back");
  await clickText(page, "button", "Use cloud models instead");
  await page.waitForSelector(".ai-page");
  check(/#\/settings/.test(await page.evaluate(() => location.hash)) && (await page.$(".gate-card")) === null, "“Use cloud models instead” goes straight to Settings → AI models");
  await page.evaluate(() => sessionStorage.clear()); await page.reload({ waitUntil: "networkidle0" }); await page.waitForSelector(".gate-card");
  await clickText(page, "button", "Continue anyway");
  await page.waitForSelector(".sidebar");
  check((await page.$(".gate-card")) === null, "“Continue anyway” lets you into the app");
  await page.reload({ waitUntil: "networkidle0" }); await page.waitForSelector(".sidebar");
  check((await page.$(".gate-card")) === null, "…and the page does not nag again during this visit");

  // ---------------------------------------------------------------- phone width
  await page.evaluate(() => sessionStorage.clear()); await page.setViewport({ width: 390, height: 844, isMobile: true });
  await page.goto(BASE, { waitUntil: "networkidle0" }); await page.reload({ waitUntil: "networkidle0" }); await page.waitForSelector(".gate-card");
  const o = await overflow(page);
  check(o.doc <= 0 && o.body <= 0, "no sideways scrolling on a phone");
  await shot(page, "gate-phone");
  reportIssues(issues, ["net::ERR_ABORTED"]);
} catch (e) { console.log("FAIL  exception: " + (e.stack || e)); process.exitCode = 1; console.log("body:", (await textOf(page).catch(() => "")).slice(0, 500)); }
finally { await browser.close(); be.proc.kill(); await fo.stop(); }
console.log(process.exitCode ? "\nSOME CHECKS FAILED" : "\nALL CHECKS PASSED");
