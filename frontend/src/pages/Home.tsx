import { useState } from "react";
import { api, resumesApi } from "../api";
import { TrendChart, scoreTone } from "../components/charts";
import Icon from "../components/Icon";
import { SkeletonKpis, SkeletonRows } from "../components/Skeleton";
import { ErrorNotice, fmtShort, minutesBetween, scoreClass, useAsync, useToast } from "../components/ui";
import { setIntent } from "../intent";
import { openSettings } from "../settingsTab";
import { describeTopics, missingTopics, pickPreselect, topicName, type WeakTopic } from "../practice";
import type { HistoryRow, Stats } from "../types";

export const getName = () => { try { return localStorage.getItem("lai.name") ?? ""; } catch { return ""; } };
const statusBadge: Record<string, [string, string]> = { completed: ["ok", "Completed"], in_progress: ["blue", "In Progress"], paused: ["warn", "Paused"], ended: ["", "Ended"] };

export function InterviewRow({ r, actions }: { r: HistoryRow; actions?: React.ReactNode }) {
  const [tone, label] = statusBadge[r.status] ?? ["", r.status];
  const open = r.status === "in_progress" || r.status === "paused";
  const mins = minutesBetween(r.created_at, r.completed_at);
  const Wrapper = actions ? "div" : "a";
  return (
    <Wrapper className="listrow" {...(actions ? {} : { href: open ? `#/interview/${r.id}` : `#/report/${r.id}` })}>
      <span className="lead"><Icon name="doc" /></span>
      <div className="grow">
        <b>{r.title}</b>
        <div className="muted small"><span style={{ textTransform: "capitalize" }}>{r.interview_type}</span> · {r.total} question{r.total === 1 ? "" : "s"}{mins ? ` · ${mins} min` : ""}</div>
      </div>
      <span className={`badge ${tone}`} style={{ padding: "6px 14px" }}>{label}</span>
      {r.average_score != null ? <span className={`mark scorepill ${scoreClass(r.average_score)}`}>{r.average_score}</span> : <span className="muted scorepill" style={{ minWidth: 38, textAlign: "center" }}>-</span>}
      <span className="when">{fmtShort(r.created_at)}</span>
      {actions ?? <span className="muted"><Icon name="right" /></span>}
    </Wrapper>
  );
}

const NAME_KEY = "lai.name";
const saveName = (v: string) => { try { localStorage.setItem(NAME_KEY, v); } catch { /* ignore */ } window.dispatchEvent(new Event("lai:name")); };
const WEAK_BELOW = 7;

function Kpis({ s }: { s: Stats }) {
  const has = s.average_score != null;
  const d = s.delta;
  return (
    <div className="kpis">
      <div className="kpi"><div className="k"><Icon name="target" />Average score</div>
        <div className="v">{has ? s.average_score : "–"}{has && <small> / 10</small>}</div>
        <div className="s">{d == null ? (has ? "First scored interview" : "Finish an interview to see this") : <span className={`delta ${d >= 0 ? "up" : "down"}`}>{d >= 0 ? "▲" : "▼"} {Math.abs(d)} <span className="muted">vs earlier</span></span>}</div></div>
      <div className="kpi"><div className="k"><Icon name="doc" />Interviews</div>
        <div className="v">{s.interviews}</div><div className="s">{s.this_week} in the last 7 days{s.best_score != null ? ` · best ${s.best_score}` : ""}</div></div>
      <div className="kpi"><div className="k"><Icon name="check" />Questions answered</div>
        <div className="v">{s.questions_answered}</div><div className="s">{s.completed} completed interview{s.completed === 1 ? "" : "s"}</div></div>
      <div className="kpi"><div className="k"><Icon name="flame" />Practice streak</div>
        <div className="v">{s.streak_days}<small> day{s.streak_days === 1 ? "" : "s"}</small></div><div className="s">{s.streak_days ? "Keep it going — one session a day" : "Practice today to start a streak"}</div></div>
    </div>
  );
}

function Progress({ s }: { s: Stats }) {
  const toast = useToast();
  const [missing, setMissing] = useState<WeakTopic[] | null>(null);
  const [busy, setBusy] = useState(false);
  const weak: WeakTopic[] = s.topics.filter((t) => t.average_score < WEAK_BELOW).map((t) => ({ topic: t.topic, untagged: t.untagged }));
  const targets = weak.slice(0, 3);
  const onlyUntagged = s.topics.length > 0 && s.topics.every((t) => t.untagged);

  /** Preselect the questions of these topics in the interview setup, or say exactly which topics have no questions. */
  const practice = async (topics: WeakTopic[]) => {
    setBusy(true); setMissing(null);
    try {
      const sets = await Promise.all((await api.sets()).map(async (set) => ({ setId: set.id, questions: await api.questions(set.id) })));
      const pick = pickPreselect(sets, topics);
      if (!pick) { setMissing(missingTopics(sets, topics)); return; }
      try { localStorage.setItem("lai.preselect", JSON.stringify(pick)); } catch { /* ignore */ }
      window.location.hash = "#/setup";
    } catch (e) { toast("error", (e as Error).message); } finally { setBusy(false); }
  };
  const addQuestionFor = (t: WeakTopic) => { setIntent(t.untagged ? { type: "add" } : { type: "add", topic: t.topic }); window.location.hash = "#/questions"; };
  const latest = s.trend[s.trend.length - 1];
  return (
    <>
      <Kpis s={s} />
      <div className="dash2">
        <div className="card">
          <div className="card-h"><h3>Score trend</h3><span className="muted small">{s.trend.length ? `last ${s.trend.length} interview${s.trend.length === 1 ? "" : "s"}` : ""}</span></div>
          {s.trend.length ? (
            <div style={{ margin: "auto 0" }}>
              <TrendChart points={s.trend} />
              <div className="muted small" style={{ marginTop: 10 }}>Latest <b className={scoreTone(latest.score)}>{latest.score}</b> · best <b>{Math.max(...s.trend.map((p) => p.score))}</b> · click a point to open its report</div>
            </div>
          ) : <div className="nodata"><div className="ei"><Icon name="trend" /></div>Your score history appears here after your first scored interview.</div>}
        </div>
        <div className="card">
          <div className="card-h"><h3>Focus areas</h3><span className="muted small">weakest topics first</span></div>
          {s.topics.length ? (
            <>
              {s.topics.slice(0, 4).map((t) => {
                const wt: WeakTopic = { topic: t.topic, untagged: t.untagged };
                return (
                  <div className="focus-row" key={t.topic}>
                    <span className="nm" title={t.untagged ? "These questions have no topic yet" : t.topic}>{t.untagged ? <i>No topic set</i> : t.topic}</span><b className={scoreTone(t.average_score)}>{t.average_score}</b>
                    <span className="track"><i className={scoreTone(t.average_score)} style={{ width: `${t.average_score * 10}%` }} /></span>
                    <small>{t.questions} answered question{t.questions === 1 ? "" : "s"}{t.untagged ? " · give them a topic for a real breakdown" : ""}</small>
                    <button className="btn ghost focus-go" disabled={busy} onClick={() => void practice([wt])} aria-label={`Practice ${topicName(wt)}`}>Practice</button>
                  </div>
                );
              })}
              {onlyUntagged && <div className="notice info small" style={{ margin: "4px 0 8px" }}>None of your questions has a topic yet. Add one to each (for example Python, System design, Networking…) and this card will show <b>where</b> you are weakest. <a href="#/questions">Open the Question Bank</a></div>}
              <div className="focus-cta">
                {weak.length ? (
                  <>
                    <button className="btn primary block" disabled={busy} onClick={() => void practice(targets)}><Icon name="target" />{targets.length === 1 ? `Practice ${topicName(targets[0])}` : "Practice my weakest topics"}</button>
                    <div className="muted small focus-note">Will preselect your {describeTopics(targets)}{weak.length > targets.length ? ` (the ${targets.length} weakest of ${weak.length})` : ""} in the interview setup.</div>
                  </>
                ) : <div className="notice ok" style={{ margin: 0 }}>Every topic is at {WEAK_BELOW}+ — nice. Add harder questions to keep growing.</div>}
                {missing && (
                  <div className="notice warn small" role="alert" style={{ marginBottom: 0 }}>
                    <b>Nothing to practice yet.</b> Your Question Bank has no {describeTopics(missing)}. {missing.some((m) => !m.untagged) ? "Add a question with that topic and try again." : "Add a question first."}
                    <div className="row" style={{ marginTop: 8 }}>{missing.slice(0, 2).map((m) => <button key={m.topic} className="btn" onClick={() => addQuestionFor(m)}><Icon name="plus" />Add {m.untagged ? "a question" : `a “${m.topic}” question`}</button>)}</div>
                  </div>
                )}
              </div>
            </>
          ) : <div className="nodata"><div className="ei"><Icon name="target" /></div>Topics you should revisit show up here. Give your questions a topic to get a breakdown.</div>}
        </div>
      </div>
    </>
  );
}

export default function Home() {
  const sets = useAsync(() => api.sets(), []);
  const hist = useAsync(() => api.interviews(), []);
  const health = useAsync(() => api.health(), []);
  const stats = useAsync(() => api.stats(), []);
  const resumes = useAsync(() => resumesApi.cachedList(), []);
  const readyResume = (resumes.data ?? []).find((r) => r.status === "ready");
  const [name, setName] = useState(getName());
  const [draft, setDraft] = useState("");
  const [skipped, setSkipped] = useState(() => { try { return localStorage.getItem("lai.name.skip") === "1"; } catch { return false; } });
  const total = (sets.data ?? []).reduce((n, s) => n + s.question_count, 0);
  const recent = (hist.data ?? []).slice(0, 5);
  const h = health.data;
  const cloud = h?.ai.mode === "cloud";
  const localProblem = !!h && !cloud && (!h.ollama.ok || !h.llm.installed);
  const problem = h && (cloud ? (!h.ai.ready ? "Ollama cloud is not set up yet: add your API key in Settings → AI models." : h.tts.error)
    : (!h.ollama.ok ? h.ollama.error : !h.llm.installed ? h.llm.error : h.tts.error));
  const commit = () => { const v = draft.trim(); if (v) { saveName(v); setName(v); } };
  const skip = () => { try { localStorage.setItem("lai.name.skip", "1"); } catch { /* ignore */ } setSkipped(true); };

  return (
    <div>
      <div className="pagehead" style={{ marginBottom: 6 }}>
        <span />
        {name && <div className="userchip"><i>{name.charAt(0).toUpperCase()}</i>{name}</div>}
      </div>
      <h1 className="hello">{name ? `${name}’s practice` : "Your practice"}</h1>
      <div className="tagline">Mock interviews for any role in tech, scored when you finish</div>
      {!name && !skipped && (
        <form className="welcome" onSubmit={(e) => { e.preventDefault(); commit(); }}>
          <div className="t">What should we call you?<span>Only stored in this browser. You can change it later in Settings.</span></div>
          <input type="text" aria-label="Your name" maxLength={40} placeholder="Your name" value={draft} onChange={(e) => setDraft(e.target.value)} />
          <button className="btn primary" type="submit" disabled={!draft.trim()}>Save</button>
          <button className="btn ghost" type="button" onClick={skip}>Not now</button>
        </form>
      )}
      {h && <button className="engine-chip" onClick={() => openSettings("ai")} aria-label="Change the AI engine in Settings">
        <Icon name={cloud ? "bolt" : "shield"} />AI engine: <b>{cloud ? `Ollama Cloud · ${h.ai.grader_model}` : `On this computer · ${h.llm.model}`}</b><span className="muted">Change</span></button>}
      {problem && <div className="notice error" style={{ marginTop: 14 }}><b>Setup needed:</b> {problem}{" "}
        {(cloud || localProblem) && <button className="linkbtn" onClick={() => openSettings("ai")}>{cloud ? "Open AI settings" : "Use Ollama cloud instead"}</button>}</div>}
      <ErrorNotice error={sets.error || hist.error} />

      <div className="cards3">
        <a className="tile" href="#/questions"><div className="ico"><Icon name="doc" size={26} /></div><div><b>Question Bank</b><span className="sub">{total} Question{total === 1 ? "" : "s"}<br />Create and manage your questions</span></div></a>
        <a className="tile" href="#/setup"><div className="ico"><Icon name="mic" size={26} /></div><div><b>Start Interview</b><span className="sub">{total ? "Ready to practice?" : "Add questions first"}<br />Configure and begin</span></div></a>
        <a className="tile" href="#/reports"><div className="ico"><Icon name="chart" size={26} /></div><div><b>View Reports</b><span className="sub">Track your progress<br />See detailed analytics</span></div></a>
        {readyResume
          ? <a className="tile" href="#/setup" data-testid="resume-tile" onClick={() => setIntent({ type: "resume-practice", resumeIds: [readyResume.id] })}><div className="ico"><Icon name="file" size={26} /></div><div><b>Interview from resume</b><span className="sub">Questions about {readyResume.name}<br />Defend what you wrote</span></div></a>
          : <a className="tile" href="#/resumes" data-testid="resume-tile"><div className="ico"><Icon name="file" size={26} /></div><div><b>Interview from resume</b><span className="sub">{(resumes.data?.length ?? 0) > 0 ? "Your resume is still being read" : "Upload a resume to get questions about your own experience"}</span></div></a>}
      </div>

      <div className="sect-title" style={{ marginTop: 4 }}><h2>Your progress</h2><span className="muted">updates after every interview</span></div>
      {stats.loading && !stats.data ? <SkeletonKpis /> : stats.data ? <Progress s={stats.data} /> : null}

      <div className="sect-title"><h2>Recent Interviews</h2>{(hist.data?.length ?? 0) > 5 && <a href="#/history" className="small">View all</a>}</div>
      {hist.loading && !hist.data && <SkeletonRows n={2} />}
      {recent.length === 0 && !hist.loading && <div className="card muted">No interviews yet. <a href="#/setup">Start your first one</a>.</div>}
      <div className="rowgrid">{recent.map((r) => <InterviewRow key={r.id} r={r} />)}</div>
    </div>
  );
}
