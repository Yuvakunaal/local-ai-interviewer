import type { UsageSummary } from "../types";

export const TASK: Record<string, { label: string; hint: string }> = {
  evaluation: { label: "Grading an answer", hint: "reads your answer, writes the evaluation" },
  repair: { label: "Cleaning up a voice transcript", hint: "fixes speech-recognition mistakes before grading" },
  summary: { label: "Report summary", hint: "writes the overall feedback at the end" },
  followup: { label: "Writing a follow-up question", hint: "the conversation model turns a gap into one natural question (cloud mode)" },
  warm: { label: "Loading the model", hint: "reads the model from disk into memory" },
  test: { label: "Connection test message", hint: "the one tiny message sent when you press the test button" },
  speech: { label: "Reading a question aloud", hint: "the Phonon voice (no tokens)" },
  resume_parse: { label: "Organising a resume", hint: "turns one part of your resume's text into editable sections" },
  resume_questions: { label: "Writing resume questions", hint: "writes interview questions about the items on your resume" },
};
export const taskLabel = (p: string) => TASK[p]?.label ?? p;
/** These calls read and write no text, so token columns do not apply. */
export const NO_TOKENS = new Set(["speech", "warm"]);

export const fmtNum = (n: number | null | undefined) => (n == null ? "–" : n.toLocaleString());
export const fmtSecs = (s: number) => (s >= 60 ? `${Math.floor(s / 60)} min ${Math.round(s % 60)} s` : `${s.toFixed(1)} s`);
export const fmtUnload = (s: number | null) => (s == null ? "" : s <= 0 ? "unloading now" : s < 90 ? `unloads in ${s} s` : `unloads in ${Math.round(s / 60)} min`);
export const when = (iso: string, now = new Date()) => {
  const d = new Date(iso);
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return d.toDateString() === now.toDateString() ? `Today ${time}` : `${d.toLocaleDateString([], { day: "numeric", month: "short" })} ${time}`;
};
export const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
export const percent = (part: number, total: number) => (total > 0 ? Math.round((part / total) * 100) : 0);

/** Headline numbers for a set of summary rows (a whole day, or all time). */
export function headline(rows: UsageSummary[]) {
  const text = rows.filter((r) => !NO_TOKENS.has(r.purpose));
  const written = sum(text.map((r) => r.output_tokens));
  const writeSeconds = sum(text.map((r) => r.avg_write_seconds * r.calls));
  return {
    calls: sum(rows.map((r) => r.calls)),
    read: sum(text.map((r) => r.prompt_tokens)),
    written,
    seconds: Math.round(sum(rows.map((r) => r.total_seconds)) * 10) / 10,
    loads: sum(rows.map((r) => r.model_loads)),
    cloudCalls: sum(rows.filter((r) => r.provider === "cloud").map((r) => r.calls)),
    cost: Math.round(sum(rows.map((r) => r.cost_usd ?? 0)) * 1e6) / 1e6,          // estimated, cloud calls only
    unpriced: sum(rows.map((r) => r.unpriced_calls)),                              // cloud calls whose model has no price: cost unknown, not free
    speed: writeSeconds > 0 ? Math.round((written / writeSeconds) * 10) / 10 : null,
  };
}

/** Widths (percent) of the load / read / write parts of one call's time, for a small stacked bar. */
export function splitWidths(load: number, read: number, write: number, total: number) {
  const whole = Math.max(total, load + read + write, 0.001);
  return { load: (load / whole) * 100, read: (read / whole) * 100, write: (write / whole) * 100 };
}
