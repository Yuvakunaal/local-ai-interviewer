import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, resumesApi } from "../api";
import Icon from "../components/Icon";
import ResumeEditor from "../components/ResumeEditor";
import { CardsSkeleton } from "../components/Loaders";
import { Confirm, fmtDate, useAsync, useToast } from "../components/ui";
import { setNavGuard } from "../navGuard";
import { awaitingConsent, changedSections, emptyProfile, isWorking, METHOD_HELP, methodLabel, normalise, sameProfile, stageText, statusChip, validateProfile } from "../resumeHelpers";
import type { Resume, ResumeProfile, ResumeText } from "../types";
import { ConsentDialog, DELETE_NOTE, practice } from "./Resumes";
import { usePoll } from "./usePoll";

type Tab = "content" | "preview" | "text";

function RawText({ id, method }: { id: number; method: string | null }) {
  const toast = useToast();
  const text = useAsync<ResumeText>(() => resumesApi.text(id), [id]);
  const copy = async () => {
    try { await navigator.clipboard.writeText(text.data?.raw_text ?? ""); toast("ok", "Copied the text"); }
    catch { toast("info", "Select the text and copy it with ⌘C / Ctrl+C."); }
  };
  if (text.error) return <div className="notice error" role="alert">{text.error} <button className="linkbtn" onClick={() => void text.reload()}>Try again</button></div>;
  if (!text.data) return <CardsSkeleton n={1} label="Loading the text…" />;
  const parts = text.data.raw_text.split(/^(--- page \d+ ---)$/m).filter((x) => x !== "");
  return (
    <div className="card">
      <div className="row between" style={{ marginBottom: 10 }}>
        <div><b>Text read from your PDF</b>{method && <span className="rz-mark" style={{ marginLeft: 8 }}>{methodLabel(method)}</span>}
          <div className="muted small">{method ? METHOD_HELP[method] : ""} Hidden or white text in a PDF shows up here too, so this is the place to spot it.</div></div>
        <button className="btn" onClick={() => void copy()} disabled={!text.data.raw_text}><Icon name="copy" />Copy</button>
      </div>
      {text.data.raw_text ? (
        <pre className="rz-raw" tabIndex={0} aria-label="Original text">{parts.map((p, i) => /^--- page \d+ ---$/.test(p) ? <span key={i} className="rz-page">{p.replace(/-/g, "").trim()}</span> : <span key={i}>{p}</span>)}</pre>
      ) : <p className="muted">No text has been read from this PDF yet.</p>}
    </div>
  );
}

function Preview({ id, name }: { id: number; name: string }) {
  const url = resumesApi.fileUrl(id);
  const noViewer = typeof navigator !== "undefined" && (navigator as Navigator & { pdfViewerEnabled?: boolean }).pdfViewerEnabled === false;
  return (
    <div className="card rz-preview">
      <div className="row between" style={{ marginBottom: 10 }}>
        <b>Original PDF</b>
        <div className="row"><a className="btn" href={url} target="_blank" rel="noopener noreferrer"><Icon name="eye" />Open in new tab</a><a className="btn" href={resumesApi.fileUrl(id, true)} download><Icon name="download" />Download</a></div>
      </div>
      {noViewer
        ? <div className="notice info" role="status">Your browser is set to download PDFs instead of showing them, so the preview can’t be shown here. Use <b>Open in new tab</b> or <b>Download</b>.</div>
        : <iframe className="rz-pdf" src={url} title={`${name} (original PDF)`} />}
    </div>
  );
}

export default function ResumeDetail({ id }: { id: number }) {
  const toast = useToast();
  const [r, setR] = useState<Resume | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("content");
  const [draft, setDraft] = useState<ResumeProfile | null>(null);
  const [saving, setSaving] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<null | "reparse" | "delete" | "revert" | { leave: string }>(null);
  const [consent, setConsent] = useState(false);

  const load = useCallback(async (quiet = false) => {
    try { const x = await resumesApi.get(id, quiet); setR(x); setError(null); return x; }
    catch (e) { setError((e as Error).message); return null; }
  }, [id]);
  useEffect(() => { void load().then((x) => { if (x) setDraft(x.profile ? normalise(x.profile) : null); }); }, [load]);
  const working = !!r && isWorking(r);
  const wasWorking = useRef(false);
  usePoll(async (alive) => {
    const x = await resumesApi.get(id, true);
    if (!alive()) return;
    setR(x);
  }, 1500, working);
  useEffect(() => {        // when the AI finishes, show what it produced (there were no edits while it worked: saving is blocked then)
    if (wasWorking.current && r && !isWorking(r)) setDraft(r.profile ? normalise(r.profile) : null);
    wasWorking.current = !!r && isWorking(r);
  }, [r]);

  const saved = r?.profile ?? null;
  const dirty = !!draft && !sameProfile(saved, draft) && !(saved === null && sameProfile(emptyProfile(), draft) && r?.status === "ready");
  const errors = useMemo(() => (draft ? validateProfile(draft) : []), [draft]);
  const changed = draft && saved ? changedSections(saved, draft) : [];

  // unsaved-changes guard: closing the tab, and moving to another page of the app
  useEffect(() => {
    if (!dirty) return;
    const before = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ""; };
    window.addEventListener("beforeunload", before);
    setNavGuard((next) => { setConfirm({ leave: next }); return false; });
    return () => { window.removeEventListener("beforeunload", before); setNavGuard(null); };
  }, [dirty]);

  const run = async (fn: () => Promise<Resume>, ok?: string) => {
    try { const x = await fn(); setR(x); if (ok) toast("ok", ok); return x; }
    catch (e) {
      if ((e as ApiError).code === "resume_changed") toast("error", "This resume was changed in another tab. Reload the page to see the latest version (your edits stay here until you do).");
      else toast("error", (e as Error).message);
      return null;
    }
  };
  const save = async () => {
    if (!r || !draft || errors.length || saving) return;
    setSaving(true);
    const x = await run(() => resumesApi.patch(r.id, r.revision, { profile: normalise(draft) }), "Saved");
    if (x?.profile) setDraft(normalise(x.profile));
    setSaving(false);
  };
  const rename = async () => {
    if (!r || renaming == null) return;
    const name = renaming.trim();
    if (!name || name === r.name) { setRenaming(null); return; }
    const x = await run(() => resumesApi.patch(r.id, r.revision, { name }));
    if (x) setRenaming(null);
  };
  const doConfirm = async () => {
    const c = confirm;
    setConfirm(null);
    if (!r || !c) return;
    if (c === "reparse") { const x = await run(() => resumesApi.reparse(r.id), "Reading your resume again…"); if (x) setTab("content"); }
    else if (c === "revert") { const x = await run(() => resumesApi.revert(r.id, r.revision), "Back to the AI version"); if (x?.profile) setDraft(normalise(x.profile)); }
    else if (c === "delete") { try { setNavGuard(null); await resumesApi.remove(r.id); toast("ok", `Deleted ${r.name}`); window.location.hash = "#/resumes"; } catch (e) { toast("error", (e as Error).message); } }
    else { setNavGuard(null); window.location.hash = c.leave; }
  };
  const answerConsent = async (accept: boolean) => { setConsent(false); if (r) await run(() => resumesApi.consent(r.id, accept)); };

  if (error && !r) return <div><div className="notice error" role="alert">{error} <button className="linkbtn" onClick={() => void load()}>Try again</button></div><a href="#/resumes">← Resumes</a></div>;
  if (!r) return <div aria-busy="true"><span className="skel" style={{ width: 260, height: 30 }} /><CardsSkeleton n={2} label="Loading the resume…" /></div>;
  const chip = statusChip(r);
  const failedNoProfile = r.status === "failed" && !draft;

  return (
    <div className="rz-detail">
      <div className="pagehead">
        <div className="grow" style={{ minWidth: 0 }}>
          <a href="#/resumes" className="small" style={{ color: "var(--muted)", textDecoration: "none" }}>← Resumes</a>
          <div className="rz-title">
            {renaming == null
              ? <><h1>{r.name}</h1><button className="btn icon ghost" aria-label="Rename this resume" title="Rename" onClick={() => setRenaming(r.name)}><Icon name="pencil" /></button></>
              : <form className="row" onSubmit={(e) => { e.preventDefault(); void rename(); }}>
                  <input type="text" aria-label="Resume name" autoFocus maxLength={60} value={renaming} onChange={(e) => setRenaming(e.target.value)} onKeyDown={(e) => { if (e.key === "Escape") setRenaming(null); }} style={{ width: 280 }} />
                  <button className="btn primary" type="submit" disabled={!renaming.trim()}>Save name</button><button className="btn" type="button" onClick={() => setRenaming(null)}>Cancel</button></form>}
            <span className={`rz-status ${chip.tone}`}>{chip.label}</span>
          </div>
          <div className="muted small">{r.original_filename} · {r.pages} page{r.pages === 1 ? "" : "s"}{r.extraction_method ? ` · read as ${methodLabel(r.extraction_method)}` : ""} · added {fmtDate(r.created_at)}</div>
        </div>
        <div className="row rz-actions">
          <button className="btn primary" disabled={r.status !== "ready" || dirty} title={dirty ? "Save your changes first" : undefined} onClick={() => practice(r.id)}><Icon name="mic" />Practice with this resume</button>
          <button className="btn" disabled={working} onClick={() => setConfirm("reparse")}><Icon name="refresh" />Re-organise with AI</button>
          <a className="btn" href={resumesApi.fileUrl(r.id, true)} download><Icon name="download" />Download original</a>
          <button className="btn ghost rz-del" onClick={() => setConfirm("delete")}><Icon name="trash" />Delete</button>
        </div>
      </div>

      {working && (
        <div className="notice info rz-banner" role="status" aria-live="polite"><span className="spinner" aria-hidden /> <b>{stageText(r)}</b><span className="muted"> — this can take a minute or two on this computer.</span>
          <button className="btn" onClick={() => void run(() => resumesApi.cancel(r.id), "Stopped")}>Stop</button></div>
      )}
      {awaitingConsent(r) && (
        <div className="notice info rz-banner" role="status"><Icon name="cloud" /> <span><b>Cloud mode is on.</b> The text was read on this computer; organising it sends the text to Ollama’s servers.</span>
          <button className="btn primary" onClick={() => setConsent(true)}>Review and allow</button></div>
      )}

      <div className="tabs" role="tablist" aria-label="Resume views">
        {([["content", "Content"], ["preview", "Preview"], ["text", "Original text"]] as const).map(([k, label]) => (
          <button key={k} id={`tab-${k}`} role="tab" aria-selected={tab === k} aria-controls={`panel-${k}`} className={`tab ${tab === k ? "active" : ""}`} onClick={() => setTab(k)}>{label}</button>
        ))}
      </div>

      <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
        {tab === "content" && (
          <>
            {failedNoProfile && (
              <div className="card rz-attn" role="alert">
                <div className="rz-attn-ic" aria-hidden><Icon name="alert" /></div>
                <div className="grow"><h2 style={{ marginBottom: 4 }}>This resume needs your attention</h2><p style={{ margin: 0 }}>{r.error_message}</p>
                  <p className="muted small">Nothing is lost: the PDF{r.has_text ? " and the text that was read are" : " is"} kept.{r.has_text ? " See the Original text tab." : ""}</p>
                  <div className="row"><button className="btn primary" onClick={() => void run(() => resumesApi.reparse(r.id))}><Icon name="refresh" />Try again</button>
                    <button className="btn" onClick={() => setDraft(emptyProfile())}><Icon name="pencil" />Fill in manually</button></div></div>
              </div>
            )}
            {r.status === "failed" && draft && !r.profile && <div className="notice info small">Filling in by hand. Press <b>Save changes</b> when you are done; the resume is then ready to use.</div>}
            {draft && (
              <>
                {r.has_ai_profile && <p className="rz-note"><Icon name="eye" />Organised by AI from your PDF – please check it. Your saved edits are what interview questions are based on.</p>}
                {(r.profile?.parse_warnings ?? []).map((w) => <div key={w} className="notice warn small" role="status">{w}</div>)}
                <ResumeEditor value={draft} onChange={setDraft} errors={errors} />
                <div className={`rz-savebar ${dirty ? "on" : ""}`} role="region" aria-label="Save changes">
                  <span className="rz-dirty" aria-live="polite">{dirty ? <><i className="rz-dot-dirty" aria-hidden />Unsaved changes{changed.length ? ` in ${changed.slice(0, 3).join(", ")}${changed.length > 3 ? "…" : ""}` : ""}</> : saving ? "Saving…" : `All changes saved · ${fmtDate(r.updated_at)}`}</span>
                  {errors.length > 0 && <span className="rz-ferr">{errors.length} field{errors.length === 1 ? "" : "s"} too long — see the red notes above.</span>}
                  <span className="grow" />
                  {r.has_ai_profile && <button className="btn ghost" disabled={working} onClick={() => setConfirm("revert")}>Revert to AI version</button>}
                  <button className="btn" disabled={!dirty || saving} onClick={() => setDraft(r.profile ? normalise(r.profile) : r.status === "failed" ? null : emptyProfile())}>Discard</button>
                  <button className="btn primary" disabled={!dirty || saving || errors.length > 0 || working} onClick={() => void save()}>{saving ? "Saving…" : "Save changes"}</button>
                </div>
              </>
            )}
            {!draft && !failedNoProfile && (working || r.status === "uploaded") && <CardsSkeleton n={2} label="Your resume is being organised…" />}
          </>
        )}
        {tab === "preview" && <Preview id={r.id} name={r.name} />}
        {tab === "text" && <RawText id={r.id} method={r.extraction_method} />}
      </div>

      {confirm === "reparse" && <Confirm title="Re-organise with AI?" message="The AI reads your PDF again and replaces the organised content, including any edits you saved. The original PDF is not changed." confirmLabel="Re-organise" onConfirm={() => void doConfirm()} onCancel={() => setConfirm(null)} />}
      {confirm === "revert" && <Confirm title="Revert to the AI version?" message="Your saved edits are replaced by the content exactly as the AI first organised it." confirmLabel="Revert" onConfirm={() => void doConfirm()} onCancel={() => setConfirm(null)} />}
      {confirm === "delete" && <Confirm title={`Delete ${r.name}?`} message={DELETE_NOTE} confirmLabel="Delete" danger onConfirm={() => void doConfirm()} onCancel={() => setConfirm(null)} />}
      {confirm && typeof confirm === "object" && <Confirm title="Leave without saving?" message="You have unsaved changes to this resume. If you leave now they are lost." confirmLabel="Leave without saving" danger onConfirm={() => void doConfirm()} onCancel={() => setConfirm(null)} />}
      {consent && <ConsentDialog names={[r.name]} onAnswer={(a) => void answerConsent(a)} />}
    </div>
  );
}
