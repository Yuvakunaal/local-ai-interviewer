// Real-Chrome end-to-end harness (puppeteer-core drives the installed Google Chrome; no browser download).
// It starts its OWN backend on port 3100 with a throw-away data dir, so your real interview data is never touched.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import puppeteer from "puppeteer-core";

export const ROOT = resolve(import.meta.dirname, "../..");
export const PORT = 3100;
export const BASE = `http://localhost:${PORT}`;
export const OUT = process.env.E2E_OUT || join(tmpdir(), "lai-e2e");
mkdirSync(OUT, { recursive: true });

/** Google Chrome (or Chromium / Edge) on macOS, Windows or Linux. Override with CHROME_PATH. */
function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const env = process.env;
  const candidates = {
    darwin: ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium", "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"],
    win32: [`${env["ProgramFiles"]}\\Google\\Chrome\\Application\\chrome.exe`, `${env["ProgramFiles(x86)"]}\\Google\\Chrome\\Application\\chrome.exe`,
      `${env["LOCALAPPDATA"]}\\Google\\Chrome\\Application\\chrome.exe`, `${env["ProgramFiles(x86)"]}\\Microsoft\\Edge\\Application\\msedge.exe`, `${env["ProgramFiles"]}\\Microsoft\\Edge\\Application\\msedge.exe`],
    linux: ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/snap/bin/chromium", "/usr/bin/microsoft-edge"],
  }[process.platform] ?? [];
  const found = candidates.find((c) => existsSync(c));
  if (!found) throw new Error("Chrome/Chromium/Edge not found. Set CHROME_PATH to the browser executable.");
  return found;
}
const CHROME = findChrome();
export const VENV_PYTHON = join(ROOT, "backend", ".venv", ...(process.platform === "win32" ? ["Scripts", "python.exe"] : ["bin", "python"]));

export async function startBackend(extraEnv = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "lai-data-"));
  const proc = spawn(VENV_PYTHON,
    ["-m", "uvicorn", "app.main:app_factory", "--factory", "--host", "127.0.0.1", "--port", String(PORT), "--log-level", "warning"],
    { cwd: join(ROOT, "backend"), env: { ...process.env, DATA_DIR: dataDir, APP_PORT: String(PORT), HF_HUB_OFFLINE: "1", PYTHONUTF8: "1", ...extraEnv }, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  proc.stdout.on("data", (d) => (log += d)); proc.stderr.on("data", (d) => (log += d));
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`http://127.0.0.1:${PORT}/api/health`)).ok) return { proc, dataDir, log: () => log }; } catch {}
    await sleep(500);
  }
  proc.kill(); throw new Error("backend did not start:\n" + log);
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function launch({ width = 1280, height = 900, args = [], gate = false } = {}) {
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: true,
    args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--no-first-run", "--disable-search-engine-choice-screen", ...args],
    defaultViewport: { width, height },
  });
  const page = await browser.newPage();
  if (!gate) await page.evaluateOnNewDocument(() => { try { sessionStorage.setItem("lai.setup.skip", "1"); } catch { /* ignore */ } });   // tests do not depend on what is installed here
  const issues = { console: [], pageErrors: [], failedRequests: [], badResponses: [], external: [] };
  page.on("console", (m) => { if (["error", "warning"].includes(m.type())) issues.console.push(`${m.type()}: ${m.text()}`); });
  page.on("pageerror", (e) => issues.pageErrors.push(String(e)));
  page.on("requestfailed", (r) => issues.failedRequests.push(`${r.method()} ${r.url()} ${r.failure()?.errorText}`));
  page.on("response", (r) => { if (r.status() >= 400) issues.badResponses.push(`${r.status()} ${r.request().method()} ${r.url().replace(BASE, "")}`); });
  page.on("request", (r) => { const u = new URL(r.url()); if (!["localhost", "127.0.0.1"].includes(u.hostname) && !r.url().startsWith("data:") && !r.url().startsWith("blob:")) issues.external.push(r.url()); });
  // observe audio without changing behaviour
  await page.evaluateOnNewDocument(() => {
    window.__audio = { plays: 0, active: 0, maxActive: 0, srcs: [] };
    const orig = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () {
      const a = window.__audio;
      return orig.call(this).then((r) => {                       // count only plays the browser actually allowed
        a.plays++; a.srcs.push(this.src.slice(0, 20)); a.active++; a.maxActive = Math.max(a.maxActive, a.active);
        const done = () => { a.active = Math.max(0, a.active - 1); this.removeEventListener("pause", done); this.removeEventListener("ended", done); };
        this.addEventListener("pause", done); this.addEventListener("ended", done);
        return r;
      });
    };
  });
  return { browser, page, issues };
}

export async function clickText(page, selector, text, { exact = false, timeout = 10000 } = {}) {
  const handle = await page.waitForFunction((sel, t, ex) => [...document.querySelectorAll(sel)].find((e) => {
    const x = (e.textContent || "").trim(); return !e.disabled && e.offsetParent !== null && (ex ? x === t : x.includes(t)); }) || null, { timeout }, selector, text, exact);
  await handle.asElement().click();
}
// Simulates a paste: native value setter + bubbling input event (what React listens to).
export const setText = (page, sel, text) => page.$eval(sel, (el, t) => {
  const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value").set.call(el, t);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}, text);
export const textOf = (page, sel = "body") => page.$eval(sel, (e) => e.innerText);
export async function waitText(page, text, timeout = 15000) { await page.waitForFunction((t) => document.body.innerText.includes(t), { timeout }, text); }
export async function overflow(page) { return page.evaluate(() => ({ doc: document.documentElement.scrollWidth - document.documentElement.clientWidth, body: document.body.scrollWidth - window.innerWidth })); }
export const shot = (page, name) => page.screenshot({ path: join(OUT, `${name}.png`), fullPage: true });

export function check(cond, label) { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) process.exitCode = 1; return cond; }
export function reportIssues(issues, allow = []) {
  const keep = (s) => !allow.some((a) => s.includes(a));
  const c = issues.console.filter(keep), p = issues.pageErrors, f = issues.failedRequests.filter(keep), b = issues.badResponses.filter(keep);
  check(c.length === 0, `no console errors/warnings${c.length ? ": " + c.join(" | ") : ""}`);
  check(p.length === 0, `no uncaught page errors${p.length ? ": " + p.join(" | ") : ""}`);
  check(f.length === 0, `no failed network requests${f.length ? ": " + f.join(" | ") : ""}`);
  check(b.length === 0, `no unexpected HTTP error responses${b.length ? ": " + b.join(" | ") : ""}`);
  check(issues.external.length === 0, `no requests left localhost${issues.external.length ? ": " + issues.external.join(" | ") : ""}`);
}
