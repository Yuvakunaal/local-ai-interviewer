import { useState } from "react";
import type { Evaluation } from "../types";
import Icon from "./Icon";

const DIM_LABEL: Record<string, string> = {
  correctness: "Correctness", completeness: "Completeness", depth: "Depth", practical_application: "Practical use",
  clarity: "Clarity", production_awareness: "Production",
};

const Group = ({ title, items, tone }: { title: string; items: string[]; tone?: "warn" | "bad" }) =>
  items.length ? (
    <div>
      <h3>{title}</h3>
      <ul className={`glist ${tone ?? ""}`}>{items.map((x, i) => <li key={i}><span className="gi"><Icon name={tone ? "alert" : "check"} /></span><span>{x}</span></li>)}</ul>
    </div>
  ) : null;

type Tab = "evaluation" | "ideal" | "followup";

const fallbackSummary = (ev: Evaluation) =>
  `${ev.verdict}: ${ev.correct_points.length} strength${ev.correct_points.length === 1 ? "" : "s"} noted and ${ev.missing_concepts.length + ev.misconceptions.length} gap${ev.missing_concepts.length + ev.misconceptions.length === 1 ? "" : "s"} to close.`;

/** Evaluation / Ideal Answer / Follow-up tabs (storyboard screen 6). */
export default function Feedback({ ev, score, followup }: { ev: Evaluation; score: number; followup?: { question: string; reason: string | null } | null }) {
  const [tab, setTab] = useState<Tab>("evaluation");
  const dims = Object.entries(ev.dimension_scores).filter(([k]) => k !== "production_awareness" || ev.production_relevant);
  const note = followup?.reason || ev.followup_reason;
  const tabs: [Tab, string][] = [["evaluation", "Evaluation"], ["ideal", "Ideal Answer"], ["followup", "Follow-up"]];
  const tone = score >= 7 ? "" : score >= 5 ? "mid" : "low";
  return (
    <div>
      <div className="tabs eval" role="tablist">
        {tabs.map(([k, label]) => <button key={k} role="tab" aria-selected={tab === k} className={`tab ${tab === k ? "active" : ""}`} onClick={() => setTab(k)}>{label}</button>)}
      </div>
      {tab === "evaluation" && (
        <div>
          <div className={`scorebox ${tone}`}>
            <div className="lhs"><div className="k">Score</div><div className="bigscore">{score.toFixed(1)} <small>/ 10</small></div></div>
            <div><div className="k">Verdict</div><div className="v">{ev.verdict_summary || fallbackSummary(ev)}{ev.confidence !== "high" && <span className="badge warn" style={{ marginLeft: 8 }} title={ev.uncertainty_note}>{ev.confidence} confidence</span>}</div></div>
          </div>
          <div className="dims">
            {dims.map(([k, v]) => <div className="dim" key={k}>{DIM_LABEL[k] ?? k}: {v}/10<div className="bar"><i style={{ width: `${v * 10}%` }} /></div></div>)}
          </div>
          {ev.question_level === "basic" && <div className="hint small muted" style={{ marginTop: -6, marginBottom: 10 }}>Basic question: depth and real-world examples count less toward the score.</div>}
          {ev.interpreted_answer && (
            <div className="notice info small" data-testid="graded-as">
              <b>You answered by voice.</b> Speech recognition can mishear technical words, so the interviewer read your answer as: <i>“{ev.interpreted_answer}”</i>. Recognition mistakes are not held against you.
            </div>
          )}
          <Group title="Strengths" items={ev.correct_points} />
          <Group title="Gaps" items={ev.missing_concepts} tone="warn" />
          <Group title="Incorrect or shaky statements" items={ev.misconceptions} tone="bad" />
          {ev.graded_by && (
            <div className="small muted graded-by" data-testid="graded-by">
              {ev.graded_by.provider === "cloud" ? "Graded by " : "Graded on this computer by "}<b>{ev.graded_by.model}</b>{ev.graded_by.provider === "cloud" ? " (Ollama cloud)" : ""}
              {ev.graded_by.fell_back_from && ev.graded_by.provider === "cloud" && <> — <b>{ev.graded_by.fell_back_from}</b> was unavailable, so the fallback model graded this.</>}
              {ev.graded_by.fell_back_from && ev.graded_by.provider === "local" && <> — the cloud was unavailable ({ev.graded_by.reason ?? ev.graded_by.fell_back_from}), so your local model graded this.</>}
            </div>
          )}
          {ev.uncertainty_note && <div className="notice warn small"><b>Note:</b> {ev.uncertainty_note} Verify this against a trusted source.</div>}
        </div>
      )}
      {tab === "ideal" && (
        <div className="stack" style={{ marginTop: 14 }}>
          <div><h3>Reference answer</h3><p style={{ whiteSpace: "pre-wrap" }}>{ev.ideal_answer || "No reference answer was produced."}</p></div>
          <Group title="How to improve" items={ev.suggested_improvements} />
        </div>
      )}
      {tab === "followup" && (
        <div className="stack" style={{ marginTop: 14 }}>
          {followup ? <div className="followup-box"><div className="hd"><i><Icon name="msg" size={14} /></i>Follow-up Question</div><div className="q">{followup.question}</div></div>
            : <div className="muted">{ev.followup_asked ? "A follow-up was asked after this answer." : "No follow-up was asked for this answer."}</div>}
          {note && <div className="small"><b>Interviewer’s note:</b> {note}</div>}
          {ev.followup_suppressed_reason && <div className="small muted">No follow-up: {ev.followup_suppressed_reason}</div>}
        </div>
      )}
    </div>
  );
}
