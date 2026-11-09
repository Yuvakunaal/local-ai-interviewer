import { useEffect, useRef, useState } from "react";
import { ApiError, resumesApi } from "../api";
import { fmtUsd } from "../aiHelpers";
import { ConsentDialog } from "../pages/Resumes";
import { usePoll } from "../pages/usePoll";
import { claimChip, clampCount, DEPTHS, DIFFICULTIES, FOCUS, generationCost, generationMinutes, KIND_LABEL, move, removeAt, replaceAt, STYLES } from "../resumeHelpers";
import type { AIConfig, DraftQuestion, GenJob, GenSettings, ResumeSummary } from "../types";
import Icon from "./Icon";
import ResumePicker from "./ResumePicker";
import { AutoText } from "./ResumeEditor";
import { Confirm, OptionCards, Seg, useToast } from "./ui";

let uidSeq = 0;
/** Stable ids for the review rows (editing a question must not remount its row). */
const withUid = (q: DraftQuestion): DraftQuestion => (q.uid ? q : { ...q, uid: `q${Date.now().toString(36)}${(uidSeq++).toString(36)}` });

function QuestionRow({ q, i, n, busy, onChange, onRemove, onMove, onRegenerate }: {
  q: DraftQuestion; i: number; n: number; busy: boolean; onChange: (q: DraftQuestion) => void; onRemove: () => void; onMove: (d: -1 | 1) => void; onRegenerate: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [rubric, setRubric] = useState(false);
  return (
    <li className={`rz-q ${busy ? "busy" : ""}`} aria-busy={busy}>
      <span className="rz-q-n">{i + 1}</span>
      <div className="grow">
        {editing
          ? <><AutoText label={`Question ${i + 1}`} value={q.text} onChange={(v) => onChange({ ...q, text: v })} error={q.text.trim().length === 0 ? "A question can’t be empty." : q.text.length > 1000 ? "Keep it under 1000 characters." : undefined} />
              <button className="btn small" style={{ marginTop: 6 }} onClick={() => setEditing(false)} disabled={!q.text.trim() || q.text.length > 1000}>Done</button></>
          : <div className="rz-q-t">{busy ? <span className="muted">Writing a new question…</span> : q.text}</div>}
        <div className="rz-q-meta">
          {q.topic && <span className="rz-tag">{q.topic}</span>}
          {q.difficulty && <span className={`pill-tag d-${q.difficulty}`}>{q.difficulty}</span>}
          {KIND_LABEL[q.kind] && <span className="muted small">{KIND_LABEL[q.kind]}</span>}
          <span className="rz-from" title={`${claimChip(q)}\n${q.claim.excerpt}`}>{claimChip(q)}</span>
        </div>
        {rubric && (
          <div className="rz-rubric">
            <div className="small muted" style={{ marginBottom: 4 }}>What a credible answer contains (guidance for grading)</div>
            <AutoText label={`What a credible answer to question ${i + 1} contains`} value={q.rubric ?? ""} onChange={(v) => onChange({ ...q, rubric: v })} error={(q.rubric ?? "").length > 1500 ? "Keep it under 1500 characters." : undefined} />
          </div>
        )}
      </div>
      <span className="rz-q-tools">
        <button className="btn icon ghost" aria-label={`Edit question ${i + 1}`} title="Edit" disabled={busy} aria-pressed={editing} onClick={() => setEditing(!editing)}><Icon name="pencil" /></button>
        <button className="btn icon ghost" aria-label={`${rubric ? "Hide" : "Show"} what a good answer to question ${i + 1} contains`} title="What a good answer contains" aria-pressed={rubric} onClick={() => setRubric(!rubric)}><Icon name="eye" /></button>
        <button className="btn icon ghost" aria-label={`Write a different question ${i + 1}`} title="Regenerate this one" disabled={busy} onClick={onRegenerate}>{busy ? <span className="spinner" style={{ width: 14, height: 14, borderWidth: 2 }} /> : <Icon name="refresh" />}</button>
        <button className="btn icon ghost" aria-label={`Move question ${i + 1} up`} title="Move up" disabled={i === 0} onClick={() => onMove(-1)}><Icon name="up" /></button>
        <button className="btn icon ghost" aria-label={`Move question ${i + 1} down`} title="Move down" disabled={i === n - 1} onClick={() => onMove(1)}><Icon name="dn" /></button>
        <button className="btn icon ghost del" aria-label={`Remove question ${i + 1}`} title="Remove" onClick={onRemove}><Icon name="trash" /></button>
      </span>
    </li>
  );
}

/** Interview setup, "Resume" source: pick resumes, choose what to ask, generate, then review and edit the questions. Nothing is generated later. */
export default function ResumeQuestionsPanel({ resumes, settings, onSettings, questions, onQuestions, saveToBank, onSaveToBank, cloud, aiConfig, onResumesChanged }: {
  resumes: ResumeSummary[]; settings: GenSettings; onSettings: (s: GenSettings) => void; questions: DraftQuestion[]; onQuestions: (q: DraftQuestion[]) => void;
  saveToBank: boolean; onSaveToBank: (v: boolean) => void; cloud: boolean; aiConfig: AIConfig | null; onResumesChanged: () => void;
}) {
  const toast = useToast();
  const [job, setJob] = useState<GenJob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [regen, setRegen] = useState<Set<number>>(new Set());
  const [consent, setConsent] = useState<{ ids: number[]; then: () => void } | null>(null);
  const [consentBusy, setConsentBusy] = useState(false);
  const [confirmAll, setConfirmAll] = useState(false);
  const replaceOnDone = useRef(true);
  const set = <K extends keyof GenSettings>(k: K, v: GenSettings[K]) => onSettings({ ...settings, [k]: v });
  const running = job?.state === "running";
  const minutes = generationMinutes(settings.count, settings.depth, cloud);
  const cost = cloud && aiConfig ? generationCost(aiConfig, settings.count, settings.depth) : undefined;
  const chosen = resumes.filter((r) => settings.resume_ids.includes(r.id));

  const finish = (j: GenJob) => {
    setJob(j);
    if (j.state === "done" || j.state === "cancelled") {
      const fresh = j.questions.map(withUid);
      if (fresh.length) onQuestions(replaceOnDone.current ? fresh : [...questions, ...fresh]);
      setWarnings(j.warnings);
      if (j.state === "done" && !j.questions.length) setError("No questions could be written. Try other focus areas, or add more detail to the resume.");
    } else if (j.state === "error") setError(j.error ?? "Writing the questions failed. Try again.");
  };
  usePoll(async (alive) => { if (!job) return; const j = await resumesApi.job(job.id); if (alive()) finish(j); }, 1500, running);
  useEffect(() => () => { if (job?.state === "running") void resumesApi.cancelJob(job.id).catch(() => {}); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  /** Runs `fn`; when cloud mode needs consent for some resumes, asks first and then runs it again. */
  const withConsent = async (fn: () => Promise<void>) => {
    try { await fn(); }
    catch (e) {
      const err = e as ApiError & { resume_ids?: number[] };
      if (err.code === "cloud_consent_required") {
        const ids = settings.resume_ids.filter((id) => resumes.find((r) => r.id === id)?.consent_cloud !== 1);
        setConsent({ ids: ids.length ? ids : settings.resume_ids, then: () => void withConsent(fn) });
      } else { setError(err.message); }
    }
  };
  const generate = (replace: boolean) => {
    if (!settings.resume_ids.length || running) return;
    setError(null); setWarnings([]);
    replaceOnDone.current = replace;
    void withConsent(async () => {
      const j = await resumesApi.generate({ ...settings, exclude_texts: questions.map((q) => q.text) });     // a new set must differ from what is shown
      finish(j);
    });
  };
  const regenerateOne = (i: number) => {
    const q = questions[i];
    setRegen((s) => new Set(s).add(i));
    void withConsent(async () => {
      try {
        const nq = await resumesApi.generateOne({ resume_id: q.resume_id, claim: q.claim, kind: q.kind, difficulty: settings.difficulty, style: settings.style, existing_texts: questions.map((x) => x.text) });
        onQuestions(replaceAt(questions, i, withUid(nq)));
      } finally { setRegen((s) => { const n = new Set(s); n.delete(i); return n; }); }
    });
  };
  const answerConsent = async (accept: boolean) => {
    const c = consent;
    if (!c) return;
    if (!accept) { setConsent(null); setError("Nothing was sent. These questions need your OK to use Ollama cloud (or switch to the local model in Settings → AI models)."); return; }
    setConsentBusy(true);
    try { for (const id of c.ids) await resumesApi.consent(id, true); onResumesChanged(); setConsent(null); c.then(); }
    catch (e) { toast("error", (e as Error).message); setConsent(null); }
    finally { setConsentBusy(false); }
  };

  return (
    <div className="rz-panel" data-testid="resume-panel">
      <div className="fld"><div className="lbl">Resumes<small>{chosen.length ? `${chosen.length} selected` : "choose at least one"}</small></div>
        <ResumePicker resumes={resumes} selected={settings.resume_ids} onChange={(ids) => set("resume_ids", ids)} /></div>

      <div className="grid2" style={{ alignItems: "start" }}>
        <div className="fld"><div className="lbl"><span id="rq-count">How many resume questions</span><small>3–20</small></div>
          <div className="rz-stepper" role="group" aria-labelledby="rq-count">
            <button type="button" className="btn icon" aria-label="Fewer questions" disabled={settings.count <= 3} onClick={() => set("count", clampCount(settings.count - 1))}><Icon name="dn" /></button>
            <input type="number" aria-label="Number of resume questions" min={3} max={20} value={settings.count} onChange={(e) => set("count", clampCount(Number(e.target.value)))} />
            <button type="button" className="btn icon" aria-label="More questions" disabled={settings.count >= 20} onClick={() => set("count", clampCount(settings.count + 1))}><Icon name="up" /></button>
          </div></div>
      </div>

      <div className="fld"><div className="lbl">Difficulty</div>
          <Seg label="Difficulty of resume questions" size="sm" value={settings.difficulty} onChange={(v) => set("difficulty", v)} options={DIFFICULTIES} /></div>
      <div className="fld"><div className="lbl">Focus<small>{settings.focus.length} chosen</small></div>
        <div className="presets" role="group" aria-label="Focus areas">
          {FOCUS.map((f) => {
            const on = settings.focus.includes(f.value);
            return <button key={f.value} type="button" className={`chip ${on ? "on" : ""}`} aria-pressed={on}
              onClick={() => set("focus", on ? (settings.focus.length > 1 ? settings.focus.filter((x) => x !== f.value) : settings.focus) : [...settings.focus, f.value])}>{on && <Icon name="check" size={13} />} {f.label}</button>;
          })}
        </div></div>

      <div className="fld"><div className="lbl">Depth<small>{DEPTHS.find((d) => d.value === settings.depth)?.hint}</small></div>
        <Seg label="Depth" value={settings.depth} onChange={(v) => set("depth", v)} options={DEPTHS.map((d) => ({ value: d.value, label: d.label }))} /></div>

      <div className="fld"><div className="lbl">Interviewer style<small>changes the wording only</small></div>
        <OptionCards label="Interviewer style" cols={3} value={settings.style} onChange={(v) => set("style", v)}
          options={STYLES.map((s) => ({ value: s.value, title: s.label, desc: s.hint, icon: s.value === "recruiter" ? "users" : s.value === "manager" ? "briefcase" : "target" }))} /></div>

      <div className="rz-gen">
        {!running ? (
          <>
            <button className="btn primary" disabled={!settings.resume_ids.length} onClick={() => (questions.length ? setConfirmAll(true) : generate(true))}>
              {questions.length ? "Regenerate all" : "Generate questions"}</button>
            <span className="muted small">about {minutes} min {cloud ? "with Ollama cloud" : "on this computer"}{cost !== undefined ? ` · estimated cost ${cost === null ? "unknown (no price set)" : `up to ${fmtUsd(cost)}`}` : ""}</span>
          </>
        ) : (
          <div className="rz-genrun" role="status" aria-live="polite">
            <span className="spinner" aria-hidden />
            <div className="grow"><b>Writing questions… {job.done} of {job.total}</b><div className="meter" aria-hidden><i style={{ width: `${Math.max(6, Math.round((job.done / Math.max(1, job.total)) * 100))}%` }} /></div></div>
            <button className="btn" onClick={() => void resumesApi.cancelJob(job.id).then(finish).catch(() => {})}>Cancel</button>
          </div>
        )}
      </div>
      {cloud && <div className="notice info small" style={{ margin: 0 }}><Icon name="cloud" /> Cloud mode is on: the selected resumes’ organised content is sent to Ollama’s servers to write these questions (you are asked first for each resume).</div>}
      {error && <div className="notice error small" role="alert" style={{ margin: 0 }}>{error} {!running && settings.resume_ids.length > 0 && <button className="linkbtn" onClick={() => generate(true)}>Try again</button>}</div>}
      {warnings.map((w) => <div key={w} className="notice warn small" role="status" style={{ margin: 0 }}>{w}</div>)}

      {questions.length > 0 && (
        <div className="rz-review">
          <div className="row between"><b>Review your questions</b><span className="muted small">{questions.length} question{questions.length === 1 ? "" : "s"} · edit, remove or reorder them</span></div>
          <ol className="rz-qlist">
            {questions.map((q, i) => (
              <QuestionRow key={q.uid ?? i} q={q} i={i} n={questions.length} busy={regen.has(i)}
                onChange={(nq) => onQuestions(replaceAt(questions, i, nq))} onRemove={() => onQuestions(removeAt(questions, i))}
                onMove={(d) => onQuestions(move(questions, i, d))} onRegenerate={() => regenerateOne(i)} />
            ))}
          </ol>
          <label className="check"><input type="checkbox" checked={saveToBank} onChange={(e) => onSaveToBank(e.target.checked)} />Also save these to my question bank <span className="muted small">(a set named “From {chosen[0]?.name ?? "your resume"}”)</span></label>
        </div>
      )}
      {consent && <ConsentDialog names={consent.ids.map((id) => resumes.find((r) => r.id === id)?.name ?? "this resume")} busy={consentBusy} onAnswer={(a) => void answerConsent(a)} />}
      {confirmAll && <Confirm title="Regenerate all questions?" message="The questions below, including your edits, are replaced by a new set." confirmLabel="Regenerate" onConfirm={() => { setConfirmAll(false); generate(true); }} onCancel={() => setConfirmAll(false)} />}
    </div>
  );
}
