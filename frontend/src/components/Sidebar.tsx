import { useEffect, useState } from "react";
import { api, resumesApi } from "../api";
import { speaker } from "../audio";
import { fmtUsd } from "../aiHelpers";
import { useSystemVoices } from "../pages/useSpeaker";
import { nextPref, setThemePref, useTheme } from "../theme";
import type { Health, HistoryRow } from "../types";
import Icon, { type IconName } from "./Icon";
import Logo from "./Logo";

const readName = () => { try { return localStorage.getItem("lai.name") ?? ""; } catch { return ""; } };

interface Item { key: string; label: string; icon: IconName; section: string; badge?: number | null; live?: boolean }

/** Polished, collapsible sidebar. Collapsed = icon rail with tooltips; on phones it becomes a slide-in drawer. */
export default function Sidebar({ route, collapsed, onToggle, mobileOpen, onClose }: { route: string; collapsed: boolean; onToggle: () => void; mobileOpen: boolean; onClose: () => void }) {
  const [health, setHealth] = useState<Health | null>(null);
  const [rows, setRows] = useState<HistoryRow[]>([]);
  const [questions, setQuestions] = useState<number | null>(null);
  const [resumes, setResumes] = useState<number | null>(null);
  const [name, setName] = useState(readName);
  const sysVoices = useSystemVoices(health?.tts.engine === "system");
  const theme = useTheme();
  const themeLabel = theme.pref === "light" ? "Light" : theme.pref === "dark" ? "Dark" : "Auto";

  // light, local-only refresh whenever the user navigates or changes the AI engine (Settings → AI models)
  const [aiTick, setAiTick] = useState(0);
  useEffect(() => { const on = () => setAiTick((n) => n + 1); let t: ReturnType<typeof setTimeout> | undefined; const soon = () => { if (t) clearTimeout(t); t = setTimeout(on, 120); };   // several changes in a row refresh once
    window.addEventListener("lai:ai", on); window.addEventListener("lai:interviews", on); window.addEventListener("lai:data", soon);
    return () => { if (t) clearTimeout(t); window.removeEventListener("lai:ai", on); window.removeEventListener("lai:interviews", on); window.removeEventListener("lai:data", soon); }; }, []);
  useEffect(() => {
    let live = true;
    api.health().then((h) => { if (live) { setHealth(h); speaker.setEngine(h.tts.engine); } }).catch(() => live && setHealth(null));
    api.interviews().then((r) => live && setRows(r)).catch(() => {});
    api.sets().then((s) => live && setQuestions(s.reduce((n, x) => n + x.question_count, 0))).catch(() => {});
    resumesApi.cachedList().then((r) => live && setResumes(r.length)).catch(() => {});
    return () => { live = false; };
  }, [route, aiTick]);
  useEffect(() => { const on = () => setName(readName()); window.addEventListener("lai:name", on); return () => window.removeEventListener("lai:name", on); }, []);

  const open = rows.find((r) => r.status === "in_progress" || r.status === "paused");
  const reports = rows.filter((r) => r.has_report).length;
  const items: Item[] = [
    { key: "home", label: "Home", icon: "home", section: "Workspace" },
    { key: "questions", label: "Questions", icon: "list", section: "Workspace", badge: questions },
    { key: "resumes", label: "Resumes", icon: "file", section: "Workspace", badge: resumes || null },
    { key: "setup", label: "Interview", icon: "mic", section: "Workspace", live: !!open },
    { key: "history", label: "History", icon: "clock", section: "Workspace", badge: rows.length || null },
    { key: "reports", label: "Reports", icon: "chart", section: "Insights", badge: reports || null },
    { key: "usage", label: "Model usage", icon: "cpu", section: "Models" },
  ];
  const active = route === "interview" ? "setup" : route === "report" ? "reports" : route;
  const sections = [...new Set(items.map((i) => i.section))];

  const cloud = health?.ai.mode === "cloud";
  const spent = health?.ai.budget?.today;
  const checks: [string, boolean | null, string][] = health ? [
    ...(cloud ? [
      ["Ollama cloud", health.ai.ready, health.ai.ready ? `grader: ${health.ai.grader_model}` : "add your API key in Settings → AI models"] as [string, boolean | null, string],
      [`Spent today ${fmtUsd(spent?.spent_usd ?? 0)}`, spent?.reached ? false : true, spent?.limit_usd != null ? `limit ${fmtUsd(spent.limit_usd)} per day` : "no daily limit set"] as [string, boolean | null, string],
      ["Ollama (local, optional)", health.ollama.ok ? true : null, health.ollama.error ?? `v${health.ollama.version}`] as [string, boolean | null, string],
    ] : [
      ["Ollama", health.ollama.ok, health.ollama.error ?? `v${health.ollama.version}`] as [string, boolean | null, string],
      [health.llm.model, health.llm.installed, health.llm.error ?? (health.llm.loaded ? "loaded" : "ready")] as [string, boolean | null, string],
    ]),
    health.tts.engine === "system"
      ? ["Voice (system)", sysVoices === null || sysVoices.length > 0 ? true : null, sysVoices === null ? "checking…" : sysVoices.length ? `${sysVoices.length} offline voices` : "none found · text only"]
      : ["Voice (Phonon)", !health.tts.error, health.tts.error ?? `${health.tts.voices} voices`],
    ["Microphone", health.stt.available ? true : null, health.stt.reason ?? health.stt.model],
  ] : [];
  const allOk = !!health && checks.every(([, ok]) => ok !== false);
  const initial = (name || "?").trim().charAt(0).toUpperCase();

  return (
    <>
      <div className={`sb-backdrop ${mobileOpen ? "show" : ""}`} onClick={onClose} aria-hidden />
      <aside className={`sidebar ${collapsed ? "collapsed" : ""} ${mobileOpen ? "open" : ""}`} aria-label="Sidebar">
        <button className="sb-handle" onClick={onToggle} aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"} aria-expanded={!collapsed} title={`${collapsed ? "Expand" : "Collapse"} sidebar  ( [ )`}><Icon name="chevl" /></button>

        <a className="sb-brand" href="#/home" onClick={onClose} aria-label="AI Interviewer home">
          <Logo size={44} className="sb-mark" />
          <span className="sb-name"><b>AI Interviewer</b><small>{health?.ai.mode === "cloud" ? "Cloud AI · voice stays local" : "Private · On-device"}</small></span>
        </a>

        <nav aria-label="Main">
          {sections.map((sec) => (
            <div key={sec} className="sb-group">
              <div className="sb-section"><span>{sec}</span></div>
              {items.filter((i) => i.section === sec).map((i) => (
                <a key={i.key} href={`#/${i.key}`} onClick={onClose} className={`sb-item ${active === i.key ? "active" : ""}`} data-tip={i.label} aria-current={active === i.key ? "page" : undefined}>
                  <span className="sb-ic"><Icon name={i.icon} />{i.live && <i className="sb-live" title="Interview in progress" />}</span>
                  <span className="sb-label">{i.label}</span>
                  {i.badge ? <span className="sb-badge">{i.badge}</span> : null}
                </a>
              ))}
            </div>
          ))}
        </nav>

        <div className="sb-foot">
          <div className={`status ${allOk ? "ok" : ""}`} aria-label="Local services" data-tip={allOk ? "All local services ready" : "Check local services"}>
            <div className="status-title"><span>Local services</span><span className={`sb-pill ${allOk ? "ok" : "bad"}`}>{health ? (allOk ? "All ready" : "Attention") : "…"}</span></div>
            {checks.map(([n, ok, tip]) => <span key={n} title={tip}><span className={`dot ${ok === true ? "ok" : ok === false ? "bad" : "warn"}`} />{n}</span>)}
            <span className="sb-dot-only"><span className={`dot ${health ? (allOk ? "ok" : "bad") : "warn"}`} /></span>
          </div>
          <button className="sb-theme" onClick={() => setThemePref(nextPref(theme.pref))} data-tip={`Theme: ${themeLabel}`} aria-label={`Colour theme: ${themeLabel}. Click to change.`} title="Change colour theme">
            <span className="sb-ic"><Icon name={theme.pref === "light" ? "sun" : theme.pref === "dark" ? "moon" : "desktop"} /></span>
            <span className="sb-label">Theme · {themeLabel}</span>
          </button>
          <a className={`sb-user ${route === "settings" ? "active" : ""}`} href="#/settings" onClick={onClose} data-tip={`${name || "You"} · Settings`} aria-label={`Settings (${name || "You"})`} aria-current={route === "settings" ? "page" : undefined}>
            <span className="sb-av">{initial}</span>
            <span className="sb-uname"><b>{name || "You"}</b></span>
            <span className="sb-gear" aria-hidden="true"><Icon name="settings" /></span>
          </a>
        </div>
      </aside>
    </>
  );
}
