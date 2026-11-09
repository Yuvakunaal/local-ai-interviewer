import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { fmtUsd, fmtRate, normaliseModel, priceFor, checkKeyDraft, cleanKeyDraft, modelOptions, selectedOption, SUPPORTED_MODELS, type ModelRole } from "../aiHelpers";
import type { AIConfig, AITest, ModelPrice } from "../types";
import Icon from "./Icon";
import { CardsSkeleton } from "./Loaders";
import { Confirm, ErrorNotice, OptionCards, Switch, useAsync, useToast } from "./ui";

const TEST_COOLDOWN_S = 6;
const num = (v: string) => (v.trim() === "" ? null : Number(v));
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** One field for the secret: lock icon, paste / show buttons and a live "does this look like a key?" line. */
function KeyField({ value, onChange, onSubmit, disabled }: { value: string; onChange: (v: string) => void; onSubmit?: () => void; disabled?: boolean }) {
  const toast = useToast();
  const [show, setShow] = useState(false);
  const chk = checkKeyDraft(value);
  const paste = async () => {
    try { const t = await navigator.clipboard.readText(); if (t.trim()) onChange(cleanKeyDraft(t)); else toast("info", "The clipboard is empty."); }
    catch { toast("info", "Your browser did not allow clipboard access. Click the box and press ⌘V (Ctrl+V)."); }
  };
  return (
    <div className="keyfield">
      <div className={`keybox is-${chk.state}`}>
        <span className="kb-ic" aria-hidden="true"><Icon name={chk.state === "ok" ? "check" : "lock"} /></span>
        <input type={show ? "text" : "password"} aria-label="Ollama cloud API key" aria-describedby="key-hint" autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false} data-lpignore="true" data-1p-ignore="true"
          placeholder="Paste your API key here" value={value} maxLength={512} disabled={disabled}
          onChange={(e) => onChange(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && chk.state === "ok") onSubmit?.(); }} />
        <button type="button" className="kb-btn" onClick={() => void paste()} disabled={disabled}><Icon name="copy" />Paste</button>
        <button type="button" className="kb-btn" aria-pressed={show} onClick={() => setShow(!show)} aria-label={show ? "Hide the key" : "Show the key"} disabled={disabled}><Icon name="eye" />{show ? "Hide" : "Show"}</button>
      </div>
      <div id="key-hint" className={`kb-hint is-${chk.state}`} role="status" aria-live="polite">{chk.text}</div>
    </div>
  );
}

function ModelRow({ role, title, desc, value, onChange, models, tested, prices }: {
  role: ModelRole; title: string; desc: string; value: string; onChange: (v: string) => void; models: string[]; tested: boolean; prices: Record<string, ModelPrice>;
}) {
  const options = useMemo(() => modelOptions(role), [role]);
  const match = selectedOption(value, options);
  const found = models.some((m) => m.toLowerCase().replace(/[-:]cloud$/, "") === value.trim().toLowerCase().replace(/[-:]cloud$/, ""));
  const price = priceFor(value, prices);
  return (
    <div className="ai-role">
      <div className="ai-role-h"><b>{title}</b><span className="muted small">{desc}</span></div>
      <div className="ai-role-b">
        <select className="ai-select" aria-label={`${title} model`} value={match ?? value} onChange={(e) => onChange(e.target.value)}>
          {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          {match === null && <option value={value}>{value} (not one of the supported models)</option>}
        </select>
        {tested && value.trim() && <span className={`badge ${found ? "ok" : "bad"}`}>{found ? "available" : "not found"}</span>}
        <span className="muted small ai-price">{price
          ? <><b>{fmtRate(price.input_per_m)}</b> in · <b>{fmtRate(price.output_per_m)}</b> out per 1M tokens{price.offpeak_input_per_m != null && <span className="ai-offpeak"> (half price off-peak)</span>}</>
          : "No price set: cost will show as unknown."}</span>
      </div>
    </div>
  );
}

/** Settings -> AI models: local or Ollama cloud, the API key, which model does what, a free connection test, prices and a spending limit. */
export default function AIModels() {
  const toast = useToast();
  const ai = useAsync(() => api.ai(), []);
  const s = ai.data;
  const [choice, setChoice] = useState<"local" | "cloud" | null>(null);
  const [consent, setConsent] = useState(false);
  const [keyDraft, setKeyDraft] = useState("");
  const [replacing, setReplacing] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [draft, setDraft] = useState<AIConfig | null>(null);
  const [test, setTest] = useState<AITest | null>(null);
  const [cool, setCool] = useState(0);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const lastSynced = useRef<string>("");

  useEffect(() => {   // follow the server, but never overwrite edits the user has not saved yet
    if (!s) return;
    const key = JSON.stringify(s.config);
    setDraft((cur) => {
      if (!cur) { lastSynced.current = key; return s.config; }
      const untouched = same(cur, JSON.parse(lastSynced.current));        // nothing edited since the last sync
      if (untouched || same(cur, s.config)) { lastSynced.current = key; return s.config; }
      return cur;
    });
    if (s.last_test) setTest((t) => t ?? s.last_test);
  }, [s]);
  useEffect(() => { if (cool <= 0) return; const t = setTimeout(() => setCool((c) => c - 1), 1000); return () => clearTimeout(t); }, [cool]);

  const act = async (label: string, fn: () => Promise<unknown>, ok?: string) => {
    setBusy(label);
    try { await fn(); if (ok) toast("ok", ok); await ai.reload(); window.dispatchEvent(new Event("lai:ai")); return true; } catch (e) { toast("error", (e as Error).message); return false; } finally { setBusy(null); }
  };

  const view = choice ?? s?.mode ?? "local";
  const cloudView = view === "cloud";
  const dirty = !!s && !!draft && !same(draft, s.config);
  const models = useMemo(() => test?.models ?? [], [test]);
  const consented = !!s?.config.cloud_consent_at;
  const keyReady = !!s?.key.set || checkKeyDraft(keyDraft).state === "ok";

  if (!s || !draft) return <div><ErrorNotice error={ai.error} />{!ai.error && <CardsSkeleton n={3} label="Loading AI settings…" />}</div>;
  const set = <K extends keyof AIConfig>(k: K, v: AIConfig[K]) => setDraft({ ...draft, [k]: v });
  const setPrice = (name: string, patch: Partial<ModelPrice>) => setDraft({ ...draft, prices: { ...draft.prices, [name]: { ...draft.prices[name], ...patch } } });
  const priceNames: string[] = [...SUPPORTED_MODELS];

  const switchToCloud = () => act("cloud", async () => {
    if (keyDraft.trim()) { await api.saveKey(cleanKeyDraft(keyDraft)); setKeyDraft(""); setReplacing(false); }
    await api.saveAI({ mode: "cloud", acknowledge_cloud: true });
    setChoice(null);
  }, "Cloud mode is on");
  const switchToLocal = () => act("local", async () => { await api.saveAI({ mode: "local" }); setChoice(null); }, "Back on this computer");
  const saveSettings = () => act("save", () => api.saveAI({
    grader_model: draft.grader_model, fallback_model: draft.fallback_model, conversation_model: draft.conversation_model, use_fallback: draft.use_fallback, fallback_to_local: draft.fallback_to_local,
    enforce_budget: draft.enforce_budget, daily_budget_usd: draft.daily_budget_usd ?? undefined, total_budget_usd: draft.total_budget_usd ?? undefined,
    clear_daily_budget: draft.daily_budget_usd == null, clear_total_budget: draft.total_budget_usd == null, prices: draft.prices,
  }), "Saved");
  const runTest = async (send: boolean) => {
    setBusy(send ? "test-msg" : "test");
    try { setTest(await api.testAI(send)); setCool(TEST_COOLDOWN_S); await ai.reload(); } catch (e) { toast("error", (e as Error).message); setCool(TEST_COOLDOWN_S); } finally { setBusy(null); }
  };

  return (
    <div className="ai-page">
      <ErrorNotice error={ai.error} />
      {s.mode === "cloud" && (
        <div className="notice info" role="status"><b>Cloud mode is on.</b> The text of your questions and answers is sent to Ollama’s servers to be graded and uses your credits. Your voice and your database stay on this computer.</div>
      )}

      <div className="card">
        <h2>How should the AI run?</h2>
        <p className="muted" style={{ marginTop: -4 }}>Choose where your interview is graded. You can switch at any time; your questions, history and reports are the same either way.</p>
        <OptionCards label="AI engine" value={view} onChange={(v) => setChoice(v === s.mode ? null : v)} cols={2} options={[
          { value: "local", title: "On this computer", desc: `Private and free: your text never leaves this machine. Uses about 4 GB of memory and takes ~25 s per answer (${s.local_model}).`, icon: "shield", aria: "Use the local model" },
          { value: "cloud", title: "Ollama Cloud", desc: "Fast and light on memory. Your questions and answers are sent to Ollama’s servers and use your credits.", icon: "bolt", aria: "Use Ollama cloud models" },
        ]} />
        {choice === "local" && <div className="row" style={{ marginTop: 14 }}><button className="btn primary" disabled={busy === "local"} onClick={() => void switchToLocal()}>Switch back to this computer</button><span className="muted small">Nothing else to set up. Your cloud settings are kept in case you come back.</span></div>}
      </div>

      {cloudView && (
        <div className={`ai-cols ${s.key.set ? "" : "one"}`}>
        <div className="ai-col">
          {!consented && (
            <div className="card c-consent">
              <h2>Before you turn this on</h2>
              <div className="grid2" style={{ alignItems: "start" }}>
                <div><h3>Sent to Ollama’s servers</h3><ul className="tight">{s.sent_to_cloud.map((x) => <li key={x}>{x}</li>)}</ul></div>
                <div><h3>Stays on this computer</h3><ul className="tight">{s.stays_local.map((x) => <li key={x}>{x}</li>)}</ul></div>
              </div>
              <label className="check consent" style={{ marginTop: 12 }}><input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
                <span>I understand my questions and answers will be sent to Ollama’s servers and that this uses my account’s credits.</span></label>
            </div>
          )}

          {choice === "cloud" && (
            <div className="row c-go">
              <button className="btn primary big" disabled={busy === "cloud" || !keyReady || !(consented || consent)} onClick={() => void switchToCloud()}><Icon name="bolt" />Use cloud models</button>
              <span className="muted small">{!keyReady ? "Add your API key below first." : !(consented || consent) ? "Tick the box above to continue." : "You can test the connection after switching."}</span>
            </div>
          )}

          <div className="card c-key">
            <div className="row between"><h2 style={{ margin: 0 }}>API key</h2>{s.key.set && <span className="badge ok"><Icon name="check" />{s.key.source === "environment" ? "from OLLAMA_API_KEY" : `saved ${s.key.hint}`}</span>}</div>
            <p className="muted small" style={{ margin: "6px 0 12px" }}>Create a key at ollama.com/settings/keys. It is stored only in this computer’s local database and is never shown again.</p>
            {s.key.source === "environment" ? <div className="notice info small" style={{ margin: 0 }}>Your key comes from the <span className="mono">OLLAMA_API_KEY</span> environment variable, so it can’t be changed or removed here.</div>
              : s.key.set && !replacing ? (
                <div className="row"><button className="btn" onClick={() => setReplacing(true)}>Replace key</button><button className="btn danger" onClick={() => setConfirmRemove(true)}><Icon name="trash" />Remove key</button></div>
              ) : (
                <div>
                  <KeyField value={keyDraft} onChange={setKeyDraft} disabled={busy === "key"}
                    onSubmit={s.key.set ? () => void act("key", async () => { await api.saveKey(cleanKeyDraft(keyDraft)); setKeyDraft(""); setReplacing(false); }, "Key saved") : undefined} />
                  {s.key.set && <div className="row" style={{ marginTop: 12 }}>
                    <button className="btn primary" disabled={checkKeyDraft(keyDraft).state !== "ok" || busy === "key"} onClick={() => void act("key", async () => { await api.saveKey(cleanKeyDraft(keyDraft)); setKeyDraft(""); setReplacing(false); }, "Key saved")}>Save key</button>
                    <button className="btn" onClick={() => { setReplacing(false); setKeyDraft(""); }}>Cancel</button>
                  </div>}
                </div>
              )}
          </div>

          {s.key.set && (
            <div className="card c-test">
                <h2>Test the connection</h2>
                <p className="muted small" style={{ margin: "0 0 12px" }}>The first button only checks your key and lists the models you can use. It costs nothing. The second sends one tiny message (a few dozen tokens, a fraction of a cent).</p>
                <div className="row">
                  <button className="btn primary" disabled={busy !== null || cool > 0} onClick={() => void runTest(false)}>{busy === "test" ? <span className="spinner" style={{ width: 14, height: 14, borderWidth: 2 }} /> : <Icon name="refresh" />}Test connection (free)</button>
                  <button className="btn" disabled={busy !== null || cool > 0} onClick={() => void runTest(true)}>Send one tiny test message</button>
                  {cool > 0 && <span className="muted small">wait {cool} s (protects your credits)</span>}
                </div>
                {test && (
                  <div className={`notice ${test.ok ? "ok" : test.key_ok ? "warn" : "error"} small`} role="status" style={{ marginTop: 12, marginBottom: 0 }}>
                    <b>{test.key_ok ? `Connected · ${test.models.length} cloud models available` : "Could not connect"}</b>
                    <div>{test.message}</div>
                    {Object.entries(test.missing ?? {}).map(([role, m]) => (
                      <div key={role}>“{m}” ({role}) was not found{(test.suggestions?.[m] ?? []).length ? <> — did you mean {(test.suggestions[m] ?? []).map((x) => <button key={x} className="linkbtn" onClick={() => set(role === "fallback" ? "fallback_model" : role === "conversation" ? "conversation_model" : "grader_model", x)}>{x}</button>)}?</> : "."}</div>
                    ))}
                    {test.message_test && <div style={{ marginTop: 6 }}>{test.message_test.ok ? <>Test message answered by <b>{test.message_test.model}</b>: “{test.message_test.text}” ({test.message_test.prompt_tokens} + {test.message_test.output_tokens} tokens)</> : <>Test message failed: {test.message_test.message}</>}</div>}
                  </div>
                )}
              </div>

          )}
          {s.key.set && (
            <div className="card c-fail">
              <h2>If a model fails</h2>
              <p className="muted small" style={{ margin: "0 0 12px" }}>What the app may do when the grader can’t answer. It never switches engines on its own.</p>
                <div className="trows">
                  <div className={`trow2 ${draft.use_fallback ? "on" : ""}`}><span className="ti"><Icon name="refresh" /></span><div className="t"><b>Use the fallback model if the grader fails</b><span>Tried once, only for grading and the report summary, and only for outages or an unknown model, never for a bad key or no credits.</span></div><Switch label="Use the fallback model" checked={draft.use_fallback} onChange={(v) => set("use_fallback", v)} /></div>
                  <div className={`trow2 ${draft.fallback_to_local ? "on" : ""}`}><span className="ti"><Icon name="shield" /></span><div className="t"><b>If the cloud can’t be reached, use my local model instead</b><span>Sends nothing to the cloud. It needs the local model installed, and the feedback says which model graded it.</span></div><Switch label="Fall back to the local model" checked={draft.fallback_to_local} onChange={(v) => set("fallback_to_local", v)} /></div>
                </div>
            </div>
          )}
        </div>

          {s.key.set && (
            <div className="ai-col">
              <div className="card c-models">
                <h2>Which model does what</h2>
                <ModelRow role="grader" title="Grader" desc={s.roles.grader} value={draft.grader_model} onChange={(v) => set("grader_model", v)} models={models} tested={!!test?.key_ok} prices={draft.prices} />
                <ModelRow role="fallback" title="Fallback / second opinion" desc={s.roles.fallback} value={draft.fallback_model} onChange={(v) => set("fallback_model", v)} models={models} tested={!!test?.key_ok} prices={draft.prices} />
                <ModelRow role="conversation" title="Conversation" desc={s.roles.conversation} value={draft.conversation_model} onChange={(v) => set("conversation_model", v)} models={models} tested={!!test?.key_ok} prices={draft.prices} />
                {draft.use_fallback && normaliseModel(draft.fallback_model) === normaliseModel(draft.grader_model) && <div className="notice warn small" style={{ marginTop: 10 }}>The fallback is the same model as the grader, so it can’t take over when the grader fails. Pick a different fallback.</div>}
              </div>
            </div>
          )}
        </div>
      )}

      {cloudView && s.key.set && (
        <div className="ai-wide">
              <div className="card">
                <h2>Spending limit and prices</h2>
                <div className="spend-cols">
                  <div>
                <div className="spend-grid">
                  {([["Today", s.budget.today], ["All time", s.budget.total]] as const).map(([label, b]) => (
                    <div key={label} className="spend">
                      <div className="row between"><span className="muted small">{label}</span><b>{fmtUsd(b.spent_usd)}{b.limit_usd != null ? ` of ${fmtUsd(b.limit_usd)}` : ""}</b></div>
                      {b.percent != null && <div className="meter" role="img" aria-label={`${label}: ${b.percent}% of the limit`}><i className={b.reached ? "low" : b.percent >= 80 ? "low" : "good"} style={{ width: `${b.percent}%` }} /></div>}
                      {b.reached && <div className="small bad-text">Limit reached: cloud calls are paused until you raise it{label === "Today" ? " or tomorrow" : ""}.</div>}
                    </div>
                  ))}
                </div>
                <div className="grid2" style={{ marginTop: 14 }}>
                  <label className="field">Daily limit (US dollars)<input type="number" min="0" step="0.1" placeholder="no limit" value={draft.daily_budget_usd ?? ""} onChange={(e) => set("daily_budget_usd", num(e.target.value))} /></label>
                  <label className="field">Total limit (US dollars)<input type="number" min="0" step="1" placeholder="no limit" value={draft.total_budget_usd ?? ""} onChange={(e) => set("total_budget_usd", num(e.target.value))} /></label>
                </div>
                <div className={`trow2 ${draft.enforce_budget ? "on" : ""}`} style={{ marginTop: 12 }}><span className="ti"><Icon name="lock" /></span><div className="t"><b>Stop cloud calls when a limit is reached</b><span>Checked before every call. With it off, the limits are only shown.</span></div><Switch label="Enforce the spending limits" checked={draft.enforce_budget} onChange={(v) => set("enforce_budget", v)} /></div>

                  </div>
                  <div>
                <h3 style={{ marginTop: 0 }}>Prices (US dollars per million tokens)</h3>
                <div className="tscroll"><table className="usage-tbl price-tbl">
                  <thead><tr><th>Model</th><th className="num">Input</th><th className="num">Output</th><th className="num">Off-peak input</th><th className="num">Off-peak output</th></tr></thead>
                  <tbody>{priceNames.map((name) => {
                    const p = draft.prices[name] ?? null;
                    return (
                      <tr key={name}>
                        <td><b>{name}</b>{!p && <div className="muted small">no price: cost shows as unknown</div>}</td>
                        {(["input_per_m", "output_per_m", "offpeak_input_per_m", "offpeak_output_per_m"] as const).map((f) => (
                          <td key={f} className="num"><input type="number" min="0" step="any" aria-label={`${name} ${f.replace(/_/g, " ")}`} value={p?.[f] ?? ""} placeholder={f.startsWith("offpeak") ? "same" : "0"}
                            onChange={(e) => setPrice(name, { input_per_m: p?.input_per_m ?? 0, output_per_m: p?.output_per_m ?? 0, [f]: num(e.target.value) ?? (f.startsWith("offpeak") ? null : 0) })} /></td>
                        ))}
                      </tr>
                    );
                  })}</tbody>
                </table></div>
                <p className="muted small" style={{ marginTop: 12 }}>Defaults are the rates on Ollama’s pricing page (read 31 Oct 2026); numbers you change are kept. DeepSeek v4.1 Flash is half price outside 12:00–18:00 UTC on weekdays. Costs shown in the app are <b>estimates</b> (reasoning tokens and cached input may be billed differently); ollama.com/settings/usage is the source of truth.</p>
                  </div>
                </div>
              </div>

              <div className="row savebar">
                {dirty && <span className="muted small">You have unsaved changes.</span>}
                <button className="btn" disabled={!dirty} onClick={() => { setDraft(s.config); }}>Discard</button>
                <button className="btn primary big" disabled={!dirty || busy === "save"} onClick={() => void saveSettings()}>Save changes</button>
              </div>
        </div>
      )}

      {confirmRemove && <Confirm title="Remove the API key?" message="The key is deleted from this computer. If cloud mode is on, the app switches back to the local model." confirmLabel="Remove key" danger
        onCancel={() => setConfirmRemove(false)} onConfirm={async () => { setConfirmRemove(false); await act("remove", () => api.removeKey(), "Key removed"); setChoice(null); }} />}
    </div>
  );
}
