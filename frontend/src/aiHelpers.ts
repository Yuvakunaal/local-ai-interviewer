import type { AIConfig, ModelPrice } from "./types";

/** "$0.0004", "$0.012", "$1.25": enough digits that small cloud costs are never shown as $0.00. */
export const fmtUsd = (n: number | null | undefined) => {
  if (n == null) return "–";
  if (n === 0) return "$0";
  if (n < 0.01) return `$${n.toFixed(4)}`;
  if (n < 1) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(2)}`;
};

/** The names people use for the same cloud model ("gemma4:31b-cloud" in the CLI, "gemma4:31b" in the API). */
export const normaliseModel = (m: string) => m.trim().toLowerCase().replace(/[-:]cloud$/, "");

export const priceKey = (model: string, prices: Record<string, ModelPrice>): string | null => {
  const want = normaliseModel(model);
  return Object.keys(prices).find((k) => normaliseModel(k) === want) ?? null;
};

export const priceFor = (model: string, prices: Record<string, ModelPrice>): ModelPrice | null => {
  const key = priceKey(model, prices);
  return key ? prices[key] : null;
};

/** The dearer (peak) rate: estimates should never promise less than what a call can cost. */
const peakCost = (p: ModelPrice | null, tokensIn: number, tokensOut: number) => (p ? (tokensIn * p.input_per_m + tokensOut * p.output_per_m) / 1_000_000 : null);

// typical sizes measured on real interviews: grading reads ~1,500 tokens and writes ~450 (reasoning models add some); a summary ~700/250; a follow-up writer ~400/80
const GRADE = [1500, 700], SUMMARY = [700, 250], FOLLOWUP = [400, 150];

/** Upper-bound cost of an interview in cloud mode, or null when a model used has no price (so the UI says "unknown", never "free"). */
export function estimateInterviewCost(cfg: AIConfig, questions: number, maxFollowups: number): number | null {
  const grader = peakCost(priceFor(cfg.grader_model, cfg.prices), GRADE[0], GRADE[1]);
  const summary = peakCost(priceFor(cfg.grader_model, cfg.prices), SUMMARY[0], SUMMARY[1]);
  const convo = peakCost(priceFor(cfg.conversation_model, cfg.prices), FOLLOWUP[0], FOLLOWUP[1]);
  if (grader == null || summary == null || convo == null || questions <= 0) return questions <= 0 ? 0 : null;
  const answers = questions * (1 + maxFollowups);                    // every question could use all its follow-ups
  return answers * grader + questions * maxFollowups * convo + summary;
}

export const TASK_ROLE: Record<string, "grader" | "conversation"> = { evaluation: "grader", summary: "grader", repair: "conversation", followup: "conversation" };

/** Same rules the server applies to a pasted key (8–512 characters, no spaces); an accidental "Bearer " prefix is dropped. */
export const cleanKeyDraft = (raw: string) => { const k = raw.trim(); return /^bearer\s/i.test(k) ? k.slice(7).trim() : k; };
export type KeyCheck = { state: "empty" | "short" | "spaces" | "ok"; text: string };
export function checkKeyDraft(raw: string): KeyCheck {
  const k = cleanKeyDraft(raw);
  if (!k) return { state: "empty", text: "Copy the whole key from ollama.com/settings/keys, then press Paste (or ⌘V / Ctrl+V)." };
  if (/\s/.test(k)) return { state: "spaces", text: "There are spaces inside this key. Copy it again without them." };
  if (k.length < 8) return { state: "short", text: "That looks too short. Copy the whole key." };
  return { state: "ok", text: `Looks right · ${k.length} characters. It is checked when you test the connection.` };
}

// ---------------------------------------------------------------- model pickers (Settings → AI models)
export type ModelRole = "grader" | "fallback" | "conversation";
/** The only three models this app is built around, one recommended per role. Every dropdown offers exactly these. */
export const SUPPORTED_MODELS = ["gpt-oss:120b", "deepseek-v4.1-flash", "gemma4:31b"] as const;
export const RECOMMENDED: Record<ModelRole, string> = { grader: "gpt-oss:120b", fallback: "deepseek-v4.1-flash", conversation: "gemma4:31b" };
/** Prices are always shown with three decimals so a row reads "$0.150 in · $0.600 out" (never "$0.15" next to "$1.2"). */
export const fmtRate = (n: number) => `$${n.toFixed(3)}`;
export interface ModelOption { value: string; label: string }

/** The dropdown for one role: the three supported models in a fixed order, the role's own one marked "(recommended)". */
export function modelOptions(role: ModelRole): ModelOption[] {
  return SUPPORTED_MODELS.map((m) => ({ value: m, label: m === RECOMMENDED[role] ? `${m} (recommended)` : m }));
}

/** Which dropdown entry stands for this model name (the CLI spelling "x-cloud" matches "x"), or null for any other name. */
export function selectedOption(value: string, options: ModelOption[]): string | null {
  const want = normaliseModel(value);
  return options.find((o) => normaliseModel(o.value) === want)?.value ?? null;
}
