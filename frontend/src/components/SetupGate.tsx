import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";
import type { PullStatus, SetupItem, SetupReport } from "../types";
import Icon from "./Icon";
import Logo from "./Logo";
import { Loading, RefreshButton } from "./Loaders";
import { ErrorNotice, useToast } from "./ui";

const OS_NAME = { macos: "macOS", windows: "Windows", linux: "Linux" } as const;

function Command({ text }: { text: string }) {
  const toast = useToast();
  const copy = async () => { try { await navigator.clipboard.writeText(text); toast("ok", "Copied"); } catch { toast("info", "Select the text and copy it with ⌘C / Ctrl+C."); } };
  return (
    <span className="gate-cmd"><code>{text}</code><button type="button" className="kb-btn" onClick={() => void copy()} aria-label={`Copy command: ${text}`}><Icon name="copy" />Copy</button></span>
  );
}

function Row({ item, report, pull, onPull, onCancel, onCloud }: { item: SetupItem; report: SetupReport; pull: PullStatus | null; onPull: () => void; onCancel: () => void; onCloud: () => void }) {
  const ok = item.status === "ok";
  const pulling = item.id === "model" && pull?.state === "pulling";
  const tone = ok ? "ok" : item.status === "missing" ? "bad" : "warn";
  return (
    <li className={`gate-row ${tone}`}>
      <span className="gate-ic" aria-hidden="true"><Icon name={ok ? "check" : item.status === "optional" ? "sparkle" : "alert"} /></span>
      <div className="gate-body">
        <div className="gate-t"><b>{item.label}</b>{!item.required && <span className="badge">optional</span>}<span className={`gate-state ${tone}`}>{ok ? "Ready" : item.status === "missing" ? "Needed" : item.status === "warn" ? "Check" : "Not installed"}</span></div>
        <div className="muted small">{item.detail}</div>
        {!ok && item.help && !pulling && (
          <div className="gate-help">
            <p>{item.help.summary}</p>
            <ol>{item.help.steps.map((st, i) => (
              <li key={i}>
                <span>{st.title}</span>
                {st.url && <a className="btn small" href={st.url} target="_blank" rel="noopener noreferrer">Open the download page <Icon name="arrowr" /></a>}
                {st.command && <Command text={st.command} />}
              </li>))}</ol>
          </div>
        )}
        {item.action === "pull_llm" && !pulling && pull?.state !== "done" && (
          <div className="gate-act">
            <button className="btn primary" onClick={onPull}><Icon name="download" />Download the model{report.downloads.size_gb ? ` (about ${report.downloads.size_gb} GB)` : ""}</button>
            <span className="muted small">{report.downloads.free_gb != null ? `${report.downloads.free_gb.toFixed(0)} GB free on this computer. ` : ""}Nothing is downloaded until you press this.</span>
          </div>
        )}
        {item.id === "model" && pull && pull.state !== "idle" && (
          <div className="gate-pull" role="status" aria-live="polite">
            {pull.state === "pulling" && <>
              <div className="meter" role="progressbar" aria-label="Model download" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pull.percent ?? undefined}><i style={{ width: `${pull.percent ?? 4}%` }} /></div>
              <div className="row between"><span className="muted small">{pull.percent != null ? `${pull.percent}% · ` : ""}{pull.status}</span><button className="btn" onClick={onCancel}>Cancel</button></div></>}
            {pull.state === "error" && <div className="notice error small" style={{ margin: 0 }}><b>The download failed.</b> {pull.error} <button className="linkbtn" onClick={onPull}>Try again</button></div>}
            {pull.state === "cancelled" && <div className="notice warn small" style={{ margin: 0 }}>Download cancelled. <button className="linkbtn" onClick={onPull}>Start again</button> (it resumes where it stopped).</div>}
            {pull.state === "done" && <div className="notice info small" style={{ margin: 0 }}>Download finished. Checking…</div>}
          </div>
        )}
        {item.action === "open_ai_settings" && !ok && <div className="gate-act"><button className="btn primary" onClick={onCloud}>Open AI settings</button></div>}
      </div>
    </li>
  );
}

/**
 * The first thing a new user sees when something the app needs is missing: a plain checklist in the middle of the page, what to install
 * and how, a one-click model download, and a way to use cloud models instead.
 */
export default function SetupGate({ initial, onContinue, onCloud, manual = false }: { initial: SetupReport; onContinue: () => void; onCloud: () => void; manual?: boolean }) {
  const toast = useToast();
  const [report, setReport] = useState<SetupReport>(initial);
  const [pull, setPull] = useState<PullStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const prev = useRef(initial.ready);

  const recheck = useCallback(async () => {
    try { setReport(await api.setup(true)); setError(null); } catch (e) { setError((e as Error).message); }
  }, []);

  // the checklist updates itself while this page is open (install Ollama, open it, and the row turns green)
  useEffect(() => {
    const t = setInterval(() => { if (!document.hidden) void recheck(); }, 3500);
    return () => clearInterval(t);
  }, [recheck]);
  // follow a running download
  useEffect(() => {
    if (pull?.state !== "pulling") return;
    const t = setInterval(async () => { try { const s = await api.pullStatus(); setPull(s); if (s.state === "done") void recheck(); } catch { /* keep trying */ } }, 800);
    return () => clearInterval(t);
  }, [pull?.state, recheck]);
  useEffect(() => { if (report.ready && !prev.current) toast("ok", "Everything needed is ready."); prev.current = report.ready; }, [report.ready, toast]);

  const startPull = async () => { try { setPull(await api.startPull("llm")); } catch (e) { setPull({ state: "error", model: null, status: "", completed: 0, total: 0, percent: null, error: (e as Error).message }); } };
  const cancel = async () => { try { setPull(await api.cancelPull()); } catch { /* ignore */ } };

  const blocking = report.items.filter((i) => i.required && i.status !== "ok");
  const required = report.items.filter((i) => i.required), optional = report.items.filter((i) => !i.required);
  return (
    <main className="gate" aria-labelledby="gate-h">
      <div className="gate-card">
        <div className="gate-head"><Logo size={46} /><div><h1 id="gate-h">{report.ready ? "Everything is ready" : "Let’s get you set up"}</h1>
          <p className="muted">{report.ready ? `Your ${OS_NAME[report.os]} computer has what AI Interviewer needs.`
            : `AI Interviewer needs ${blocking.length === 1 ? "one more thing" : `${blocking.length} more things`} on this ${OS_NAME[report.os]} computer. Install ${blocking.length === 1 ? "it" : "them"}, then come back: this page notices by itself.`}</p></div></div>
        <ErrorNotice error={error} />
        <h2 className="gate-sub">Needed</h2>
        <ul className="gate-list">{required.map((i) => <Row key={i.id} item={i} report={report} pull={pull} onPull={() => void startPull()} onCancel={() => void cancel()} onCloud={onCloud} />)}</ul>
        {optional.length > 0 && <><h2 className="gate-sub">Nice to have</h2>
          <ul className="gate-list">{optional.map((i) => <Row key={i.id} item={i} report={report} pull={pull} onPull={() => void startPull()} onCancel={() => void cancel()} onCloud={onCloud} />)}</ul></>}
        <div className="gate-foot">
          {report.ready
            ? <button className="btn primary big" onClick={onContinue}>{manual ? "Back to the app" : "Start practicing"} <Icon name="arrowr" /></button>
            : <><RefreshButton onRefresh={recheck} label="Check again" />
                <button className="btn" onClick={onCloud}><Icon name="bolt" />Use cloud models instead</button>
                <button className="btn ghost" onClick={onContinue}>Continue anyway</button></>}
        </div>
        {!report.ready && <p className="muted small gate-note">Cloud models need no download: add an Ollama API key in Settings and your questions are graded on Ollama’s servers (your voice stays on this computer).</p>}
      </div>
    </main>
  );
}

/** Fetches the first report and decides whether to show the gate. */
export function useSetupReport() {
  const [state, setState] = useState<{ loading: boolean; report: SetupReport | null }>({ loading: true, report: null });
  useEffect(() => { api.setup(true).then((r) => setState({ loading: false, report: r }), () => setState({ loading: false, report: null })); }, []);
  return state;
}

export { Loading };
