import { useEffect, useState } from "react";
import { api } from "../api";
import { speaker } from "../audio";
import Feedback from "../components/Feedback";
import { Scorecard, Skills } from "../components/Scorecard";
import { fmtUsd } from "../aiHelpers";
import { ScoreRing, scoreTone } from "../components/charts";
import Icon from "../components/Icon";
import { SkeletonRows } from "../components/Skeleton";
import { ErrorNotice, fmtShort, minutesBetween, scoreClass, useAsync, useToast } from "../components/ui";
import type { Report as ReportT } from "../types";
import { CLAIM_VERDICT_TONE } from "../resumeHelpers";
import { useSpeaker } from "./useSpeaker";

const List = ({ title, items }: { title: string; items: string[] }) => (
  <div><h3>{title}</h3>{items.length ? <ul className="tight">{items.map((x, i) => <li key={i}>{x}</li>)}</ul> : <p className="muted small">None identified.</p>}</div>
);
const barColor = (s: number) => (s >= 8 ? "linear-gradient(90deg,#7b8cf8,#5b5ff0)" : s >= 7 ? "linear-gradient(90deg,#3fbf8f,#1e9e68)" : s >= 6.5 ? "linear-gradient(90deg,#8d9bf5,#6a6bf0)" : s >= 5 ? "linear-gradient(90deg,#f6b34f,#e89418)" : "linear-gradient(90deg,#ff9d8f,#e8604f)");

export default function ReportPage({ id }: { id: number }) {
  const toast = useToast();
  const { data: r, error, reload, setData } = useAsync<ReportT>(() => api.report(id), [id]);
  const speech = useSpeaker();
  const pending = r?.narrative_status === "pending";
  const [pdf, setPdf] = useState<"idle" | "waiting" | "building">("idle");
  useEffect(() => { if (pdf === "waiting" && r && !pending) setPdf("building"); }, [pdf, pending, r]);      // the written summary is finished first, so it is in the file
  useEffect(() => {
    if (pdf !== "building") return;
    let alive = true;
    void (async () => {
      try {
        const [name] = await Promise.all([api.downloadReportPdf(id), new Promise((res) => setTimeout(res, 700))]);   // never a flicker: the loader stays long enough to be seen
        toast("ok", `Saved ${name}`);
      } catch (e) { toast("error", (e as Error).message); }
      finally { if (alive) setPdf("idle"); }
    })();
    return () => { alive = false; };
  }, [pdf, id]);
  useEffect(() => {
    if (!pending) return;
    const t = setInterval(() => { if (!document.hidden) void reload(); }, 2500);
    return () => clearInterval(t);
  }, [pending, reload]);
  useEffect(() => () => speaker.stop(), []);

  if (error) return <div><ErrorNotice error={error} /><a href="#/reports">← Back to reports</a></div>;
  if (!r) return <div aria-busy="true"><SkeletonRows n={3} /></div>;
  const s = r.summary;
  const ins = r.insights;
  const voice = r.interview.config.voice;
  const mins = minutesBetween(r.interview.created_at, r.interview.completed_at);

  return (
    <div>
      <div className="pagehead">
        <div>
          <a href="#/reports" className="small no-print" style={{ color: "var(--muted)", textDecoration: "none" }}>← Reports</a>
          <h1>Interview Report</h1>
          <div style={{ fontWeight: 600, marginTop: 4 }}>{r.interview.title}</div>
          <div className="muted small">{fmtShort(r.interview.created_at)} · {s.total_questions} Question{s.total_questions === 1 ? "" : "s"}{mins ? ` · ${mins} min` : ""} · {r.interview.status}</div>
        </div>
        <div className="row no-print">
          <button className="btn soft" disabled={pdf !== "idle"} aria-busy={pdf !== "idle"} onClick={() => setPdf(pending ? "waiting" : "building")}
            title="Saves the report as a PDF file">
            {pdf === "idle" ? <Icon name="download" /> : <span className="spinner" style={{ width: 14, height: 14, borderWidth: 2 }} aria-hidden="true" />}
            {pdf === "waiting" ? "Waiting for the summary…" : pdf === "building" ? "Preparing PDF…" : "Export as PDF"}
          </button>
          <a className="btn soft" href={api.exportReportUrl(id, "json")} download><Icon name="file" />Export as JSON</a>
          <a className="btn" href={api.exportReportUrl(id, "md")} download><Icon name="download" />Markdown</a>
        </div>
      </div>

      <div className="rep-top">
      <div className="card hero">
        <ScoreRing value={s.average_score} label="average" size={120} />
        <div className="txt">
          <div className="muted small" style={{ fontWeight: 500 }}>Overall result</div>
          <div style={{ fontSize: "1.45rem", fontWeight: 600, letterSpacing: "-.01em", margin: "4px 0" }} className={s.average_score != null ? scoreTone(s.average_score) : ""}>{s.verdict ?? "Not scored"}</div>
          <div className="muted">{s.scored} of {s.total_questions} question{s.total_questions === 1 ? "" : "s"} scored{s.followups_asked ? ` · ${s.followups_asked} follow-up${s.followups_asked === 1 ? "" : "s"}` : ""}{s.skipped ? ` · ${s.skipped} skipped` : ""}</div>
        </div>
      </div>
      <div className="stats">
        <div className="stat"><b className="c-blue">{s.total_questions}</b><span>Total Questions</span></div>
        <div className="stat"><b className="c-green">{s.answered}</b><span>Answered</span></div>
        <div className="stat"><b className="c-red">{s.skipped}</b><span>Skipped</span></div>
        <div className="stat"><b className="c-amber">{s.average_score ?? "—"}</b><span>Average Score</span></div>
        <div className="stat"><b className="c-muted">{s.unanswered}</b><span>Not Reached</span></div>
      </div>
      </div>
      {r.ai_usage && r.ai_usage.calls > 0 && (
        <div className="muted small ai-usage-line" data-testid="ai-usage" style={{ marginBottom: 12 }}>
          <Icon name="cpu" />AI used for this interview: {r.ai_usage.calls} model call{r.ai_usage.calls === 1 ? "" : "s"} · {(r.ai_usage.prompt_tokens + r.ai_usage.output_tokens).toLocaleString()} tokens · {r.ai_usage.seconds} s
          {r.ai_usage.by_provider.cloud && <> · <b>{r.ai_usage.by_provider.cloud.unpriced_calls ? "cost unknown (no price set)" : `${fmtUsd(r.ai_usage.cost_usd)} estimated cloud cost`}</b></>}
          {r.ai_usage.by_provider.cloud && r.ai_usage.by_provider.local ? " (some calls ran on this computer)" : r.ai_usage.by_provider.local ? " · ran on this computer, free" : ""}
          {" · "}<a href="#/usage">details</a>
        </div>
      )}
      <Scorecard r={r} />
      {s.answered_not_scored > 0 && <div className="notice warn small">{s.answered_not_scored} answered question(s) could not be evaluated and are excluded from averages.</div>}

      <div className="twocol">
        <div className="card">
          <h2>Topic-wise Performance</h2>
          {r.topics.map((t) => (
            <div className="tbar" key={t.topic}>
              <span>{t.topic}</span>
              <div className="track">{t.average_score != null && <i style={{ width: `${t.average_score * 10}%`, background: barColor(t.average_score) }} />}</div>
              <b>{t.average_score != null ? t.average_score.toFixed(1) : "—"}</b>
            </div>
          ))}
          <details><summary className="small muted" style={{ cursor: "pointer" }}>How scores are calculated</summary><ul className="tight small muted">{r.scoring_rules.map((x) => <li key={x}>{x}</li>)}</ul></details>
        </div>
        <div className="card">
          <div className="row between"><h2>Overall Feedback</h2>
            {pending ? <span className="muted small"><span className="spinner" style={{ width: 12, height: 12, borderWidth: 2 }} /> Writing summary…</span>
              : <button className="btn ghost no-print" onClick={async () => { try { setData(await api.regenerateReport(id)); } catch (e) { toast("error", (e as Error).message); } }}>Regenerate</button>}</div>
          <p style={{ color: "var(--text-2)", lineHeight: 1.6 }}>{ins.overall_summary}</p>
          {r.insights_source === "rules" && !pending && <span className="badge">rule-based</span>}
          {r.narrative_status === "failed" && <div className="notice warn small">The model couldn’t write the summary ({r.narrative_error}). Showing rule-based insights instead.</div>}
        </div>
      </div>

      {r.resume_claims && r.resume_claims.length > 0 && (
        <div className="card" data-testid="resume-claims">
          <div className="row between"><h2>Resume claims</h2><span className="muted small">How well you defended what your resume says · weakest first</span></div>
          <div className="rz-claims">
            {r.resume_claims.map((c) => (
              <div className="rz-claim" key={`${c.resume_id}-${c.section}-${c.label}`}>
                <div className="grow">
                  <div className="rz-claim-t">{c.label || c.section}</div>
                  <div className="muted small">{c.resume_name}{c.resume_deleted ? " (deleted resume)" : ""}{c.section ? ` › ${c.section}` : ""} · {c.question_numbers.map((n) => `Q${n}`).join(", ")}</div>
                  <div className="small rz-tip"><Icon name="target" size={13} />{c.tip}</div>
                </div>
                <span className={`mark ${scoreClass(c.average_score)}`}>{c.average_score}</span>
                <span className={`badge ${CLAIM_VERDICT_TONE[c.verdict] ?? ""} rz-verdict`}>{c.verdict}</span>
              </div>
            ))}
          </div>
          <p className="muted small" style={{ margin: "8px 0 0" }}>Solid 7+ · Shaky 5–7 · Weak below 5. Skipped and unanswered questions are not counted.</p>
        </div>
      )}

      {r.skills && <Skills skills={r.skills} />}

      <div className="card">
        <h2>Insights</h2>
        <div className="grid2">
          <List title="Strengths" items={ins.strengths} /><List title="Knowledge gaps" items={ins.knowledge_gaps} />
          <List title="Repeated misconceptions" items={ins.repeated_misconceptions} /><List title="Topics to revise" items={ins.topics_to_revise} />
        </div>
        <List title="Recommendations" items={ins.recommendations} />
      </div>

      <h2 style={{ marginTop: 22, marginBottom: 4 }}>Detailed feedback</h2>
      <p className="muted small" style={{ margin: "0 0 12px" }}>Open a question to see what you answered, the feedback on it and a reference answer.</p>
      {r.questions.map((q) => (
        <details key={q.position} className="card report-q">
          <summary>
            <div className="row between" style={{ flexWrap: "nowrap" }}><div className="grow"><b>Q{q.position}.</b> <span style={{ whiteSpace: "pre-wrap" }}>{q.text.length > 220 ? q.text.slice(0, 220) + "…" : q.text}</span></div>
              <div className="row" style={{ flexWrap: "nowrap" }}>{q.source === "resume" && <span className="badge rz-resume-chip" title={`${q.resume_name ?? "Resume"}${q.resume_deleted ? " (deleted resume)" : ""}${q.claim?.label ? " › " + q.claim.label : ""}`}><Icon name="file" size={12} />Resume</span>}{q.topic && <span className="badge accent">{q.topic}</span>}
                {q.score != null ? <span className={`mark ${scoreClass(q.score)}`}>{q.score}</span> : <span className={`badge ${q.status === "skipped" ? "warn" : ""}`}>{q.status === "unanswered" ? "not reached" : q.status === "answered" ? "not scored" : q.status}</span>}</div></div>
          </summary>
          <div className="body">
            {q.source === "resume" && q.claim && <p className="muted small rz-from-line"><Icon name="file" size={13} />About {q.resume_name ?? "your resume"}{q.resume_deleted ? " (deleted resume)" : ""}{q.claim.section ? ` › ${q.claim.section}` : ""}{q.claim.label ? ` › ${q.claim.label}` : ""}</p>}
            <button className="btn no-print" onClick={() => (speech.key === `r${q.position}` && speech.status !== "idle" ? speaker.stop() : void speaker.play(`r${q.position}`, q.text, voice))}>
              <Icon name="vol" />{speech.key === `r${q.position}` && speech.status === "loading" ? "Generating…" : speech.key === `r${q.position}` && speech.status === "playing" ? "Stop" : "Replay question"}</button>
            {speech.key === `r${q.position}` && speech.error && <span className="small" style={{ color: "var(--bad)", marginLeft: 8 }}>{speech.error}</span>}
            {q.turns.map((t) => (
              <div key={t.seq} className={`thread-turn ${t.kind}`}>
                {t.kind === "followup" && <div><span className="badge accent">Follow-up</span> <b>{t.question}</b></div>}
                {t.status === "skipped" ? <p className="muted">Skipped.</p> : <>
                  <div className="bubble-a">{t.answer ?? <i>No answer</i>}{t.source === "voice" && <span className="badge" style={{ marginLeft: 8 }}>voice</span>}</div>
                  {t.evaluation ? <div style={{ marginTop: 12 }}><Feedback ev={t.evaluation} score={t.score ?? t.evaluation.score} /></div> : t.status === "submitted" ? <p className="muted small">Not evaluated (model error).</p> : null}
                </>}
              </div>
            ))}
            {q.turns.length === 0 && <p className="muted">This question was not reached.</p>}
          </div>
        </details>
      ))}
    </div>
  );
}
