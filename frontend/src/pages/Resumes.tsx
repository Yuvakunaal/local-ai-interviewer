import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, resumesApi, uploadResume } from "../api";
import Icon from "../components/Icon";
import { Confirm, ErrorNotice, Modal, fmtShort, useAsync, useToast } from "../components/ui";
import { INTENT_EVENT, setIntent, takeIntent } from "../intent";
import { anyWorking, awaitingConsent, checkPdf, fmtBytes, isWorking, looksLikePdf, methodLabel, stageText, statusChip, steps } from "../resumeHelpers";
import type { Resume, ResumeSummary } from "../types";
import { usePoll } from "./usePoll";

const MAX_MB_DEFAULT = 10;
export const DELETE_NOTE = "This deletes the PDF, its text and the organised content from this computer. Past interviews keep their questions and short quotes from the resume (up to 400 characters each), so their reports still work.";

export function practice(id: number) {
  setIntent({ type: "resume-practice", resumeIds: [id] });
  window.location.hash = "#/setup";
}

/** "Stays on this computer" or the cloud notice, whichever is true right now. */
export function PrivacyLine({ cloud }: { cloud: boolean }) {
  return (
    <p className="rz-privacy"><Icon name={cloud ? "cloud" : "shield"} />
      {cloud ? "Cloud mode is on: the text is sent to Ollama cloud to organise it – you will be asked first. The PDF itself stays on this computer."
        : "Stays on this computer. Your resume is read and organised by the local model; nothing is uploaded anywhere."}</p>
  );
}

export function ConsentDialog({ names, onAnswer, busy }: { names: string[]; onAnswer: (accept: boolean) => void; busy?: boolean }) {
  return (
    <Modal title="Send to Ollama cloud?" onClose={() => onAnswer(false)} narrow>
      <p className="muted" style={{ marginTop: 0 }}>Cloud mode is on. To organise {names.length === 1 ? `“${names[0]}”` : `${names.length} resumes`} and write questions about {names.length === 1 ? "it" : "them"}, the
        extracted text is sent to Ollama’s servers. The PDF itself stays on this computer.</p>
      <p className="muted small">Prefer to keep it local? Switch to <b>On this computer</b> in Settings → AI models and press Try again.</p>
      <div className="row" style={{ justifyContent: "flex-end" }}>
        <button className="btn" onClick={() => onAnswer(false)} disabled={busy}>Not now</button>
        <button className="btn primary" onClick={() => onAnswer(true)} disabled={busy} autoFocus>Send to the cloud</button>
      </div>
    </Modal>
  );
}

function Stepper({ r, uploading, percent }: { r: ResumeSummary | null; uploading: boolean; percent: number }) {
  const list = steps(r, uploading);
  return (
    <ol className="rz-steps" aria-label="Progress">
      {list.map((s) => (
        <li key={s.key} className={`rz-step ${s.state}`} aria-current={s.state === "active" ? "step" : undefined}>
          <span className="rz-dot" aria-hidden>{s.state === "done" ? <Icon name="check" /> : s.state === "error" ? <Icon name="x" /> : s.state === "active" ? <span className="spinner" /> : null}</span>
          <span className="rz-sl">{s.label}{s.key === "upload" && uploading ? ` · ${percent}%` : s.detail ? ` · ${s.detail}` : ""}</span>
        </li>
      ))}
    </ol>
  );
}

type Phase = { kind: "pick" } | { kind: "uploading"; percent: number; file: File } | { kind: "tracking"; id: number } | { kind: "duplicate"; file: File; id: number; name: string };

/** Centred, undimmed dialog: drop or pick a PDF, then watch it being read. Closing it never stops the work. */
export function UploadDialog({ onClose, onChanged, cloud, maxMb = MAX_MB_DEFAULT, initialFile }: { onClose: () => void; onChanged: () => void; cloud: boolean; maxMb?: number; initialFile?: File | null }) {
  const toast = useToast();
  const [phase, setPhase] = useState<Phase>({ kind: "pick" });
  const [error, setError] = useState<string | null>(null);
  const [drag, setDrag] = useState(false);
  const [resume, setResume] = useState<Resume | null>(null);
  const [consentBusy, setConsentBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);

  const send = async (file: File, allowDuplicate = false) => {
    setError(null);
    const bad = checkPdf(file, maxMb);
    if (bad) { setError(bad); return; }
    try {
      const head = new Uint8Array(await file.slice(0, 5).arrayBuffer());
      if (!looksLikePdf(head)) { setError("This file is not really a PDF (only its name ends in .pdf). Export your resume as a PDF and try again."); return; }
    } catch { /* the server checks again */ }
    abort.current = new AbortController();
    setPhase({ kind: "uploading", percent: 0, file });
    try {
      const res = await uploadResume(file, { allowDuplicate, signal: abort.current.signal, onProgress: (f) => setPhase({ kind: "uploading", percent: Math.round(f * 100), file }) });
      if (res.kind === "duplicate") { setPhase({ kind: "duplicate", file, id: res.id, name: res.name }); return; }
      setResume(res.resume);
      setPhase({ kind: "tracking", id: res.resume.id });
      onChanged();
    } catch (e) {
      if ((e as ApiError).code === "aborted") { setPhase({ kind: "pick" }); return; }
      setError((e as Error).message);
      setPhase({ kind: "pick" });
    }
  };
  const tracking = phase.kind === "tracking" ? phase.id : null;
  usePoll(async (alive) => {
    if (tracking == null) return;
    const r = await resumesApi.get(tracking, true);
    if (!alive()) return;
    setResume(r);
    if (!isWorking(r)) onChanged();
  }, 1500, tracking != null && (!resume || isWorking(resume)));

  const started = useRef(false);
  useEffect(() => { if (initialFile && !started.current) { started.current = true; void send(initialFile); } }, [initialFile]); // eslint-disable-line react-hooks/exhaustive-deps
  const onFiles = (files: FileList | null) => { const f = files?.[0]; if (f) void send(f); };
  const retry = async () => { if (!resume) return; try { setResume(await resumesApi.reparse(resume.id)); onChanged(); } catch (e) { toast("error", (e as Error).message); } };
  const answerConsent = async (accept: boolean) => {
    if (!resume) return;
    setConsentBusy(true);
    try { setResume(await resumesApi.consent(resume.id, accept)); onChanged(); } catch (e) { toast("error", (e as Error).message); } finally { setConsentBusy(false); }
  };
  const live = resume && phase.kind === "tracking" ? stageText(resume) : phase.kind === "uploading" ? `Uploading · ${phase.percent}%` : "";

  return (
    <Modal title="Add resume" onClose={onClose}>
      <div aria-live="polite" className="sr-only">{live}</div>
      {phase.kind === "pick" && (
        <>
          <button type="button" className={`rz-drop ${drag ? "over" : ""}`} onClick={() => input.current?.click()}
            onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)}
            onDrop={(e) => { e.preventDefault(); setDrag(false); onFiles(e.dataTransfer.files); }}>
            <span className="rz-drop-ic"><Icon name="upload" size={22} /></span>
            <b>Drop your resume here, or choose a file</b>
            <span className="muted small">PDF only · up to {maxMb} MB</span>
          </button>
          <input ref={input} type="file" accept="application/pdf,.pdf" hidden aria-label="Choose a PDF file" data-testid="resume-file" onChange={(e) => { onFiles(e.target.files); e.target.value = ""; }} />
          <ErrorNotice error={error} />
          <PrivacyLine cloud={cloud} />
        </>
      )}
      {phase.kind === "uploading" && (
        <div className="rz-track">
          <div className="rz-file"><Icon name="file" /><b>{phase.file.name}</b><span className="muted small">{fmtBytes(phase.file.size)}</span></div>
          <div className="meter" role="progressbar" aria-label="Upload" aria-valuemin={0} aria-valuemax={100} aria-valuenow={phase.percent}><i style={{ width: `${Math.max(4, phase.percent)}%` }} /></div>
          <Stepper r={null} uploading percent={phase.percent} />
          <div className="row" style={{ justifyContent: "flex-end" }}><button className="btn" onClick={() => abort.current?.abort()}>Cancel upload</button></div>
        </div>
      )}
      {phase.kind === "duplicate" && (
        <div className="rz-track">
          <div className="notice warn" role="alert" style={{ marginTop: 0 }}><b>You already added this file</b> — it is “{phase.name}”. Add it again anyway?</div>
          <div className="row" style={{ justifyContent: "flex-end" }}>
            <button className="btn" onClick={() => setPhase({ kind: "pick" })}>Cancel</button>
            <a className="btn" href={`#/resumes/${phase.id}`} onClick={onClose}>Open “{phase.name}”</a>
            <button className="btn primary" onClick={() => void send(phase.file, true)}>Add anyway</button>
          </div>
        </div>
      )}
      {phase.kind === "tracking" && resume && (
        <div className="rz-track">
          <div className="rz-file"><Icon name="file" /><b>{resume.name}</b><span className="muted small">{resume.original_filename} · {resume.pages} page{resume.pages === 1 ? "" : "s"}</span></div>
          <Stepper r={resume} uploading={false} percent={100} />
          {isWorking(resume) && <p className="muted small" style={{ margin: 0 }}>You can close this window: reading continues and the card shows its progress.</p>}
          {awaitingConsent(resume) && (
            <div className="notice info" style={{ margin: 0 }}><b>Cloud mode is on.</b> The text was read on this computer. To organise it, the text is sent to Ollama’s servers (the PDF stays here).
              <div className="row" style={{ marginTop: 10 }}><button className="btn primary" disabled={consentBusy} onClick={() => void answerConsent(true)}>Send to the cloud</button><button className="btn" disabled={consentBusy} onClick={() => void answerConsent(false)}>Not now</button></div></div>
          )}
          {resume.status === "ready" && (
            <div className="notice ok" role="status" style={{ margin: 0 }}><b>Ready.</b> Your resume was organised{resume.warnings ? ", with a note to check" : ""}. Please look it over before you practice.</div>
          )}
          {resume.status === "failed" && (
            <div className="notice error" role="alert" style={{ margin: 0 }}><b>This needs your attention.</b> {resume.error_message}</div>
          )}
          <div className="row" style={{ justifyContent: "flex-end" }}>
            {resume.status === "failed" && <button className="btn" onClick={() => void retry()}><Icon name="refresh" />Try again</button>}
            <button className="btn" onClick={onClose}>{isWorking(resume) ? "Close" : "Done"}</button>
            {(resume.status === "ready" || resume.status === "failed") && <a className="btn primary" href={`#/resumes/${resume.id}`} onClick={onClose}>{resume.status === "ready" ? "Review it" : "Open it"} <Icon name="arrowr" /></a>}
          </div>
        </div>
      )}
    </Modal>
  );
}

function ResumeCard({ r, onDelete, onChanged }: { r: ResumeSummary; onDelete: (r: ResumeSummary) => void; onChanged: () => void }) {
  const toast = useToast();
  const chip = statusChip(r);
  const method = methodLabel(r.extraction_method);
  const working = isWorking(r);
  const act = async (fn: () => Promise<unknown>) => { try { await fn(); onChanged(); } catch (e) { toast("error", (e as Error).message); } };
  return (
    <article className="rz-card" aria-label={r.name} data-testid="resume-card">
      <div className="rz-card-h">
        <span className="rz-thumb" aria-hidden><i /></span>
        <div className="grow">
          <a className="rz-name" href={`#/resumes/${r.id}`}>{r.name}</a>
          <div className="muted small rz-meta" title={r.original_filename}>{r.original_filename}</div>
        </div>
        <span className={`rz-status ${chip.tone}`}>{chip.label}</span>
      </div>
      <div className="rz-facts">
        <span className="rz-mark">{r.pages} page{r.pages === 1 ? "" : "s"}{method ? ` · ${method}` : ""}</span><span className="muted small">Added {fmtShort(r.created_at)}</span>
      </div>
      {working && (
        <div className="rz-work" role="status"><div className="meter rz-indet" aria-hidden><i /></div><span className="small">{stageText(r)}</span></div>
      )}
      {awaitingConsent(r) && <div className="notice info small" style={{ margin: 0 }}>Waiting for your OK to send the text to Ollama cloud. <a href={`#/resumes/${r.id}`}>Open it</a></div>}
      {r.status === "failed" && <p className="rz-err small">{r.error_message}</p>}
      {r.skills_preview.length > 0 && <div className="rz-skills">{r.skills_preview.map((s) => <span key={s} className="rz-tag">{s}</span>)}</div>}
      <div className="rz-card-f">
        <span className="muted small">Edited {fmtShort(r.updated_at)}</span>
        <div className="row" style={{ gap: 6 }}>
          {r.status === "failed" && <button className="btn" onClick={() => void act(() => resumesApi.reparse(r.id))}>Try again</button>}
          <a className="btn" href={`#/resumes/${r.id}`}>Open</a>
          <button className="btn soft" disabled={r.status !== "ready"} onClick={() => practice(r.id)} title={r.status === "ready" ? "Interview setup with this resume" : "Available when it is ready"}>Practice</button>
          <button className="btn icon ghost rz-del" aria-label={`Delete ${r.name}`} title="Delete" onClick={() => onDelete(r)}><Icon name="trash" /></button>
        </div>
      </div>
    </article>
  );
}

export default function Resumes() {
  const toast = useToast();
  const list = useAsync(() => resumesApi.list(), []);
  const health = useAsync(() => api.health(), []);
  const [rows, setRows] = useState<ResumeSummary[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [dropped, setDropped] = useState<File | null>(null);
  const [deleting, setDeleting] = useState<ResumeSummary | null>(null);
  const [maxMb, setMaxMb] = useState(MAX_MB_DEFAULT);
  const cloud = health.data?.ai.mode === "cloud";
  useEffect(() => { if (list.data) setRows(list.data); }, [list.data]);
  useEffect(() => { resumesApi.storage().then((s) => setMaxMb(s.max_mb)).catch(() => {}); }, []);
  const refresh = useCallback(async () => { try { setRows(await resumesApi.list(true)); } catch { /* keep what is shown */ } }, []);
  usePoll(async (alive) => { const r = await resumesApi.list(true); if (alive()) setRows(r); }, 1500, !!rows && anyWorking(rows));

  useEffect(() => {    // "Upload resume" from the palette / Home
    const apply = () => { if (takeIntent(["resume-upload"])) setAdding(true); };
    apply();
    window.addEventListener(INTENT_EVENT, apply);
    return () => window.removeEventListener(INTENT_EVENT, apply);
  }, []);

  const del = async () => {
    if (!deleting) return;
    const d = deleting;
    setDeleting(null);
    try { await resumesApi.remove(d.id); toast("ok", `Deleted ${d.name}`); await refresh(); } catch (e) { toast("error", (e as Error).message); }
  };

  return (
    <div>
      <div className="pagehead">
        <div><h1>Resumes</h1><div className="muted">Add your resume, check how it was read, and practice questions about your own experience.</div></div>
        <button className="btn primary" onClick={() => setAdding(true)}><Icon name="plus" />Add resume</button>
      </div>
      {list.error && <div className="notice error" role="alert">{list.error} <button className="linkbtn" onClick={() => void list.reload()}>Try again</button></div>}
      {!rows && !list.error && <div className="rz-grid" aria-busy="true">{[0, 1, 2].map((i) => <span key={i} className="skel rz-skel" aria-hidden />)}<span className="sr-only">Loading resumes…</span></div>}
      {rows && rows.length === 0 && (
        <div className="rz-empty" role="status">
          <span className="rz-thumb big" aria-hidden><i /></span>
          <h2>No resumes yet</h2>
          <p className="muted">Press <b>Add resume</b> at the top right to upload your resume as a PDF.<br />Then use it to practice interview questions about your own experience.</p>
        </div>
      )}
      {rows && rows.length > 0 && (
        <div className="rz-grid">
          {rows.map((r) => <ResumeCard key={r.id} r={r} onDelete={setDeleting} onChanged={() => void refresh()} />)}
        </div>
      )}
      {adding && <UploadDialog cloud={cloud} maxMb={maxMb} initialFile={dropped} onClose={() => { setAdding(false); setDropped(null); void refresh(); }} onChanged={() => void refresh()} />}
      {deleting && <Confirm title={`Delete ${deleting.name}?`} message={DELETE_NOTE} confirmLabel="Delete" danger onConfirm={() => void del()} onCancel={() => setDeleting(null)} />}
    </div>
  );
}
