import { useState } from "react";
import { api } from "../api";
import { SkeletonRows } from "../components/Skeleton";
import { Confirm, ErrorNotice, useAsync, useToast } from "../components/ui";
import { InterviewRow } from "./Home";

export default function History() {
  const toast = useToast();
  const list = useAsync(() => api.interviews(), []);
  const [confirm, setConfirm] = useState<null | { title: string; message: string; run: () => Promise<unknown> }>(null);
  const rows = list.data ?? [];
  const act = async (fn: () => Promise<unknown>) => { try { await fn(); toast("ok", "Done"); } catch (e) { toast("error", (e as Error).message); } await list.reload(); };

  return (
    <div>
      <div className="pagehead">
        <div><h1>History</h1><div className="muted">Every session saved on this computer. Resume unfinished ones, open reports, or delete.</div></div>
        <div className="row">
          <a className="btn primary" href="#/setup">New interview</a>
          <button className="btn danger" disabled={!rows.length} onClick={() => setConfirm({ title: "Clear all history?", message: `This permanently deletes ${rows.length} interview session(s), their answers and reports. Your question library is not affected.`, run: () => api.clearHistory() })}>Clear history</button>
        </div>
      </div>
      <ErrorNotice error={list.error} />
      {list.loading && !list.data && <SkeletonRows n={4} />}
      {rows.length === 0 && !list.loading && <div className="card muted" style={{ textAlign: "center" }}>No interviews yet. <a href="#/setup">Start one</a>.</div>}
      <div className="rowgrid wide">{rows.map((r) => (
        <InterviewRow key={r.id} r={r} actions={
          <div className="row" style={{ gap: 8, flexWrap: "nowrap" }}>
            {(r.status === "in_progress" || r.status === "paused") && <a className="btn primary" href={`#/interview/${r.id}`}>Resume</a>}
            {r.has_report ? <a className="btn" href={`#/report/${r.id}`}>Report</a> : null}
            <button className="btn danger" aria-label={`Delete ${r.title}`} onClick={() => setConfirm({ title: "Delete this session?", message: `“${r.title}” and its report will be permanently removed.`, run: () => api.deleteInterview(r.id) })}>Delete</button>
          </div>} />
      ))}</div>
      {confirm && <Confirm title={confirm.title} message={confirm.message} confirmLabel="Delete" danger onCancel={() => setConfirm(null)} onConfirm={() => { const c = confirm; setConfirm(null); void act(c.run); }} />}
    </div>
  );
}
