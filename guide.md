# AI Interviewer — Simple Guide

Your personal interviewer for practicing any kind of tech interview (software, data, cloud, security, ML, QA, DevOps and more). It runs **on your own computer** (Mac, Windows or Linux): it asks questions aloud, listens to (or reads) your answers, scores them, asks smart follow-ups and gives you a report. Once it's set up it needs no internet, accounts or API keys (an optional cloud mode for faster grading is described in section 4b).

---

## 0. Get the app

1. Open **https://github.com/Yuvakunaal/local-ai-interviewer**, press the green **Code** button, then **Download ZIP**. (If you use git: `git clone https://github.com/Yuvakunaal/local-ai-interviewer.git`.)
2. Unzip it somewhere you'll keep it, for example your home folder. The folder is called `local-ai-interviewer-main` (or `local-ai-interviewer` with git).
   * Windows: right-click the ZIP → **Extract All…**. Don't run it from inside the ZIP, and avoid folders synced by OneDrive if you can (they can lock files while the app runs).
3. Follow **section 2 (One-time setup)** below, then start the app with the commands in section 1.

---

## 1. The two commands you will use every day

Use the column for your computer. Open **Terminal** (Mac/Linux) or **Command Prompt / PowerShell** (Windows), go to the project folder, and run:

| | Mac / Linux | Windows |
|---|---|---|
| Go to the folder | `cd ~/local-ai-interviewer-main` (use your own path) | `cd %USERPROFILE%\local-ai-interviewer-main` (use your own path; PowerShell: `cd $HOME\local-ai-interviewer-main`) |
| **Start** | `./start.sh` | `start.bat` (PowerShell: `.\start.bat`) |
| **Stop** (when finished) | `./stop.sh --unload` | `stop.bat --unload` |
| Health check | `./check.sh` | `check.bat` |

Then use **http://localhost:3000** in **Google Chrome** (Edge also works). On Windows, `start.bat` opens it for you.

`--unload` also frees the AI model's memory (recommended); plain `stop` just stops the website.

> You can close the window after start says **Ready** — the site keeps running until you run stop (or restart the computer).

Other handy things:

| Command | What it does |
|---|---|
| `check` | Checks everything is installed and ready (read-only, safe any time) |
| `start --dev` | Developer mode with hot-reload (not needed for normal use) |
| `tail -n 50 logs/backend.log` (Windows: `type logs\backend.log`) | Shows recent app logs if something misbehaves (logs never contain your answers) |

---

## 2. One-time setup

You only need this on a new computer or after deleting things. Everything below downloads from the internet **once**; after that the app works offline.

1. Install **Ollama** from https://ollama.com/download and open it once (a llama icon appears in the menu bar / system tray).
2. Install **Node.js 18+** and **Python 3.10+**:
   * Mac: `brew install node python`
   * Windows: `winget install OpenJS.NodeJS.LTS` and `winget install Python.Python.3.12` (when using the python.org installer, tick **Add python.exe to PATH**). Close and reopen the terminal afterwards.
   * Linux: your package manager, e.g. `sudo apt install nodejs npm python3 python3-venv`
3. In the terminal, in the project folder:

   | Mac / Linux | Windows | What it does |
   |---|---|---|
   | `./setup-models.sh` | `setup-models.bat` | downloads the AI brain (`qwen3.5:4b` ≈ 4 GB), plus the premium Phonon voice on Apple-Silicon Macs; asks before downloading |
   | `./setup-models.sh --stt` | `setup-models.bat --stt` | OPTIONAL: offline speech recognition for microphone answers (≈ 150 MB) |
   | `./start.sh` | `start.bat` | installs the app's own dependencies the first time, then starts it |

**About the voice that reads questions aloud:** on an Apple-Silicon Mac you get the premium **Phonon** voice. On Windows, Linux and Intel Macs the app uses the **built-in offline voices of your computer** (Windows: Microsoft David, Zira…). Nothing is sent online. If you hear nothing on Windows: Settings → Time & language → Speech → *Add voices*. On Linux install `speech-dispatcher` and `espeak-ng`. With no voice at all the questions are simply shown as text.

---

## 3. Using the website — from first launch to your first interview

### Step 0 · First time? The app checks your computer for you
When you start the app for the first time it checks what it needs. If something is missing you'll see a **"Let's get you set up"** page in the middle of the screen: it lists what to install (for example **Ollama**) with the exact steps for your computer and copy buttons, and turns green by itself when you've done it. The AI model can be downloaded right there with one click (it shows the size first and never downloads without you pressing the button). If Python or Node.js is missing, a simple page opens with the install steps before the app starts. You can also choose **Use cloud models instead** to skip the download. You can open this check again any time from **Settings → Local services → Setup check**.

### Step 1 · Check that everything is green
Look at the bottom of the left sidebar: **Local services — All ready** with green dots for Ollama, the AI model, Voice (Phonon, or *system* on Windows/Linux) and Microphone. If a dot is red, jump to *Troubleshooting* below.

### Quick tips for moving around
* **`Ctrl+K`** (Mac: **`⌘K`**) opens a search-everything palette: jump to any page, add or import a question, resume an interview, switch theme.
* **`?`** shows all keyboard shortcuts. Handy ones: **`[`** collapses the sidebar, **`g` then `q`** goes to Questions.
* **Dark mode:** click **Theme** at the bottom of the sidebar (Light → Dark → Auto), or *Settings → Profile → Appearance*.
* **Home** shows your progress: average score, streak, score trend, and **Focus areas** (your weakest topics) with a **Practice weakest topics** button.
* The first time you open Home it asks what to call you — optional, stored only in your browser.

### Step 2 · Add your questions  (sidebar → **Questions**)
Two ways:

* **One at a time:** click **+ Add Question**. Type the question. Optionally add:
  * an **expected answer / rubric** (the key points a good answer should cover — this makes grading much more accurate),
  * a **topic** (Python, System design, SQL…) and a **difficulty**.
* **Many at once:** click **Import Questions** and paste them, separating each question with a line that contains only `--`:
  ```
  What is the difference between a process and a thread?
  --
  How would you design a rate limiter for a public API?
  --
  Explain idempotency and why it matters for retries.
  ```
  You'll see **Detected N questions**; click ✕ to drop any of them. Choose **Append** (keeps your old questions — default) or **Replace** (asks you to confirm and saves a backup first). Duplicates are skipped automatically. A `.json` file can be imported the same way.

In the question list you can search, filter by topic/difficulty, tick several questions, and use **⋯** for *Move up/down, Duplicate, Preview, Hear this question*. The pencil edits, the bin deletes (it always asks first).

### Step 2b · Optional: add your resume  (sidebar → **Resumes**)
Want questions about **your own** experience? Press **Add resume** (or drop the PDF on the page) and pick your resume as a PDF.
1. Watch it being read: *Uploading → Reading text → Organising with AI → Ready*. You can close the window; it carries on.
2. Press **Review it**. Check the sections (the AI can make mistakes), fix anything wrong and press **Save changes**. **Preview** shows your original PDF; **Original text** shows exactly what was read.
3. If it says **Needs attention**, read the reason: a scanned resume needs the free OCR program (Mac: `brew install tesseract`, Windows: `winget install UB-Mannheim.TesseractOCR`, Linux: `sudo apt install tesseract-ocr`) — then press **Try again**. Or press **Fill in manually**.
4. Press **Practice** on the resume. In the interview setup choose how many questions and what to focus on, press **Generate questions**, then read them: edit, remove or regenerate any you don't like.

Your resume stays on this computer (in cloud mode you are asked before its text is sent). **Delete** removes it; past reports keep working.

### Step 3 · Set up the interview  (sidebar → **Interview**)
Work down the five numbered sections; the card on the right shows a live summary.

1. **Basics** — name the session and pick **Technical / HR / Scenario-based / Mixed**.
2. **Questions** — *All* or *Selected* questions, in your order or **Shuffled**.
3. **Interviewer** — pick a voice (press ▶ on any voice to hear it; Windows/Linux show your computer's voices), playback speed, and **max follow-ups per question (None, 1, 2 or 3)**. "None" turns follow-ups off completely.
4. **Evaluation** — **Lenient / Balanced / Strict**. (Scores always come at the end, in your report.)
5. **Experience** — read questions aloud automatically; microphone input.

Press **Start Interview**.

### Step 4 · Take the interview
The full-screen interview shows a glowing "AI Interviewer" orb. The question is **spoken automatically** (if you left that on) and shown in big text.

* A small timer and word count under the answer box show how long you've spent on the question.
* Player: ⏸/▶ pause or play, ↻ replay, ■ stop, **1x** speed, 🔊 mute.
* Type your answer in **Your Answer** (use **Notes (Optional)** for a private scratchpad — it's never graded).
* **Microphone (optional):** press the mic button, speak, press it again — your words are transcribed on your computer and appear in the box so you can **edit them before submitting**.
* Press **Submit Answer** (or ⌘/Ctrl + Enter). Nothing is ever submitted automatically.
* **Skip Question** is never counted as a correct answer and never scored as zero.
* Under the answer box: **Pause** and **End interview** (asks to confirm).

### Step 5 · Keep going — scores come at the end
After you submit, the AI reviews your answer on your computer (or in the cloud). **You are not shown a score in the middle of the interview** — it's practice, like a real one. The next question (or a follow-up, when one is worth asking) simply appears. This can take a little while the first time; you can even refresh the page and it carries on.

If something fails, your answer is **kept** and you get a **Retry evaluation** button.

### Step 6 · Finish and see your score
After the last question you get **Interview complete** with your **final score** right away, and **View the full report** (also in sidebar → **Reports**). The report has:

* the **Scorecard** — every question with the score of your answer and of each follow-up, the question's score, and your **final score**,
* total / answered / skipped / average score and **topic-wise performance** bars,
* a **Skills** breakdown (correctness, completeness, depth, practical application, clarity, production awareness),
* an overall written summary, strengths, knowledge gaps, topics to revise, recommendations,
* **Detailed feedback**: open any question to see your answers, the strengths and gaps, a reference answer, and a 🔊 button to hear the question again,
* **Export as PDF** — press it and a finished, clean PDF report is built and saved straight to your Downloads (no print window). The button shows *Preparing PDF…* while it works, and waits for the written summary if that is still being finished. The PDF has a summary, the scorecard, topics, skills, insights and the detailed feedback for every question — text and tables, no charts. You can also export **JSON** or **Markdown** (the scorecard is included in both).

If you practiced with your resume, **Resume claims** lists each thing from your resume you were asked about, with a Solid / Shaky / Weak verdict and a tip, weakest first.

Skipped and not-reached questions are **not** included in your average.

### Step 8 · Come back later
* Closed the tab or the computer mid-interview? Open the site → sidebar → **Interview**: a wide bar at the top shows your **Active interview** with **Continue interview**. Your place, answers and follow-up count are all saved. (**Exit Interview** takes you to the same page.)
* **One interview at a time.** You can start a new interview only after you finish the active one or press **End interview** on that bar (the report is built from the answers so far).
* **History** lists every session (resume, open report, delete). **Clear history** asks before deleting.

---

## 4. Seeing what the AI model is doing

Click **Model usage** in the left sidebar (under *Models*, above *Local services*). It shows what is loaded in memory right now, and for every kind of model call (grading an answer, cleaning up your voice transcript, the report summary, reading a question aloud) how many **tokens** it used, how long it took, how fast it wrote, and how often the model had to be **loaded** — that load is the moment a small computer can freeze. Only numbers are saved, never your answers. In Terminal, `ollama ps` shows the same "in memory" view.

---

## 4b. Optional: use Ollama's cloud models instead of your own computer

If your laptop is slow or short on memory, you can let Ollama's servers do the grading. It costs a small amount of money (a graded answer is roughly a twentieth of a cent) and it is **off by default** — nothing is sent anywhere unless you do this:

1. Make an API key at **ollama.com/settings/keys**.
2. In the app: **Settings → AI models → Ollama cloud models**, paste the key, tick the box that says you understand your answers will be sent to Ollama, and press **Use cloud models**.
3. Press **Test connection (free)**. It only checks the key and lists the models — it costs nothing.
4. (Optional) Set a **daily limit** in dollars. The app stops asking the cloud when it is reached, and keeps your answer so you can retry later.

Your voice never leaves the computer — only the written text of the question and your answer. The sidebar says **Cloud AI · voice stays local** while this is on. **Model usage** shows every cloud call and its estimated cost (estimates — Ollama's own page is the real bill). To go back, choose **On this computer** in the same place.

---

## 5. Tips for the best results

* **Add a rubric** to the questions you care most about. Without one, the AI relies on general knowledge and can occasionally be wrong — treat scores as study feedback, not a verdict.
* Answer in full sentences and mention **trade-offs and a real example**; short-but-complete answers are fine too.
* Use **Strict** when you feel ready for a tough interviewer; **Lenient** when learning.
* Settings → **Evaluation rubric** lets you change what matters (e.g. more weight on production awareness) and add your own grading guidance.
* Sidebar: click the round handle (or press **`[`**) to collapse it to icons.
* Use headphones in a quiet room if you use the microphone.

---

## 6. What to take care of (your side)

1. **Keep Ollama installed and don't delete its models.** Never run `ollama rm qwen3.5:4b` or `ollama rm phonon`. The start command launches Ollama for you if it isn't running.
2. **Use Chrome (or Edge)** at `http://localhost:3000`. Allow the **microphone** when Chrome asks (only needed for mic answers).
3. **Memory is tight (8 GB).** Close heavy apps and browser tabs before you start an interview — this is the main thing that stops freezing. The app loads the AI model early in the interview and frees it again when you finish. After you finish, run `./stop.sh --unload`.
4. **Your data is in the `data` folder inside the app folder** (questions, answers, reports). **Back it up** now and then:
   ```bash
   cp -R ~/local-ai-interviewer-main/data ~/Desktop/interviewer-backup          # Mac / Linux (use your own path)
   ```
   ```bat
   xcopy /E /I %USERPROFILE%\local-ai-interviewer-main\data %USERPROFILE%\Desktop\interviewer-backup    :: Windows
   ```
   Don't delete the folder unless you want a fresh start. Also use **Questions → Export JSON** to save your question list.
5. **Don't move or rename the project folder** while it's running. After a restart/shutdown of the computer, start it again.
6. **Keep it private:** the site only listens on your own computer (`127.0.0.1`). Don't change `APP_HOST` in `.env`.
7. After a page refresh Chrome blocks audio autoplay — just press ▶ to hear the question.
8. The internet is needed only for first-time downloads (Ollama, models, dependencies). Normal use works fully offline — unless you turn on cloud models (section 4b), which needs internet while it is on.
9. **If you use a cloud key, treat the `data` folder as private:** the key is saved inside it. Don't share it or post it online. (Or put the key in `.env` as `OLLAMA_API_KEY` instead.)

---

## 7. Troubleshooting

| What you see | What to do |
|---|---|
| Page won't open | Run start, wait for **Ready**, open http://localhost:3000. |
| Red dot next to **Ollama** | Open the Ollama app (or run `ollama serve`), then reload. |
| "Model 'qwen3.5:4b' is not installed" | Run setup-models (`./setup-models.sh` / `setup-models.bat`). |
| "Port 3000 is already in use" | Run stop, then start. Otherwise set `APP_PORT=3010` in a `.env` file (copy `.env.example` to `.env`). |
| Evaluation says it failed | Read the reason, fix it (usually Ollama closed), press **Retry evaluation**. Nothing is lost. |
| The computer freezes for a bit when an answer is graded | The AI model (about 4 GB) is loading into memory. Close browser tabs and big apps before you start; the interview-setup screen warns you when memory is low. It happens once near the start, and the memory is freed automatically when you finish. |
| Evaluation is very slow / computer laggy | Close other apps; run `stop --unload` then start again; lower `LLM_NUM_CTX=4096` in `.env`. |
| No sound | Press ▶ (the browser blocks autoplay after a refresh); check the volume. Sidebar → Voice should be green; on Windows/Linux Settings shows how many offline voices were found (see *One-time setup*). |
| Microphone toggle is greyed out | Run setup-models with `--stt`, then reload. Allow the mic in Chrome (lock icon → Site settings). |
| Mic transcript has a wrong word | Edit the text before submitting — it's only a draft. |
| Resume says **Needs attention** | Read the reason on its page. Scanned PDF → install Tesseract (see Step 2b) and press **Try again**. Password-protected → save a copy without a password. Or press **Fill in manually**. |
| Resume takes a long time | A few minutes is normal on an 8 GB laptop. Keep working; the card shows progress. |
| Anything else | Run check, and read the end of `logs/backend.log` |

---

## 8. Optional: run the self-tests

```bash
cd ~/local-ai-interviewer-main                 # your own path. Windows: use backend\.venv\Scripts\python instead of backend/.venv/bin/python
backend/.venv/bin/python -m pytest backend                       # fast tests (no models needed)
RUN_INTEGRATION=1 backend/.venv/bin/python -m pytest -m integration backend/tests/integration   # real model tests (~2 min)
cd frontend && node e2e/basics.mjs                               # opens real Chrome, checks the whole UI
cd frontend && node e2e/cloud.mjs                                # cloud mode against a pretend cloud (no internet, no cost)
```

(The browser tests use their own temporary data and port 3100, so your real data is never touched.)

---

**Quick recap:** start (`./start.sh` / `start.bat`) → open **localhost:3000** → **Questions** (add) → **Interview** (configure → Start) → answer → **Report** (all scores at the end) → stop (`./stop.sh --unload` / `stop.bat --unload`).

Good luck with your interviews! 🎯
