// The "no Phonon" path used on Windows / Linux / Intel Macs: the backend is forced to TTS_PROVIDER=system and the
// questions must be spoken by the computer's own offline voices (speechSynthesis) - never through /api/speech/synthesize.
import { BASE, check, clickText, launch, reportIssues, shot, sleep, startBackend, textOf, waitText } from "./lib.mjs";

const be = await startBackend({ TTS_PROVIDER: "system" });
const { browser, page, issues } = await launch();
let synthRequests = 0;
page.on("request", (r) => { if (r.url().includes("/api/speech/synthesize")) synthRequests++; });
await page.evaluateOnNewDocument(() => {
  window.__spoken = [];
  const synth = window.speechSynthesis;
  const orig = synth.speak.bind(synth);
  synth.speak = (u) => { window.__spoken.push({ text: u.text, voice: u.voice ? u.voice.name : null, local: u.voice ? u.voice.localService : null, rate: u.rate, volume: u.volume }); return orig(u); };
});
try {
  const health = await (await fetch(`${BASE}/api/health`)).json();
  check(health.tts.engine === "system" && health.tts.error === null && /offline voices/.test(health.tts.note), "server reports the system-voice engine with no error (Phonon not required)");

  await page.goto(BASE, { waitUntil: "networkidle0" });
  await waitText(page, "Voice (system)");
  const voices = await page.evaluate(async () => {
    const get = () => speechSynthesis.getVoices();
    for (let i = 0; i < 20 && !get().length; i++) await new Promise((r) => setTimeout(r, 150));
    return get().filter((v) => v.localService && /^en([-_]|$)/i.test(v.lang)).map((v) => v.name);
  });
  console.log(`INFO  ${voices.length} offline English voice(s) visible to Chrome on this machine${voices.length ? ": " + voices.slice(0, 4).join(", ") + (voices.length > 4 ? ", …" : "") : ""}`);

  const sets = await (await fetch(`${BASE}/api/sets`)).json();
  const setId = sets[0].id;
  for (const text of ["What is the difference between a data lake and a data warehouse?", "How do you make a pipeline idempotent?"]) {
    await fetch(`${BASE}/api/sets/${setId}/questions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text, topic: "Basics" }) });
  }

  await page.goto(`${BASE}/#/setup`, { waitUntil: "networkidle0" });
  await page.waitForSelector('[aria-label="Voice"]');
  await sleep(800);
  const pageText = await textOf(page);
  check(/offline voices on this computer/.test(pageText) || /No offline voice was found/.test(pageText), "Setup labels the voice list as this computer's offline voices");
  const chips = await page.$$eval('[aria-label="Voice"] [role=radio]', (els) => els.map((e) => e.textContent.trim()));
  check(chips[0]?.startsWith("System default") && chips.length >= 2 && chips.length <= 1 + voices.length, `voice picker lists "System default" + ${chips.length - 1} real voices (joke voices hidden)`);
  check(!chips.some((c) => /Bad News|Bahh|Zarvox|Trinoids|Bells/.test(c)), "novelty voices are not offered");
  check(new Set(chips).size === chips.length, `every voice chip has a unique label (${chips.length} chips)`);
  check(!/Phonon/.test(await page.$eval(".fld .lbl", (e) => e.textContent)), "no Phonon wording in the voice section");

  if (voices.length) {
    await page.click('[aria-label="Voice"] [role=radio] .vplay');
    await sleep(500);
    let spoken = await page.evaluate(() => window.__spoken);
    check(spoken.length === 1 && /Hello! I'll be your interviewer/.test(spoken[0].text), "previewing a voice speaks the sample sentence through speechSynthesis");
    await page.click('[aria-label="Voice"] [role=radio]:nth-child(2) .vplay');
    await sleep(500);
    spoken = await page.evaluate(() => window.__spoken);
    const second = spoken[spoken.length - 1];
    check(!!second.voice && second.voice.startsWith(chips[1].replace(/ · .*$/, "")), `choosing a specific voice uses exactly that voice (${second.voice})`);
    check(spoken.every((s) => s.local !== false), "only local (offline) voices are ever used");

    await page.evaluate(() => speechSynthesis.cancel());
    await clickText(page, "button", "1.5×");
    await page.click('[aria-label="Voice"] [role=radio] .vplay');
    await sleep(500);
    check((await page.evaluate(() => window.__spoken.at(-1).rate)) === 1.5, "playback speed 1.5× is applied natively to the OS voice");
    await page.evaluate(() => speechSynthesis.cancel());
  } else {
    check(/No offline voice was found/.test(pageText), "with no offline voice installed the page explains how to add one");
  }
  await shot(page, "setup-system-voices");

  await clickText(page, "button", "Start Interview");
  await page.waitForSelector(".player", { timeout: 15000 });
  await sleep(1500);
  const spokenNow = await page.evaluate(() => window.__spoken.map((s) => s.text));
  if (voices.length) check(spokenNow.some((t) => t.includes("data lake")), "the first interview question is read aloud by the OS voice");
  else check(true, "interview starts without a voice (text only)");
  check(synthRequests === 0, "no request was ever made to Phonon (/api/speech/synthesize)");
  await shot(page, "interview-system-voice");

  await page.goto(`${BASE}/#/settings`, { waitUntil: "networkidle0" });
  await waitText(page, "Speech · system voices");
  check(true, "Settings shows the system-voice service row");
  reportIssues(issues);
} catch (e) {
  console.log("FAIL  exception: " + (e.stack || e));
  process.exitCode = 1;
} finally {
  await browser.close();
  be.proc.kill();
}
console.log(process.exitCode ? "\nSOME CHECKS FAILED" : "\nALL CHECKS PASSED");
