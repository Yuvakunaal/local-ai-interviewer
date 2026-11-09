import type { PullStatus, SetupReport, Health, HistoryRow, ImportPreview, ImportResult, InterviewConfig, InterviewState, QSet, Question, QuestionInput, Report, Rubric, Stats, Usage, AIState, AITest, AIUpdate,
  DraftQuestion, GenJob, GenSettings, Resume, ResumeProfile, ResumeQuestionInput, ResumeStorage, ResumeSummary, ResumeText } from "./types";

export class ApiError extends Error {
  constructor(public code: string, message: string, public status = 0) {
    super(message);
  }
}

async function parse(res: Response): Promise<never | unknown> {
  if (res.ok) return res.status === 204 ? null : res.headers.get("content-type")?.includes("json") ? res.json() : res;
  let code = "http_error";
  let message = `Request failed (${res.status}).`;
  try {
    const body = await res.json();
    code = body?.error?.code ?? code;
    message = body?.error?.message ?? message;
  } catch { /* non-JSON error body */ }
  throw new ApiError(code, message, res.status);
}

// ------------------------------------------------------------------ request tracking and a small read cache
// Every request is counted so the app can show a quiet progress bar when something takes a moment ("busy" below), except
// background work that has its own indicator (polling, model warm-up, speech). Reads that many screens share (health, lists,
// settings) are cached for a few seconds and de-duplicated, so moving between pages does not repeat the same request; any change
// (POST/PUT/PATCH/DELETE) clears the cache, so what you see is never older than your last action.
type BusyListener = (inflight: number) => void;
let inflight = 0;
const busyListeners = new Set<BusyListener>();
export const subscribeBusy = (cb: BusyListener) => { busyListeners.add(cb); return () => { busyListeners.delete(cb); }; };
const bump = (d: number) => { inflight += d; busyListeners.forEach((l) => l(inflight)); };

const cache = new Map<string, { at: number; data?: unknown; pending?: Promise<unknown> }>();
export const clearApiCache = () => cache.clear();

async function call<T>(path: string, init?: RequestInit, opts: { quiet?: boolean } = {}): Promise<T> {
  const mutating = (init?.method ?? "GET") !== "GET" && !opts.quiet;      // quiet requests (warm-up, speech) change nothing a screen shows
  if (mutating) clearApiCache();
  if (!opts.quiet) bump(1);
  try {
    let res: Response;
    try {
      res = await fetch(path, init);
    } catch (e) {
      if ((e as Error).name === "AbortError") throw e;
      throw new ApiError("network", "Cannot reach the local server. Is the app still running? Start it again with start.sh (macOS/Linux) or start.bat (Windows).");
    }
    return (await parse(res)) as T;
  } finally {
    if (!opts.quiet) bump(-1);
    if (mutating) {
      clearApiCache();                 // a read that started before this change must not leave an older copy behind
      window.dispatchEvent(new Event("lai:data"));    // lets the sidebar counts and status refresh straight away
    }
  }
}

/** A GET shared for `ttl` ms. `fresh` skips the stored copy (Refresh buttons). Callers get their own copy, so editing it is safe. */
function cachedGet<T>(path: string, ttl: number, fresh = false, opts: { quiet?: boolean } = {}): Promise<T> {
  const hit = cache.get(path);
  if (hit && !fresh) {
    if (hit.pending) return (hit.pending as Promise<T>).then((d) => structuredClone(d));
    if (Date.now() - hit.at < ttl) return Promise.resolve(structuredClone(hit.data as T));
  }
  const pending = call<T>(path, undefined, opts);
  const entry = { at: Date.now(), pending: pending as Promise<unknown> };
  cache.set(path, entry);
  pending.then((data) => { if (cache.get(path) === entry) cache.set(path, { at: Date.now(), data }); }, () => { if (cache.get(path) === entry) cache.delete(path); });
  return pending.then((d) => structuredClone(d));
}

const json = (method: string, body?: unknown): RequestInit => ({
  method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body),
});

export const api = {
  health: (fresh = false) => cachedGet<Health>("/api/health", 4000, fresh, { quiet: true }),
  setup: (fresh = false) => cachedGet<SetupReport>("/api/setup", 2000, fresh, { quiet: true }),
  startPull: (which: "llm" | "tts" = "llm") => call<PullStatus>("/api/setup/pull", json("POST", { which }), { quiet: true }),
  pullStatus: () => call<PullStatus>("/api/setup/pull", undefined, { quiet: true }),
  cancelPull: () => call<PullStatus>("/api/setup/pull", json("DELETE"), { quiet: true }),
  stats: () => cachedGet<Stats>("/api/stats", 5000),
  usage: (range: "today" | "all" = "all", provider: "all" | "local" | "cloud" = "all") => call<Usage>(`/api/usage?limit=40&range=${range}&provider=${provider}`),
  ai: () => cachedGet<AIState>("/api/ai", 5000),
  saveAI: (patch: AIUpdate) => call<AIState>("/api/ai", json("PUT", patch)),
  saveKey: (api_key: string) => call<AIState>("/api/ai/key", json("PUT", { api_key })),
  removeKey: () => call<AIState>("/api/ai/key", json("DELETE")),
  testAI: (send_message = false) => call<AITest>("/api/ai/test", json("POST", { send_message })),
  clearUsage: () => call<{ deleted: number }>("/api/usage", json("DELETE")),
  warm: () => call<{ status: "loaded" | "loading" }>("/api/llm/warm", json("POST"), { quiet: true }),
  voices: () => cachedGet<{ engine: "phonon" | "system"; voices: string[]; default: string; speed_supported: boolean; speed_note: string }>("/api/voices", 120_000),
  sttStatus: () => cachedGet<{ available: boolean; model: string; reason: string | null }>("/api/speech/stt", 30_000),
  rubric: () => cachedGet<Rubric>("/api/rubric", 10_000),
  saveRubric: (r: Rubric) => call<Rubric>("/api/rubric", json("PUT", r)),

  sets: () => cachedGet<QSet[]>("/api/sets", 5000),
  createSet: (name: string) => call<QSet>("/api/sets", json("POST", { name })),
  renameSet: (id: number, name: string) => call<QSet>(`/api/sets/${id}`, json("PATCH", { name })),
  deleteSet: (id: number) => call<null>(`/api/sets/${id}`, json("DELETE")),
  questions: (setId: number) => call<Question[]>(`/api/sets/${setId}/questions`),
  addQuestion: (setId: number, q: QuestionInput) => call<Question>(`/api/sets/${setId}/questions`, json("POST", q)),
  updateQuestion: (id: number, q: QuestionInput) => call<Question>(`/api/questions/${id}`, json("PUT", q)),
  deleteQuestion: (id: number) => call<null>(`/api/questions/${id}`, json("DELETE")),
  duplicateQuestion: (id: number) => call<Question>(`/api/questions/${id}/duplicate`, json("POST")),
  reorder: (setId: number, ids: number[]) => call<Question[]>(`/api/sets/${setId}/reorder`, json("POST", { ordered_ids: ids })),
  previewImport: (setId: number, format: "text" | "json", content: string) =>
    call<ImportPreview>(`/api/sets/${setId}/import/preview`, json("POST", { format, content })),
  commitImport: (setId: number, mode: "append" | "replace", questions: QuestionInput[], confirm: boolean) =>
    call<ImportResult>(`/api/sets/${setId}/import/commit`, json("POST", { mode, questions, confirm_replace: confirm })),
  exportSetUrl: (setId: number) => `/api/sets/${setId}/export`,

  interviews: () => cachedGet<HistoryRow[]>("/api/interviews", 3000),
  createInterview: (setId: number | null, config: Partial<InterviewConfig>, resumeQuestions: ResumeQuestionInput[] = []) =>
    call<InterviewState>("/api/interviews", json("POST", { set_id: setId, config, resume_questions: resumeQuestions })),
  interview: (id: number) => call<InterviewState>(`/api/interviews/${id}`, undefined, { quiet: true }),
  answer: (id: number, turnId: number, text: string, source: "typed" | "voice") =>
    call<InterviewState>(`/api/interviews/${id}/answer`, json("POST", { turn_id: turnId, text, source })),
  action: (id: number, action: "retry" | "continue" | "skip", turnId: number) =>
    call<InterviewState>(`/api/interviews/${id}/${action}`, json("POST", { turn_id: turnId })),
  control: (id: number, action: "pause" | "resume" | "end") => call<InterviewState>(`/api/interviews/${id}/${action}`, json("POST")),
  deleteInterview: (id: number) => call<null>(`/api/interviews/${id}`, json("DELETE")),
  clearHistory: () => call<{ deleted: number }>("/api/interviews?confirm=true", json("DELETE")),
  report: (id: number) => call<Report>(`/api/interviews/${id}/report`),
  regenerateReport: (id: number) => call<Report>(`/api/interviews/${id}/report/regenerate`, json("POST")),
  exportReportUrl: (id: number, format: "md" | "json") => `/api/interviews/${id}/report/export?format=${format}`,
  /** Builds the PDF report on the server and saves it as a file (no print dialog). Resolves with the file name. */
  downloadReportPdf: async (id: number): Promise<string> => {
    const res = await call<Response>(`/api/interviews/${id}/report/export?format=pdf`);
    const blob = await res.blob();
    const name = /filename="?([^";]+)"?/i.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? `interview-report-${id}.pdf`;
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = name; a.style.display = "none";
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 15_000);
    return name;
  },
};

// ------------------------------------------------------------------ resumes
export type UploadResult = { kind: "created"; resume: Resume } | { kind: "duplicate"; id: number; name: string };

/** Upload a PDF with real upload progress (XMLHttpRequest: fetch cannot report it). */
export function uploadResume(file: File, opts: { allowDuplicate?: boolean; onProgress?: (fraction: number) => void; signal?: AbortSignal } = {}): Promise<UploadResult> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/api/resumes${opts.allowDuplicate ? "?allow_duplicate=true" : ""}`);
    xhr.responseType = "json";
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) opts.onProgress?.(e.loaded / e.total); };
    xhr.onload = () => {
      const body = xhr.response as { error?: { code: string; message: string }; duplicate_of?: { id: number; name: string } } | null;
      clearApiCache();
      window.dispatchEvent(new Event("lai:data"));
      if (xhr.status >= 200 && xhr.status < 300 && body) {
        if (body.duplicate_of) resolve({ kind: "duplicate", id: body.duplicate_of.id, name: body.duplicate_of.name });
        else resolve({ kind: "created", resume: body as unknown as Resume });
      } else reject(new ApiError(body?.error?.code ?? "http_error", body?.error?.message ?? `Upload failed (${xhr.status}).`, xhr.status));
    };
    xhr.onerror = () => reject(new ApiError("network", "Cannot reach the local server. Is the app still running?"));
    xhr.onabort = () => reject(new ApiError("aborted", "Upload cancelled."));
    opts.signal?.addEventListener("abort", () => xhr.abort());
    const form = new FormData();
    form.append("file", file, file.name);
    xhr.send(form);
  });
}

export const resumesApi = {
  list: (quiet = false) => call<ResumeSummary[]>("/api/resumes", undefined, { quiet }),
  cachedList: () => cachedGet<ResumeSummary[]>("/api/resumes", 3000, false, { quiet: true }),
  get: (id: number, quiet = false) => call<Resume>(`/api/resumes/${id}`, undefined, { quiet }),
  text: (id: number) => call<ResumeText>(`/api/resumes/${id}/text`),
  storage: () => call<ResumeStorage>("/api/resumes/storage"),
  patch: (id: number, revision: number, patch: { name?: string; profile?: ResumeProfile }) => call<Resume>(`/api/resumes/${id}`, json("PATCH", { revision, ...patch })),
  revert: (id: number, revision: number) => call<Resume>(`/api/resumes/${id}/revert`, json("POST", { revision })),
  reparse: (id: number) => call<Resume>(`/api/resumes/${id}/reparse`, json("POST")),
  cancel: (id: number) => call<Resume>(`/api/resumes/${id}/cancel`, json("POST")),
  consent: (id: number, accept: boolean) => call<Resume>(`/api/resumes/${id}/consent`, json("POST", { accept })),
  remove: (id: number) => call<{ deleted: number }>(`/api/resumes/${id}`, json("DELETE")),
  removeAll: () => call<{ deleted: number }>("/api/resumes?confirm=true", json("DELETE")),
  fileUrl: (id: number, download = false) => `/api/resumes/${id}/file${download ? "?download=1" : ""}`,
  generate: (s: GenSettings & { exclude_texts?: string[] }) => call<GenJob>("/api/resumes/questions/generate", json("POST", s)),
  job: (id: string) => call<GenJob>(`/api/resumes/questions/jobs/${id}`, undefined, { quiet: true }),
  cancelJob: (id: string) => call<GenJob>(`/api/resumes/questions/jobs/${id}`, json("DELETE")),
  generateOne: (body: { resume_id: number; claim: DraftQuestion["claim"]; kind?: string; difficulty: GenSettings["difficulty"]; style: GenSettings["style"]; existing_texts: string[] }) =>
    call<DraftQuestion>("/api/resumes/questions/generate-one", json("POST", body)),
  saveToBank: (questions: ResumeQuestionInput[]) => call<{ added: number; skipped: number; sets: { id: number; name: string }[] }>("/api/resumes/questions/save-to-bank", json("POST", { questions })),
};

export async function synthesize(text: string, voice: string, signal?: AbortSignal): Promise<Blob> {
  const res = await call<Response>("/api/speech/synthesize", { ...json("POST", { text, voice }), signal }, { quiet: true });
  const blob = await res.blob();
  if (blob.size < 200) throw new ApiError("empty_audio", "The speech model returned empty audio.");
  return blob;
}

export async function transcribe(blob: Blob): Promise<string> {
  const form = new FormData();
  form.append("audio", blob, "answer.webm");
  const data = await call<{ text: string }>("/api/speech/transcribe", { method: "POST", body: form }, { quiet: true });
  return data.text;
}
