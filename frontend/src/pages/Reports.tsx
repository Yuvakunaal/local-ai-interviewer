import { api } from "../api";
import { SkeletonRows } from "../components/Skeleton";
import { ErrorNotice, useAsync } from "../components/ui";
import { InterviewRow } from "./Home";

export default function Reports() {
  const list = useAsync(() => api.interviews(), []);
  const rows = (list.data ?? []).filter((r) => r.has_report);
  const scored = rows.filter((r) => r.average_score != null);
  const avg = scored.length ? Math.round((scored.reduce((n, r) => n + (r.average_score ?? 0), 0) / scored.length) * 10) / 10 : null;
  return (
    <div>
      <div className="pagehead"><div><h1>Reports</h1><div className="muted">Track your progress across finished interviews.</div></div></div>
      <ErrorNotice error={list.error} />
      <div className="stats">
        <div className="stat"><b className="c-blue">{rows.length}</b><span>Reports</span></div>
        <div className="stat"><b className="c-amber">{avg ?? "—"}</b><span>Average of all scored sessions</span></div>
        <div className="stat"><b className="c-green">{rows.filter((r) => r.status === "completed").length}</b><span>Completed</span></div>
      </div>
      {list.loading && !list.data && <SkeletonRows n={4} />}
      {rows.length === 0 && !list.loading && <div className="card muted" style={{ textAlign: "center" }}>No reports yet. Finish (or end) an interview to see one here. <a href="#/setup">Start an interview</a>.</div>}
      <div className="rowgrid">{rows.map((r) => <InterviewRow key={r.id} r={r} />)}</div>
    </div>
  );
}
