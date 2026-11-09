export type Difficulty = "easy" | "medium" | "hard";
export interface QSet { id: number; name: string; question_count: number }
export interface Question { id: number; set_id: number; position: number; text: string; rubric: string | null; topic: string | null; difficulty: Difficulty | null }
export interface QuestionInput { text: string; rubric?: string | null; topic?: string | null; difficulty?: Difficulty | null }

export interface ImportItem { text: string; rubric?: string | null; topic?: string | null; difficulty?: string | null; duplicate?: "existing" | "batch" | null; error?: string | null }
export interface ImportPreview { items: ImportItem[]; count: number; duplicates: number; errors: string[]; warnings: string[]; set_name?: string | null }
export interface ImportResult { added: number; skipped_duplicates: number; removed: number; backup_file: string | null }

export interface InterviewConfig {
  title: string; interview_type: "technical" | "hr" | "scenario" | "mixed"; question_ids: number[] | null;
  order: "supplied" | "shuffled"; max_followups: number; voice: string; speech_speed: number;
  strictness: "lenient" | "balanced" | "strict"; feedback_mode: "immediate" | "after_followups" | "at_end";
  question_audio: "auto" | "manual"; mic_enabled: boolean;
  include_bank?: boolean; mix?: MixOrder;
}
export type MixOrder = "bank_first" | "resume_first" | "interleave" | "shuffled";

export interface Evaluation {
  correct_points: string[]; missing_concepts: string[]; misconceptions: string[];
  dimension_scores: Record<string, number>; production_relevant: boolean; suggested_improvements: string[];
  verdict_summary?: string; ideal_answer: string; confidence: "high" | "medium" | "low"; uncertainty_note: string;
  needs_followup: boolean; followup_reason: string; score: number; verdict: string;
  followup_asked: boolean; followup_suppressed_reason?: string | null;
  question_level?: "basic" | "standard" | "advanced"; interpreted_answer?: string | null;
  graded_by?: { provider: "local" | "cloud"; model: string; fell_back_from?: string | null; reason?: string | null } | null;
}
export interface Turn {
  id: number; seq: number; kind: "main" | "followup"; question_text: string; status: "asked" | "submitted" | "evaluated" | "skipped";
  answer_text: string | null; answer_source: string | null; followup_reason: string | null; eval_attempts: number;
  evaluation?: Evaluation; score?: number;
}
export interface ItemView { id: number; position: number; text: string; topic: string | null; difficulty: string | null; status: string; followup_count: number; score: number | null; source?: "bank" | "resume"; resume_name?: string | null }
export interface InterviewState {
  id: number; title: string; interview_type: string; status: "in_progress" | "paused" | "completed" | "ended";
  phase: "awaiting_answer" | "evaluating" | "evaluation_failed" | "feedback" | "done"; error: string | null;
  config: InterviewConfig; current_turn_id: number | null; created_at: string; completed_at: string | null;
  progress: { total: number; finished: number; answered: number; skipped: number; unanswered: number; position: number | null };
  items: ItemView[];
  current: null | {
    item: { id: number; position: number; text: string; topic: string | null; difficulty: string | null; followup_count: number; followups_max: number; followups_remaining: number; source?: "bank" | "resume"; resume_name?: string | null };
    turn: Turn | null; thread: Turn[]; pending_followup: { question: string; reason: string | null } | null;
  };
  next_action: "followup" | "next_question" | "finish" | null; has_report: boolean;
}
export interface HistoryRow { id: number; title: string; interview_type: string; status: string; phase: string; created_at: string; updated_at: string; completed_at: string | null; total: number; answered: number; skipped: number; has_report: number; average_score: number | null }

export interface ReportTurn { seq: number; kind: string; question: string; answer: string | null; source: string | null; status: string; score: number | null; evaluation: Evaluation | null }
export interface ReportQuestion { position: number; text: string; topic: string | null; difficulty: string | null; status: string; score: number | null; verdict: string | null; followups_asked: number; turns: ReportTurn[];
  source?: "bank" | "resume"; resume_id?: number | null; resume_name?: string | null; resume_deleted?: boolean; claim?: Claim | null }
export interface ResumeClaimResult { resume_id: number | null; resume_name: string; section: string; label: string; average_score: number; verdict: "Solid" | "Shaky" | "Weak"; questions: number; scored: number; question_numbers: number[]; tip: string; resume_deleted?: boolean }
export interface Insights { overall_summary: string; strengths: string[]; knowledge_gaps: string[]; repeated_misconceptions: string[]; topics_to_revise: string[]; recommendations: string[] }
export interface Report {
  interview: { id: number; title: string; type: string; status: string; created_at: string; completed_at: string | null; config: InterviewConfig };
  summary: { total_questions: number; answered: number; skipped: number; unanswered: number; scored: number; answered_not_scored: number; average_score: number | null; followups_asked: number; verdict: string | null };
  topics: { topic: string; questions: number; scored: number; average_score: number | null }[];
  ai_usage?: { calls: number; prompt_tokens: number; output_tokens: number; seconds: number; cost_usd: number | null; by_provider: Record<string, { calls: number; cost_usd: number | null; unpriced_calls: number }> };
  questions: ReportQuestion[]; scoring_rules: string[]; skills?: { key: string; label: string; average: number | null; answers: number }[]; insights: Insights; insights_source: "model" | "rules";
  narrative_status: "pending" | "ready" | "failed"; narrative_error: string | null;
  resume_claims?: ResumeClaimResult[];
}
export interface Health {
  ollama: { ok: boolean; host: string; version: string | null; error: string | null };
  llm: { model: string; installed: boolean; loaded: boolean; error: string | null };
  tts: { model: string; provider: "auto" | "phonon" | "system"; engine: "phonon" | "system"; installed: boolean; voices: number; error: string | null; note: string | null };
  stt: { available: boolean; model: string; reason: string | null };
  bind: string; local_only: boolean; platform: string;
  memory?: { total_gb: number; available_gb: number; needs_gb: number; tight: boolean } | null;
  ai: { mode: "local" | "cloud"; processing: "local" | "cloud"; ready: boolean | null; grader_model: string | null; key_set: boolean; consented: boolean; budget: Budget | null; last_test_ok: boolean | null };
  ocr?: OcrStatus;
}
export interface OcrStatus { available: boolean; enabled: boolean; version: string | null; reason: string | null; install: string; install_all: Record<string, string>; os: "macos" | "windows" | "linux" }
export interface ModelPrice { input_per_m: number; output_per_m: number; offpeak_input_per_m: number | null; offpeak_output_per_m: number | null }
export interface BudgetPart { spent_usd: number; limit_usd: number | null; percent: number | null; reached: boolean }
export interface Budget { enforced: boolean; today: BudgetPart; total: BudgetPart }
export interface AIConfig {
  mode: "local" | "cloud"; cloud_consent_at: string | null; grader_model: string; fallback_model: string; use_fallback: boolean; conversation_model: string;
  fallback_to_local: boolean; enforce_budget: boolean; daily_budget_usd: number | null; total_budget_usd: number | null; prices: Record<string, ModelPrice>;
}
export interface AITest {
  at: string; ok: boolean; key_ok: boolean; models: string[]; missing: Record<string, string>; suggestions: Record<string, string[]>; message?: string; code?: string;
  message_test: { ok: boolean; model: string; text?: string; code?: string; message?: string; prompt_tokens?: number; output_tokens?: number } | null;
}
export interface AIState {
  mode: "local" | "cloud"; ready: boolean; config: AIConfig; key: { set: boolean; source: "saved" | "environment" | null; hint: string | null };
  budget: Budget; last_test: AITest | null; local_model: string; roles: Record<string, string>; sent_to_cloud: string[]; stays_local: string[];
}
export type AIUpdate = Partial<Omit<AIConfig, "cloud_consent_at" | "mode">> & { mode?: "local" | "cloud"; acknowledge_cloud?: boolean; clear_daily_budget?: boolean; clear_total_budget?: boolean };
export interface Stats {
  interviews: number; completed: number; this_week: number; questions_answered: number;
  average_score: number | null; best_score: number | null; delta: number | null; streak_days: number;
  trend: { id: number; title: string; date: string; score: number }[];
  topics: { topic: string; average_score: number; questions: number; untagged: boolean }[];
}
export interface Usage {
  range: "today" | "all"; provider: "all" | "local" | "cloud"; mode: "local" | "cloud"; budget: Budget; prices_note: string;
  loaded: { model: string; size_gb: number; gpu_percent: number | null; context: number | null; unloads_in_seconds: number | null }[];
  summary: UsageSummary[];
  recent: UsageCall[];
  totals: { all_time: UsageTotal; today: UsageTotal };
}
export interface UsageSummary {
  provider: "local" | "cloud"; cost_usd: number | null; unpriced_calls: number;
  model: string; purpose: string; calls: number; prompt_tokens: number; output_tokens: number;
  avg_seconds: number; total_seconds: number; fastest_seconds: number; slowest_seconds: number;
  avg_load_seconds: number; avg_read_seconds: number; avg_write_seconds: number;
  tokens_per_second: number | null; model_loads: number; last_at: string;
}
export interface UsageCall {
  provider: "local" | "cloud"; cost_usd: number | null;
  id: number; at: string; model: string; purpose: string; prompt_tokens: number | null; output_tokens: number | null;
  load_seconds: number; read_seconds: number; write_seconds: number; seconds: number; tokens_per_second: number | null; detail: string | null;
  interview_id: number | null; interview_title: string | null; interview_status: string | null; has_report: boolean; label: string | null;
}
export interface UsageTotal { calls: number; prompt_tokens: number; output_tokens: number; seconds: number; cost_usd: number; cloud_calls: number; unpriced_calls: number }
export interface Rubric { correctness: number; completeness: number; depth: number; practical_application: number; clarity: number; production_awareness: number; extra_guidance: string }

export interface SetupHelp { summary: string; steps: { title: string; url?: string; command?: string }[] }
export interface SetupItem { id: string; label: string; required: boolean; status: "ok" | "missing" | "warn" | "optional"; detail: string; action?: "pull_llm" | "open_ai_settings" | null; help?: SetupHelp }
export interface SetupReport {
  os: "macos" | "windows" | "linux"; ready: boolean; needs_setup: boolean; mode: "local" | "cloud"; local_ready: boolean; items: SetupItem[]; blocking: string[];
  alternatives: { cloud_key_ready: boolean }; downloads: { model: string; size_gb: number | null; free_gb: number | null };
}
export interface PullStatus { state: "idle" | "pulling" | "done" | "error" | "cancelled"; model: string | null; status: string; completed: number; total: number; percent: number | null; error: string | null }

// ------------------------------------------------------------------ resumes
export type ResumeStatus = "uploaded" | "extracting" | "ocr" | "structuring" | "ready" | "failed";
export interface ResumeSummary {
  id: number; name: string; original_filename: string; size_bytes: number; pages: number; status: ResumeStatus; stage_detail: string | null;
  error_code: string | null; error_message: string | null; extraction_method: "text" | "ocr" | "mixed" | null; consent_cloud: number | null; revision: number;
  created_at: string; updated_at: string; last_parsed_at: string | null; has_profile: boolean; skills_preview: string[]; warnings: number;
}
export interface Resume extends ResumeSummary { profile: ResumeProfile | null; has_ai_profile: boolean; has_text: boolean }
export interface ResumeContact { name: string; email: string; phone: string; location: string; links: string[] }
export interface SkillGroup { group: string; items: string[] }
export interface ExperienceEntry { company: string; title: string; location: string; start: string; end: string; is_current: boolean; bullets: string[] }
export interface ProjectEntry { name: string; role: string; tech: string[]; link: string; bullets: string[] }
export interface EducationEntry { school: string; degree: string; field: string; start: string; end: string; details: string }
export interface ResumeProfile {
  contact: ResumeContact; summary: string; skills: SkillGroup[]; experience: ExperienceEntry[]; projects: ProjectEntry[]; education: EducationEntry[];
  certifications: string[]; achievements: string[]; other: string[]; parse_warnings: string[];
}
export interface ResumeText { id: number; raw_text: string; extraction_method: "text" | "ocr" | "mixed" | null; pages: number }
export interface ResumeStorage { count: number; bytes: number; file_bytes: number; max_mb: number; max_pages: number; ocr: OcrStatus & { path: string | null; langs: string }; pdf_support: boolean }
export interface Claim { section: string; label: string; excerpt: string }
export type FocusArea = "experience" | "projects" | "skills" | "achievements" | "education" | "behavioural" | "gaps";
export type Depth = "overview" | "standard" | "deep";
export type GenDifficulty = "mixed" | "easy" | "medium" | "hard";
export type InterviewerStyle = "recruiter" | "manager" | "skeptic";
export interface DraftQuestion { uid?: string; text: string; rubric: string | null; topic: string | null; difficulty: Difficulty | null; kind: string; resume_id: number; resume_name: string; claim: Claim; focus?: string }
export interface GenJob { id: string; state: "running" | "done" | "error" | "cancelled"; done: number; total: number; requested: number; questions: DraftQuestion[]; warnings: string[]; error: string | null; error_code: string | null }
export interface GenSettings { resume_ids: number[]; count: number; focus: FocusArea[]; depth: Depth; difficulty: GenDifficulty; style: InterviewerStyle }
export interface ResumeQuestionInput { text: string; rubric: string | null; topic: string | null; difficulty: Difficulty | null; kind?: string; resume_id: number | null; resume_name: string | null; claim: Claim | null }
