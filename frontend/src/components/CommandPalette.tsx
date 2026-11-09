import { useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api, resumesApi } from "../api";
import { setIntent } from "../intent";
import { grouped, rank, resumePaletteItems, type PaletteItem } from "../palette";
import { setThemePref, useTheme } from "../theme";
import type { HistoryRow, Question } from "../types";
import Icon from "./Icon";

export const PALETTE_EVENT = "lai:palette";
export const SHORTCUTS_EVENT = "lai:shortcuts";
const go = (hash: string) => { window.location.hash = hash; };
const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
export const modKey = isMac ? "⌘" : "Ctrl";

/** ⌘K / Ctrl+K: jump anywhere, run common actions, find a question. Everything is local; nothing is sent anywhere. */
export default function CommandPalette({ onClose, toggleSidebar }: { onClose: () => void; toggleSidebar: () => void }) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [questions, setQuestions] = useState<Question[]>([]);
  const [open, setOpen] = useState<HistoryRow | undefined>();
  const [latest, setLatest] = useState<HistoryRow | undefined>();
  const [readyResumes, setReadyResumes] = useState<number[]>([]);
  const theme = useTheme();
  const list = useRef<HTMLDivElement>(null);
  const id = useId();

  useEffect(() => {   // loaded when the palette opens; failures just mean fewer results
    let live = true;
    api.sets().then((sets) => Promise.all(sets.map((s) => api.questions(s.id)))).then((q) => live && setQuestions(q.flat())).catch(() => {});
    api.interviews().then((rows) => { if (live) { setOpen(rows.find((r) => r.status === "in_progress" || r.status === "paused")); setLatest(rows.find((r) => r.has_report)); } }).catch(() => {});
    resumesApi.cachedList().then((rs) => live && setReadyResumes(rs.filter((r) => r.status === "ready").map((r) => r.id))).catch(() => {});
    return () => { live = false; };
  }, []);

  const items = useMemo<PaletteItem[]>(() => {
    const out: PaletteItem[] = [];
    const act = (id_: string, label: string, icon: PaletteItem["icon"], run: () => void, keywords = "", hint?: string) => out.push({ id: id_, group: "Actions", label, icon, run, keywords, hint });
    if (open) act("resume", `Resume “${open.title}”`, "mic", () => go(`#/interview/${open.id}`), "continue interview", `${open.answered}/${open.total} answered`);
    act("start", "Start a new interview", "mic", () => go("#/setup"), "begin practice session");
    act("add", "Add a question", "plus", () => { setIntent({ type: "add" }); go("#/questions"); }, "new create");
    act("import", "Import questions", "upload", () => { setIntent({ type: "import" }); go("#/questions"); }, "paste bulk json");
    const resumeItems = resumePaletteItems(go, setIntent, readyResumes);
    out.push(...resumeItems.filter((i) => i.group === "Actions"));
    if (latest) act("report", `Open latest report`, "chart", () => go(`#/report/${latest.id}`), "results score", latest.title);
    act("sidebar", "Collapse or expand the sidebar", "chevl", toggleSidebar, "menu", "[");
    (["light", "dark", "system"] as const).forEach((p) => act(`theme-${p}`, `Theme: ${p[0].toUpperCase()}${p.slice(1)}`, p === "light" ? "sun" : p === "dark" ? "moon" : "desktop", () => setThemePref(p), "appearance colour mode", theme.pref === p ? "current" : undefined));
    act("shortcuts", "Keyboard shortcuts", "keyboard", () => window.dispatchEvent(new Event(SHORTCUTS_EVENT)), "keys help", "?");
    ([["home", "Home", "home", "H"], ["questions", "Questions", "list", "Q"], ["setup", "Interview", "mic", "I"], ["history", "History", "clock", "Y"], ["reports", "Reports", "chart", "R"],
      ["usage", "Model usage", "cpu", "U"], ["settings", "Settings", "settings", "S"]] as const)
      .forEach(([k, label, icon, key]) => { out.push({ id: `go-${k}`, group: "Go to", label, icon, run: () => go(`#/${k}`), hint: `G ${key}`, keywords: `${k} tokens time speed ollama` });
        if (k === "questions") out.push(...resumeItems.filter((i) => i.group === "Go to")); });
    questions.forEach((q) => out.push({ id: `q-${q.id}`, group: "Questions", label: q.text, icon: "doc", hint: q.topic ?? undefined, keywords: `${q.topic ?? ""} ${q.rubric ?? ""}`,
      run: () => { setIntent({ type: "search", text: q.text.slice(0, 80) }); go("#/questions"); } }));
    return out;
  }, [questions, open, latest, theme.pref, toggleSidebar, readyResumes]);

  const shown = useMemo(() => grouped(rank(items, query)), [items, query]);
  useEffect(() => setActive(0), [query]);
  useEffect(() => { list.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" }); }, [active, shown]);

  const run = (item: PaletteItem | undefined) => { if (!item) return; onClose(); item.run(); };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(a + 1, shown.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
    else if (e.key === "Enter") { e.preventDefault(); run(shown[active]); }
    else if (e.key === "Escape") { e.preventDefault(); onClose(); }
  };

  let lastGroup = "";
  return createPortal(
    <div className="overlay palette-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal palette" role="dialog" aria-modal="true" aria-label="Command palette" onKeyDown={onKey}>
        <div className="pal-input">
          <Icon name="search" />
          <input autoFocus type="text" role="combobox" aria-expanded="true" aria-controls={`${id}-list`} aria-activedescendant={shown[active] ? `${id}-${shown[active].id}` : undefined}
            aria-label="Search commands, pages and questions" placeholder="Search commands, pages and questions…" value={query} onChange={(e) => setQuery(e.target.value)} spellCheck={false} autoComplete="off" />
          <kbd>esc</kbd>
        </div>
        <div className="pal-list" id={`${id}-list`} role="listbox" ref={list}>
          {shown.length === 0 && <div className="pal-empty">Nothing matches “{query}”.</div>}
          {shown.map((item, i) => {
            const header = item.group !== lastGroup ? (lastGroup = item.group) : null;
            return (
              <div key={item.id}>
                {header && <div className="pal-group">{header}</div>}
                <div id={`${id}-${item.id}`} role="option" aria-selected={i === active} className={`pal-item ${i === active ? "on" : ""}`} onMouseMove={() => setActive(i)} onClick={() => run(item)}>
                  <span className="pal-ic"><Icon name={item.icon} /></span>
                  <span className="pal-t">{item.label}</span>
                  {item.hint && <span className="pal-hint">{item.hint}</span>}
                </div>
              </div>
            );
          })}
        </div>
        <div className="pal-foot"><span><kbd>↑</kbd><kbd>↓</kbd> navigate</span><span><kbd>↵</kbd> select</span><span><kbd>{modKey}</kbd><kbd>K</kbd> toggle</span></div>
      </div>
    </div>,
    document.body,
  );
}

