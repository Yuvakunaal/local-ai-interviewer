import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { speaker } from "../audio";
import Icon from "../components/Icon";
import { SkeletonRows } from "../components/Skeleton";
import { INTENT_EVENT, takeIntent } from "../intent";
import { Confirm, ErrorNotice, Menu, Modal, topicClass, useAsync, useToast } from "../components/ui";
import type { Difficulty, ImportItem, ImportPreview, Question, QuestionInput } from "../types";
import { useSpeaker } from "./useSpeaker";

const LAST_SET = "lai.lastSet";
const safeGet = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
const safeSet = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } };
const DIFF_ORDER: Record<string, number> = { easy: 0, medium: 1, hard: 2 };
type Sort = "manual" | "newest" | "az" | "difficulty";

export default function Questions() {
  const toast = useToast();
  const sets = useAsync(() => api.sets(), []);
  const [setId, setSetId] = useState<number | null>(null);
  useEffect(() => {
    if (sets.data && (setId == null || !sets.data.some((s) => s.id === setId))) {
      const saved = Number(safeGet(LAST_SET));
      setSetId(sets.data.find((s) => s.id === saved)?.id ?? sets.data[0]?.id ?? null);
    }
  }, [sets.data, setId]);
  const qs = useAsync(() => (setId ? api.questions(setId) : Promise.resolve([] as Question[])), [setId]);
  const [editing, setEditing] = useState<Question | "new" | null>(null);
  const [newTopic, setNewTopic] = useState("");          // pre-filled topic when the Add dialog is opened from the dashboard
  const [importing, setImporting] = useState(false);
  const [confirm, setConfirm] = useState<null | { title: string; message: string; label: string; run: () => Promise<void> }>(null);
  const [dragId, setDragId] = useState<number | null>(null);
  const [overId, setOverId] = useState<number | null>(null);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [setDialog, setSetDialog] = useState<null | "new" | "rename">(null);
  const [search, setSearch] = useState("");
  useEffect(() => {   // requests from the command palette: "add a question", "import", "find this question"
    if (setId == null) return;
    const apply = () => {
      const i = takeIntent(["add", "import", "search"]);
      if (!i) return;
      if (i.type === "add") { setNewTopic(i.topic ?? ""); setEditing("new"); } else if (i.type === "import") setImporting(true); else setSearch(i.text);
    };
    apply();
    window.addEventListener(INTENT_EVENT, apply);
    return () => window.removeEventListener(INTENT_EVENT, apply);
  }, [setId]);
  const [topicFilter, setTopicFilter] = useState("");
  const [diffFilter, setDiffFilter] = useState("");
  const [sort, setSort] = useState<Sort>("manual");
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const speech = useSpeaker();
  const all = qs.data ?? [];
  const filtering = !!(search.trim() || topicFilter || diffFilter) || sort !== "manual";
  const current = sets.data?.find((s) => s.id === setId);

  const topicCounts = useMemo(() => {
    const m = new Map<string, number>();
    all.forEach((q) => m.set(q.topic ?? "", (m.get(q.topic ?? "") ?? 0) + 1));
    return m;
  }, [all]);
  const topics = useMemo(() => [...topicCounts.keys()].filter(Boolean).sort(), [topicCounts]);
  const tabTopics = useMemo(() => [...topicCounts.entries()].filter(([t]) => t).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([t]) => t), [topicCounts]);

  const list = useMemo(() => {
    const f = all.filter((q) => (!topicFilter || q.topic === topicFilter) && (!diffFilter || q.difficulty === diffFilter)
      && (!search.trim() || `${q.text} ${q.topic ?? ""} ${q.rubric ?? ""}`.toLowerCase().includes(search.trim().toLowerCase())));
    if (sort === "newest") f.sort((a, b) => b.id - a.id);
    else if (sort === "az") f.sort((a, b) => a.text.localeCompare(b.text));
    else if (sort === "difficulty") f.sort((a, b) => (DIFF_ORDER[a.difficulty ?? ""] ?? 9) - (DIFF_ORDER[b.difficulty ?? ""] ?? 9));
    return f;
  }, [all, topicFilter, diffFilter, search, sort]);

  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    try { await fn(); if (ok) toast("ok", ok); } catch (e) { toast("error", (e as Error).message); }
    await Promise.all([qs.reload(), sets.reload()]);
  };
  const move = (qid: number, dir: -1 | 1) => {
    const ids = all.map((q) => q.id);
    const i = ids.indexOf(qid), j = i + dir;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    void run(() => api.reorder(setId!, ids));
  };
  const drop = (target: number) => {
    if (dragId == null || dragId === target) return;
    const ids = all.map((q) => q.id).filter((i) => i !== dragId);
    ids.splice(ids.indexOf(target) + (all.findIndex((q) => q.id === dragId) < all.findIndex((q) => q.id === target) ? 1 : 0), 0, dragId);
    void run(() => api.reorder(setId!, ids));
  };
  const speak = (q: Question) => void speaker.play(`q${q.id}`, q.text, safeGet("lai.voice") || "default");
  const allSelected = list.length > 0 && list.every((q) => selected.has(q.id));
  const toggle = (id: number, on: boolean) => { const n = new Set(selected); on ? n.add(id) : n.delete(id); setSelected(n); };
  const deleteSelected = () => setConfirm({ title: `Delete ${selected.size} question(s)?`, label: "Delete", message: "The selected questions will be removed from this set. Past interview reports keep their own copies.",
    run: async () => { for (const id of selected) await api.deleteQuestion(id); setSelected(new Set()); } });

  return (
    <div>
      <div className="pagehead">
        <div><h1>Question Bank</h1><div className="muted">Manage your interview questions</div></div>
        <div className="row">
          <button className="btn" onClick={() => setImporting(true)} disabled={!setId}><Icon name="upload" />Import Questions</button>
          <a className="btn" href={setId ? api.exportSetUrl(setId) : undefined} download aria-disabled={!setId}><Icon name="download" />Export JSON</a>
          <button className="btn primary" onClick={() => { setNewTopic(""); setEditing("new"); }} disabled={!setId} aria-label="Add question" title="Add question"><Icon name="plus" />Add Question</button>
        </div>
      </div>

      <div className="row small" style={{ marginBottom: 6 }}>
        <span className="muted">Question set</span>
        <select aria-label="Question set" style={{ width: "auto", minWidth: 190, padding: "6px 30px 6px 10px" }} value={setId ?? ""} onChange={(e) => { setSetId(Number(e.target.value)); setSelected(new Set()); safeSet(LAST_SET, e.target.value); }}>
          {(sets.data ?? []).map((s) => <option key={s.id} value={s.id}>{s.name} ({s.question_count})</option>)}
        </select>
        <button className="btn ghost" onClick={() => setSetDialog("new")}>New set</button>
        <button className="btn ghost" onClick={() => setSetDialog("rename")} disabled={!current}>Rename</button>
        <button className="btn ghost danger" style={{ border: 0 }} disabled={!current || (sets.data?.length ?? 0) < 2}
          onClick={() => current && setConfirm({ title: "Delete question set?", label: "Delete set", message: `“${current.name}” and its ${current.question_count} question(s) will be removed. Past interview reports keep their own copies of the questions.`,
            run: async () => { await api.deleteSet(current.id); setSetId(null); } })}>Delete set</button>
      </div>

      <ErrorNotice error={sets.error || qs.error} />

      {all.length > 0 && (
        <>
          <div className="tabs pill" role="tablist" style={{ display: "inline-flex", marginTop: 12 }}>
            <button role="tab" aria-selected={!topicFilter} className={`tab ${!topicFilter ? "active" : ""}`} onClick={() => setTopicFilter("")}>All ({all.length})</button>
            {tabTopics.map((t) => <button key={t} role="tab" aria-selected={topicFilter === t} className={`tab ${topicFilter === t ? "active" : ""}`} onClick={() => setTopicFilter(t)}>{t} ({topicCounts.get(t)})</button>)}
          </div>
          <div className="qfilters" role="search">
            <div className="searchbox"><Icon name="search" /><input type="search" aria-label="Search questions" placeholder="Search questions..." value={search} onChange={(e) => setSearch(e.target.value)} /></div>
            <select aria-label="Filter by topic" value={topicFilter} onChange={(e) => setTopicFilter(e.target.value)}><option value="">Topic</option>{topics.map((t) => <option key={t} value={t}>{t}</option>)}</select>
            <select aria-label="Filter by difficulty" value={diffFilter} onChange={(e) => setDiffFilter(e.target.value)}><option value="">Difficulty</option><option value="easy">Easy</option><option value="medium">Medium</option><option value="hard">Hard</option></select>
            <select aria-label="Sort" value={sort} onChange={(e) => setSort(e.target.value as Sort)}><option value="manual">Sort</option><option value="newest">Newest first</option><option value="az">A → Z</option><option value="difficulty">Difficulty</option></select>
          </div>
          {filtering && <div className="muted small">Showing {list.length} of {all.length}. Reordering is available with no filter or sort applied. <button className="btn ghost" style={{ padding: "2px 8px" }} onClick={() => { setSearch(""); setTopicFilter(""); setDiffFilter(""); setSort("manual"); }}>Clear</button></div>}
        </>
      )}

      {all.length > 0 && list.length === 0 && <div className="card muted" style={{ textAlign: "center", marginTop: 12 }}>No questions match your filters.</div>}
      {qs.loading && !qs.data && <SkeletonRows n={4} />}
      {all.length === 0 && !qs.loading && (
        <div className="card" style={{ textAlign: "center", padding: 40, marginTop: 14 }}>
          <h2>No questions yet</h2>
          <p className="muted">Press <b>Add Question</b>, or paste many at once with <b>Import Questions</b> (separate questions with a line containing only <span className="mono">--</span>).</p>
          <div className="row" style={{ justifyContent: "center" }}>
            <button className="btn primary" onClick={() => setEditing("new")}><Icon name="plus" />Add your first question</button>
            <button className="btn" onClick={() => setImporting(true)}><Icon name="upload" />Import Questions</button>
          </div>
        </div>
      )}

      {list.length > 0 && (
        <div className="qtable">
          {selected.size > 0 ? (
            <div className="bulkbar">
              <input type="checkbox" aria-label="Select all" checked={allSelected} ref={(el) => { if (el) el.indeterminate = !allSelected; }} onChange={(e) => setSelected(e.target.checked ? new Set(list.map((q) => q.id)) : new Set())} />
              <span>{selected.size} selected</span><span className="grow" />
              <button className="btn" onClick={() => { safeSet("lai.preselect", JSON.stringify({ setId, ids: [...selected] })); window.location.hash = "#/setup"; }}>Practice selected</button>
              <button className="btn danger" onClick={deleteSelected}>Delete selected</button>
              <button className="btn ghost" onClick={() => setSelected(new Set())}>Clear</button>
            </div>
          ) : (
            <div className="qhead"><input type="checkbox" aria-label="Select all" checked={false} onChange={() => setSelected(new Set(list.map((q) => q.id)))} /><span>Select all</span></div>
          )}
          {list.map((q) => (
            <div key={q.id} className={`qrow ${overId === q.id && dragId !== q.id ? "dragover" : ""}`} draggable={!filtering}
              onDragStart={() => setDragId(q.id)} onDragEnd={() => { setDragId(null); setOverId(null); }}
              onDragOver={(e) => { e.preventDefault(); setOverId(q.id); }} onDrop={() => { drop(q.id); setDragId(null); setOverId(null); }}>
              <input type="checkbox" aria-label={`Select question ${q.position + 1}`} checked={selected.has(q.id)} onChange={(e) => toggle(q.id, e.target.checked)} />
              <span className="num">{q.position + 1}</span>
              <div>
                <div className={`qtext ${expanded === q.id ? "" : "clamp"}`}>{q.text}</div>
                {expanded === q.id && q.rubric && <div className="notice info small" style={{ marginTop: 8 }}><b>Expected answer / rubric:</b><div style={{ whiteSpace: "pre-wrap" }}>{q.rubric}</div></div>}
                {q.rubric && expanded !== q.id && <span className="badge ok" style={{ marginTop: 6 }} title={q.rubric}>rubric</span>}
              </div>
              <div className="tags">
                {q.topic ? <span className={`pill-tag ${topicClass(q.topic)}`} title={q.topic}>{q.topic}</span> : <span />}
                {q.difficulty ? <span className={`pill-tag d-${q.difficulty}`} style={{ textTransform: "capitalize" }}>{q.difficulty}</span> : <span />}
              </div>
              <div className="qactions">
                <button className="btn icon" aria-label="Edit question" title="Edit" onClick={() => setEditing(q)}><Icon name="pencil" /></button>
                <button className="btn icon del" aria-label="Delete question" title="Delete" onClick={() => setConfirm({ title: "Delete this question?", label: "Delete", message: q.text.slice(0, 200), run: () => api.deleteQuestion(q.id).then(() => undefined) })}><Icon name="trash" /></button>
                <Menu label={`More actions for question ${q.position + 1}`} trigger={<Icon name="more" />}>
                  {(close) => (<>
                    <button disabled={filtering || q.position === 0} onClick={() => { close(); move(q.id, -1); }} aria-label="Move up"><Icon name="up" />Move up</button>
                    <button disabled={filtering || q.position === all.length - 1} onClick={() => { close(); move(q.id, 1); }} aria-label="Move down"><Icon name="dn" />Move down</button>
                    <button onClick={() => { close(); void run(() => api.duplicateQuestion(q.id), "Duplicated"); }} aria-label="Duplicate question"><Icon name="copy" />Duplicate</button>
                    <button onClick={() => { close(); setExpanded(expanded === q.id ? null : q.id); }} aria-label="Preview question"><Icon name="eye" />{expanded === q.id ? "Collapse preview" : "Preview"}</button>
                    <button onClick={() => { close(); speech.key === `q${q.id}` && speech.status !== "idle" ? speaker.stop() : speak(q); }} aria-label="Hear question"><Icon name="vol" />{speech.key === `q${q.id}` && speech.status !== "idle" ? "Stop audio" : "Hear this question"}</button>
                  </>)}
                </Menu>
              </div>
            </div>
          ))}
        </div>
      )}
      {speech.error && speech.key?.startsWith("q") && <ErrorNotice error={speech.error} />}

      {editing && setId && (
        <QuestionForm initial={editing === "new" ? null : editing} defaultTopic={newTopic} topics={topics} onClose={() => setEditing(null)}
          onSave={async (q) => { await run(() => (editing === "new" ? api.addQuestion(setId, q) : api.updateQuestion(editing.id, q)), "Saved"); setEditing(null); }} />
      )}
      {importing && setId && <BulkImport setId={setId} existing={all.length} onClose={() => setImporting(false)} onDone={async (msg) => { await Promise.all([qs.reload(), sets.reload()]); toast("ok", msg); setImporting(false); }} />}
      {setDialog && <SetNameDialog title={setDialog === "new" ? "New question set" : "Rename set"} initial={setDialog === "rename" ? current?.name ?? "" : ""} onClose={() => setSetDialog(null)}
        onSave={async (name) => {
          try {
            if (setDialog === "new") { const s = await api.createSet(name); setSetId(s.id); safeSet(LAST_SET, String(s.id)); } else await api.renameSet(setId!, name);
            setSetDialog(null); await sets.reload();
          } catch (e) { toast("error", (e as Error).message); }
        }} />}
      {confirm && <Confirm title={confirm.title} message={confirm.message} confirmLabel={confirm.label} danger onCancel={() => setConfirm(null)}
        onConfirm={() => { const c = confirm; setConfirm(null); void run(c.run, "Done"); }} />}
    </div>
  );
}

function SetNameDialog({ title, initial, onClose, onSave }: { title: string; initial: string; onClose: () => void; onSave: (name: string) => void }) {
  const [name, setName] = useState(initial);
  return (
    <Modal title={title} onClose={onClose} narrow>
      <form onSubmit={(e) => { e.preventDefault(); if (name.trim()) onSave(name.trim()); }}>
        <label className="field">Name<input type="text" autoFocus value={name} maxLength={100} onChange={(e) => setName(e.target.value)} /></label>
        <div className="row" style={{ justifyContent: "flex-end", marginTop: 16 }}>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={!name.trim()}>Save</button>
        </div>
      </form>
    </Modal>
  );
}

function QuestionForm({ initial, defaultTopic = "", topics, onClose, onSave }: { initial: Question | null; defaultTopic?: string; topics: string[]; onClose: () => void; onSave: (q: QuestionInput) => Promise<void> }) {
  const [text, setText] = useState(initial?.text ?? "");
  const [rubric, setRubric] = useState(initial?.rubric ?? "");
  const [topic, setTopic] = useState(initial?.topic ?? defaultTopic);
  const [difficulty, setDifficulty] = useState<Difficulty | "">(initial?.difficulty ?? "");
  const [busy, setBusy] = useState(false);
  return (
    <Modal title={initial ? "Edit Question" : "Add Question"} onClose={onClose}>
      <form className="stack" onSubmit={async (e) => {
        e.preventDefault(); if (busy || !text.trim()) return; setBusy(true);
        try { await onSave({ text, rubric: rubric || null, topic: topic || null, difficulty: difficulty || null }); } finally { setBusy(false); }
      }}>
        <label className="field">Question
          <textarea autoFocus value={text} onChange={(e) => setText(e.target.value)} rows={4} maxLength={4000} placeholder="e.g. How would you design a rate limiter for a public API?" />
        </label>
        <label className="field">Expected answer / evaluation rubric <span className="muted">(optional)</span>
          <textarea value={rubric} onChange={(e) => setRubric(e.target.value)} rows={4} maxLength={4000} placeholder="Key points a strong answer should cover. Equivalent approaches are accepted." />
        </label>
        <div className="grid2">
          <label className="field">Topic <span className="muted">(optional)</span>
            <input type="text" list="topics" value={topic} maxLength={80} onChange={(e) => setTopic(e.target.value)} placeholder="Python, System design, SQL…" />
            <datalist id="topics">{topics.map((t) => <option key={t} value={t} />)}</datalist>
          </label>
          <label className="field">Difficulty <span className="muted">(optional)</span>
            <select value={difficulty} onChange={(e) => setDifficulty(e.target.value as Difficulty | "")}>
              <option value="">Not set</option><option value="easy">Easy</option><option value="medium">Medium</option><option value="hard">Hard</option>
            </select>
          </label>
        </div>
        <div className="row" style={{ justifyContent: "flex-end" }}>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy || !text.trim()}>{busy ? "Saving…" : "Save"}</button>
        </div>
      </form>
    </Modal>
  );
}

const EXAMPLE = `What is the difference between a process and a thread?
--
How would you design a rate limiter for a public API?
--
Explain idempotency and why it matters for retries.
--
How would you investigate a sudden spike in production errors?`;

function BulkImport({ setId, existing, onClose, onDone }: { setId: number; existing: number; onClose: () => void; onDone: (msg: string) => void }) {
  const [mode, setMode] = useState<"text" | "json">("text");
  const [content, setContent] = useState("");
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [removed, setRemoved] = useState<Set<number>>(new Set());
  const [action, setAction] = useState<"append" | "replace">("append");
  const [confirmReplace, setConfirmReplace] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const seq = useRef(0);

  useEffect(() => {
    setRemoved(new Set());
    if (!content.trim()) { setPreview(null); return; }
    const my = ++seq.current;
    const t = setTimeout(async () => {
      try { const p = await api.previewImport(setId, mode, content); if (my === seq.current) { setPreview(p); setError(null); } }
      catch (e) { if (my === seq.current) setError((e as Error).message); }
    }, 250);
    return () => clearTimeout(t);
  }, [content, mode, setId]);

  const kept = (preview?.items ?? []).map((it, i) => ({ it, i })).filter(({ it, i }) => !removed.has(i) && !it.duplicate && !it.error);
  const dupCount = (preview?.items ?? []).filter((it, i) => !removed.has(i) && it.duplicate).length;
  const label = (it: ImportItem) => (it.duplicate === "existing" ? "Already in your queue — will be skipped" : it.duplicate === "batch" ? "Repeated in this paste — will be skipped" : it.error);

  const commit = async () => {
    if (!kept.length || busy) return;
    setBusy(true);
    try {
      const r = await api.commitImport(setId, action, kept.map(({ it }) => ({ text: it.text, rubric: it.rubric, topic: it.topic, difficulty: it.difficulty as Difficulty | null })), confirmReplace);
      onDone(`Imported ${r.added} question(s)${r.skipped_duplicates ? `, skipped ${r.skipped_duplicates} duplicate(s)` : ""}${r.removed ? `, replaced ${r.removed}` : ""}${r.backup_file ? ` (backup: data/backups/${r.backup_file})` : ""}.`);
    } catch (e) { setError((e as Error).message); setBusy(false); }
  };

  return (
    <Modal title="Import Questions" onClose={onClose}>
      <div className="muted" style={{ marginTop: -6, marginBottom: 12 }}>Paste your questions below. Use <span className="mono">--</span> as a separator.</div>
      <div className="tabs pill" style={{ display: "inline-flex", marginBottom: 12 }}>
        <button className={`tab ${mode === "text" ? "active" : ""}`} onClick={() => { setMode("text"); setContent(""); }}>Paste text</button>
        <button className={`tab ${mode === "json" ? "active" : ""}`} onClick={() => { setMode("json"); setContent(""); }}>JSON file</button>
      </div>
      {mode === "text" ? (
        <textarea aria-label="Questions to import" rows={8} value={content} onChange={(e) => setContent(e.target.value)} placeholder={EXAMPLE} spellCheck={false} />
      ) : (
        <label className="field">Choose a .json file <span className="muted">(from “Export JSON”, or {"{ \"questions\": [{ \"text\", \"rubric\", \"topic\", \"difficulty\" }] }"})</span>
          <input type="file" accept="application/json,.json" onChange={async (e) => { const f = e.target.files?.[0]; if (f) setContent(await f.text()); }} />
        </label>
      )}
      <ErrorNotice error={error} />
      {preview?.warnings.map((w) => <div key={w} className="notice warn">{w}</div>)}
      {preview?.errors.map((w) => <div key={w} className="notice error">{w}</div>)}
      {preview && preview.items.length > 0 && (
        <div style={{ marginTop: 14 }}>
          <div className="row between" style={{ marginBottom: 6 }}><b>Detected {kept.length} question{kept.length === 1 ? "" : "s"}</b><span className="muted small">{preview.count} found{dupCount ? `, ${dupCount} duplicate(s)` : ""}</span></div>
          <div className="import-list">
            {preview.items.map((it, i) => removed.has(i) ? null : (
              <div key={i} className="import-item" style={{ opacity: it.duplicate || it.error ? 0.6 : 1 }}>
                <span className="n">{i + 1}</span>
                <div className="grow"><div className="qtext clamp">{it.text}</div>
                  {(it.duplicate || it.error) && <span className="badge warn">{label(it)}</span>}
                  {it.topic && <span className={`pill-tag ${topicClass(it.topic)}`} style={{ marginLeft: 6 }}>{it.topic}</span>}
                </div>
                <button className="btn icon ghost" style={{ color: "var(--bad)" }} aria-label={`Remove question ${i + 1} from import`} onClick={() => setRemoved(new Set(removed).add(i))}><Icon name="x" /></button>
              </div>
            ))}
          </div>
          <div className="radios" style={{ marginTop: 16 }}>
            <label><input type="radio" checked={action === "append"} onChange={() => setAction("append")} />Append to existing questions <span className="muted">({existing} stay untouched)</span></label>
            <label><input type="radio" checked={action === "replace"} onChange={() => setAction("replace")} />Replace existing questions</label>
          </div>
          {action === "replace" && <label className="check notice warn"><input type="checkbox" checked={confirmReplace} onChange={(e) => setConfirmReplace(e.target.checked)} /><span>Yes, replace the {existing} current question(s). A JSON backup is saved to <span className="mono">data/backups/</span> first.</span></label>}
        </div>
      )}
      <div className="row" style={{ justifyContent: "flex-end", marginTop: 18 }}>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={!kept.length || busy || (action === "replace" && !confirmReplace)} onClick={commit}>
          {busy ? "Importing…" : `Import ${kept.length || ""} Question${kept.length === 1 ? "" : "s"}`}
        </button>
      </div>
    </Modal>
  );
}
