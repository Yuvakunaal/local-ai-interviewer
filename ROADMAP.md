# Roadmap

This is a list of **intentions, not commitments**. There are no dates, and the project has one maintainer, so order and scope can
change. It is derived from the documented limitations in [README section 11](README.md#11-known-limitations) and from natural next
steps for the code base. Items tagged **[contributors welcome]** are good places to start; see [CONTRIBUTING.md](CONTRIBUTING.md).

Nothing here changes the project's principles: local-first by default, no telemetry, the application (not the model) decides scores
and state transitions.

## Verify what is only assumed today

- **Run on real Windows and Linux machines.** CI exercises the backend, frontend and launcher on all three systems, but the `.bat`
  wrappers, process start/stop on Windows and the Linux voice setup have not been run on real hardware. Reports of what works and
  what does not are valuable. **[contributors welcome]**
- **Grade the grader independently.** A first benchmark exists (`backend/benchmarks/grading/`, results in
  [evaluation §8](docs/evaluation.md#8-measured-grading-quality-benchmark)): 70/70 pairs ranked as labelled, one subtle error missed.
  Its labels are the project's own. Still needed: answers labelled by people who did not write the prompt, a held-out set for any
  prompt change, voice answers, resume questions and other machines. **[contributors welcome]**
- **Test cloud mode more against the real Groq API.** One full interview was run by hand on 18 Nov 2026; the rate-limit wait, the
  fallback model and voice answers have only met a fake server. The tests in `backend/tests/integration/` run when `GROQ_API_KEY` is
  set and `-m integration` is given. **[contributors welcome]**
- **Try the microphone feature with a physical microphone** and different accents and Whisper sizes.

## Quality and maintainability

- **Static type checking for the backend** (mypy or pyright), introduced gradually so it does not block unrelated work.
  **[contributors welcome]**
- **Frontend page tests** for the remaining pages. Setup, Report, Interview and Resume detail have page tests that run
  against recorded backend responses; the other pages are exercised only by the real-Chrome scripts in `frontend/e2e`.
  **[contributors welcome]**
- **Accessibility audit with a screen reader** (VoiceOver, NVDA). The existing sweeps check unnamed controls, contrast and overflow
  automatically; they do not replace listening to the interface. **[contributors welcome]**
- Keep the line-coverage figure honest: it was 94 % on 2026-11-15 and should not fall without a reason.

## Interview content

- **Extend the technology-implications catalogue** used for offline resume questions (about 35 technologies and activities today;
  others get project deep-dive and clarification questions only). Entries live in `backend/app/services/tech_implications.py` and
  must be reviewed for accuracy. **[contributors welcome]**
- Tune the adaptive engine's thresholds on real interview data. They are documented heuristics, not measured values.
- Revisit the short-phrase heuristic that suppresses follow-ups after "I don't know"-style answers.

## Distribution

- **Packaging** so users do not need Python installed separately. Since 2.0.2 the release zip contains the built interface, so
  Node.js is no longer needed to run it. This is an idea, not a plan; any packaging must keep the local-only guarantees and not
  add a silent update check.
- **Releases** are tagged and published by a workflow since v2.0.0; the procedure is in
  [docs/maintainers/releasing.md](docs/maintainers/releasing.md).

## Not planned

- Telemetry, analytics or any call home.
- Multi-user accounts or a hosted service. The app is single-user and binds to loopback only.
- Letting the model decide scores, limits or state transitions ([ADR 0001](docs/adr/0001-deterministic-scoring.md)).

## How items get added

Open a feature request or start a Discussion (if enabled). See [docs/community/templates.md](docs/community/templates.md) for the
feature-discussion format the maintainer uses.
