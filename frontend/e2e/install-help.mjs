// The plain page opened when Python or Node is missing (there is no app yet): shown straight from the file, no server, nothing loaded from the internet.
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { ROOT, check, launch, overflow, shot, textOf } from "./lib.mjs";

const { browser, page, issues } = await launch({ width: 1000, height: 900 });
const reqs = []; page.on("request", (r) => reqs.push(r.url()));
const url = pathToFileURL(join(ROOT, "scripts", "setup-required.html")).href;
try {
  await page.goto(`${url}?need=python,node`, { waitUntil: "networkidle0" });
  const text = await textOf(page);
  check(/One more thing before AI Interviewer can start/.test(text) && /Python 3\.10 or newer/.test(text) && /Node\.js 18 or newer/.test(text), "it names exactly what is missing");
  const mac = (await page.$$eval(".need code", (c) => c.map((x) => x.textContent))).join("|");
  check(/brew install python/.test(mac) && /brew install node/.test(mac), `macOS steps (Homebrew) are shown for a Mac (${mac})`);
  await page.evaluate(() => document.querySelector('[data-os="windows"]').click());
  const win = (await page.$$eval(".need code", (c) => c.map((x) => x.textContent))).join("|");
  check(/winget install Python\.Python\.3\.12/.test(win) && /winget install OpenJS\.NodeJS\.LTS/.test(win) && /start\.bat/.test(await textOf(page, "#after")), "the Windows tab shows winget commands and says to run start.bat again");
  await page.evaluate(() => document.querySelector('[data-os="linux"]').click());
  check(/apt install python3/.test(await textOf(page, "#needs")) && /\.\/start\.sh/.test(await textOf(page, "#after")), "the Linux tab shows apt commands and ./start.sh");
  await page.goto(`${url}?need=node`, { waitUntil: "networkidle0" });
  check(!/Python 3\.10/.test(await textOf(page, "#needs")) && /Node\.js/.test(await textOf(page, "#needs")), "?need=node lists only Node");
  const links = await page.$$eval("a[href^=http]", (a) => a.map((x) => x.rel));
  check(links.length > 0 && links.every((r) => /noopener/.test(r)), "download links open in a new tab safely");
  check(reqs.every((u) => u.startsWith("file:") || u.startsWith("data:")), "the page loads nothing from the internet");
  await shot(page, "install-help");
  await page.setViewport({ width: 390, height: 800, isMobile: true }); await page.reload({ waitUntil: "networkidle0" });
  const o = await overflow(page);
  check(o.doc <= 0 && o.body <= 0, "no sideways scrolling on a phone");
  check(issues.pageErrors.length === 0, "no script errors");
} catch (e) { console.log("FAIL  exception: " + (e.stack || e)); process.exitCode = 1; }
finally { await browser.close(); }
console.log(process.exitCode ? "\nSOME CHECKS FAILED" : "\nALL CHECKS PASSED");
