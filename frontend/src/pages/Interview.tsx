import { useCallback, useEffect, useRef, useState } from "react";
import { modKey } from "../components/CommandPalette";
import { useModelKeepAlive } from "./useModelKeepAlive";
import { ApiError, api, transcribe } from "../api";
import { speaker } from "../audio";
import Feedback from "../components/Feedback";
import { ScoreRing } from "../components/charts";
import Icon from "../components/Icon";
import { Loading } from "../components/Loaders";
import Player, { Orb } from "../components/Player";
import { Confirm, ErrorNotice, Modal, useAsync, useFullscreen, useToast } from "../components/ui";
import { MicRecorder } from "../recorder";
import type { InterviewState, Turn } from "../types";

const draftKey = (iid: number, tid: number) => `lai.draft.${iid}.${tid}`;
const notesKey = (iid: number, itemId: number) => `lai.notes.${iid}.${itemId}`;
const read = (k: string) => { try { return localStorage.getItem(k) ?? ""; } catch { return ""; } };
const write = (k: string, v: string) => { try { v ? localStorage.setItem(k, v) : localStorage.removeItem(k); } catch { /* ignore */ } };

const clock = (s: number) => `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
const wordCount = (s: string) => (s.trim() ? s.trim().split(/\s+/).length : 0);

/** Seconds spent on the current question (resets for every new question, stops while paused or evaluating). */
function useElapsed(key: number | null | undefined, running: boolean) {
  const [sec, setSec] = useState(0);
  useEffect(() => setSec(0), [key]);
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setSec((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [running, key]);
  return sec;
}

export default function Interview({ id }: { id: number }) {
  const toast = useToast();
  const [st, setSt] = useState<InterviewState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [answer, setAnswer] = useState("");
  const [notes, setNotes] = useState("");
  const [tab, setTab] = useState<"answer" | "notes">("answer");
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [confirm, setConfirm] = useState<null | "skip" | "end">(null);
  const [showProgress, setShowProgress] = useState(false);
  const [mic, setMic] = useState<"idle" | "recording" | "transcribing">("idle");
  const [micError, setMicError] = useState<string | null>(null);
  const recorder = useRef(new MicRecorder());
  const usedVoice = useRef(false);
  const spoken = useRef<number | null>(null);
  const [elapsed, setElapsed] = useState(0);

  const refresh = useCallback(async () => {
    try { setSt(await api.interview(id)); setError(null); } catch (e) { setError((e as Error).message); }
  }, [id]);
  useEffect(() => { void refresh(); }, [refresh]);

  const turn = st?.current?.turn ?? null;
  const engine = useAsync(() => api.health(), []).data;
  const cloudAI = engine?.ai.mode === "cloud";
  const thinking = useElapsed(turn?.id, st?.phase === "awaiting_answer" && st?.status === "in_progress" && !!turn);
  const turnId = turn?.id ?? null;
  const itemId = st?.current?.item.id ?? null;
  const evaluating = st?.phase === "evaluating";
  const finished = st?.status === "completed" || st?.status === "ended";
  const paused = st?.status === "paused";
  const fsMode = !!st && !finished && !paused && st.phase !== "feedback";
  useFullscreen(fsMode);

  // poll while the local model is evaluating (survives refresh: the server owns the state)
  useEffect(() => {
    if (!evaluating) { setElapsed(0); return; }
    const t0 = Date.now();
    let n = 0, timer: ReturnType<typeof setTimeout> | undefined, alive = true;
    const tick = () => {          // quick at first, calmer the longer the model thinks; nothing while the tab is hidden
      timer = setTimeout(async () => { if (!document.hidden) await refresh(); n++; if (alive) tick(); }, Math.min(2000, 700 + n * 150));
    };
    tick();
    const wake = () => { if (!document.hidden) void refresh(); };
    document.addEventListener("visibilitychange", wake);
    const clock = setInterval(() => setElapsed(Math.floor((Date.now() - t0) / 1000)), 500);
    return () => { alive = false; if (timer) clearTimeout(timer); clearInterval(clock); document.removeEventListener("visibilitychange", wake); };
  }, [evaluating, refresh]);

  // restore / persist the unsent draft for the current question; private notes per question
  useEffect(() => {
    if (turnId != null && st?.phase === "awaiting_answer") { setAnswer(read(draftKey(id, turnId))); usedVoice.current = false; setTab("answer"); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [turnId, st?.phase === "awaiting_answer"]);
  useEffect(() => { if (itemId != null) setNotes(read(notesKey(id, itemId))); }, [id, itemId]);
  const onType = (v: string) => { setAnswer(v); if (turnId != null) write(draftKey(id, turnId), v); };

  // speak each new question once; never while paused / evaluating / reviewing feedback
  useEffect(() => {
    if (!st) return;
    speaker.setRate(st.config.speech_speed);
    if (st.status !== "in_progress" || st.phase !== "awaiting_answer" || !turn) return;
    if (st.config.question_audio !== "auto" || spoken.current === turn.id) return;
    spoken.current = turn.id;
    void speaker.play(`t${turn.id}`, turn.question_text, st.config.voice);
  }, [st, turn]);
  useModelKeepAlive(!!st && st.status === "in_progress" && (st.phase === "awaiting_answer" || st.phase === "feedback"), turn?.id);
  useEffect(() => { if (st && (st.status !== "in_progress" || st.phase !== "awaiting_answer")) speaker.stop(); }, [st?.status, st?.phase]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => { speaker.stop(); spoken.current = null; recorder.current.cancel(); }, []);

  const run = async (fn: () => Promise<InterviewState>, after?: () => void) => {
    if (busyRef.current) return;                       // one request at a time: no double submits
    busyRef.current = true; setBusy(true);
    try { setSt(await fn()); setError(null); after?.(); }
    catch (e) {
      const err = e as ApiError;
      setError(err.message);
      if (err.status === 409) await refresh();         // page was stale: reload the truth from the server
    } finally { busyRef.current = false; setBusy(false); }
  };

  if (!st) return <div style={{ padding: 30 }}>{error ? <ErrorNotice error={error} /> : <Loading label="Opening your interview…" />}</div>;
  const p = st.progress;
  const cur = st.current;
  const canAnswer = st.phase === "awaiting_answer" && st.status === "in_progress" && !!turn;
  const isFollowup = turn?.kind === "followup";
  const pct = Math.round((p.finished / Math.max(1, p.total)) * 100);
  // header label: while reviewing feedback it names what was just answered; otherwise what is on screen now
  const lastEval = (cur?.thread ?? []).filter((t) => t.status === "evaluated").slice(-1)[0];
  const onFollowup = st.phase === "feedback" ? lastEval?.kind === "followup" : isFollowup;
  const fuNo = st.phase === "feedback" ? lastEval?.seq ?? 1 : turn?.seq ?? 1;
  const where = onFollowup ? `Follow-up ${fuNo} of ${cur?.item.followups_max ?? 1}` : `Question ${p.position ?? p.finished} of ${p.total}`;
  const micOn = st.config.mic_enabled && MicRecorder.supported();

  const submit = () => {
    if (!canAnswer || !turn || !answer.trim() || busyRef.current) return;
    speaker.stop();
    void run(() => api.answer(id, turn.id, answer.trim(), usedVoice.current ? "voice" : "typed"), () => write(draftKey(id, turn.id), ""));
  };

  const toggleMic = async () => {
    setMicError(null);
    if (mic === "idle") {
      speaker.stop();
      try { await recorder.current.start(); setMic("recording"); } catch (e) { setMicError((e as Error).message); }
    } else if (mic === "recording") {
      setMic("transcribing");
      try {
        const text = await transcribe(await recorder.current.stop());
        usedVoice.current = true;
        onType((answer ? answer.trimEnd() + " " : "") + text);
      } catch (e) { setMicError((e as Error).message); }
      setMic("idle");
    }
  };

  const canSkip = !busy && !paused && (canAnswer || st.phase === "evaluation_failed" || (st.phase === "feedback" && st.next_action === "followup"));
  const dialogs = (
    <>
      {showProgress && <Modal title="Interview Progress" onClose={() => setShowProgress(false)}><ProgressList st={st} pct={pct} /></Modal>}
      {confirm === "skip" && (
        <Confirm title="Skip?" confirmLabel="Skip" onCancel={() => setConfirm(null)}
          message={isFollowup || st.next_action === "followup" ? "The follow-up will be skipped and left unscored. Your earlier answer on this question still counts." : "This question will be marked as skipped. It is not scored and does not count toward your average."}
          onConfirm={() => { setConfirm(null); if (st.current_turn_id != null) void run(() => api.action(id, "skip", st.current_turn_id!)); }} />
      )}
      {confirm === "end" && (
        <Confirm title="End the interview?" confirmLabel="End & build report" danger onCancel={() => setConfirm(null)}
          message={`${p.total - p.finished} question(s) have not been completed. They will be reported as “not reached” (not scored). This can’t be undone.`}
          onConfirm={() => { setConfirm(null); void run(() => api.control(id, "end"), () => toast("ok", "Interview ended")); }} />
      )}
    </>
  );

  // ============================================================ full-screen stage (storyboard screens 5 & 7)
  if (fsMode) {
    return (
      <div className="fs">
        <div className="fs-top">
          <a className="btn exit" href="#/setup" title="Your progress is saved; continue it any time from the Interview page"><Icon name="arrowl" />Exit Interview</a>
          <div className="title">{st.title}{cloudAI && <span className="badge accent" style={{ marginLeft: 8 }} title="Your questions and answers are graded by Ollama's cloud models. Your voice stays on this computer."><Icon name="cloud" />Cloud AI</span>}</div>
          <button className="prog" onClick={() => setShowProgress(true)} aria-label="Show interview progress">
            <div className="lbl">{where}</div>
            <div className="pbar" role="progressbar" aria-valuemin={0} aria-valuemax={p.total} aria-valuenow={p.finished}><div className="bar"><i style={{ width: `${pct}%` }} /></div><span>{pct}%</span></div>
          </button>
        </div>

        {turn ? (
          <Player key={turn.id} audioKey={`t${turn.id}`} text={turn.question_text} voice={st.config.voice} initialRate={st.config.speech_speed}>
            {isFollowup && <div className="orb-label" style={{ marginBottom: 6, textAlign: "center" }}><span className="badge accent">Follow-up</span> {cur?.item.topic && <span className="badge">{cur.item.topic}</span>}</div>}
            {!isFollowup && (cur?.item.topic || cur?.item.difficulty || cur?.item.source === "resume") && <div style={{ textAlign: "center", marginBottom: 8 }}>{cur?.item.source === "resume" && <span className="badge rz-resume-chip" title={cur.item.resume_name ?? undefined}><Icon name="file" size={13} />From your resume</span>} {cur?.item.topic && <span className="badge accent">{cur.item.topic}</span>} {cur?.item.difficulty && <span className="badge" style={{ textTransform: "capitalize" }}>{cur.item.difficulty}</span>}</div>}
            <div className="interview-q">{turn.question_text}</div>
            {isFollowup && turn.followup_reason && <div className="why">Why I’m asking: {turn.followup_reason}</div>}
          </Player>
        ) : <div className="orb-wrap"><Orb live={false} /></div>}

        <ErrorNotice error={error} />

        {canAnswer && turn && (
          <div className="acard">
            <div className="tabs" role="tablist">
              <button role="tab" aria-selected={tab === "answer"} className={`tab ${tab === "answer" ? "active" : ""}`} onClick={() => setTab("answer")}>Your Answer</button>
              <button role="tab" aria-selected={tab === "notes"} className={`tab ${tab === "notes" ? "active" : ""}`} onClick={() => setTab("notes")}>Notes (Optional)</button>
            </div>
            {tab === "notes" ? (
              <>
                <textarea aria-label="Private notes" rows={4} value={notes} maxLength={4000} placeholder="Private scratchpad for this question — saved on this computer only, never sent to the interviewer or evaluated."
                  onChange={(e) => { setNotes(e.target.value); if (itemId != null) write(notesKey(id, itemId), e.target.value); }} />
                <div className="arow"><span className="small muted">Not evaluated and not part of your answer.</span><button className="btn" onClick={() => setTab("answer")}>Back to answer</button></div>
              </>
            ) : (
              <>
                <div className="ansrow">
                  <textarea id="answer" aria-label="Your answer" value={answer} onChange={(e) => onType(e.target.value)} disabled={busy || mic === "transcribing"} maxLength={8000}
                    placeholder={micOn ? "Type your answer, or use the microphone" : "Type your answer"} onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") submit(); }} />
                  {micOn && (
                    <button className={`micbtn ${mic === "recording" ? "rec" : ""}`} onClick={() => void toggleMic()} disabled={mic === "transcribing" || busy}
                      aria-label={mic === "recording" ? "Stop and transcribe" : mic === "transcribing" ? "Transcribing locally" : "Record answer"} title={mic === "recording" ? "Stop & transcribe" : "Record answer"}>
                      {mic === "recording" ? <span className="rec-dot" /> : mic === "transcribing" ? <span className="spinner" style={{ width: 18, height: 18, borderWidth: 2 }} /> : <Icon name="mic" size={22} />}</button>
                  )}
                </div>
                {mic === "recording" && <div className="small" style={{ color: "var(--bad)", marginTop: 6 }}>Recording… press the microphone again to stop &amp; transcribe locally.</div>}
                {micError && <div className="notice error small">{micError}</div>}
                <div className="arow">
                  <button className="btn skipbtn" onClick={() => setConfirm("skip")} disabled={!canSkip}><Icon name="skip" />Skip Question</button>
                  <span className="small muted ans-meta"><span className="tm" title="Time on this question"><Icon name="timer" />{clock(thinking)}</span><span>{wordCount(answer)} words</span><span>{modKey}+Enter to submit</span></span>
                  <button className="btn primary big" onClick={submit} disabled={!answer.trim() || busy || mic !== "idle"}>{busy ? "Submitting…" : <>Submit Answer <Icon name="arrowr" /></>}</button>
                </div>
              </>
            )}
          </div>
        )}

        {evaluating && turn && (
          <div className="acard" style={{ paddingTop: 20 }}>
            <div className="row"><span className="spinner" /><b>{cloudAI ? `Evaluating your answer with ${engine?.ai.grader_model ?? "the cloud model"} (cloud)…` : "Evaluating your answer with the local model…"}</b><span className="muted small">{elapsed}s · {cloudAI ? "usually a few seconds" : "usually under a minute"}</span></div>
            <div className="bubble-a" style={{ marginTop: 10 }}>{turn.answer_text}</div>
          </div>
        )}

        {st.phase === "evaluation_failed" && turn && (
          <div className="acard" style={{ paddingTop: 20 }}>
            <div className="notice error" style={{ marginTop: 0 }}><b>The answer was saved, but it couldn’t be evaluated.</b><div>{st.error}</div></div>
            <div className="bubble-a">{turn.answer_text}</div>
            <div className="row" style={{ marginTop: 12 }}>
              <button className="btn primary" disabled={busy} onClick={() => void run(() => api.action(id, "retry", turn.id))}>Retry evaluation</button>
              <button className="btn" onClick={() => setConfirm("skip")}>Skip this question</button>
            </div>
          </div>
        )}

        <div className="subtle">
          <button disabled={busy} onClick={() => void run(() => api.control(id, "pause"))}>Pause</button>
          <button disabled={busy || evaluating} title={evaluating ? "Wait for the evaluation to finish" : undefined} onClick={() => setConfirm("end")}>End interview</button>
        </div>
        {dialogs}
      </div>
    );
  }

  // ============================================================ paused / feedback / finished (sidebar layout)
  const evaluated = (cur?.thread ?? []).filter((t) => t.status === "evaluated");
  const shown = st.config.feedback_mode === "immediate" ? evaluated.slice(-1) : evaluated;   // earlier answers were already reviewed
  const prior = evaluated.filter((t) => !shown.includes(t));

  return (
    <div>
      {!finished && (
        <div className="evalhead">
          <a href="#/setup" className="link" title="Your progress is saved; continue it any time from the Interview page"><Icon name="arrowl" />Exit Interview</a>
          <b>{where}</b>
        </div>
      )}
      <ErrorNotice error={error} />

      {finished && (
        <div className="card">
          <h2>{st.status === "completed" ? "Interview complete" : "Interview ended"}</h2>
          <p className="muted">{p.answered} answered · {p.skipped} skipped · {p.unanswered} not reached.</p>
          <FinalScore id={id} />
          <a className="btn primary" href={`#/report/${id}`}>View the full report <Icon name="arrowr" /></a>
        </div>
      )}

      {paused && !finished && (
        <div className="card">
          <h2>Paused</h2>
          <p className="muted">Your place is saved{st.phase === "evaluating" ? " (the current answer is still being evaluated in the background)" : ""}. Press Resume to continue.</p>
          <div className="row">
            <button className="btn primary" disabled={busy} onClick={() => void run(() => api.control(id, "resume"))}>▶ Resume</button>
            <button className="btn danger" disabled={busy || evaluating} onClick={() => setConfirm("end")}>End interview</button>
          </div>
        </div>
      )}

      {st.phase === "feedback" && !paused && !finished && (
        <>
          {prior.length > 0 && <details className="card"><summary style={{ cursor: "pointer", fontWeight: 600 }}>Earlier on this question ({prior.length})</summary>{prior.map((t) => <PriorTurn key={t.id} t={t} />)}</details>}
          {shown.map((t, i) => <FeedbackTurn key={t.id} t={t} followup={i === shown.length - 1 ? cur?.pending_followup ?? null : null} />)}
          {cur?.pending_followup && (
            <div className="followup-box">
              <div className="hd"><i><Icon name="msg" size={14} /></i>Follow-up Question</div>
              <div className="q">{cur.pending_followup.question}</div>
            </div>
          )}
          <div className="footright">
            <button className="btn primary big" autoFocus disabled={busy || st.current_turn_id == null} onClick={() => void run(() => api.action(id, "continue", st.current_turn_id!))}>
              {st.next_action === "followup" ? <>Continue to Follow-up <Icon name="arrowr" /></> : st.next_action === "finish" ? <>Finish &amp; view report <Icon name="arrowr" /></> : <>Next question <Icon name="arrowr" /></>}</button>
          </div>
          <div className="subtle no-print">
            <button disabled={!canSkip} onClick={() => setConfirm("skip")}>Skip{st.next_action === "followup" ? " follow-up" : ""}</button>
            <button disabled={busy} onClick={() => void run(() => api.control(id, "pause"))}>Pause</button>
            <button disabled={busy} onClick={() => setConfirm("end")}>End interview</button>
          </div>
        </>
      )}

      <div className="card" style={{ marginTop: 18 }}>
        <ProgressList st={st} pct={pct} />
      </div>
      {dialogs}
    </div>
  );
}

/** The one number you waited for, shown the moment the interview ends (the report has everything else). */
function FinalScore({ id }: { id: number }) {
  const rep = useAsync(() => api.report(id), [id]);
  const s = rep.data?.summary;
  if (rep.error) return null;
  if (!s) return <div className="final-score"><span className="skel" style={{ width: 96, height: 96, borderRadius: "50%" }} aria-hidden /><span className="muted">Calculating your score…</span></div>;
  return (
    <div className="final-score" data-testid="final-score">
      <ScoreRing value={s.average_score} label="final score" size={96} />
      <div>
        <div className="fs-verdict">{s.verdict ?? "No scored answers"}</div>
        <div className="muted small">{s.scored} of {s.total_questions} question{s.total_questions === 1 ? "" : "s"} scored{s.followups_asked ? ` · ${s.followups_asked} follow-up${s.followups_asked === 1 ? "" : "s"}` : ""}</div>
      </div>
    </div>
  );
}

function ProgressList({ st, pct }: { st: InterviewState; pct: number }) {
  const p = st.progress;
  return (
    <div>
      <div className="progress-head"><h2 style={{ margin: 0 }}>Interview Progress</h2><span className="muted small">{p.finished} of {p.total} Questions</span></div>
      <div className="pbar" style={{ marginTop: 10 }} role="progressbar" aria-valuemin={0} aria-valuemax={p.total} aria-valuenow={p.finished}><div className="bar"><i style={{ width: `${pct}%` }} /></div><span>{pct}%</span></div>
      <ul className="plist">
        {st.items.map((it) => {
          const now = it.status === "active";
          return (
            <li key={it.id} className={now ? "now" : ""}>
              <span className={`mark ${it.status === "answered" ? "done" : it.status === "skipped" ? "skip" : now ? "now" : ""}`} aria-hidden>{it.status === "answered" ? <Icon name="check" /> : it.status === "skipped" ? "–" : it.position + 1}</span>
              <span className="grow" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{it.text.length > 140 ? it.text.slice(0, 140) + "…" : it.text}{it.source === "resume" && <> <span className="badge rz-resume-chip"><Icon name="file" size={12} />From your resume</span></>}</span>
              {it.score != null ? <span className={`badge ${it.score >= 7 ? "ok" : it.score >= 5 ? "warn" : "bad"}`}>{it.score.toFixed(1)}</span>
                : now ? <span className="badge blue">Answering...</span>
                : <span className="muted small">{it.status === "skipped" ? "Skipped" : it.status === "unanswered" ? "Not reached" : it.status === "answered" ? "Answered" : "-"}</span>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function PriorTurn({ t }: { t: Turn }) {
  return (
    <div style={{ marginTop: 12 }}>
      <div className="small muted">{t.kind === "main" ? "Question" : "Follow-up"}</div>
      <div style={{ whiteSpace: "pre-wrap", fontWeight: 600 }}>{t.question_text}</div>
      {t.answer_text && <div className="bubble-a small" style={{ marginTop: 6 }}>{t.answer_text}</div>}
      {t.evaluation && <div style={{ marginTop: 8 }}><Feedback ev={t.evaluation} score={t.score ?? t.evaluation.score} /></div>}
    </div>
  );
}

function FeedbackTurn({ t, followup }: { t: Turn; followup: { question: string; reason: string | null } | null }) {
  return (
    <div className="card">
      <details style={{ marginBottom: 12 }}>
        <summary style={{ cursor: "pointer" }} className="small muted"><span className="badge">{t.kind === "main" ? "Question" : "Follow-up"}</span> <b style={{ color: "var(--text)" }}>{t.question_text.length > 120 ? t.question_text.slice(0, 120) + "…" : t.question_text}</b></summary>
        <div style={{ whiteSpace: "pre-wrap", fontWeight: 600, marginTop: 8 }}>{t.question_text}</div>
        <div className="bubble-a small" style={{ marginTop: 8 }}>{t.answer_text}</div>
      </details>
      {t.evaluation && <Feedback ev={t.evaluation} score={t.score ?? t.evaluation.score} followup={followup} />}
    </div>
  );
}
