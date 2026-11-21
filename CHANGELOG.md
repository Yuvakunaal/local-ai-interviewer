# Changelog

All notable changes to this project. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/) as defined for this app in [docs/maintainers/releasing.md](docs/maintainers/releasing.md).

## [Unreleased]

### Added
- Page tests for the Resume detail page (#24), on responses recorded from the backend (`backend/tests/test_report_fixture.py`
  writes `resume-detail-api.json` and fails if the resume API changes shape): what the page shows from the API, loading and
  failed-load states, edit/discard/save with the revision, a save refused by another tab, the unsaved-changes guard, rename,
  delete, re-organise with AI with live progress, a resume the AI could not organise, Practice, and the Candidate profile,
  Preview and Original text tabs.

## [2.0.2] - 2026-11-21

Easier install: the release zip runs without Node.js. No database, setting or score changes; upgrading needs no action.

### Changed
- The release zip now contains the built interface, so a release download needs only Python (plus Ollama for local mode, or a Groq
  key). Node.js is needed only for a git clone or after changing frontend files; with Node.js installed the launcher still rebuilds
  the interface when its files change, as before.
- `start` asks for Node.js only when the interface actually has to be built (or for `--dev`); an up-to-date build no longer needs
  it. `check` reports a missing Node.js as a warning, not a failure, when the interface is already built.
- README: a shorter opening (what it is, why it is different, a quick start with the release zip and the Groq option), and the
  platform table now says that CI runs start, health check and stop on Windows and Linux (green since 2026-11-20).

## [2.0.1] - 2026-11-21

Bug fix for Windows and dependency updates. No database, setting or score changes; upgrading needs no action.

### Fixed
- Launcher on Windows: with Ollama not installed or not running, `start` could report "Backend did not answer within 90 s" although
  the app was running. Its health probe gave up after 2 s, and on Windows `/api/health` takes about that long when Ollama is absent
  (Windows needs ~2 s to refuse a connection to a closed local port). The probe now allows 10 s. Seen in CI on 2026-11-20 (passed 2
  runs, failed 1); the CI diagnosis showed the backend answering normally when started by hand. Test: `test_launcher.py`.

### Dependencies
- PDF reports: reportlab 4.5 → 5.1 (`requirements.txt` and both hash locks). The full backend test suite, including the PDF report
  tests, passes on 5.1. An existing install keeps working on 4.5; to match the lock exactly, run
  `backend/.venv/bin/pip install --require-hashes -r backend/requirements.lock` (Windows: `backend\.venv\Scripts\pip ...`).
- Minimum versions raised: httpx ≥ 0.28.1, faster-whisper ≥ 1.2.1 (optional speech-to-text), pip-audit ≥ 2.10.1 (development).
- Frontend development tools: ESLint 10, jsdom 31, @testing-library/jest-dom 7 and a group of smaller updates. They are used only for
  tests and linting; the built app is unchanged.

### Development
- A test now fails when a hash lock pins a version that its requirements file does not allow (a Dependabot PR had raised reportlab in
  `requirements.txt` while CI, which installs the lock, still tested 4.5).
- Two timing assertions in `test_llm_timeouts.py` no longer fail on Windows, whose clock advances in ~15 ms steps.

## [2.0.0] - 2026-11-21

Database schema v6; scores of categorised questions change, see *Changed*.

### Changed: cloud mode now uses Groq (action needed if you used cloud mode)
- The optional cloud mode moved from Ollama cloud (which ended free usage on 9 Nov 2026) to the **Groq API** with your own key
  (`console.groq.com/keys`). Defaults: grader `openai/gpt-oss-120b`; fallback and conversation `openai/gpt-oss-20b`; other model ids
  can still be typed in. Local mode, the local Ollama model and voice are unchanged.
- **Upgrade note:** the first start after upgrading returns the app to local mode, deletes the saved Ollama cloud key and clears your
  cloud consent (including each resume's). To use cloud mode again, add a Groq key and agree to the new notice. Budgets, history and
  reports are kept. `OLLAMA_API_KEY` / `OLLAMA_CLOUD_URL` are ignored; use `GROQ_API_KEY` / `GROQ_BASE_URL`.
- Groq's Free plan is rate-limited, not billed (read 2026-11-18 for both default models: 30 requests and 8,000 tokens a minute; 1,000
  requests and 200,000 tokens a day). On a rate limit the app waits once if the reply can still arrive in time, otherwise it says when
  the limit resets. Cost figures are estimates of what the same use would cost on a paid plan.
- The consent notice names Groq and states that Groq may log requests for up to 30 days.
- New setting `CLOUD_REASONING_EFFORT` (`low` default, `medium`, `high`).
- New opt-in test of the real API: runs only when `GROQ_API_KEY` is set (`backend/tests/integration/test_real_groq.py`).

### Interface
- Setup: one-click presets (Quick practice, Full mock, Resume round) that fill the settings below; the voice picker shows the chosen
  voice and opens the full list only on "Change voice" (names no longer cut off).
- Report: organised into tabs (Overview, Questions, Skills & progress, Adaptive); "Overall feedback" and "Insights" merged into one
  card; the selected tab survives a reload; on phones every tab stays visible.
- Home: a "Next step" card (continue the interview in progress, practise your weakest topics, or start the first interview).
- Interview: more space around "Why this question"; "Time left" turns amber in the last five minutes.
- Candidate profile: skills grouped by confidence (high open, medium and listed-only folded).

### Project infrastructure
- pytest 9.0.3+ (PYSEC-2026-1845, dev only); the security workflow now audits the development lock too.
- Tests fail on a leaked database connection or an unreaped child process (`filterwarnings` in `backend/pytest.ini`); three tests
  that left a connection open are fixed, and the launcher reaps a child it started when it stops it.
- A real-concurrency test: eight simultaneous submits of one answer give one 200, seven 409s and one model call; pause, end and
  delete during a running grade behave as documented (`backend/tests/test_concurrency.py`).
- New CI step (not yet run in CI at the time of writing): start and stop the app with the launcher on Linux, macOS and Windows (`start.sh`/`stop.sh`, `scripts\run.bat start`/`stop.bat`)
  and checks the health endpoint and the UI in between; until now only the read-only `check` ran there. A new Linux job runs the
  real-Chrome `qa-sweep` and `ui-audit` suites (no model needed).
- `scripts/offline_check.py` (macOS): a real interview with the backend in a sandbox that blocks every non-loopback connection.
  2026-11-19: 7/7 checks, only `127.0.0.1` contacted. README §10 no longer states a Wi-Fi-off result that was never measured.
- Grading benchmark with the real local model (`backend/benchmarks/grading/`): 10 questions x 5 labelled answer kinds plus 6
  prompt-injection attempts, 3 repeats. 2026-11-19, qwen3.5:4b, eval-2.1: 70/70 pairs ranked as labelled, 55/56 answers inside the
  band fixed before the run, one subtle wrong claim missed, median repeat spread 0.2 points. Method and limits: docs/evaluation.md §8.
- Python dependencies are installed from hash-locked files (`backend/requirements.lock`, `requirements-dev.lock`, generated from
  the `.txt` files with `uv pip compile --universal --generate-hashes`) with `--require-hashes`, by the launcher and by CI; pip-audit
  checks the lock. Verified: full backend suite on Python 3.10, 3.11 and 3.13 from the lock; every Windows x64 and Linux x64/arm64
  wheel for Python 3.12 matches its recorded hash (`pip download --require-hashes`).
- Frontend line coverage is measured: `npm run coverage`; CI runs it in place of `npm test`. It was 23 % of lines; tests for the
  Report and Interview pages, rendered from report and interview states the backend itself produces
  (`backend/tests/test_report_fixture.py` keeps those fixtures in step with the API), raise it to 41 % (2026-11-19), with
  tests for the Setup page (the settings a preset fills are the ones sent; no second interview while one runs). Page tests wait up
  to 5 s for the page to settle and 15 s per test, because a busy machine or CI runner can need longer than the 1 s / 5 s defaults.
- `typescript-eslint` 8.73 removes the dev-only `minimatch` advisory (`npm audit`: 0 vulnerabilities).
- The real-model integration tests score answers through `Evaluator.finalize`, the path the app uses, instead of the v1
  `compute_score`.
- CI rebuilt: lint/docs job, backend tests on macOS/Windows/Linux (Python 3.12) plus Ubuntu on Python 3.10, frontend checks on all three
  systems, launcher smoke test; actions pinned to commit SHAs, least-privilege permissions, cancelled duplicate runs, dependency caching.
- Security workflow: dependency review on pull requests, pip-audit, npm audit, CodeQL (`security-extended`); weekly schedule. Dependabot
  for pip, npm and GitHub Actions.
- Lint: ruff (bug-finding rules only) and ESLint (TypeScript + React hook rules); optional pre-commit hooks; `.editorconfig`.
- Repository tests: Markdown links/images/anchors, `.env.example` vs settings actually read, version consistency, SHA-pinned actions,
  no committed secrets or data files. State-machine guard tests.
- Release workflow (tag-triggered, verifies the tag matches the app version and the CHANGELOG), label taxonomy and sync workflow,
  issue forms, pull request template, governance and developer documentation, real screenshots and a social preview image.

### Security
Found by an audit of the whole project in November 2026.
- **Resume consent could be bypassed in cloud mode.** A resume's text or an excerpt of it could reach the cloud provider without that
  resume's consent when the mode was switched to cloud while the resume was being read, when an interview containing resume questions
  was started locally and continued in cloud mode, or when a request supplied resume questions directly. Consent is now checked at the
  one place every cloud request passes through; starting such an interview in cloud mode is refused with a clear message, and the
  resume page has an *Allow for cloud* button.
- Requests from other programs on the same computer are refused: a state-changing request whose `Origin` is another `localhost` port
  is rejected (previously any loopback port was accepted), and so is any `/api` request a browser marks as cross-site. Responses
  carry headers that forbid framing by other sites and content-type sniffing.
- A small PDF that expands to an enormous size when opened ("decompression bomb") is refused before the PDF library reads it.
- Text in the Markdown report export is escaped, so an answer or model reply cannot place a live image, link target or HTML tag in
  the exported file.
- The share-safe export no longer includes the interview title, exact times or resume-derived topic names.
- Text placed in a prompt can no longer close its own "untrusted data" fence (the `<<<` / `>>>` markers are neutralised).
- Errors from the cloud provider that arrive inside a streamed reply are redacted like all others (the API key cannot appear).
- The launcher creates `logs/` readable by the owner only, and refuses to start when another program already listens on the app's
  port on the IPv6 loopback address.
- With `GROQ_BASE_URL` set, the consent screen names the server that really receives the text instead of presenting it as Groq.

### Fixed
- Launcher: it waited at most 20 s for the backend and then reported "Backend failed to start" with no reason (seen on the first CI
  run on Windows, 2026-11-20, with an empty log). It now waits up to 90 s while the backend process is alive (a first start on a fresh
  machine can be slow), reports the exit code if the process died, and prints the command to run the backend in the foreground when
  the log is empty. CI prints a diagnosis when the Windows start fails. Tests: `test_launcher.py`.
- `logs/backend.log` stayed empty during a normal interview (nothing was logged below warning level), although the docs send you
  there for troubleshooting. Saving an answer, each grading (with its time) and finishing are now logged with ids, sizes and
  timings only, never the answer text. Test: `test_interview_flow.py`.
- The model-written answer was headed "Reference answer", which read like an authority even when it was wrong (independent review,
  round 3: a false statement about tuples). It is now "Suggested answer (written by the AI)" in the app, Markdown and PDF, and is
  marked *not checked* when the question has no expected answer. Tests: `test_reports.py`, `feedback.test.tsx`.
- Report summary: the model that writes it never saw the questions, only topics and grading notes, and could describe an answer
  wrongly (independent review, round 2: a LEFT JOIN answer summarised as "full outer join"). Each question's text is now in its
  input, fenced as data; questions about a resume make the summary call pass the per-resume cloud consent check. Tests: `test_reports.py`.
- Pausing while the last answer was being graded: the interview completed with the pause still open, so the pause counted as
  interview time. Finishing now closes the pause. Test: `test_concurrency.py`.
- Wording: an error the grader claims but cannot quote is "not counted as mistakes" (it is left out of the mistakes list and the
  verdict). It was described as "not counted", but the score still comes from the grader's ratings; README and docs now say so.
- Grading: an answer that only lists terms, explaining nothing, scored up to 4.9 (independent review, round 1). Such lists are now
  capped at 3 with the reason shown; questions that ask for a list are exempt. Real model, 8 lists: the 7 detected scored 1.2–2.9
  (`backend/benchmarks/grading/term_lists.py`). Tests: `test_grounding.py`.
- The share-safe export's heading read "Interview report: Interview report"; it is now "Interview report (share-safe copy)" in
  Markdown and the PDF's title. `HEAD /` (uptime checks, `curl -I`) was answered 405; the UI routes now accept HEAD.
- Grading worker: an application error other than "interview deleted" ended the worker silently and left the interview in
  "evaluating" for good. It now becomes "evaluation failed" with the answer kept. Test: `test_state_machine_guards.py`.
- Interview: answering in a tab that was out of date (the server replies 409) reloaded the page to the current question but wiped
  the explanation at once, so the typed answer seemed to vanish for no reason. The message now stays. Test:
  `frontend/src/__tests__/interviewPage.test.tsx`.
- End-to-end tests: when port 3100 was already taken (the app, or a second e2e run), the harness tested and wrote into that server
  and reported PASS. It now refuses a busy port, checks its own backend is the one answering, and takes `E2E_PORT`. Test:
  `node frontend/e2e/harness-selftest.mjs`.
- Local model: an answer could fail with "the local model stopped responding (idle timeout)" while the model was still reading the
  question and answer. Ollama sends nothing until its first word, and on an 8 GB computer that is swapping, reading a 1,800-token
  prompt alone can take over 90 s (seen in review round 0: 4 of 6 real-model tests). The wait for the first word may now use the whole
  `LLM_TIMEOUT_S` (240 s); `LLM_IDLE_TIMEOUT_S` applies between words; the message says which happened. Tests:
  `backend/tests/test_llm_timeouts.py`.
- Cloud mode:
  - a reply cut off at the output limit, or a stream that ended early, was treated as a complete reply; it is now an error you can
    retry;
  - waiting out a rate limit no longer blocks other cloud requests, and the connection test reports "busy" instead of hanging;
  - the **total** spending limit was computed from the usage history, so *Clear usage* (or the 2,000-row history limit) reset it; it
    now has its own running total;
  - the plain test command (`pytest backend`) could call the real Groq API when `GROQ_API_KEY` was set in the shell; real-API tests
    now need `-m integration`, and ordinary tests ignore cloud variables from the environment;
  - `/api/health` reported `local_only: true` unconditionally; it now reflects the address the server is bound to.
- Grading:
  - answers longer than 6,000 characters were silently cut before grading although 20,000 are accepted; the whole answer is graded;
  - an answer that began with "I don't know exactly, but…" and then explained the topic could be scored as a non-attempt; only an
    answer that is nothing but a non-attempt is treated as one;
  - with all six rubric weights at zero, profile questions were scored on the extra dimensions only; the score is now the plain
    mean of the core dimensions;
  - adaptive mode could treat two different questions as duplicates ("…in Python 2?" / "…in Python 3?") and skip one, and deep-dive
    did not recognise its focus topic when the letter case differed.
- A backup download deleted the temporary file of another backup still being downloaded.
- Importing a deeply nested JSON file returned a server error instead of a message; very large imports and voice names are limited.
- Grading (prompt `eval-2.1`, profiles v3), from a real Groq-graded report:
  - a correct, complete answer to a basic question was held below 8 because problem-solving counted at full weight on a definition;
    it now counts at 35 % like the other dimensions a definition does not ask for, and the grader no longer lists syntax or internals
    as "missing" from a correct definition;
  - on resume questions the reference answer could state facts the candidate never gave (an invented latency figure); the grader is
    now told to outline a strong answer from what was actually said, the heading reads "What a strong answer covers", and figures
    that nobody mentioned are flagged in the app, the Markdown and the PDF;
  - the PDF report printed raw field names (`conceptual_understanding 8 problem_solving 7`); every dimension now has a proper label.
- The sidebar's last links were hidden behind the Local services panel on shorter windows (e.g. 1280×820); the menu now scrolls on
  its own and the panel folds when space is short.
- A running adaptive interview showed "Question 1 of 1" on the dashboard and the Active interview bar; it now shows the planned total.
- The documented and launcher-enforced Node.js minimum was 18, but the build tool needs 20.19+ or 22.12+ (and the frontend tests
  22.12+): users on Node 18–20.18 or 22.0–22.11 passed `check` and then failed to build. The launcher now checks major.minor, the
  docs say 20.19+/22.12+, `frontend/package.json` declares `engines`, and the Linux hint no longer suggests the (too old) apt package.
- Two `useMemo` hooks recomputed on every render; an unused value and a missing exception chain in the backend; a malformed
  `eslint-disable` comment.
- `.env.example` now documents `CLOUD_TIMEOUT_S`, `CLOUD_IDLE_TIMEOUT_S`, `CLOUD_MAX_TOKENS` and `ALLOW_NON_LOCAL_OLLAMA`.

### Security
- The API explorer pages (`/api/docs`, `/redoc`) loaded JavaScript and CSS from a public CDN, contrary to the "only localhost"
  promise. They are now off by default; developers can enable `/api/docs` with `API_DOCS=1`. `/api/openapi.json` is unchanged.
- `puppeteer-core` (development only, used by the e2e scripts) upgraded 24 → 25, removing two high-severity transitive advisories
  (`basic-ftp`, `extract-zip`) that were reachable only through code paths the scripts never use.
- Resume lines that look like instructions to an AI are flagged and excluded from offline questions and excerpts.
- Backups are written inside the private data folder (never the shared temp folder) and removed after download.

### Added
- **Interview Intelligence 2.0** ([docs/evaluation.md](docs/evaluation.md)): category evaluation profiles (SQL, Python, data
  engineering, ML, system design, software engineering, behavioural, general) with extra dimensions (conceptual understanding,
  problem-solving, edge cases, trade-offs); verbatim evidence quotes verified against the answer; ungrounded "misconceptions" shown but
  never counted; deterministic consistency rules; answer classification (correct / correct but incomplete / partially correct /
  incorrect / no attempt / uncertain); provenance on every evaluation (prompt, profile and rubric versions, model route, temperature,
  input hash). Still one grading call per answer.
- **Adaptive interviews** ([docs/adaptive-interviews.md](docs/adaptive-interviews.md)): a question pool and a deterministic engine with
  six strategies (progressive, deep-dive, practical, conceptual, mixed, resume-based), four levels with confidence-weighted, cool-down
  and anti-oscillation rules, topic coverage, one revisit of weak topics, evidence-based early end, and clarify / deepen / scenario /
  probe-gap follow-ups with a loop guard. Every decision is persisted with a plain-language reason.
- **Time limits** for fixed and adaptive interviews (paused time excluded).
- **Candidate profile** for every resume ([docs/resume-intelligence.md](docs/resume-intelligence.md)): skill inventory with
  evidence-based confidence and source line references, extraction-quality check against the raw text, projects, experience summary
  and gaps, technology relationships, clarification areas, prompt-injection warnings, practice history and unexplored areas. Offline,
  no model call.
- **Offline claim-grounded resume questions** (`resume_auto`): technology implications and a project deep-dive progression, each tied
  to its resume excerpt; same per-resume cloud-consent rule as AI-written questions.
- **Report analytics**: classification breakdown, difficulty-wise and conceptual-vs-practical performance, profile usage, progress per
  topic versus your previous attempt, learning plan, adaptive decision timeline, resume coverage.
- **Share-safe exports** (`?redact=true`, PDF/Markdown/JSON): allow-list of scores and topics; answers, grader prose, follow-ups,
  resume names, labels and excerpts removed.
- **Database backup download** (`GET /api/backup`, Settings → Profile) and a read-only evaluation-profile view in Settings.
- Docs: architecture decision records, contribution guide, security policy, issue/PR templates, tag-triggered release workflow.

### Changed
- Questions that match a category profile are scored with that profile's weights, so their scores can differ from 1.x. Uncategorised
  questions use the *general* profile, identical to 1.x. Your rubric weights in Settings still apply to every profile.
- A short answer containing "I don't know" that the grader still found nothing of value in is capped at 2 per dimension.
- Database schema v6 (additive: new columns and tables; existing data untouched; upgrades automatically from every earlier version).

## [1.0.0] - 2026-11-09

First public version (never tagged).

The first public version of the repository (commits `2b07ee2` and `900f970`; the version number in the code was 1.0.0, but no
Git tag or GitHub release was created): local mock interviews with a question bank, spoken questions, Whisper microphone input,
follow-ups, reports, resumes and optional Ollama cloud mode.
