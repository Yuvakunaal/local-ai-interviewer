/** A one-shot request from the command palette to a page ("open the Add Question dialog", "search for X"). */
export type Intent = { type: "add"; topic?: string } | { type: "import" } | { type: "search"; text: string }
  | { type: "resume-upload" }                                  // Resumes page: open the Add resume dialog
  | { type: "resume-practice"; resumeIds: number[] };          // Interview setup: question source "Resume", these resumes preselected

const KEY = "lai.intent";
export const INTENT_EVENT = "lai:intent";

export function setIntent(i: Intent) {
  try { sessionStorage.setItem(KEY, JSON.stringify(i)); } catch { /* ignore */ }
  window.dispatchEvent(new Event(INTENT_EVENT));   // a page that is already open picks it up immediately
}

/** Takes the pending intent if it is one of `types` (all types when omitted); an intent meant for another page is left for that page. */
export function takeIntent<T extends Intent["type"]>(types?: T[]): Extract<Intent, { type: T }> | null {
  try {
    const v = sessionStorage.getItem(KEY);
    if (!v) return null;
    const i = JSON.parse(v) as Intent;
    if (types && !types.includes(i.type as T)) return null;
    sessionStorage.removeItem(KEY);
    return i as Extract<Intent, { type: T }>;
  } catch { return null; }
}
