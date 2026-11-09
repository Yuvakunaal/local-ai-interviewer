import type { ReportQuestion } from "./types";

/** One score chip on the scorecard: the main answer, or one follow-up. */
export interface Chip { label: string; score: number | null; note: string | null }

/** "Answer", "Follow-up 1", "Follow-up 2" ... with the score each earned (or why there is none). */
export function chipsFor(q: Pick<ReportQuestion, "turns">): Chip[] {
  let followups = 0;
  return q.turns.map((t) => {
    const label = t.kind === "main" ? "Answer" : `Follow-up ${++followups}`;
    if (t.status === "skipped") return { label, score: null, note: "skipped" };
    if (t.status === "asked") return { label, score: null, note: "not answered" };
    if (t.score == null) return { label, score: null, note: "not scored" };
    return { label, score: t.score, note: null };
  });
}

export const questionNote = (q: Pick<ReportQuestion, "status" | "score">): string | null =>
  q.score != null ? null : q.status === "skipped" ? "Skipped" : q.status === "unanswered" ? "Not reached" : q.status === "answered" ? "Not scored" : null;

/** The longest "a / b / c" a text may be shown at on one line. */
export const clip = (text: string, max = 150) => { const t = text.replace(/\s+/g, " ").trim(); return t.length > max ? t.slice(0, max - 1) + "…" : t; };
