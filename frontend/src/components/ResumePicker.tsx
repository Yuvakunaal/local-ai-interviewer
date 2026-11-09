import type { ResumeSummary } from "../types";

/** Choose one or more ready resumes (checkbox list). */
export default function ResumePicker({ resumes, selected, onChange }: { resumes: ResumeSummary[]; selected: number[]; onChange: (ids: number[]) => void }) {
  const toggle = (id: number, on: boolean) => onChange(on ? [...selected.filter((x) => x !== id), id] : selected.filter((x) => x !== id));
  return (
    <div className="rz-pick" role="group" aria-label="Resumes to ask about">
      {resumes.map((r) => (
        <label key={r.id} className={`rz-pick-row ${selected.includes(r.id) ? "on" : ""}`}>
          <input type="checkbox" checked={selected.includes(r.id)} onChange={(e) => toggle(r.id, e.target.checked)} />
          <span className="grow"><b>{r.name}</b><span className="muted small"> · {r.original_filename}</span>
            {r.skills_preview.length > 0 && <span className="rz-pick-skills">{r.skills_preview.slice(0, 4).map((s) => <span key={s} className="rz-tag">{s}</span>)}</span>}</span>
        </label>
      ))}
    </div>
  );
}
