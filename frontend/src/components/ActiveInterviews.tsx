import { useState } from "react";
import { api } from "../api";
import type { HistoryRow } from "../types";
import Icon from "./Icon";
import { Confirm, useToast } from "./ui";

export const isActive = (r: HistoryRow) => r.status === "in_progress" || r.status === "paused";

/** "just now", "12 min ago", "3 h ago", "2 days ago" */
export function ago(iso: string | null | undefined, now = Date.now()): string {
  const t = iso ? Date.parse(iso) : NaN;
  if (Number.isNaN(t)) return "earlier";
  const m = Math.max(0, Math.round((now - t) / 60000));
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  if (m < 60 * 24) return `${Math.round(m / 60)} h ago`;
  const d = Math.round(m / 1440);
  return `${d} day${d === 1 ? "" : "s"} ago`;
}

/**
 * The interview you have not finished. Only one can run at a time, so this bar sits at the top of the Interview page and
 * a new interview can start only after it is finished or ended.
 */
export default function ActiveInterviews({ rows, onChanged }: { rows: HistoryRow[]; onChanged: () => void }) {
  const toast = useToast();
  const [confirm, setConfirm] = useState<HistoryRow | null>(null);
  const [busy, setBusy] = useState(false);
  if (rows.length === 0) return null;

  const end = async (r: HistoryRow) => {
    setBusy(true);
    try { await api.control(r.id, "end"); toast("ok", `“${r.title}” was ended. You can start a new interview now.`); }
    catch (e) { toast("error", (e as Error).message); }
    finally { setBusy(false); setConfirm(null); onChanged(); window.dispatchEvent(new Event("lai:interviews")); }
  };

  return (
    <section className="active-iv" aria-label="Active interview" data-testid="active-interview">
      {rows.map((r) => {
        const done = r.answered + r.skipped;
        const pct = r.total ? Math.round((done / r.total) * 100) : 0;
        const evaluating = r.phase === "evaluating";
        return (
          <div className="aiv" key={r.id}>
            <span className="aiv-ic" aria-hidden="true"><Icon name="mic" /></span>
            <div className="aiv-main">
              <div className="aiv-t">
                <span className="aiv-label">Active interview</span>
                <b>{r.title}</b>
                <span className={`badge ${r.status === "paused" ? "warn" : "accent"}`}>{r.status === "paused" ? "Paused" : "In progress"}</span>
              </div>
              <div className="aiv-m">
                <div className="meter" role="progressbar" aria-label="Questions done" aria-valuemin={0} aria-valuemax={r.total} aria-valuenow={done}><i style={{ width: `${pct}%` }} /></div>
                <span>{done} of {r.total} question{r.total === 1 ? "" : "s"} done · last activity {ago(r.updated_at)}</span>
              </div>
            </div>
            <div className="aiv-actions">
              <a className="btn primary big" href={`#/interview/${r.id}`}>Continue interview <Icon name="arrowr" /></a>
              <button className="btn" disabled={busy || evaluating} title={evaluating ? "Wait for the current evaluation to finish" : "Stop this interview and get its report"} onClick={() => setConfirm(r)}>End interview</button>
            </div>
          </div>
        );
      })}
      <p className="aiv-note">Only one interview can run at a time. Continue this one, or end it, to start a new interview.</p>
      {confirm && (
        <Confirm title="End this interview?" confirmLabel="End interview" danger onCancel={() => setConfirm(null)} onConfirm={() => void end(confirm)}
          message={<>“{confirm.title}” stops here and its report is built from the {confirm.answered} answer{confirm.answered === 1 ? "" : "s"} so far. You can’t continue it afterwards.</>} />
      )}
    </section>
  );
}
