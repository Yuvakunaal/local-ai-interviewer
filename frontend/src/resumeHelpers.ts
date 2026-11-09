/** Pure helpers for the Resumes feature (no React, no network) so they can be unit-tested. */
import { priceFor } from "./aiHelpers";
import type { AIConfig, Claim, Depth, DraftQuestion, FocusArea, GenDifficulty, InterviewerStyle, MixOrder, ResumeProfile, ResumeStatus, ResumeSummary } from "./types";

// ------------------------------------------------------------------ naming and status
/** "Resume N" with the lowest free N (same rule as the server). */
export function nextResumeName(existing: string[]): string {
  const used = new Set(existing.map((n) => /^Resume (\d+)$/.exec(n)?.[1]).filter(Boolean).map(Number));
  let n = 1;
  while (used.has(n)) n++;
  return `Resume ${n}`;
}

export const WORKING: ResumeStatus[] = ["extracting", "ocr", "structuring"];
export const awaitingConsent = (r: Pick<ResumeSummary, "status" | "stage_detail">) => r.status === "uploaded" && r.stage_detail === "awaiting_cloud_consent";
/** Still being read or organised (the list keeps polling while any resume is like this). */
export const isWorking = (r: Pick<ResumeSummary, "status" | "stage_detail">) => WORKING.includes(r.status) || (r.status === "uploaded" && !awaitingConsent(r));
export const anyWorking = (rs: Pick<ResumeSummary, "status" | "stage_detail">[]) => rs.some(isWorking);

export type Tone = "ok" | "warn" | "bad" | "blue" | "accent" | "";
export function statusChip(r: Pick<ResumeSummary, "status" | "stage_detail">): { label: string; tone: Tone } {
  if (awaitingConsent(r)) return { label: "Waiting for your OK", tone: "warn" };
  if (r.status === "ready") return { label: "Ready", tone: "ok" };
  if (r.status === "failed") return { label: "Needs attention", tone: "bad" };
  if (r.status === "structuring") return { label: "Organising…", tone: "blue" };
  return { label: "Reading…", tone: "blue" };
}

export const METHOD_LABEL: Record<string, string> = { text: "Text", ocr: "OCR", mixed: "Mixed" };
export const methodLabel = (m: string | null | undefined) => (m ? METHOD_LABEL[m] ?? m : null);
export const METHOD_HELP: Record<string, string> = {
  text: "The text was read directly from the PDF.",
  ocr: "Every page was a scanned image, so the text was recognised with OCR. Check names and numbers.",
  mixed: "Some pages had text and some were scanned images (read with OCR).",
};

/** One plain sentence about what is happening right now. */
export function stageText(r: Pick<ResumeSummary, "status" | "stage_detail">): string {
  const d = r.stage_detail && r.stage_detail !== "queued" && r.stage_detail !== "awaiting_cloud_consent" ? r.stage_detail : "";
  if (awaitingConsent(r)) return "Waiting for your OK to use Ollama cloud";
  switch (r.status) {
    case "uploaded": return "Waiting to start…";
    case "extracting": return d && /page/.test(d) ? `Reading text · ${d}` : "Reading text…";
    case "ocr": return d ? `Running OCR · ${d}` : "Running OCR…";
    case "structuring": return d && /part/.test(d) ? `Organising with AI · ${d}` : "Organising with AI…";
    case "ready": return "Ready";
    default: return "Needs attention";
  }
}

export type StepState = "done" | "active" | "todo" | "error";
export interface Step { key: string; label: string; state: StepState; detail?: string }
/** The upload dialog's stepper: Uploading → Reading text → (Running OCR) → Organising with AI → Ready. */
export function steps(r: Pick<ResumeSummary, "status" | "stage_detail" | "extraction_method" | "error_code"> | null, uploading = false): Step[] {
  const order = ["upload", "read", "ocr", "organise", "ready"];
  const showOcr = !!r && (r.status === "ocr" || r.extraction_method === "ocr" || r.extraction_method === "mixed" || r.error_code === "ocr_unavailable");
  let current = "upload";
  if (r && !uploading) {
    if (r.status === "uploaded") current = awaitingConsent(r) ? "organise" : "read";
    else if (r.status === "extracting") current = "read";
    else if (r.status === "ocr") current = "ocr";
    else if (r.status === "structuring") current = "organise";
    else if (r.status === "ready") current = "done";
    else current = r.error_code === "ocr_unavailable" ? "ocr" : r.error_code === "no_text" || r.error_code === "resume_unreadable" ? "read" : "organise";
  }
  const failed = r?.status === "failed";
  const labels: Record<string, string> = { upload: "Uploading", read: "Reading text", ocr: "Running OCR", organise: "Organising with AI", ready: "Ready" };
  const idx = current === "done" ? order.length : order.indexOf(current);
  return order.filter((k) => k !== "ocr" || showOcr).map((k) => {
    const i = order.indexOf(k);
    let state: StepState = i < idx ? "done" : i === idx ? (failed ? "error" : "active") : "todo";
    if (k === "ready" && current === "done") state = "done";
    const detail = state === "active" && r && ((k === "read" && r.status === "extracting") || (k === "ocr" && r.status === "ocr") || (k === "organise" && r.status === "structuring"))
      ? r.stage_detail ?? undefined : undefined;
    return { key: k, label: labels[k], state, detail: detail && /of/.test(detail) ? detail : undefined };
  });
}

// ------------------------------------------------------------------ file checks (mirror the server)
export function checkPdf(file: { name: string; type: string; size: number }, maxMb: number): string | null {
  const isPdf = file.type === "application/pdf" || /\.pdf$/i.test(file.name);
  if (!isPdf) return "Only PDF files can be added. Save or export your resume as a PDF first.";
  if (file.size === 0) return "This file is empty.";
  if (file.size > maxMb * 1024 * 1024) return `This file is larger than ${maxMb} MB. Export a smaller PDF (fewer images) and try again.`;
  return null;
}
/** First bytes of the file must be "%PDF-" (the server checks the same). */
export const looksLikePdf = (head: Uint8Array) => head.length >= 5 && String.fromCharCode(...head.slice(0, 5)) === "%PDF-";

export const fmtBytes = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

// ------------------------------------------------------------------ the editable profile
export const emptyProfile = (): ResumeProfile => ({
  contact: { name: "", email: "", phone: "", location: "", links: [] }, summary: "", skills: [], experience: [], projects: [], education: [],
  certifications: [], achievements: [], other: [], parse_warnings: [],
});
export const emptyExperience = () => ({ company: "", title: "", location: "", start: "", end: "", is_current: false, bullets: [""] });
export const emptyProject = () => ({ name: "", role: "", tech: [] as string[], link: "", bullets: [""] });
export const emptyEducation = () => ({ school: "", degree: "", field: "", start: "", end: "", details: "" });

/** The shape the server saves: text trimmed, blank list items dropped (so "dirty" compares like for like). */
export function normalise(p: ResumeProfile): ResumeProfile {
  const t = (s: string | undefined | null) => (s ?? "").trim();
  const tl = (xs: string[] | undefined) => (xs ?? []).map(t).filter(Boolean);
  return {
    contact: { name: t(p.contact?.name), email: t(p.contact?.email), phone: t(p.contact?.phone), location: t(p.contact?.location), links: tl(p.contact?.links) },
    summary: t(p.summary),
    skills: (p.skills ?? []).map((g) => ({ group: t(g.group), items: tl(g.items) })),
    experience: (p.experience ?? []).map((e) => ({ company: t(e.company), title: t(e.title), location: t(e.location), start: t(e.start), end: t(e.end), is_current: !!e.is_current, bullets: tl(e.bullets) })),
    projects: (p.projects ?? []).map((e) => ({ name: t(e.name), role: t(e.role), tech: tl(e.tech), link: t(e.link), bullets: tl(e.bullets) })),
    education: (p.education ?? []).map((e) => ({ school: t(e.school), degree: t(e.degree), field: t(e.field), start: t(e.start), end: t(e.end), details: t(e.details) })),
    certifications: tl(p.certifications), achievements: tl(p.achievements), other: tl(p.other), parse_warnings: tl(p.parse_warnings),
  };
}
export const sameProfile = (a: ResumeProfile | null, b: ResumeProfile | null) => JSON.stringify(a ? normalise(a) : null) === JSON.stringify(b ? normalise(b) : null);

/** Which sections differ (for the "Unsaved changes in …" hint). */
export function changedSections(saved: ResumeProfile, draft: ResumeProfile): string[] {
  const a = normalise(saved), b = normalise(draft);
  const names: [keyof ResumeProfile, string][] = [["contact", "Contact"], ["summary", "Summary"], ["skills", "Skills"], ["experience", "Experience"], ["projects", "Projects"],
    ["education", "Education"], ["certifications", "Certifications"], ["achievements", "Achievements"], ["other", "Other"]];
  return names.filter(([k]) => JSON.stringify(a[k]) !== JSON.stringify(b[k])).map(([, n]) => n);
}

export interface FieldError { path: string; message: string }
const LIMIT = { short: 160, location: 120, date: 40, link: 300, item: 800, summary: 3000, skill: 80, tech: 60, group: 60, name: 200, phone: 80 };
const COUNT = { skills: 20, skillItems: 80, experience: 40, projects: 40, education: 20, list: 50, bullets: 25, links: 12, tech: 40 };
/** The server's limits, checked before saving so the user sees exactly which field is too long. */
export function validateProfile(p: ResumeProfile): FieldError[] {
  const errs: FieldError[] = [];
  const len = (path: string, v: string, n: number) => { if ((v ?? "").trim().length > n) errs.push({ path, message: `Keep this under ${n} characters (now ${v.trim().length}).` }); };
  const cnt = (path: string, xs: unknown[], n: number) => { if (xs.length > n) errs.push({ path, message: `At most ${n} entries here (now ${xs.length}).` }); };
  len("contact.name", p.contact.name, LIMIT.name); len("contact.email", p.contact.email, LIMIT.name); len("contact.phone", p.contact.phone, LIMIT.phone); len("contact.location", p.contact.location, LIMIT.name);
  cnt("contact.links", p.contact.links, COUNT.links); p.contact.links.forEach((l, i) => len(`contact.links.${i}`, l, LIMIT.link));
  len("summary", p.summary, LIMIT.summary);
  cnt("skills", p.skills, COUNT.skills);
  p.skills.forEach((g, i) => { len(`skills.${i}.group`, g.group, LIMIT.group); cnt(`skills.${i}.items`, g.items, COUNT.skillItems); g.items.forEach((x, k) => len(`skills.${i}.items.${k}`, x, LIMIT.skill)); });
  cnt("experience", p.experience, COUNT.experience);
  p.experience.forEach((e, i) => {
    len(`experience.${i}.company`, e.company, LIMIT.short); len(`experience.${i}.title`, e.title, LIMIT.short); len(`experience.${i}.location`, e.location, LIMIT.location);
    len(`experience.${i}.start`, e.start, LIMIT.date); len(`experience.${i}.end`, e.end, LIMIT.date); cnt(`experience.${i}.bullets`, e.bullets, COUNT.bullets);
    e.bullets.forEach((b, k) => len(`experience.${i}.bullets.${k}`, b, LIMIT.item));
  });
  cnt("projects", p.projects, COUNT.projects);
  p.projects.forEach((e, i) => {
    len(`projects.${i}.name`, e.name, LIMIT.short); len(`projects.${i}.role`, e.role, LIMIT.location); len(`projects.${i}.link`, e.link, LIMIT.link);
    cnt(`projects.${i}.tech`, e.tech, COUNT.tech); e.tech.forEach((x, k) => len(`projects.${i}.tech.${k}`, x, LIMIT.tech));
    cnt(`projects.${i}.bullets`, e.bullets, COUNT.bullets); e.bullets.forEach((b, k) => len(`projects.${i}.bullets.${k}`, b, LIMIT.item));
  });
  cnt("education", p.education, COUNT.education);
  p.education.forEach((e, i) => {
    len(`education.${i}.school`, e.school, LIMIT.short); len(`education.${i}.degree`, e.degree, LIMIT.short); len(`education.${i}.field`, e.field, LIMIT.short);
    len(`education.${i}.start`, e.start, LIMIT.date); len(`education.${i}.end`, e.end, LIMIT.date); len(`education.${i}.details`, e.details, LIMIT.item);
  });
  for (const k of ["certifications", "achievements", "other"] as const) { cnt(k, p[k], COUNT.list); p[k].forEach((x, i) => len(`${k}.${i}`, x, LIMIT.item)); }
  return errs;
}
export const errorFor = (errs: FieldError[], path: string) => errs.find((e) => e.path === path)?.message;

export function move<T>(xs: T[], i: number, dir: -1 | 1): T[] {
  const j = i + dir;
  if (j < 0 || j >= xs.length) return xs;
  const out = [...xs];
  [out[i], out[j]] = [out[j], out[i]];
  return out;
}
export const removeAt = <T,>(xs: T[], i: number) => xs.filter((_, k) => k !== i);
export const replaceAt = <T,>(xs: T[], i: number, v: T) => xs.map((x, k) => (k === i ? v : x));

export function topSkills(p: ResumeProfile | null, n = 6): string[] {
  const out: string[] = [];
  for (const g of p?.skills ?? []) for (const s of g.items) { if (!out.includes(s)) out.push(s); if (out.length >= n) return out; }
  return out;
}
export function profileCounts(p: ResumeProfile | null) {
  return { roles: p?.experience.length ?? 0, projects: p?.projects.length ?? 0, skills: (p?.skills ?? []).reduce((n, g) => n + g.items.length, 0), education: p?.education.length ?? 0 };
}

// ------------------------------------------------------------------ questions about resumes
export const FOCUS: { value: FocusArea; label: string }[] = [
  { value: "experience", label: "Work experience" }, { value: "projects", label: "Projects" }, { value: "skills", label: "Skills & tech depth" },
  { value: "achievements", label: "Achievements & metrics" }, { value: "education", label: "Education" }, { value: "behavioural", label: "Behavioural / ownership" },
  { value: "gaps", label: "Gaps & transitions" },
];
export const DEFAULT_FOCUS: FocusArea[] = ["experience", "projects", "skills", "achievements"];
export const DEPTHS: { value: Depth; label: string; hint: string }[] = [
  { value: "overview", label: "Overview", hint: "One question per item, broad coverage" },
  { value: "standard", label: "Standard", hint: "Up to two angles on each item" },
  { value: "deep", label: "Deep-dive", hint: "Several probing questions about the same claim" },
];
export const STYLES: { value: InterviewerStyle; label: string; hint: string }[] = [
  { value: "recruiter", label: "Friendly recruiter", hint: "Warm, invites your story" },
  { value: "manager", label: "Hiring manager", hint: "Impact, ownership, teamwork" },
  { value: "skeptic", label: "Skeptical senior engineer", hint: "Specifics, numbers, reasons" },
];
export const DIFFICULTIES: { value: GenDifficulty; label: string }[] = [{ value: "mixed", label: "Mixed" }, { value: "easy", label: "Easy" }, { value: "medium", label: "Medium" }, { value: "hard", label: "Hard" }];
export const KIND_LABEL: Record<string, string> = {
  project_deep_dive: "Deep dive", tech_depth: "Tech depth", metric_challenge: "Numbers", ownership_behavioural: "Ownership",
  decision_tradeoff: "Decisions", failure_learning: "Lessons", gap_transition: "Career move",
};
export const clampCount = (n: number) => Math.max(3, Math.min(20, Math.round(Number.isFinite(n) ? n : 8)));

/** "From: Resume 1 › Experience › Backend engineer at Acme" */
export function claimChip(q: { resume_name?: string | null; claim?: Claim | null }, deleted = false): string {
  const name = `${q.resume_name || "Resume"}${deleted ? " (deleted resume)" : ""}`;
  return ["From: " + name, q.claim?.section, q.claim?.label].filter(Boolean).join(" › ");
}

/** The order bank (B) and resume (R) questions will be asked in (same rule as the server; shuffled is shown as "mixed at random"). */
export function mixSequence(mix: MixOrder, bank: number, resume: number): ("B" | "R")[] {
  const B = Array<"B">(bank).fill("B"), R = Array<"R">(resume).fill("R");
  if (mix === "resume_first") return [...R, ...B];
  if (mix === "interleave") { const out: ("B" | "R")[] = []; for (let i = 0; i < Math.max(bank, resume); i++) { if (i < resume) out.push("R"); if (i < bank) out.push("B"); } return out; }
  return [...B, ...R];
}
export const MIX_LABEL: Record<MixOrder, string> = { bank_first: "Bank first", resume_first: "Resume first", interleave: "Interleave", shuffled: "Shuffle all" };

export type Source = "bank" | "resume" | "both";
export function sessionCounts(source: Source, bankCount: number, resumeCount: number) {
  const bank = source === "resume" ? 0 : bankCount;
  const resume = source === "bank" ? 0 : resumeCount;
  return { bank, resume, total: bank + resume };
}
/** Minutes for an interview with this many questions (same formula the setup page always used). */
export const interviewMinutes = (questions: number, maxFollowups: number) => Math.max(5, Math.round((questions * (2.5 + maxFollowups * 1.3)) / 5) * 5);

/** How many small model requests writing these questions takes: at most 4 claims per request, plus room for one top-up. */
export function generationRequests(count: number, depth: Depth): number {
  const claims = depth === "deep" ? Math.ceil(count / 3) : depth === "standard" ? Math.ceil(count / 1.5) : count;
  return Math.ceil(claims / 4) + 1;
}
/** "about N min on this computer" (local ~40 s per request on an 8 GB laptop; cloud ~12 s). */
export const generationMinutes = (count: number, depth: Depth, cloud: boolean) => Math.max(1, Math.round((generationRequests(count, depth) * (cloud ? 12 : 40)) / 60));

/** Upper-bound cost of writing the questions in cloud mode (null when the grader has no price set). */
export function generationCost(cfg: AIConfig, count: number, depth: Depth): number | null {
  const p = priceFor(cfg.grader_model, cfg.prices);
  if (!p) return null;
  const n = generationRequests(count, depth);
  return (n * (1600 * p.input_per_m + 1100 * p.output_per_m)) / 1_000_000;
}

export const toInput = (q: DraftQuestion) => ({ text: q.text.trim(), rubric: q.rubric?.trim() || null, topic: q.topic?.trim() || null, difficulty: q.difficulty, kind: q.kind,
  resume_id: q.resume_id, resume_name: q.resume_name, claim: q.claim });
export const validQuestion = (q: DraftQuestion) => q.text.trim().length > 0 && q.text.trim().length <= 1000 && (q.rubric ?? "").length <= 1500;

export const CLAIM_VERDICT_TONE: Record<string, Tone> = { Solid: "ok", Shaky: "warn", Weak: "bad" };
