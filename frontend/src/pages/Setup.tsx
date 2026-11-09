import { useEffect, useMemo, useRef, useState } from "react";
import { api, resumesApi } from "../api";
import { speaker } from "../audio";
import Icon, { Stop } from "../components/Icon";
import ActiveInterviews, { isActive } from "../components/ActiveInterviews";
import { ErrorNotice, OptionCards, Section, Seg, Switch, topicClass, useAsync, useToast } from "../components/ui";
import type { DraftQuestion, GenSettings, InterviewConfig, MixOrder, Question } from "../types";
import ResumeQuestionsPanel from "../components/ResumeQuestionsPanel";
import { takeIntent } from "../intent";
import { DEFAULT_FOCUS, MIX_LABEL, interviewMinutes, mixSequence, sessionCounts, toInput, validQuestion, type Source } from "../resumeHelpers";
import type { SystemVoice } from "../systemVoices";
import { estimateInterviewCost, fmtUsd } from "../aiHelpers";
import { describeTopics } from "../practice";
import { openSettings } from "../settingsTab";
import { shortVoiceName, useSpeaker, useSystemVoices } from "./useSpeaker";

const KEY = "lai.setup";
const DEFAULTS: InterviewConfig = {
  title: "Practice Interview - 1", interview_type: "technical", question_ids: null, order: "supplied", max_followups: 2,
  voice: "default", speech_speed: 1, strictness: "balanced", feedback_mode: "at_end", question_audio: "auto", mic_enabled: false,
};
const load = (): InterviewConfig => { try { const { title: _t, feedback_mode: _f, include_bank: _b, mix: _m, ...saved } = JSON.parse(localStorage.getItem(KEY) || "{}"); return { ...DEFAULTS, ...saved, question_ids: null }; } catch { return DEFAULTS; } };
// the resume part of the setup (settings + reviewed questions) survives a page refresh within this tab
const DRAFT_KEY = "lai.setup.resume";
interface ResumeDraft { source: Source; gen: GenSettings; questions: DraftQuestion[]; mix: MixOrder; saveToBank: boolean }
const loadDraft = (): Partial<ResumeDraft> => { try { return JSON.parse(sessionStorage.getItem(DRAFT_KEY) || "{}"); } catch { return {}; } };
const SOURCE_LABEL: Record<Source, string> = { bank: "Question bank", resume: "Resume", both: "Both" };   // the title is never remembered: each interview gets its own
const takePreselect = (): { setId: number; ids: number[]; label?: string; skipped?: { topic: string; untagged: boolean }[] } | null => { try { const v = localStorage.getItem("lai.preselect"); localStorage.removeItem("lai.preselect"); return v ? JSON.parse(v) : null; } catch { return null; } };
const TYPES = { technical: "Technical", hr: "HR", scenario: "Scenario-based", mixed: "Mixed" } as const;
const STRICT_DESC = { lenient: "Credits partial understanding", balanced: "Fair, like a real interviewer", strict: "Expects precision and depth" } as const;

/** Short names; when two voices share one (macOS has en-US and en-GB "Eddy"), the region is added: "Eddy · UK". */
function labelVoices(voices: SystemVoice[]) {
  const short = voices.map((v) => shortVoiceName(v.name));
  return voices.map((v, i) => {
    const clash = short.filter((s) => s === short[i]).length > 1;
    const region = v.lang.split(/[-_]/)[1]?.toUpperCase() ?? v.lang;
    return { id: v.id, label: clash ? `${short[i]} · ${region}` : short[i], full: `${v.name} (${v.lang})` };
  });
}

export default function Setup() {
  const toast = useToast();
  const sets = useAsync(() => api.sets(), []);
  const voices = useAsync(() => api.voices(), []);
  const health = useAsync(() => api.health(), []);
  const ai = useAsync(() => api.ai(), []);
  const hist = useAsync(() => api.interviews(), []);
  const active = (hist.data ?? []).filter(isActive);
  const [pre] = useState(takePreselect);
  const [resumeIntent] = useState(() => takeIntent(["resume-practice"]));
  const [draft0] = useState(loadDraft);
  const resumes = useAsync(() => resumesApi.list(), []);
  const ready = (resumes.data ?? []).filter((r) => r.status === "ready");
  const [source, setSource] = useState<Source>(resumeIntent ? "resume" : pre ? "bank" : draft0.source ?? "bank");
  const [gen, setGen] = useState<GenSettings>(() => ({ resume_ids: [], count: 8, focus: DEFAULT_FOCUS, depth: "standard", difficulty: "mixed", style: "manager", ...draft0.gen,
    ...(resumeIntent ? { resume_ids: resumeIntent.resumeIds } : {}) }));
  const [rqs, setRqs] = useState<DraftQuestion[]>(resumeIntent ? [] : draft0.questions ?? []);
  const [mix, setMix] = useState<MixOrder>(draft0.mix ?? "interleave");
  const [saveToBank, setSaveToBank] = useState(!!draft0.saveToBank);
  useEffect(() => { try { sessionStorage.setItem(DRAFT_KEY, JSON.stringify({ source, gen, questions: rqs, mix, saveToBank })); } catch { /* ignore */ } }, [source, gen, rqs, mix, saveToBank]);
  useEffect(() => {      // drop resumes that are gone or not ready; with one ready resume and nothing chosen, choose it
    if (!resumes.data) return;
    const ok = gen.resume_ids.filter((id) => ready.some((r) => r.id === id));
    if (ok.length !== gen.resume_ids.length || (!ok.length && ready.length === 1)) setGen((g) => ({ ...g, resume_ids: ok.length ? ok : ready.length === 1 ? [ready[0].id] : [] }));
    if (!ready.length && source !== "bank") setSource("bank");
  }, [resumes.data]); // eslint-disable-line react-hooks/exhaustive-deps
  const [setId, setSetId] = useState<number | null>(pre?.setId ?? null);
  const [cfg, setCfg] = useState<InterviewConfig>(load);
  const [selected, setSelected] = useState<Set<number>>(new Set(pre?.ids ?? []));
  const [mode, setMode] = useState<"all" | "selected">(pre ? "selected" : "all");
  const [showPre, setShowPre] = useState(true);
  const [qsearch, setQsearch] = useState("");
  const [vsearch, setVsearch] = useState("");
  const [busy, setBusy] = useState(false);
  const speech = useSpeaker();
  const isSystem = voices.data?.engine === "system";            // no Phonon here: use this computer's offline voices
  const sysVoices = useSystemVoices(isSystem);
  const vgrid = useRef<HTMLDivElement>(null);
  const qs = useAsync(() => (setId ? api.questions(setId) : Promise.resolve([] as Question[])), [setId]);
  const questions = qs.data ?? [];

  useEffect(() => { if (sets.data && setId == null) setSetId(sets.data[0]?.id ?? null); }, [sets.data, setId]);
  useEffect(() => { if (!pre) setSelected(new Set(questions.map((q) => q.id))); }, [qs.data]); // eslint-disable-line react-hooks/exhaustive-deps
  const voiceItems = useMemo<{ id: string; label: string; full: string }[]>(() => isSystem
    ? [{ id: "default", label: "System default", full: "System default voice" }, ...labelVoices(sysVoices ?? [])]
    : (voices.data?.voices ?? []).map((v) => ({ id: v, label: v, full: v })), [isSystem, sysVoices, voices.data]);
  useEffect(() => {
    if (!voices.data || (isSystem && sysVoices === null)) return;      // wait until the voice list is known
    let saved = false; try { saved = !!localStorage.getItem(KEY); } catch { /* ignore */ }
    const ids = voiceItems.map((v) => v.id);
    if (!ids.includes(cfg.voice)) setCfg((c) => ({ ...c, voice: voices.data!.default }));
    else if (!saved && !isSystem && cfg.voice === "default" && ids.includes("Hadley")) setCfg((c) => ({ ...c, voice: "Hadley" }));   // storyboard default voice
  }, [voices.data, sysVoices]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {   // bring the chosen voice into view inside the scrollable grid
    const g = vgrid.current; const el = g?.querySelector<HTMLElement>("[aria-checked=true]");
    if (g && el && !vsearch) g.scrollTop = Math.max(0, el.offsetTop - g.offsetTop - 8);
  }, [voices.data, sysVoices, cfg.voice === "" ]); // eslint-disable-line react-hooks/exhaustive-deps
  const titleTouched = useRef(false);
  const set = <K extends keyof InterviewConfig>(k: K, v: InterviewConfig[K]) => { if (k === "title") titleTouched.current = true; setCfg((c) => ({ ...c, [k]: v })); };
  useEffect(() => { const n = hist.data?.length; if (n !== undefined && !titleTouched.current) setCfg((c) => ({ ...c, title: `Practice Interview - ${n + 1}` })); }, [hist.data]);

  const chosen = useMemo(() => questions.filter((q) => selected.has(q.id)), [questions, selected]);
  const bankCount = mode === "all" ? questions.length : chosen.length;
  const goodRqs = rqs.filter(validQuestion);
  const counts = sessionCounts(source, bankCount, goodRqs.length);
  const count = counts.total;
  const cloud = health.data?.ai.mode === "cloud";
  const llmReady = cloud ? !!health.data?.ai.ready : !!health.data?.ollama.ok && !!health.data.llm.installed;
  const budgetToday = health.data?.ai.budget?.today;
  const estCost = cloud && ai.data ? estimateInterviewCost(ai.data.config, count, cfg.max_followups) : undefined;
  const estMin = interviewMinutes(count, cfg.max_followups);
  const voiceList = (voices.data ? voiceItems : [{ id: cfg.voice, label: cfg.voice, full: cfg.voice }]).filter((v) => v.full.toLowerCase().includes(vsearch.trim().toLowerCase()));
  const voiceLabel = voiceItems.find((v) => v.id === cfg.voice)?.label ?? cfg.voice;
  const shownQs = questions.filter((q) => `${q.text} ${q.topic ?? ""}`.toLowerCase().includes(qsearch.trim().toLowerCase()));

  const previewVoice = (v: string) => {
    if (speech.key === `vp-${v}` && speech.status !== "idle") { speaker.stop(); return; }
    speaker.setRate(cfg.speech_speed);
    void speaker.play(`vp-${v}`, "Hello! I'll be your interviewer today. Let's begin with the first question.", v);
  };

  const useBank = source !== "resume";
  const canStart = !busy && count > 0 && active.length === 0 && (!useBank || !!setId) && (source === "bank" || goodRqs.length > 0);
  const start = async () => {
    if (!canStart) return;
    setBusy(true);
    try {
      try { localStorage.setItem(KEY, JSON.stringify({ ...cfg, title: undefined })); localStorage.setItem("lai.voice", cfg.voice); } catch { /* ignore */ }
      const resumeQs = source === "bank" ? [] : goodRqs.map(toInput);
      if (resumeQs.length && saveToBank) {
        try { const r = await resumesApi.saveToBank(resumeQs); if (r.added) toast("ok", `Saved ${r.added} question${r.added === 1 ? "" : "s"} to “${r.sets[0]?.name}”`); }
        catch (e) { toast("error", `Could not save to the question bank: ${(e as Error).message}`); }
      }
      const st = await api.createInterview(useBank ? setId : null, { ...cfg, question_ids: mode === "all" ? null : chosen.map((q) => q.id), include_bank: useBank,
        mix: source === "both" ? mix : "bank_first" }, resumeQs);
      try { sessionStorage.removeItem(DRAFT_KEY); } catch { /* ignore */ }
      window.location.hash = `#/interview/${st.id}`;
    } catch (e) { toast("error", (e as Error).message); setBusy(false); hist.reload(); }
  };

  const summary: [string, string, string][] = [
    ["briefcase", "Type", TYPES[cfg.interview_type]],
    ["list", "Questions", source === "bank" ? `${count} · ${cfg.order === "shuffled" ? "Shuffled" : "In order"}` : `${count} in total`],
    ...(source !== "bank" ? [["doc", "From question bank", source === "both" ? String(counts.bank) : "—"] as [string, string, string], ["file", "From resume", String(counts.resume)] as [string, string, string]] : []),
    ...(source === "both" ? [["shuffle", "Order", MIX_LABEL[mix]] as [string, string, string]] : []),
    ["msg", "Follow-ups", cfg.max_followups === 0 ? "None" : `Up to ${cfg.max_followups} each`],
    ["voice", "Voice", `${voiceLabel} · ${cfg.speech_speed}×`],
    ["target", "Strictness", cfg.strictness.charAt(0).toUpperCase() + cfg.strictness.slice(1)],
    ["cpu", "AI engine", cloud ? `Ollama Cloud` : "This computer"],
    ["eye", "Scores", "In the final report"],
  ];

  return (
    <div>
      <div className="pagehead">
        <div><h1>Start New Interview</h1><div className="muted">Configure your interview session</div></div>
      </div>
      <ActiveInterviews rows={active} onChanged={hist.reload} />
      {health.data && !llmReady && (
        <div className="notice error"><b>{cloud ? "Ollama cloud isn’t ready." : "The interview model isn’t ready."}</b> {cloud ? "Add your API key in Settings → AI models." : (health.data.ollama.error ?? health.data.llm.error)} You can still start, but answers can’t be evaluated until this is fixed.{" "}
          <button className="linkbtn" onClick={() => openSettings("ai")}>{cloud ? "Open AI settings" : "Use Ollama cloud instead"}</button></div>
      )}
      <ErrorNotice error={sets.error || qs.error} />
      {pre && showPre && (
        <div className="notice info row between" role="status">
          <span><b>Practicing {pre.label ?? "your selection"}</b> — {pre.ids.length} question{pre.ids.length === 1 ? "" : "s"} preselected in step 2 below.
            {pre.skipped && pre.skipped.length > 0 && <span className="muted"> Left out because you have no questions for {describeTopics(pre.skipped)} yet.</span>}</span>
          <button className="btn" onClick={() => { setMode("all"); setSelected(new Set(questions.map((q) => q.id))); setShowPre(false); }}>Use all questions instead</button>
        </div>
      )}

      <div className="setup-grid">
        <div className="setup-wrap"><div className="setup-main">
          <div className="setup-col">
          <Section step={1} icon="sparkle" title="Basics" desc="Name your session and choose the kind of interview">
            <div className="fld"><div className="lbl"><label htmlFor="title">Interview title</label></div>
              <input id="title" type="text" value={cfg.title} maxLength={120} onChange={(e) => set("title", e.target.value)} /></div>
            <div className="fld"><div className="lbl">Interview type<small>Shapes how answers are judged</small></div>
              <OptionCards label="Interview type" value={cfg.interview_type} onChange={(v) => set("interview_type", v)} options={[
                { value: "technical", title: "Technical", desc: "Concepts, coding, design, tools", icon: "briefcase" },
                { value: "hr", title: "HR", desc: "Behaviour, motivation, teamwork", icon: "users" },
                { value: "scenario", title: "Scenario-based", desc: "Investigate and design under pressure", icon: "route" },
                { value: "mixed", title: "Mixed", desc: "Judged per question automatically", icon: "layers" },
              ]} /></div>
          </Section>

          <Section step={3} icon="voice" title="Interviewer" desc="Choose the voice and how much the interviewer probes">
            <div className="fld"><div className="lbl">Voice<small>{!voices.data ? "" : isSystem ? `${sysVoices === null ? "…" : sysVoices.length} offline voices on this computer · press ▶ to hear one` : `Phonon · ${voices.data.voices.length} voices · press ▶ to hear one`}</small></div>
              <div className="vsearch"><Icon name="search" /><input type="search" aria-label="Search voices" placeholder="Search voices…" value={vsearch} onChange={(e) => setVsearch(e.target.value)} /></div>
              <div className="vgrid" role="radiogroup" aria-label="Voice" ref={vgrid}>
                {!voices.data && !voices.error && [0, 1, 2, 3, 4, 5].map((i) => <span key={`sk${i}`} className="skel" style={{ height: 44 }} aria-hidden />)}
                {voiceList.map((v) => {
                  const playing = speech.key === `vp-${v.id}` && speech.status !== "idle";
                  return (
                    <div key={v.id} role="radio" aria-checked={cfg.voice === v.id} tabIndex={0} className={`vchip ${cfg.voice === v.id ? "on" : ""}`} onClick={() => set("voice", v.id)}
                      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); set("voice", v.id); } }}>
                      <span className="vn" title={v.full}>{v.label}</span>
                      <button className="vplay" aria-label={`Preview voice ${v.label}`} title={playing ? "Stop" : "Preview"} onClick={(e) => { e.stopPropagation(); previewVoice(v.id); }}>
                        {speech.key === `vp-${v.id}` && speech.status === "loading" ? <span className="spinner" style={{ width: 12, height: 12, borderWidth: 2 }} /> : playing ? <Stop /> : <Icon name="vol" size={15} />}</button>
                    </div>
                  );
                })}
                {voiceList.length === 0 && <div className="muted small">No voice matches “{vsearch}”.</div>}
              </div>
              {isSystem && sysVoices !== null && sysVoices.length === 0 && <div className="notice info small" style={{ marginTop: 8 }}>No offline voice was found, so questions will be shown as text only. Windows: Settings → Time &amp; language → Speech → Add voices. Linux: install <b>speech-dispatcher</b> and <b>espeak-ng</b>. Chrome’s online “Google” voices are never used.</div>}
              {voices.error && <div className="hint" style={{ color: "var(--bad)" }}>{voices.error}</div>}
              {speech.key?.startsWith("vp-") && speech.error && <div className="hint" style={{ color: "var(--bad)" }}>{speech.error}</div>}
            </div>
            <div className="grid2" style={{ alignItems: "start" }}>
              <div className="fld"><div className="lbl">Playback speed<small>{cfg.speech_speed}×</small></div>
                <Seg label="Playback speed" size="sm" value={cfg.speech_speed} onChange={(v) => { set("speech_speed", v); speaker.setRate(v); }}
                  options={[0.75, 1, 1.25, 1.5].map((v) => ({ value: v, label: `${v}×`, aria: `Speed ${v}x` }))} />
                <div className="hint">{isSystem ? "Applied by your computer’s voice." : "Phonon only speaks at 1×; the browser’s player adjusts speed."}</div></div>
              <div className="fld"><div className="lbl">Max follow-ups per question<small>{cfg.max_followups === 0 ? "off" : `up to ${cfg.max_followups}`}</small></div>
                <Seg label="Max follow-ups" size="sm" value={cfg.max_followups} onChange={(v) => set("max_followups", v)}
                  options={[0, 1, 2, 3].map((v) => ({ value: v, label: v === 0 ? "None" : String(v), aria: `Max follow-ups: ${v}` }))} />
                <div className="hint">A hard limit; follow-ups are only asked when they add value.</div></div>
            </div>
          </Section>
          </div>
          <div className="setup-col">
          <Section step={2} icon="list" title="Questions" desc="Pick what you’ll be asked and in which order">
            <div className="fld"><div className="lbl">Question source{!ready.length && <small><a href="#/resumes">{(resumes.data?.length ?? 0) ? "Your resume is still being read" : "Add a resume"}</a> to get questions about your own experience</small>}</div>
              <Seg label="Question source" value={source} onChange={setSource} options={(["bank", "resume", "both"] as const).map((v) => ({ value: v, label: SOURCE_LABEL[v], icon: v === "bank" ? "list" : v === "resume" ? "file" : "layers", disabled: v !== "bank" && !ready.length }))} /></div>
            {source !== "resume" && <>
            <div className="row between">
              <Seg label="Select questions" value={mode} onChange={setMode} options={[
                { value: "all", label: `All questions (${questions.length})` }, { value: "selected", label: `Selected (${selected.size})` }]} />
              <Seg label="Question order" value={cfg.order} onChange={(v) => set("order", v)} options={[
                { value: "supplied", label: "Supplied order", icon: "list" }, { value: "shuffled", label: "Shuffle", icon: "shuffle" }]} />
            </div>
            {(sets.data?.length ?? 0) > 1 && (
              <div className="fld"><div className="lbl"><label htmlFor="qset">Question set</label></div>
                <select id="qset" aria-label="Question set" value={setId ?? ""} onChange={(e) => setSetId(Number(e.target.value))}>
                  {(sets.data ?? []).map((s) => <option key={s.id} value={s.id}>{s.name} ({s.question_count})</option>)}</select></div>
            )}
            {questions.length === 0 && !qs.loading && <div className="notice warn">This set is empty. <a href="#/questions">Add questions</a> first.</div>}
            {mode === "selected" && questions.length > 0 && (
              <div className="qpick">
                <div className="qpick-h">
                  <div className="searchbox"><Icon name="search" /><input type="search" aria-label="Search questions" placeholder="Search questions…" value={qsearch} onChange={(e) => setQsearch(e.target.value)} /></div>
                  <button className="btn" onClick={() => setSelected(new Set(questions.map((q) => q.id)))}>All</button>
                  <button className="btn" onClick={() => setSelected(new Set())}>None</button>
                </div>
                <div className="qpick-l">
                  {shownQs.map((q) => (
                    <label key={q.id}>
                      <input type="checkbox" checked={selected.has(q.id)} onChange={(e) => { const n = new Set(selected); e.target.checked ? n.add(q.id) : n.delete(q.id); setSelected(n); }} />
                      <span className="grow"><span className="muted">{q.position + 1}.</span> {q.text.length > 150 ? q.text.slice(0, 150) + "…" : q.text}</span>
                      {q.topic && <span className={`pill-tag ${topicClass(q.topic)}`}>{q.topic}</span>}
                    </label>
                  ))}
                  {shownQs.length === 0 && <div className="muted" style={{ padding: 16 }}>No questions match.</div>}
                </div>
              </div>
            )}
            </>}
            {source !== "bank" && ready.length > 0 && <>
              {source === "both" && <hr className="rz-hr" />}
              <ResumeQuestionsPanel resumes={ready} settings={gen} onSettings={setGen} questions={rqs} onQuestions={setRqs} saveToBank={saveToBank} onSaveToBank={setSaveToBank}
                cloud={!!cloud} aiConfig={ai.data?.config ?? null} onResumesChanged={() => void resumes.reload()} />
            </>}
            {source === "both" && (
              <div className="fld"><div className="lbl">Order<small>{(() => { const seq = mixSequence(mix, counts.bank, counts.resume); return mix === "shuffled" ? "all questions mixed at random" : seq.length ? `${seq.slice(0, 10).map((x) => (x === "B" ? "bank" : "resume")).join(" · ")}${seq.length > 10 ? " …" : ""}` : ""; })()}</small></div>
                <Seg label="Order of bank and resume questions" value={mix} onChange={setMix} options={(["resume_first", "bank_first", "interleave", "shuffled"] as const).map((v) => ({ value: v, label: MIX_LABEL[v] }))} />
                <div className="hint">“Supplied order / Shuffle” above still decides the order of the bank questions among themselves.</div></div>
            )}
          </Section>

          <Section step={4} icon="target" title="Evaluation" desc="How strictly your answers are graded">
            <div className="fld"><div className="lbl">Strictness</div>
              <OptionCards label="Evaluation strictness" cols={3} value={cfg.strictness} onChange={(v) => set("strictness", v)} options={([
                ["lenient", "Lenient", "smile"], ["balanced", "Balanced", "target"], ["strict", "Strict", "bolt"]] as const).map(([value, title, ic]) => ({
                value, title, desc: STRICT_DESC[value], icon: ic === "smile" ? "check" : ic }))} /></div>
            <div className="notice info small" role="note" style={{ margin: 0 }}><b>Scores and feedback come at the end.</b> While you practice there is no score after each answer. When the interview is over you get every answer’s score, every follow-up’s score and your final score in one report.</div>
          </Section>

          <Section step={5} icon="settings" title="Experience" desc="Audio and input preferences">
            <div className="trows">
              <div className={`trow2 ${cfg.question_audio === "auto" ? "on" : ""}`}><span className="ti"><Icon name="vol" /></span>
                <div className="t"><b>Read each question aloud</b><span>Plays automatically when a question appears; otherwise use Play.</span></div>
                <Switch label="Read each question aloud automatically" checked={cfg.question_audio === "auto"} onChange={(v) => set("question_audio", v ? "auto" : "manual")} /></div>
              <div className={`trow2 ${cfg.mic_enabled ? "on" : ""}`}><span className="ti"><Icon name="mic" /></span>
                <div className="t"><b>Microphone input (speech to text)</b><span>{health.data?.stt.available ? `Transcribed offline with Whisper “${health.data.stt.model}”.` : `Unavailable — ${health.data?.stt.reason ?? "checking…"}`}</span></div>
                <Switch label="Enable microphone input" checked={cfg.mic_enabled} disabled={!health.data?.stt.available} onChange={(v) => set("mic_enabled", v)} /></div>
            </div>
          </Section>
          </div>
        </div></div>

        <aside className="summary" aria-label="Session summary">
          <div className="sum-h"><small>Session summary</small><h3>{cfg.title || "Untitled interview"}</h3></div>
          <div className="sum-b">{summary.map(([ic, k, v]) => <div className="sum-r" key={k}><span className="k"><Icon name={ic as never} />{k}</span><b>{v}</b></div>)}</div>
          <div className="sum-f">
            <div className={`ready ${llmReady ? "ok" : "bad"}`}><Icon name={llmReady ? (cloud ? "bolt" : "shield") : "alert"} />{cloud ? (llmReady ? `Cloud AI ready · ${health.data?.ai.grader_model}` : "Cloud AI not ready") : (llmReady ? "Local model ready · runs offline" : "Local model not ready")}</div>
            {cloud && llmReady && (
              <div className="notice info small" role="status" style={{ marginTop: 0 }} data-testid="cost-estimate">
                <b>Estimated cost: </b>{estCost === undefined ? "…" : estCost === null ? "unknown (a model has no price set)" : estCost === 0 ? "$0" : `up to ${fmtUsd(estCost)}`}
                <div className="muted">An upper bound for this interview. Your answers are sent to Ollama’s servers.</div>
              </div>
            )}
            {cloud && budgetToday?.reached && <div className="notice error small" role="alert" style={{ marginTop: 0 }}><b>Daily budget used up.</b> Answers will not be graded until you raise the limit in Settings → AI models or switch to the local model.</div>}
            {!cloud && llmReady && health.data?.memory?.tight && (
              <div className="notice warn small" role="status" style={{ marginTop: 0 }}>
                <b>Low free memory</b> — {health.data.memory.available_gb} GB free of {health.data.memory.total_gb} GB; the model needs about {health.data.memory.needs_gb} GB.
                Your computer may freeze for ~20 seconds while it loads. Closing browser tabs and other big apps first avoids that.
              </div>
            )}
            {active.length > 0 && <div className="notice warn small" role="status" style={{ marginTop: 0 }}><b>An interview is still active.</b> Continue or end “{active[0].title}” to start a new one.</div>}
            {count === 0 && <div className="notice warn small" role="status" style={{ marginTop: 0 }}>{source === "bank" ? "No questions selected yet." : rqs.length ? "Fix or remove the empty questions first." : "Generate and review your resume questions first."}</div>}
            <button className="btn primary big block" disabled={!canStart} onClick={start}>{busy ? "Starting…" : <>Start Interview <Icon name="arrowr" /></>}</button>
            <div className="est">{count ? <><span className="est-ic"><Icon name="clock" /></span><span><b>{count}</b> question{count === 1 ? "" : "s"} <i className="est-dot" aria-hidden="true" /> about <b>{estMin} min</b></span></> : <><span className="est-ic"><Icon name="list" /></span><span>Add questions to begin</span></>}</div>
          </div>
        </aside>
      </div>
    </div>
  );
}
