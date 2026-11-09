import { chipsFor, clip, questionNote } from "../scorecardHelpers";
import type { Report } from "../types";
import { scoreClass } from "./ui";

/** Every score of the interview on one screen: each answer, each follow-up, each question, and the final score. */
export function Scorecard({ r }: { r: Report }) {
  const s = r.summary;
  return (
    <section className="card scorecard" data-testid="scorecard" aria-labelledby="sc-h">
      <div className="row between sc-head">
        <h2 id="sc-h" style={{ margin: 0 }}>Scorecard</h2>
        <span className="muted small">Question score = the main answer counts twice, each follow-up once, then averaged.</span>
      </div>
      <ol className="sc-list">
        {r.questions.map((q) => {
          const note = questionNote(q);
          return (
            <li className="sc-row" key={q.position}>
              <span className="sc-n">Q{q.position}</span>
              <div className="sc-main">
                <div className="sc-q">{clip(q.text)}</div>
                <div className="sc-turns">
                  {q.topic && <span className="badge accent">{q.topic}</span>}
                  {chipsFor(q).map((c) => (
                    <span className="sc-chip" key={c.label}>
                      <span>{c.label}</span>
                      {c.score != null ? <b className={`mark sm ${scoreClass(c.score)}`}>{c.score}</b> : <i>{c.note}</i>}
                    </span>
                  ))}
                  {q.turns.length === 0 && <span className="muted small">No answer recorded</span>}
                </div>
              </div>
              <div className="sc-total" aria-label={q.score != null ? `Question ${q.position} score ${q.score}` : `Question ${q.position}: ${note}`}>
                {q.score != null ? <><b className={`mark ${scoreClass(q.score)}`}>{q.score}</b><span>{q.verdict}</span></> : <span className="badge">{note}</span>}
              </div>
            </li>
          );
        })}
      </ol>
      <div className="sc-final">
        <span>Final score</span>
        <span className="muted small">average of {s.scored} scored question{s.scored === 1 ? "" : "s"}{s.skipped + s.unanswered > 0 ? ` · ${s.skipped + s.unanswered} not counted` : ""}</span>
        <b className={`mark lg ${scoreClass(s.average_score)}`}>{s.average_score ?? "—"}</b><small className="muted">/ 10</small>
        <span className="sc-verdict">{s.verdict ?? "No scored answers"}</span>
      </div>
    </section>
  );
}

/** Average of each skill over all answers (the six things every answer is rated on). */
export function Skills({ skills }: { skills: NonNullable<Report["skills"]> }) {
  const rows = skills.filter((k) => k.average != null);
  if (rows.length === 0) return null;
  return (
    <section className="card" data-testid="skills">
      <div className="row between"><h2 style={{ margin: 0 }}>Skills</h2><span className="muted small">average over all your answers</span></div>
      <div className="skills-grid">
        {rows.map((k) => (
          <div className="tbar" key={k.key}>
            <span>{k.label}</span>
            <div className="track"><i style={{ width: `${(k.average ?? 0) * 10}%`, background: (k.average ?? 0) >= 7 ? "var(--ok)" : (k.average ?? 0) >= 5 ? "var(--warn)" : "var(--bad)" }} /></div>
            <b>{k.average?.toFixed(1)}</b>
          </div>
        ))}
      </div>
    </section>
  );
}
