// New UI features in real Chrome against an isolated seeded backend: command palette, keyboard shortcuts, theme
// (persist / system), dashboard + "practice weakest topics", first-run name prompt, interview timer + word count.
import { BASE, check, clickText, launch, reportIssues, setText, shot, sleep, startBackend, textOf, waitText } from "./lib.mjs";
import { seedHistory } from "./seed.mjs";

const be = await startBackend();
seedHistory(be.dataDir);
const { browser, page, issues } = await launch();
let warmCalls = 0;
page.on("request", (r) => { if (r.method() === "POST" && r.url().endsWith("/api/llm/warm")) warmCalls++; });
// lets a check pretend the computer is low on memory by rewriting the /api/health reply (the page reads window.__mem)
await page.evaluateOnNewDocument(() => {
  const real = window.fetch.bind(window);
  window.fetch = async (...a) => {
    const res = await real(...a);
    if (String(a[0]).includes("/api/health") && (window.__mem || window.__llmLoaded !== undefined)) {
      const d = await res.clone().json();
      if (window.__mem) d.memory = window.__mem;
      if (window.__llmLoaded !== undefined) d.llm.loaded = window.__llmLoaded;
      return new Response(JSON.stringify(d), { status: 200, headers: { "content-type": "application/json" } });
    }
    return res;
  };
});
const hash = () => page.evaluate(() => location.hash);
const theme = () => page.$eval("html", (e) => e.dataset.theme);
const post = (path, body) => fetch(`${BASE}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
try {
  const sets = await (await fetch(`${BASE}/api/sets`)).json();
  for (const [text, topic] of [["How would you design a star schema for retail sales?", "Modeling"], ["Explain micro-partitions and pruning in Snowflake.", "Snowflake"], ["What is a CTE and when do you use one?", "SQL"]])
    await post(`/api/sets/${sets[0].id}/questions`, { text, topic });

  // ---------------------------------------------------------------- first-run name prompt (no hard-coded author name)
  await page.goto(BASE, { waitUntil: "networkidle0" });
  await waitText(page, "Your progress");
  let body = await textOf(page);
  check(!body.includes("Kunaal") && /Your practice/.test(body) && body.includes("What should we call you?"), "first run: neutral greeting and a prompt for the name");
  await setText(page, '.welcome input[type=text]', "Ada");
  await clickText(page, ".welcome button", "Save");
  await waitText(page, "Ada");
  check((await textOf(page, "h1.hello")).includes("Ada’s practice"), "greeting uses the saved name");
  await page.reload({ waitUntil: "networkidle0" });
  await waitText(page, "Your progress");
  check((await textOf(page, "h1.hello")).includes("Ada’s practice") && !(await textOf(page)).includes("What should we call you?"), "name persists and the prompt is gone");

  // ---------------------------------------------------------------- dashboard from seeded history
  body = await textOf(page);
  check(/Average score[\s\S]*6\.7/.test(body) && /Interviews\s*6/.test(body) && /Practice streak\s*2/.test(body), "KPIs: average 6.7, 6 interviews, 2-day streak");
  check(/▲ 1\.6/.test(body), "KPI: improvement vs earlier runs is shown");
  check((await page.$$(".trend .pt")).length === 6 && (await page.$eval(".trend a", (a) => a.getAttribute("href"))).startsWith("#/report/"), "trend chart has one linked point per interview");
  const focus = await page.$$eval(".focus-row .nm", (els) => els.map((e) => e.textContent));
  check(focus[0] === "Snowflake" && focus.includes("SQL"), `focus areas list the weakest topic first (${focus.join(", ")})`);
  const note = await textOf(page, ".focus-note");
  check(/Will preselect your “Snowflake”, “Modeling” and “SQL” \(the 3 weakest of 4\) in the interview setup/.test(note), `the card says exactly which topics it will practice (${note.replace(/\s+/g, " ")})`);
  await clickText(page, "button", "Practice my weakest topics");
  await page.waitForFunction(() => location.hash === "#/setup");
  await page.waitForSelector(".sec");
  await sleep(500);
  const setupText = await textOf(page);
  check(/Practicing “Snowflake”, “Modeling” and “SQL” — 3 questions preselected/.test(setupText), "Setup repeats what you are practicing, by name");
  check(setupText.includes("Selected (3)") && setupText.includes("All questions (3)"), "'Practice weakest topics' preselects the questions of the 3 weakest topics (Snowflake, Modeling, SQL) in the interview setup");
  check(await page.$eval('.seg [aria-checked=true]', () => true).catch(() => false) && (await page.$$eval('.seg button[aria-checked=true]', (b) => b.map((x) => x.textContent))).some((x) => x.startsWith("Selected")), "…and switches the setup to 'Selected' questions");

  // ---------------------------------------------------------------- command palette
  await page.goto(`${BASE}/#/home`, { waitUntil: "networkidle0" });
  await page.keyboard.down("Control"); await page.keyboard.press("k"); await page.keyboard.up("Control");
  await page.waitForSelector(".palette");
  check(await page.$eval(".palette input", (i) => document.activeElement === i), "Ctrl+K opens the palette with the search box focused");
  check((await textOf(page, ".pal-list")).includes("Start a new interview") && (await textOf(page, ".pal-list")).includes("Settings"), "palette lists actions and pages");
  await page.type(".palette input", "sett");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => location.hash === "#/settings");
  check(!(await page.$(".palette")), "Enter runs the highlighted item (go to Settings) and closes the palette");
  await page.keyboard.down("Control"); await page.keyboard.press("k"); await page.keyboard.up("Control");
  await page.waitForSelector(".palette");
  await page.type(".palette input", "micro-partitions");
  await sleep(200);
  check((await textOf(page, ".pal-list")).includes("Explain micro-partitions"), "palette finds a question by its words");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => location.hash === "#/questions");
  await sleep(500);
  check((await page.$eval('input[type=search]', (i) => i.value)).startsWith("Explain micro-partitions"), "choosing a question opens the Question Bank filtered to it");
  await page.keyboard.down("Control"); await page.keyboard.press("k"); await page.keyboard.up("Control");
  await page.waitForSelector(".palette");
  await page.type(".palette input", "add a q");
  await page.keyboard.press("Enter");
  await page.waitForSelector('[role=dialog][aria-label="Add Question"]');
  check(true, "'Add a question' opens the Add Question dialog even when already on that page");
  await page.keyboard.press("Escape");
  await page.keyboard.down("Control"); await page.keyboard.press("k"); await page.keyboard.up("Control");
  await page.waitForSelector(".palette");
  await page.type(".palette input", "zzzzqq");
  check((await textOf(page, ".pal-list")).includes("Nothing matches"), "palette says so when nothing matches");
  await page.keyboard.press("Escape");
  check(!(await page.$(".palette")), "Esc closes the palette");

  // ---------------------------------------------------------------- shortcuts
  await page.goto(`${BASE}/#/home`, { waitUntil: "networkidle0" });
  await page.keyboard.press("?");
  await page.waitForSelector('[aria-label="Keyboard shortcuts"]');
  check((await textOf(page, '[aria-label="Keyboard shortcuts"]')).includes("Open the command palette"), "? shows the keyboard shortcuts");
  await page.keyboard.press("Escape");
  await sleep(150);
  await page.keyboard.press("g"); await page.keyboard.press("h");
  await page.keyboard.press("g"); await page.keyboard.press("y");
  await page.waitForFunction(() => location.hash === "#/history");
  check(true, "'g' then 'y' jumps to History");
  await page.goto(`${BASE}/#/questions`, { waitUntil: "networkidle0" });
  await page.waitForSelector('input[type=search]');
  await page.click('input[type=search]');
  await page.keyboard.type("gq?");
  check((await hash()) === "#/questions" && (await page.$eval('input[type=search]', (i) => i.value)) === "gq?", "shortcuts are ignored while typing in a field");

  // ---------------------------------------------------------------- theme
  await page.goto(`${BASE}/#/home`, { waitUntil: "networkidle0" });
  check((await theme()) === "light", "default theme is light");
  await page.click(".sb-theme");
  check((await theme()) === "dark", "sidebar toggle: light -> dark");
  await page.reload({ waitUntil: "networkidle0" });
  check((await theme()) === "dark", "dark theme survives a reload (applied before first paint)");
  await page.click(".sb-theme");                                     // dark -> system
  await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }]);
  await sleep(200);
  check((await theme()) === "light", "system mode follows the OS (light)");
  await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "dark" }]);
  await sleep(200);
  check((await theme()) === "dark", "system mode follows the OS live (dark)");
  await page.goto(`${BASE}/#/settings`, { waitUntil: "networkidle0" });
  await clickText(page, ".tabbar button", "Profile");
  await clickText(page, '[aria-label="Colour theme"] button', "Light");
  check((await theme()) === "light" && (await page.evaluate(() => localStorage.getItem("lai.theme"))) === "light", "Settings → Appearance sets and saves the theme");
  await page.keyboard.down("Control"); await page.keyboard.press("k"); await page.keyboard.up("Control");
  await page.type(".palette input", "theme dark");
  await page.keyboard.press("Enter");
  await sleep(150);
  check((await theme()) === "dark", "the palette can switch the theme too");

  // ---------------------------------------------------------------- sidebar: Model usage above "Local services", no Search button
  await page.goto(`${BASE}/#/home`, { waitUntil: "networkidle0" });
  check((await page.$(".sidebar .sb-search")) === null && !(await page.$$eval(".sidebar button", (bs) => bs.some((b) => /search/i.test(b.getAttribute("aria-label") || b.textContent)))), "the sidebar has no Search button any more");
  const order = await page.evaluate(() => {
    const link = document.querySelector('.sidebar a[href="#/usage"]'), status = document.querySelector(".sidebar .status");
    return { has: !!link, label: link?.textContent.trim(), above: !!link && !!status && !!(link.compareDocumentPosition(status) & Node.DOCUMENT_POSITION_FOLLOWING), section: link?.closest(".sb-group")?.querySelector(".sb-section")?.textContent.trim() };
  });
  check(order.has && order.above && /Model usage/.test(order.label) && order.section === "Models", `"Model usage" is its own sidebar section, above "Local services" (${order.section})`);
  await page.keyboard.press("g"); await page.keyboard.press("u");
  await page.waitForFunction(() => location.hash === "#/usage");
  check(true, "'g' then 'u' opens Model usage");
  check(!(await page.$$eval(".tabbar button", (b) => b.some((x) => /Model usage/.test(x.textContent)))) , "Model usage is no longer a tab inside Settings");

  // ---------------------------------------------------------------- Model usage page (tokens, time and where it goes)
  await page.goto(`${BASE}/#/usage`, { waitUntil: "networkidle0" });
  await page.waitForSelector(".usage-tbl tbody tr");
  await page.waitForFunction(() => document.body.innerText.includes("Report summary"));
  let usageText = await textOf(page);
  check(/^Model usage/.test(await textOf(page, "main h1")) && usageText.includes("Where the time goes") && usageText.includes("Tokens by task"), "Model usage is a full page with its own charts");
  check(usageText.includes("Grading an answer") && usageText.includes("Cleaning up a voice transcript") && usageText.includes("Report summary") && usageText.includes("Reading a question aloud"), "every kind of model call is listed with a plain-English name");
  const kpis = await page.$$eval(".kpi", (ks) => ks.map((k) => k.innerText.replace(/\s+/g, " ")));
  check(kpis.some((k) => /Tokens read 5,020/.test(k)) && kpis.some((k) => /Tokens written 1,952/.test(k)), `headline numbers add up (${kpis.slice(0, 2).join(" | ")})`);
  const gradeRow = await page.$$eval(".usage-tbl tbody tr", (rs) => rs.map((r) => r.innerText.replace(/\s+/g, " ")).find((x) => x.startsWith("Grading an answer")));
  check(/Grading an answer(?: This computer)? qwen3\.5:4b[^0-9]*3 3,740 1,578/.test(gradeRow) && /tok\/s/.test(gradeRow), `grading row sums tokens read/written (${gradeRow?.slice(0, 90)})`);
  check(/25\.4 s – 42\.5 s/.test(gradeRow) && /load 5\.1 s/.test(gradeRow), "…shows fastest–slowest and where the average call's time goes (load / read / write)");
  check(/Today[\s\S]*All time/.test(await textOf(page, ".seg")) , "there is a Today / All time switch");
  await page.waitForFunction(() => /GB\s+free of/.test(document.body.innerText) && /In memory right now/.test(document.body.innerText), { timeout: 20000 }).catch(() => {});   // the memory card loads a moment after the rest
  usageText = await textOf(page);
  check(/GB\s+free of/.test(usageText) && /In memory right now/.test(usageText), "it shows live memory and what is loaded now");
  check(/model load 15\.2 s/.test(usageText), "the slow model load (the moment a computer can freeze) is flagged in the latest calls");
  const forLinks = await page.$$eval('.usage-tbl a[href^="#/report/"]', (as) => as.map((a) => a.textContent));
  check(forLinks.length >= 3 && forLinks[0].startsWith("Practice Interview"), `each call says which interview it was for, with a link to its report (${forLinks.length} links)`);
  check(/Q1/.test(await textOf(page, ".usage-tbl:last-of-type")) || /Q1/.test(usageText), "…and which question (Q1, Q2…)");
  check(/58 characters, 3\.4 s of audio/.test(usageText), "spoken questions show characters and audio length instead of tokens");
  check(usageText.includes("What do these numbers mean?") && !/SECRET|ORIGINAL QUESTION/.test(usageText), "it explains the numbers and shows no prompt text");
  await clickText(page, ".seg button", "All time");
  await page.waitForFunction(() => document.querySelector(".seg button.on")?.textContent.includes("All time"));
  check(await page.evaluate(() => localStorage.getItem("lai.usage.range")) === "all", "the chosen range is remembered");
  // the memory card must tell the truth in every state (it once said "Enough room" while only 0.9 GB was free, because the model was loaded)
  const memoryCard = async (mem, loaded) => {
    await page.evaluate((m, l) => { window.__mem = m; window.__llmLoaded = l; }, mem, loaded);
    await clickText(page, "button", "Refresh");
    await sleep(700);
    return (await page.$$eval(".card", (cs) => cs.map((c) => c.innerText).find((x) => x.startsWith("Computer memory")))).replace(/\s+/g, " ");
  };
  let card = await memoryCard({ total_gb: 8, available_gb: 2.4, needs_gb: 4.3, tight: true }, false);
  check(/Tight\./.test(card) && /only 2\.4 GB is free/.test(card) && !/Enough/.test(card), `memory card, model not loaded and little free: warns with the real numbers (${card.slice(0, 120)})`);
  card = await memoryCard({ total_gb: 8, available_gb: 6.5, needs_gb: 4.3, tight: false }, false);
  check(/Enough room for the model/.test(card) && !/Tight/.test(card), "memory card, model not loaded and plenty free: says there is enough room");
  card = await memoryCard({ total_gb: 8, available_gb: 0.9, needs_gb: 4.3, tight: false }, true);
  check(/The model is loaded/.test(card) && /using about 4\.3 GB/.test(card) && !/Enough room/.test(card) && /0\.9 GB free of 8 GB/.test(card), `memory card, model loaded and little free: explains why instead of claiming "enough room" (${card.slice(0, 130)})`);
  await page.evaluate(() => { window.__mem = null; window.__llmLoaded = undefined; });

  await clickText(page, "button", "Clear history");
  await page.waitForSelector('[role=dialog]');
  await clickText(page, '[role=dialog] button', "Clear history");
  await waitText(page, "Nothing recorded yet");
  check(true, "clearing the history asks first and empties it");

  // ---------------------------------------------------------------- low-memory heads-up before the model is loaded
  await page.reload({ waitUntil: "networkidle0" });
  await page.evaluate(() => { window.__mem = { total_gb: 8, available_gb: 2.4, needs_gb: 4.3, tight: true }; });
  await sleep(4300);                                                  // the app reuses a health reading for 4 s; wait for the fake numbers to be read
  await page.goto(`${BASE}/#/setup`, { waitUntil: "networkidle0" });
  await page.waitForSelector(".sec");
  await sleep(600);
  if (await page.$(".ready.ok")) {
    const warn = await textOf(page, ".summary");
    check(warn.includes("Low free memory") && warn.includes("2.4 GB free of 8 GB") && warn.includes("about 4.3 GB"), "Setup warns when free memory is too low for the model (with the real numbers)");
    await page.evaluate(() => { window.__mem = { total_gb: 8, available_gb: 6.5, needs_gb: 4.3, tight: false }; });
    await sleep(4300);
    await page.goto(`${BASE}/#/home`, { waitUntil: "networkidle0" });
    await page.goto(`${BASE}/#/setup`, { waitUntil: "networkidle0" });
    await page.waitForSelector(".sec"); await sleep(600);
    check(!(await textOf(page, ".summary")).includes("Low free memory"), "…and stays quiet when there is enough memory");
  } else check(true, "model not installed on this machine: memory notice not applicable");
  await page.evaluate(() => { window.__mem = null; });

  // ---------------------------------------------------------------- interview: timer + word count (dark, full screen)
  await page.goto(`${BASE}/#/setup`, { waitUntil: "networkidle0" });
  await page.waitForSelector(".sec");
  await page.evaluate(() => localStorage.setItem("lai.setup", "{}"));
  await clickText(page, "button", "Start Interview");
  await page.waitForSelector("#answer", { timeout: 15000 });
  await sleep(2300);
  const clock = await textOf(page, ".ans-meta .tm");
  check(/^0?0:0[1-9]$/.test(clock.trim()), `the per-question timer is running (${clock.trim()})`);
  await page.type("#answer", "Idempotency means running a job twice gives the same result.");
  await sleep(150);
  check((await textOf(page, ".ans-meta")).includes("10 words"), "word count updates as you type");
  await shot(page, "features-interview-dark");
  await sleep(5000);
  check(warmCalls >= 1, `the AI model is asked to load a few seconds into the interview, before the first answer (${warmCalls} warm-up call)`);
  // ---------------------------------------------------------------- phone width (390px)
  await page.setViewport({ width: 390, height: 844, isMobile: true });
  for (const theme of ["light", "dark"]) {
    await page.evaluate((x) => localStorage.setItem("lai.theme", x), theme);
    await page.goto(`${BASE}/#/home`, { waitUntil: "networkidle0" });
    await page.reload({ waitUntil: "networkidle0" });
    await waitText(page, "Your progress");
    const ov = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check(ov <= 1, `[${theme}] phone: Home dashboard has no sideways scroll (overflow ${ov}px)`);
    const cols = await page.$eval(".kpis", (e) => getComputedStyle(e).gridTemplateColumns.split(" ").length);
    check(cols === 2, `[${theme}] phone: KPI cards wrap to 2 columns`);
    await page.keyboard.down("Control"); await page.keyboard.press("k"); await page.keyboard.up("Control");
    await page.waitForSelector(".palette");
    const box = await page.$eval(".palette", (e) => { const r = e.getBoundingClientRect(); return { l: r.left, r: r.right, w: innerWidth, t: r.top, b: r.bottom, h: innerHeight }; });
    check(box.l >= 0 && box.r <= box.w && box.t >= 0 && box.b <= box.h, `[${theme}] phone: the palette fits inside the screen`);
    if (theme === "dark") await shot(page, "features-phone-palette-dark");
    await page.keyboard.press("Escape");
  }
  reportIssues(issues, ["Failed to load resource"]);
} catch (e) { console.log("FAIL  exception: " + (e.stack || e)); process.exitCode = 1; }
finally { await browser.close(); be.proc.kill(); }
console.log(process.exitCode ? "\nSOME CHECKS FAILED" : "\nALL CHECKS PASSED");
