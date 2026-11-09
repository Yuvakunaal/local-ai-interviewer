import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { emptyEducation, emptyExperience, emptyProject, errorFor, move, removeAt, replaceAt, type FieldError } from "../resumeHelpers";
import type { EducationEntry, ExperienceEntry, ProjectEntry, ResumeProfile, SkillGroup } from "../types";
import Icon from "./Icon";

// ------------------------------------------------------------------ small building blocks
/** A textarea that grows with its content (no inner scrollbar). */
export function AutoText({ value, onChange, label, rows = 1, placeholder, error, id: given, className = "" }: {
  value: string; onChange: (v: string) => void; label: string; rows?: number; placeholder?: string; error?: string; id?: string; className?: string;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const auto = useId();
  const id = given ?? auto;
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight + 2}px`;
  }, [value]);
  return (
    <>
      <textarea ref={ref} id={id} className={`rz-auto ${className} ${error ? "invalid" : ""}`} rows={rows} value={value} placeholder={placeholder} aria-label={label}
        aria-invalid={!!error} aria-describedby={error ? `${id}-e` : undefined} onChange={(e) => onChange(e.target.value)} />
      {error && <div id={`${id}-e`} className="rz-ferr">{error}</div>}
    </>
  );
}

function Field({ label, value, onChange, error, placeholder, type = "text", disabled }: {
  label: string; value: string; onChange: (v: string) => void; error?: string; placeholder?: string; type?: string; disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className="rz-field">
      <label htmlFor={id}>{label}</label>
      <input id={id} type={type} value={value} placeholder={placeholder} disabled={disabled} aria-invalid={!!error} aria-describedby={error ? `${id}-e` : undefined}
        className={error ? "invalid" : ""} onChange={(e) => onChange(e.target.value)} />
      {error && <div id={`${id}-e`} className="rz-ferr">{error}</div>}
    </div>
  );
}

/** Move up / move down / remove for one entry of a list. */
function ItemTools({ what, i, n, onMove, onRemove }: { what: string; i: number; n: number; onMove: (d: -1 | 1) => void; onRemove: () => void }) {
  return (
    <span className="rz-tools">
      <button type="button" className="btn icon ghost" aria-label={`Move ${what} ${i + 1} up`} title="Move up" disabled={i === 0} onClick={() => onMove(-1)}><Icon name="up" /></button>
      <button type="button" className="btn icon ghost" aria-label={`Move ${what} ${i + 1} down`} title="Move down" disabled={i === n - 1} onClick={() => onMove(1)}><Icon name="dn" /></button>
      <button type="button" className="btn icon ghost del" aria-label={`Remove ${what} ${i + 1}`} title="Remove" onClick={onRemove}><Icon name="trash" /></button>
    </span>
  );
}

/** A list of multi-line text items (bullets, achievements…): add / remove / reorder; each one grows as you type. */
function TextList({ items, onChange, what, addLabel, errors, path, placeholder }: {
  items: string[]; onChange: (v: string[]) => void; what: string; addLabel: string; errors: FieldError[]; path: string; placeholder?: string;
}) {
  const focusLast = useRef(false);
  const wrap = useRef<HTMLDivElement>(null);
  useEffect(() => { if (focusLast.current) { focusLast.current = false; wrap.current?.querySelector<HTMLTextAreaElement>(".rz-li:last-child textarea")?.focus(); } }, [items.length]);
  return (
    <div className="rz-list" ref={wrap}>
      {items.map((b, i) => (
        <div className="rz-li" key={i}>
          <span className="rz-bullet" aria-hidden>•</span>
          <div className="grow"><AutoText label={`${what} ${i + 1}`} value={b} placeholder={placeholder} error={errorFor(errors, `${path}.${i}`)} onChange={(v) => onChange(replaceAt(items, i, v))} /></div>
          <ItemTools what={what} i={i} n={items.length} onMove={(d) => onChange(move(items, i, d))} onRemove={() => onChange(removeAt(items, i))} />
        </div>
      ))}
      {errorFor(errors, path) && <div className="rz-ferr">{errorFor(errors, path)}</div>}
      <button type="button" className="btn ghost rz-addline" onClick={() => { focusLast.current = true; onChange([...items, ""]); }}><Icon name="plus" />{addLabel}</button>
    </div>
  );
}

/** Chips with a × each, and a small box that adds one on Enter (or a comma). */
function Chips({ items, onChange, label, errors, path }: { items: string[]; onChange: (v: string[]) => void; label: string; errors: FieldError[]; path: string }) {
  const [draft, setDraft] = useState("");
  const id = useId();
  const add = () => {
    const parts = draft.split(",").map((x) => x.trim()).filter(Boolean);
    if (!parts.length) return;
    const next = [...items];
    for (const p of parts) if (!next.some((x) => x.toLowerCase() === p.toLowerCase())) next.push(p);
    onChange(next);
    setDraft("");
  };
  const bad = items.map((_, i) => errorFor(errors, `${path}.${i}`)).find(Boolean) ?? errorFor(errors, path);
  return (
    <div className="rz-chips">
      {items.map((s, i) => (
        <span key={`${s}-${i}`} className="rz-chip">{s}<button type="button" aria-label={`Remove ${s}`} onClick={() => onChange(removeAt(items, i))}><Icon name="x" /></button></span>
      ))}
      <label htmlFor={id} className="sr-only">{label}</label>
      <input id={id} type="text" className="rz-chip-in" value={draft} placeholder={`Add ${label.toLowerCase()}…`} onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === ",") { e.preventDefault(); add(); } else if (e.key === "Backspace" && !draft && items.length) onChange(items.slice(0, -1)); }}
        onBlur={add} />
      {bad && <div className="rz-ferr" style={{ flexBasis: "100%" }}>{bad}</div>}
    </div>
  );
}

function Sec({ id, title, count, icon, children, action }: { id: string; title: string; count?: number; icon: Parameters<typeof Icon>[0]["name"]; children: ReactNode; action?: ReactNode }) {
  return (
    <section className="rz-sec" aria-labelledby={`${id}-h`}>
      <header className="rz-sec-h"><span className="rz-sec-ic" aria-hidden><Icon name={icon} /></span><h2 id={`${id}-h`}>{title}</h2>{count != null && <span className="rz-count">{count}</span>}<span className="grow" />{action}</header>
      <div className="rz-sec-b">{children}</div>
    </section>
  );
}

// ------------------------------------------------------------------ the editor
/** The organised resume as an editable form. Fully controlled: `value` in, every change out through `onChange`. */
export default function ResumeEditor({ value: p, onChange, errors }: { value: ResumeProfile; onChange: (p: ResumeProfile) => void; errors: FieldError[] }) {
  const set = <K extends keyof ResumeProfile>(k: K, v: ResumeProfile[K]) => onChange({ ...p, [k]: v });
  const setExp = (i: number, e: Partial<ExperienceEntry>) => set("experience", replaceAt(p.experience, i, { ...p.experience[i], ...e }));
  const setPrj = (i: number, e: Partial<ProjectEntry>) => set("projects", replaceAt(p.projects, i, { ...p.projects[i], ...e }));
  const setEdu = (i: number, e: Partial<EducationEntry>) => set("education", replaceAt(p.education, i, { ...p.education[i], ...e }));
  const setSkill = (i: number, g: Partial<SkillGroup>) => set("skills", replaceAt(p.skills, i, { ...p.skills[i], ...g }));
  const c = p.contact;
  const err = (path: string) => errorFor(errors, path);

  return (
    <div className="rz-editor">
      <Sec id="contact" title="Contact & links" icon="user">
        <div className="rz-grid2">
          <Field label="Name" value={c.name} error={err("contact.name")} onChange={(v) => set("contact", { ...c, name: v })} />
          <Field label="Email" type="email" value={c.email} error={err("contact.email")} onChange={(v) => set("contact", { ...c, email: v })} />
          <Field label="Phone" value={c.phone} error={err("contact.phone")} onChange={(v) => set("contact", { ...c, phone: v })} />
          <Field label="Location" value={c.location} error={err("contact.location")} onChange={(v) => set("contact", { ...c, location: v })} />
        </div>
        <div className="rz-sub">Links</div>
        <TextList items={c.links} what="Link" addLabel="Add link" path="contact.links" errors={errors} placeholder="e.g. github.com/yourname" onChange={(v) => set("contact", { ...c, links: v })} />
      </Sec>

      <Sec id="summary" title="Summary" icon="msg">
        <AutoText label="Summary" rows={3} value={p.summary} error={err("summary")} placeholder="A few sentences about you, as written on your resume." onChange={(v) => set("summary", v)} />
      </Sec>

      <Sec id="skills" title="Skills" icon="bolt" count={p.skills.reduce((n, g) => n + g.items.length, 0)}
        action={<button type="button" className="btn ghost" onClick={() => set("skills", [...p.skills, { group: "", items: [] }])}><Icon name="plus" />Add group</button>}>
        {p.skills.length === 0 && <p className="muted small">No skills yet. Add a group such as Languages, Frameworks, Cloud or Tools.</p>}
        {p.skills.map((g, i) => (
          <div className="rz-group" key={i}>
            <div className="rz-entry-h">
              <div className="grow"><Field label={`Group ${i + 1} name`} value={g.group} placeholder="e.g. Languages" error={err(`skills.${i}.group`)} onChange={(v) => setSkill(i, { group: v })} /></div>
              <ItemTools what="skill group" i={i} n={p.skills.length} onMove={(d) => set("skills", move(p.skills, i, d))} onRemove={() => set("skills", removeAt(p.skills, i))} />
            </div>
            <Chips label="Skill" items={g.items} errors={errors} path={`skills.${i}.items`} onChange={(v) => setSkill(i, { items: v })} />
          </div>
        ))}
      </Sec>

      <Sec id="experience" title="Experience" icon="briefcase" count={p.experience.length}
        action={<button type="button" className="btn ghost" onClick={() => set("experience", [...p.experience, emptyExperience()])}><Icon name="plus" />Add role</button>}>
        {p.experience.length === 0 && <p className="muted small">No roles yet.</p>}
        {p.experience.map((e, i) => (
          <div className="rz-entry" key={i}>
            <div className="rz-entry-h"><b className="grow">{[e.title, e.company].filter(Boolean).join(" · ") || `Role ${i + 1}`}</b>
              <ItemTools what="role" i={i} n={p.experience.length} onMove={(d) => set("experience", move(p.experience, i, d))} onRemove={() => set("experience", removeAt(p.experience, i))} /></div>
            <div className="rz-grid2">
              <Field label="Company" value={e.company} error={err(`experience.${i}.company`)} onChange={(v) => setExp(i, { company: v })} />
              <Field label="Title" value={e.title} error={err(`experience.${i}.title`)} onChange={(v) => setExp(i, { title: v })} />
              <Field label="Location" value={e.location} error={err(`experience.${i}.location`)} onChange={(v) => setExp(i, { location: v })} />
              <div className="rz-dates">
                <Field label="Start" value={e.start} placeholder="e.g. Mar 2021" error={err(`experience.${i}.start`)} onChange={(v) => setExp(i, { start: v })} />
                <Field label="End" value={e.is_current ? "" : e.end} placeholder={e.is_current ? "Present" : "e.g. Jun 2023"} disabled={e.is_current} error={err(`experience.${i}.end`)} onChange={(v) => setExp(i, { end: v })} />
              </div>
            </div>
            <label className="check rz-current"><input type="checkbox" checked={e.is_current} onChange={(ev) => setExp(i, { is_current: ev.target.checked })} />I work here now</label>
            <div className="rz-sub">What you did</div>
            <TextList items={e.bullets} what="Bullet" addLabel="Add bullet" path={`experience.${i}.bullets`} errors={errors} onChange={(v) => setExp(i, { bullets: v })} />
          </div>
        ))}
      </Sec>

      <Sec id="projects" title="Projects" icon="layers" count={p.projects.length}
        action={<button type="button" className="btn ghost" onClick={() => set("projects", [...p.projects, emptyProject()])}><Icon name="plus" />Add project</button>}>
        {p.projects.length === 0 && <p className="muted small">No projects yet.</p>}
        {p.projects.map((e, i) => (
          <div className="rz-entry" key={i}>
            <div className="rz-entry-h"><b className="grow">{e.name || `Project ${i + 1}`}</b>
              <ItemTools what="project" i={i} n={p.projects.length} onMove={(d) => set("projects", move(p.projects, i, d))} onRemove={() => set("projects", removeAt(p.projects, i))} /></div>
            <div className="rz-grid2">
              <Field label="Name" value={e.name} error={err(`projects.${i}.name`)} onChange={(v) => setPrj(i, { name: v })} />
              <Field label="Your role" value={e.role} error={err(`projects.${i}.role`)} onChange={(v) => setPrj(i, { role: v })} />
              <Field label="Link" value={e.link} placeholder="optional" error={err(`projects.${i}.link`)} onChange={(v) => setPrj(i, { link: v })} />
            </div>
            <div className="rz-sub">Technologies</div>
            <Chips label="Technology" items={e.tech} errors={errors} path={`projects.${i}.tech`} onChange={(v) => setPrj(i, { tech: v })} />
            <div className="rz-sub">What you did</div>
            <TextList items={e.bullets} what="Bullet" addLabel="Add bullet" path={`projects.${i}.bullets`} errors={errors} onChange={(v) => setPrj(i, { bullets: v })} />
          </div>
        ))}
      </Sec>

      <Sec id="education" title="Education" icon="target" count={p.education.length}
        action={<button type="button" className="btn ghost" onClick={() => set("education", [...p.education, emptyEducation()])}><Icon name="plus" />Add education</button>}>
        {p.education.length === 0 && <p className="muted small">No education yet.</p>}
        {p.education.map((e, i) => (
          <div className="rz-entry" key={i}>
            <div className="rz-entry-h"><b className="grow">{e.school || `Education ${i + 1}`}</b>
              <ItemTools what="education entry" i={i} n={p.education.length} onMove={(d) => set("education", move(p.education, i, d))} onRemove={() => set("education", removeAt(p.education, i))} /></div>
            <div className="rz-grid2">
              <Field label="School" value={e.school} error={err(`education.${i}.school`)} onChange={(v) => setEdu(i, { school: v })} />
              <Field label="Degree" value={e.degree} error={err(`education.${i}.degree`)} onChange={(v) => setEdu(i, { degree: v })} />
              <Field label="Field" value={e.field} error={err(`education.${i}.field`)} onChange={(v) => setEdu(i, { field: v })} />
              <div className="rz-dates">
                <Field label="Start" value={e.start} error={err(`education.${i}.start`)} onChange={(v) => setEdu(i, { start: v })} />
                <Field label="End" value={e.end} error={err(`education.${i}.end`)} onChange={(v) => setEdu(i, { end: v })} />
              </div>
            </div>
            <div className="rz-sub">Details</div>
            <AutoText label={`Education ${i + 1} details`} value={e.details} error={err(`education.${i}.details`)} placeholder="Grade, thesis, honours… (optional)" onChange={(v) => setEdu(i, { details: v })} />
          </div>
        ))}
      </Sec>

      {([["certifications", "Certifications", "check", "Certification"], ["achievements", "Achievements & awards", "target", "Achievement"], ["other", "Other", "more", "Item"]] as const).map(([k, title, icon, what]) => (
        <Sec key={k} id={k} title={title} icon={icon} count={p[k].length}>
          <TextList items={p[k]} what={what} addLabel={`Add ${what.toLowerCase()}`} path={k} errors={errors} onChange={(v) => set(k, v)} />
        </Sec>
      ))}
    </div>
  );
}
