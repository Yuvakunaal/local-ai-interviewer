import type { IconName } from "./components/Icon";
import type { Intent } from "./intent";

export interface PaletteItem {
  id: string;
  group: "Actions" | "Go to" | "Questions";
  label: string;
  hint?: string;
  icon: IconName;
  keywords?: string;
  run: () => void;
}

const MAX_QUESTIONS = 8;

/** Every query word must appear in the label or keywords; label matches rank above keyword matches, word starts above middles. */
export function rank(items: PaletteItem[], query: string): PaletteItem[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return items.filter((i) => i.group !== "Questions");
  const scored: { item: PaletteItem; score: number; order: number }[] = [];
  items.forEach((item, order) => {
    const label = item.label.toLowerCase();
    const extra = `${item.keywords ?? ""} ${item.hint ?? ""}`.toLowerCase();
    let score = 0;
    for (const w of words) {
      const at = label.indexOf(w);
      if (at === 0) score += 0;
      else if (at > 0 && /[\s\-_/.]/.test(label[at - 1])) score += 1;
      else if (at > 0) score += 2;
      else if (extra.includes(w)) score += 3;
      else return;                        // a word that matches nothing excludes the item
    }
    scored.push({ item, score, order });
  });
  scored.sort((a, b) => a.score - b.score || a.order - b.order);
  const out: PaletteItem[] = [];
  let questions = 0;
  for (const s of scored) {
    if (s.item.group === "Questions" && ++questions > MAX_QUESTIONS) continue;
    out.push(s.item);
  }
  return out;
}

/** Keep each group together, in the order Actions, Go to, Questions, while preserving the ranking inside a group. */
export function grouped(items: PaletteItem[]): PaletteItem[] {
  const order = ["Actions", "Go to", "Questions"] as const;
  return [...items].sort((a, b) => (order.indexOf(a.group) - order.indexOf(b.group)));
}

/** The palette's resume entries: "Upload resume", "Interview from my resume" (actions) and "Resumes" (go to). */
export function resumePaletteItems(go: (hash: string) => void, setIntent: (i: Intent) => void, readyIds: number[]): PaletteItem[] {
  return [
    { id: "resume-upload", group: "Actions", label: "Upload resume", icon: "upload", keywords: "cv pdf add resume", run: () => { setIntent({ type: "resume-upload" }); go("#/resumes"); } },
    { id: "resume-interview", group: "Actions", label: "Interview from my resume", icon: "file", keywords: "cv practice questions about my experience",
      hint: readyIds.length ? undefined : "upload one first",
      run: () => { if (readyIds.length) { setIntent({ type: "resume-practice", resumeIds: readyIds.slice(0, 1) }); go("#/setup"); } else { setIntent({ type: "resume-upload" }); go("#/resumes"); } } },
    { id: "go-resumes", group: "Go to", label: "Resumes", icon: "file", hint: "G E", keywords: "resumes cv pdf", run: () => go("#/resumes") },
  ];
}
