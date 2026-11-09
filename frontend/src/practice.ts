/** "Practice my weakest topics": turn the dashboard's weak topics into a preselection of real questions. */

export interface WeakTopic { topic: string; untagged: boolean }
export interface QuestionLite { id: number; topic: string | null }
/** `label` names only the topics that really matched; `skipped` are weak topics that had no question in that set. */
export interface Preselect { setId: number; ids: number[]; label: string; skipped: WeakTopic[] }

/** Reports call questions without a topic "Uncategorized"; that is a placeholder, not a topic a question can have. */
export const isUntagged = (topic: string | null | undefined) => !topic || !topic.trim() || topic.trim().toLowerCase() === "uncategorized";

/** Plain-English name of a topic for buttons and messages. */
export const topicName = (t: WeakTopic) => (t.untagged ? "questions with no topic" : `“${t.topic}”`);

export function describeTopics(topics: WeakTopic[]): string {
  const names = topics.map(topicName);
  return names.length <= 1 ? names[0] ?? "" : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

const matches = (q: QuestionLite, t: WeakTopic) => (t.untagged ? isUntagged(q.topic) : (q.topic ?? "").trim().toLowerCase() === t.topic.trim().toLowerCase());

export const matchQuestions = (questions: QuestionLite[], topics: WeakTopic[]): number[] =>
  questions.filter((q) => topics.some((t) => matches(q, t))).map((q) => q.id);

/** The set holding the most matching questions (an interview practices one set), or null when nothing matches. */
export function pickPreselect(sets: { setId: number; questions: QuestionLite[] }[], topics: WeakTopic[]): Preselect | null {
  let best: Preselect | null = null;
  for (const s of sets) {
    const ids = matchQuestions(s.questions, topics);
    if (!ids.length || (best && ids.length <= best.ids.length)) continue;
    const matched = topics.filter((t) => s.questions.some((q) => matches(q, t)));
    best = { setId: s.setId, ids, label: describeTopics(matched), skipped: topics.filter((t) => !matched.includes(t)) };
  }
  return best;
}

/** Weak topics that no question in any set belongs to (so the user knows exactly what to add). */
export const missingTopics = (sets: { questions: QuestionLite[] }[], topics: WeakTopic[]): WeakTopic[] =>
  topics.filter((t) => !sets.some((s) => s.questions.some((q) => matches(q, t))));
