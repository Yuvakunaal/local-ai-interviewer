import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import Icon from "../components/Icon";
import { CardsSkeleton, RefreshButton } from "../components/Loaders";
import { Confirm, ErrorNotice, Seg, useAsync, useToast } from "../components/ui";
import type { UsageCall } from "../types";
import { fmtUsd } from "../aiHelpers";
import { openSettings } from "../settingsTab";
import { NO_TOKENS, TASK, fmtNum, fmtSecs, fmtUnload, headline, percent, splitWidths, sum, taskLabel, when } from "./usageFormat";

const RANGE_KEY = "lai.usage.range";
const PROVIDER_KEY = "lai.usage.provider";
type Provider = "all" | "local" | "cloud";
const readProvider = (): Provider => { try { const v = localStorage.getItem(PROVIDER_KEY); return v === "local" || v === "cloud" ? v : "all"; } catch { return "all"; } };
const readRange = (): "today" | "all" => { try { return localStorage.getItem(RANGE_KEY) === "all" ? "all" : "today"; } catch { return "today"; } };

const Split = ({ load, read, write, total }: { load: number; read: number; write: number; total: number }) => {
  const w = splitWidths(load, read, write, total);
  return (
    <span className="split" role="img" aria-label={`Loading ${fmtSecs(load)}, reading ${fmtSecs(read)}, writing ${fmtSecs(write)}`}>
      <i className="ld" style={{ width: `${w.load}%` }} /><i className="rd" style={{ width: `${w.read}%` }} /><i className="wr" style={{ width: `${w.write}%` }} />
    </span>
  );
};

function callTarget(r: UsageCall) {
  if (!r.interview_id) return null;
  if (r.has_report) return `#/report/${r.interview_id}`;
  return r.interview_status === "in_progress" || r.interview_status === "paused" ? `#/interview/${r.interview_id}` : null;
}

/** What each local model reads, writes and how long it takes: tokens, time (and where it goes), speed, model loads, memory. */
export default function UsagePage() {
  const toast = useToast();
  const [range, setRange] = useState<"today" | "all">(readRange);
  const [provider, setProvider] = useState<Provider>(readProvider);
  const usage = useAsync(() => api.usage(range, provider), [range, provider]);
  const force = useRef(false);
  const health = useAsync(() => { const f = force.current; force.current = false; return api.health(f); }, []);
  const refresh = async () => { force.current = true; await Promise.all([usage.reload(), health.reload()]); };
  const [confirm, setConfirm] = useState(false);
  useEffect(() => { const t = setInterval(() => { if (!document.hidden) { void usage.reload(); void health.reload(); } }, 5000); return () => clearInterval(t); }, []); // eslint-disable-line react-hooks/exhaustive-deps   // live numbers, but not while the tab is hidden
  const pick = (r: "today" | "all") => { setRange(r); try { localStorage.setItem(RANGE_KEY, r); } catch { /* ignore */ } };
  const pickProvider = (p: Provider) => { setProvider(p); try { localStorage.setItem(PROVIDER_KEY, p); } catch { /* ignore */ } };

  const u = usage.data;
  const rows = u?.summary ?? [];
  const h = headline(rows);
  const totalSeconds = sum(rows.map((r) => r.total_seconds));
  const textRows = rows.filter((r) => !NO_TOKENS.has(r.purpose));
  const maxTokens = Math.max(1, ...textRows.flatMap((r) => [r.prompt_tokens, r.output_tokens]));
  const bothEngines = new Set(rows.map((r) => r.provider)).size > 1;
  const lbl = (r: { purpose: string; provider: string }) => (bothEngines ? `${taskLabel(r.purpose)} · ${r.provider === "cloud" ? "cloud" : "local"}` : taskLabel(r.purpose));
  const mem = health.data?.memory;
  const modelLoaded = !!health.data?.llm.loaded;
  const emptyToday = !!u && range === "today" && rows.length === 0 && u.totals.all_time.calls > 0;

  return (
    <div>
      <div className="pagehead">
        <div><h1>Model usage</h1><div className="muted">What each AI model reads and writes, how long it takes, where that time goes and, for cloud models, what it costs. Only numbers are saved — your questions and answers never are.</div></div>
        <div className="row">
          <Seg label="Time range" size="sm" value={range} onChange={pick} options={[{ value: "today", label: "Today" }, { value: "all", label: "All time" }]} />
          <Seg label="Which AI" size="sm" value={provider} onChange={pickProvider} options={[{ value: "all", label: "All" }, { value: "local", label: "This computer" }, { value: "cloud", label: "Cloud", icon: "cloud", aria: "Cloud models only" }]} />
          <RefreshButton onRefresh={refresh} />
          <button className="btn danger" disabled={!u?.totals.all_time.calls} onClick={() => setConfirm(true)}><Icon name="trash" />Clear history</button>
        </div>
      </div>
      <ErrorNotice error={usage.error} />
      {!u && usage.loading && !usage.error && <CardsSkeleton n={3} label="Loading model usage…" />}

      <div className="usage-grid2">
        <div className="card">
          <div className="card-h"><h3>In memory right now</h3><span className="muted small">same as <span className="mono">ollama ps</span></span></div>
          {u && u.loaded.length === 0 && <div className="muted">No model is loaded. The interview model loads a few seconds into an interview and is freed when you finish.</div>}
          {u?.loaded.map((m) => (
            <div className="listrow" key={m.model} style={{ marginBottom: 8 }}>
              <span className="lead"><Icon name="cpu" /></span>
              <div className="grow"><b>{m.model}</b><div className="muted small">{m.size_gb} GB{m.gpu_percent != null ? ` · ${m.gpu_percent}% on the GPU` : ""}{m.context ? ` · context window ${m.context.toLocaleString()} tokens` : ""}</div></div>
              <span className="badge">{fmtUnload(m.unloads_in_seconds)}</span>
            </div>
          ))}
        </div>
        <div className="card">
          <div className="card-h"><h3>Computer memory</h3><span className="muted small">{mem ? `${percent(mem.total_gb - mem.available_gb, mem.total_gb)}% in use` : "right now"}</span></div>
          {mem ? (
            <>
              <div className="big-num">{mem.available_gb} GB <small>free of {mem.total_gb} GB</small></div>
              <div className="meter" role="img" aria-label={`${mem.available_gb} GB free of ${mem.total_gb} GB`}><i className={modelLoaded ? "info" : mem.tight ? "low" : "good"} style={{ width: `${100 - percent(mem.available_gb, mem.total_gb)}%` }} /></div>
              <div className="small" style={{ marginTop: 8 }}>{modelLoaded
                ? <span><b>The model is loaded</b> and is using about {mem.needs_gb} GB of this, so less is free while you practice. That is normal; it is released when you finish.</span>
                : mem.tight
                  ? <span className="mid"><b>Tight.</b> The model needs about {mem.needs_gb} GB but only {mem.available_gb} GB is free; loading it may slow your computer for a moment. Close other apps first.</span>
                  : <span className="good"><b>Enough</b> room for the model (it needs about {mem.needs_gb} GB).</span>}</div>
            </>
          ) : <div className="muted">Memory information is not available on this system.</div>}
        </div>
      </div>

      {emptyToday && <div className="notice info row between" style={{ marginTop: 14 }}><span>Nothing recorded today yet.</span><button className="btn" onClick={() => pick("all")}>Show all time</button></div>}

      {u && !emptyToday && rows.length === 0 && (
        <div className="card nodata" style={{ marginTop: 16 }}><div className="ei"><Icon name="cpu" /></div>Nothing recorded yet. Numbers appear here after your first graded answer.</div>
      )}

      {rows.length > 0 && (
        <>
          <div className="kpis" style={{ marginTop: 16, gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))" }}>
            <div className="kpi"><div className="k"><Icon name="doc" />Tokens read</div><div className="v">{fmtNum(h.read)}</div><div className="s">the prompts the models were given</div></div>
            <div className="kpi"><div className="k"><Icon name="pencil" />Tokens written</div><div className="v">{fmtNum(h.written)}</div><div className="s">what the models produced</div></div>
            <div className="kpi"><div className="k"><Icon name="timer" />Model time</div><div className="v">{fmtSecs(h.seconds)}</div><div className="s">{h.calls} call{h.calls === 1 ? "" : "s"}{h.loads ? ` · ${h.loads} model load${h.loads === 1 ? "" : "s"}` : ""}</div></div>
            <div className="kpi"><div className="k"><Icon name="bolt" />Writing speed</div><div className="v">{h.speed ?? "–"}<small> tok/s</small></div><div className="s">tokens written per second</div></div>
            {h.cloudCalls > 0 && <div className="kpi" data-testid="cost-kpi"><div className="k"><Icon name="chart" />Estimated cloud cost</div><div className="v">{fmtUsd(h.cost)}</div>
              <div className="s">{h.cloudCalls} cloud call{h.cloudCalls === 1 ? "" : "s"}{h.unpriced ? ` · ${h.unpriced} with no price set (cost unknown)` : ""}</div></div>}
          </div>

          {(u?.mode === "cloud" || h.cloudCalls > 0) && u && (
            <div className="card" style={{ marginTop: 16 }} data-testid="spend-card">
              <div className="card-h"><h3>Cloud spending</h3><span className="muted small">estimates from your price list · <a href="#/settings" onClick={() => openSettings("ai")}>change limits and prices</a></span></div>
              <div className="spend-grid">
                {([["Today", u.budget.today], ["All time", u.budget.total]] as const).map(([label, b]) => (
                  <div key={label} className="spend">
                    <div className="row between"><span className="muted small">{label}</span><b>{fmtUsd(b.spent_usd)}{b.limit_usd != null ? ` of ${fmtUsd(b.limit_usd)}` : " (no limit)"}</b></div>
                    {b.percent != null && <div className="meter" role="img" aria-label={`${label}: ${b.percent}% of the limit`}><i className={b.percent >= 80 ? "low" : "good"} style={{ width: `${b.percent}%` }} /></div>}
                    {b.reached && <div className="small bad-text">Limit reached{u.budget.enforced ? ": cloud calls are paused." : " (not enforced)."}</div>}
                  </div>
                ))}
              </div>
              <div className="muted small" style={{ marginTop: 10 }}>{u.prices_note}</div>
            </div>
          )}

          <div className="usage-grid2" style={{ marginTop: 16 }}>
            <div className="card">
              <div className="card-h"><h3>Where the time goes</h3><span className="muted small">share of model time by task</span></div>
              <div className="stack-bar" role="img" aria-label="Share of model time by task">{rows.map((r) => <i key={`${r.provider}/${r.model}/${r.purpose}`} className={`tk-${r.purpose}`} style={{ width: `${percent(r.total_seconds, totalSeconds)}%` }} title={`${lbl(r)}: ${fmtSecs(r.total_seconds)}`} />)}</div>
              <div className="legend">{rows.map((r) => (
                <div key={`${r.provider}/${r.model}/${r.purpose}`} className="lg"><span className={`sw tk-${r.purpose}`} /><span className="grow">{lbl(r)}</span><b>{fmtSecs(r.total_seconds)}</b><span className="muted">{percent(r.total_seconds, totalSeconds)}%</span></div>
              ))}</div>
            </div>
            <div className="card">
              <div className="card-h"><h3>Tokens by task</h3><span className="muted small">read vs written</span></div>
              {textRows.map((r) => (
                <div key={`${r.provider}/${r.model}/${r.purpose}`} className="tokrow">
                  <div className="tn">{lbl(r)}</div>
                  <div className="meter"><i className="rdbar" style={{ width: `${(r.prompt_tokens / maxTokens) * 100}%` }} /></div><span className="tv">{fmtNum(r.prompt_tokens)} read</span>
                  <div className="meter"><i className="wrbar" style={{ width: `${(r.output_tokens / maxTokens) * 100}%` }} /></div><span className="tv">{fmtNum(r.output_tokens)} written</span>
                </div>
              ))}
            </div>
          </div>

          <div className="card" style={{ marginTop: 16 }}>
            <h2>By task</h2>
            <div className="tscroll"><table className="usage-tbl">
              <thead><tr><th>Task</th><th className="num">Calls</th><th className="num">Tokens read</th><th className="num">Tokens written</th><th className="num">Cost</th><th className="num">Average</th><th className="num">Fastest – slowest</th><th className="num">Speed</th><th>Where the time goes</th><th className="num">Model loads</th></tr></thead>
              <tbody>{rows.map((s) => (
                <tr key={`${s.provider}/${s.model}/${s.purpose}`}>
                  <td className="taskcol"><b title={TASK[s.purpose]?.hint}>{taskLabel(s.purpose)}</b><div className="muted small"><span className={`badge ${s.provider === "cloud" ? "accent" : ""}`}>{s.provider === "cloud" ? "Cloud" : "This computer"}</span> {s.model}</div></td>
                  <td className="num">{s.calls}</td>
                  <td className="num">{NO_TOKENS.has(s.purpose) ? "–" : fmtNum(s.prompt_tokens)}</td><td className="num">{NO_TOKENS.has(s.purpose) ? "–" : fmtNum(s.output_tokens)}</td>
                  <td className="num">{s.provider === "cloud" ? (s.unpriced_calls ? <span title="No price set for this model">unknown</span> : fmtUsd(s.cost_usd)) : "free"}</td>
                  <td className="num">{fmtSecs(s.avg_seconds)}</td><td className="num">{s.calls > 1 ? `${fmtSecs(s.fastest_seconds)} – ${fmtSecs(s.slowest_seconds)}` : "–"}</td>
                  <td className="num">{s.tokens_per_second != null ? `${s.tokens_per_second} tok/s` : "–"}</td>
                  <td>{s.purpose === "speech" ? <span className="muted">–</span> : (
                    <><Split load={s.avg_load_seconds} read={s.avg_read_seconds} write={s.avg_write_seconds} total={s.avg_seconds} />
                      <div className="muted small">{s.purpose === "warm" ? `load ${fmtSecs(s.avg_load_seconds)}` : `load ${fmtSecs(s.avg_load_seconds)} · read ${fmtSecs(s.avg_read_seconds)} · write ${fmtSecs(s.avg_write_seconds)}`}</div></>)}</td>
                  <td className="num">{s.model_loads ? <span className="badge warn">{s.model_loads}</span> : "0"}</td>
                </tr>))}</tbody>
            </table></div>
          </div>
        </>
      )}

      {u && u.recent.length > 0 && (
        <div className="card" style={{ marginTop: 16 }}>
          <h2>Latest calls</h2>
          <div className="tscroll"><table className="usage-tbl">
            <thead><tr><th>When</th><th>For</th><th>Task</th><th className="num">Read → written</th><th className="num">Cost</th><th className="num">Time</th><th className="num">Speed</th></tr></thead>
            <tbody>{u.recent.map((r) => {
              const href = callTarget(r);
              const name = r.interview_title ?? (r.interview_id ? "Deleted interview" : null);
              return (
                <tr key={r.id}>
                  <td className="nowrap">{when(r.at)}</td>
                  <td>{name ? <>{href ? <a href={href}>{name}</a> : name}{r.label && <span className="badge" style={{ marginLeft: 8 }}>{r.label}</span>}</> : <span className="muted">{r.purpose === "speech" ? "Question audio" : r.label && r.purpose.startsWith("resume") ? <a href="#/resumes">{r.label}</a> : "–"}</span>}</td>
                  <td><b>{taskLabel(r.purpose)}</b>{r.provider === "cloud" && <span className="badge accent" style={{ marginLeft: 8 }}><Icon name="cloud" />{r.model}</span>}{r.load_seconds >= 1 && <span className="badge warn" style={{ marginLeft: 8 }} title="The model had to be loaded into memory for this call. This is when a computer with little free memory can freeze.">model load {fmtSecs(r.load_seconds)}</span>}{r.detail && <div className="muted small">{r.detail}</div>}</td>
                  <td className="num">{r.prompt_tokens == null ? "–" : `${fmtNum(r.prompt_tokens)} → ${fmtNum(r.output_tokens)}`}</td>
                  <td className="num">{r.provider === "cloud" ? (r.cost_usd == null ? "unknown" : fmtUsd(r.cost_usd)) : "free"}</td>
                  <td className="num"><b>{fmtSecs(r.seconds)}</b>{(r.read_seconds > 0 || r.write_seconds > 0) && <div className="muted small">read {fmtSecs(r.read_seconds)} · write {fmtSecs(r.write_seconds)}</div>}</td>
                  <td className="num">{r.tokens_per_second != null ? `${r.tokens_per_second} tok/s` : "–"}</td>
                </tr>
              );
            })}</tbody>
          </table></div>
        </div>
      )}

      <details className="card" style={{ marginTop: 16 }}>
        <summary style={{ cursor: "pointer", fontWeight: 650 }}>What do these numbers mean?</summary>
        <ul className="tight" style={{ marginTop: 10 }}>
          <li><b>Tokens</b> are the pieces of text a model reads and writes; one token is about three quarters of a word. <i>Read</i> is the prompt it was given, <i>written</i> is what it produced.</li>
          <li><b>Where the time goes:</b> <span className="sw2 ld" /> <i>load</i> (bringing the model from disk into memory), <span className="sw2 rd" /> <i>read</i> (the model taking in your prompt) and <span className="sw2 wr" /> <i>write</i> (producing the answer, token by token).</li>
          <li><b>Speed</b> is how fast it writes. On this kind of laptop about 20 tokens per second is normal; the wait for a grade is mostly this.</li>
          <li><b>Model load</b> is the one-off time to bring the model into memory. On a computer with little free memory this is when everything else can freeze.</li>
          <li>Only these numbers are stored, in your local database (the newest 2,000 calls). Your questions, answers and the model’s replies are never copied here.</li>
        </ul>
      </details>

      {confirm && <Confirm title="Clear model usage history?" message="This deletes the recorded numbers only. Your questions, interviews and reports are not affected." confirmLabel="Clear history" danger
        onCancel={() => setConfirm(false)} onConfirm={async () => { setConfirm(false); try { await api.clearUsage(); toast("ok", "Usage history cleared"); } catch (e) { toast("error", (e as Error).message); } await usage.reload(); }} />}
    </div>
  );
}
