import { useEffect, useRef, useState } from "react";
import { api, resumesApi } from "../api";
import { fmtBytes } from "../resumeHelpers";
import { Confirm } from "../components/ui";
import type { ResumeStorage } from "../types";
import Icon, { type IconName } from "../components/Icon";
import { CardsSkeleton, RefreshButton } from "../components/Loaders";
import AIModels from "../components/AIModels";
import { takeSettingsTab, type SettingsTab } from "../settingsTab";
import { ErrorNotice, Seg, useAsync, useToast } from "../components/ui";
import type { Rubric } from "../types";
import { getName } from "./Home";
import { setThemePref, useTheme } from "../theme";
import { useSystemVoices } from "./useSpeaker";

type Dim = "correctness" | "completeness" | "depth" | "practical_application" | "clarity" | "production_awareness";
const DIMS: [Dim, string, string, string][] = [
  ["correctness", "Technical correctness", "Is what was said true?", "#5648f0"], ["completeness", "Completeness", "Are the essential concepts covered?", "#2f9cf0"],
  ["depth", "Depth of understanding", "Why and how, not just what.", "#8a4cf5"], ["practical_application", "Practical application", "Examples and real-world judgement.", "#1e9e68"],
  ["clarity", "Clarity & reasoning", "Structure and explanation.", "#f0a010"], ["production_awareness", "Production awareness", "Only counted when a question is about production.", "#e8604f"],
];
const PRESETS: [string, string, Omit<Rubric, "extra_guidance">][] = [
  ["Balanced", "Default", { correctness: .3, completeness: .2, depth: .15, practical_application: .15, clarity: .1, production_awareness: .1 }],
  ["Accuracy first", "Facts above all", { correctness: .45, completeness: .25, depth: .1, practical_application: .1, clarity: .05, production_awareness: .05 }],
  ["Depth & reasoning", "Why over what", { correctness: .25, completeness: .15, depth: .3, practical_application: .1, clarity: .15, production_awareness: .05 }],
  ["Production mindset", "Real-world ops", { correctness: .2, completeness: .15, depth: .1, practical_application: .3, clarity: .05, production_awareness: .2 }],
];

export default function SettingsPage() {
  const toast = useToast();
  const [tab, setTab] = useState<SettingsTab>(() => takeSettingsTab() ?? "services");
  const force = useRef(false);
  const health = useAsync(() => { const f = force.current; force.current = false; return api.health(f); }, []);
  const rubric = useAsync(() => api.rubric(), []);
  const [r, setR] = useState<Rubric | null>(null);
  const [name, setName] = useState(getName());
  useEffect(() => { if (rubric.data) setR(rubric.data); }, [rubric.data]);
  const h = health.data;
  const cloudOn = h?.ai.mode === "cloud";
  const sysVoices = useSystemVoices(h?.tts.engine === "system");
  const theme = useTheme();

  const svc = (icon: IconName, title: string, detail: string, state: "ok" | "bad" | "warn") =>
    <div className={`svc ${state}`} key={title}><span className="si"><Icon name={state === "ok" ? icon : "alert"} /></span><div><b>{title}</b><span>{detail}</span></div></div>;

  const total = r ? DIMS.reduce((n, [k]) => n + (r[k] as number), 0) : 0;
  const pct = (k: Dim) => (r && total > 0 ? Math.round(((r[k] as number) / total) * 100) : 0);
  const sameAs = (p: Omit<Rubric, "extra_guidance">) => !!r && DIMS.every(([k]) => Math.abs((r[k] as number) - p[k]) < 0.001);

  return (
    <div>
      <div className="pagehead"><div><h1>Settings</h1><div className="muted">Local services, your profile and how answers are scored.</div></div></div>
      <div className="tabbar" role="tablist">
        {([["services", "Local services", "cpu"], ["ai", "AI models", "bolt"], ["profile", "Profile", "user"], ["rubric", "Evaluation rubric", "target"]] as const).map(([k, label, ic]) =>
          <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? "on" : ""} onClick={() => setTab(k)}><Icon name={ic} />{label}</button>)}
      </div>

      {tab === "services" && (
        <>
          <div className="card">
            <div className="row between" style={{ marginBottom: 14 }}><div><h2 style={{ margin: 0 }}>Local services</h2><div className="muted small">{cloudOn ? "Grading runs on Ollama’s cloud. Voice and speech recognition run on this computer." : "Everything runs on this computer."}</div></div>
              <div className="row"><a className="btn" href="#/welcome">Setup check</a><RefreshButton onRefresh={async () => { force.current = true; await health.reload(); }} /></div></div>
            <ErrorNotice error={health.error} />
            {!h && health.loading && !health.error && <CardsSkeleton n={1} label="Checking local services…" />}
            {h && <div className="svc-grid">
              {svc("cpu", cloudOn ? "Ollama (local, optional)" : "Ollama", h.ollama.ok ? `v${h.ollama.version} · ${h.ollama.host}` : h.ollama.error ?? "not reachable", h.ollama.ok ? "ok" : cloudOn ? "warn" : "bad")}
              {cloudOn
                ? svc("bolt", `Ollama cloud · ${h.ai.grader_model}`, h.ai.ready ? "API key saved · you agreed to send text to the cloud" : "add your API key in the AI models tab", h.ai.ready ? "ok" : "bad")
                : svc("sparkle", `Interview model · ${h.llm.model}`, h.llm.error ?? (h.llm.loaded ? "installed · loaded in memory" : "installed · loads on first use"), h.llm.installed ? "ok" : "bad")}
              {h.tts.engine === "system"
                ? svc("voice", "Speech · system voices", sysVoices === null ? "checking…" : sysVoices.length ? `${sysVoices.length} offline voices on this computer` : "no offline voice found — questions will be shown as text", sysVoices === null || sysVoices.length ? "ok" : "warn")
                : svc("voice", `Speech · ${h.tts.model}`, h.tts.error ?? `${h.tts.voices} voices`, h.tts.error ? "bad" : "ok")}
              {svc("mic", `Speech recognition · ${h.stt.model}`, h.stt.available ? "ready (offline Whisper)" : `optional — ${h.stt.reason}`, h.stt.available ? "ok" : "warn")}
              {h.ocr && svc("file", "Resume OCR (Tesseract)", h.ocr.available ? `${h.ocr.version ?? "installed"} · reads scanned resumes` : `optional — only for scanned resumes. Install: ${h.ocr.install}`, h.ocr.available ? "ok" : "warn")}
              {svc("lock", "Network binding", `${h.bind} · loopback only`, h.local_only ? "ok" : "bad")}
            </div>}
          </div>
          <div className="card">
            <h2>Privacy</h2>
            <ul className="privacy">
              {(cloudOn
                ? ["Questions, answers and reports are stored in a local SQLite file.", "Cloud mode is ON: your questions, answers and rubrics are sent to Ollama’s servers for grading. Voice and speech recognition stay on this computer.", "Your Ollama API key is kept only in this computer’s local database and is never shown again.", "No analytics or telemetry. The server only accepts requests from this computer."]
                : ["Questions, answers and reports stay in a local SQLite file.", "No accounts, API keys, analytics or telemetry. Cloud AI is off: nothing is sent to any server.", "The server only accepts requests from this computer.", "Voice, evaluation and transcription run on-device and work offline."]
              ).map((t) => <li key={t}><Icon name={cloudOn && t.startsWith("Cloud mode") ? "alert" : "shield"} />{t}</li>)}
            </ul>
          </div>
        </>
      )}

      {tab === "ai" && <AIModels />}

      {tab === "profile" && (
        <div className="card" style={{ maxWidth: 560 }}>
          <h2>Profile</h2>
          <label className="field">Name shown on the Home screen and in the sidebar
            <input type="text" maxLength={40} value={name} onChange={(e) => { setName(e.target.value); try { localStorage.setItem("lai.name", e.target.value); } catch { /* ignore */ } window.dispatchEvent(new Event("lai:name")); }} /></label>
          <p className="muted small">Stored only in this browser.</p>
          <div className="fld" style={{ marginTop: 22 }}><div className="lbl">Appearance<small>{theme.pref === "system" ? `following your system (${theme.resolved})` : `${theme.pref} theme`}</small></div>
            <Seg label="Colour theme" value={theme.pref} onChange={setThemePref}
              options={[{ value: "light", label: "Light", icon: "sun" }, { value: "dark", label: "Dark", icon: "moon" }, { value: "system", label: "System", icon: "desktop" }]} />
            <div className="hint">Applies instantly and is remembered on this computer. Printed reports always use the light look.</div></div>
        </div>
      )}
      {tab === "profile" && <ResumeData />}

      {tab === "rubric" && !r && !rubric.error && <CardsSkeleton n={2} label="Loading the evaluation rubric…" />}
      {tab === "rubric" && r && (
        <div className="card">
          <h2>Evaluation rubric</h2>
          <p className="muted" style={{ marginTop: -4 }}>Each answer is rated 0–10 on six dimensions by the AI model. The final score is the weighted average below (weights are re-normalised, so they needn’t add up to 1).</p>
          <div className="fld"><div className="lbl">Presets</div>
            <div className="presets">{PRESETS.map(([n, d, p]) => <button key={n} className={`chip ${sameAs(p) ? "on" : ""}`} title={d} onClick={() => setR({ ...r, ...p })}>{n}</button>)}</div></div>
          <div className="fld" style={{ marginTop: 18 }}><div className="lbl">Weight distribution<small>share of the final score</small></div>
            <div className="wbar" aria-hidden>{DIMS.map(([k, , , c]) => <i key={k} style={{ width: `${pct(k)}%`, background: c }} />)}</div></div>
          <div className="wgrid">
          {DIMS.map(([k, label, hint, color]) => (
            <div className="wrow" key={k}>
              <div className="n"><b><span className="sw" style={{ background: color }} />{label}</b><span>{hint}</span></div>
              <input className="range" type="range" aria-label={label} min={0} max={1} step={0.05} value={r[k] as number} style={{ "--c": color, "--p": `${(r[k] as number) * 100}%` } as React.CSSProperties} onChange={(e) => setR({ ...r, [k]: Number(e.target.value) })} />
              <div className="v">{pct(k)}%</div>
            </div>
          ))}
          </div>
          <label className="field" style={{ marginTop: 14 }}>Extra grading guidance <span className="muted">(optional, added to every evaluation)</span>
            <textarea rows={3} maxLength={1500} value={r.extra_guidance} onChange={(e) => setR({ ...r, extra_guidance: e.target.value })} placeholder="e.g. I'm interviewing for a senior backend role; expect scaling and cost awareness in answers." /></label>
          <div className="row" style={{ marginTop: 16 }}>
            <button className="btn primary" onClick={async () => { try { setR(await api.saveRubric(r)); toast("ok", "Rubric saved"); } catch (e) { toast("error", (e as Error).message); } }}>Save rubric</button>
            <button className="btn" onClick={() => setR({ ...r, ...PRESETS[0][2] })}>Reset weights</button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Settings → Profile: how much resume data is stored, and a way to delete all of it (interview history is kept). */
function ResumeData() {
  const toast = useToast();
  const [st, setSt] = useState<ResumeStorage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ask, setAsk] = useState(false);
  const load = async () => { try { setSt(await resumesApi.storage()); setError(null); } catch (e) { setError((e as Error).message); } };
  useEffect(() => { void load(); }, []);
  const wipe = async () => {
    setAsk(false);
    try { const r = await resumesApi.removeAll(); toast("ok", `Deleted ${r.deleted} resume${r.deleted === 1 ? "" : "s"}`); await load(); } catch (e) { toast("error", (e as Error).message); }
  };
  return (
    <div className="card" style={{ maxWidth: 560 }} data-testid="resume-data">
      <h2>Resumes</h2>
      <ErrorNotice error={error} />
      {!st && !error && <span className="skel" style={{ height: 40 }} />}
      {st && <>
        <p className="muted" style={{ marginTop: -4 }}>{st.count === 0 ? "No resumes are stored." : `${st.count} resume${st.count === 1 ? "" : "s"} · ${fmtBytes(st.bytes)} on this computer (the PDFs, their text and the organised content).`}</p>
        <p className="muted small">Stored in the <b>data</b> folder: copying it as a backup also copies your resumes. Reports and exports never include the resume files.</p>
        <div className="row"><a className="btn" href="#/resumes">Open Resumes</a>
          <button className="btn danger" disabled={st.count === 0} onClick={() => setAsk(true)}><Icon name="trash" />Delete all resume data</button></div>
      </>}
      {ask && <Confirm title="Delete all resume data?" message="Every resume PDF, its text and its organised content are deleted from this computer. Your interview history and reports are kept (they hold only the questions and short quotes)." confirmLabel="Delete all" danger onConfirm={() => void wipe()} onCancel={() => setAsk(false)} />}
    </div>
  );
}
