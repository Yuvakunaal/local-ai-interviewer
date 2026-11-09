import { describe, expect, it } from "vitest";
import { checkKeyDraft, cleanKeyDraft, estimateInterviewCost, fmtRate, fmtUsd, modelOptions, normaliseModel, priceFor, priceKey, RECOMMENDED, selectedOption, SUPPORTED_MODELS } from "../aiHelpers";
import type { AIConfig, ModelPrice } from "../types";
import { ago, isActive } from "../components/ActiveInterviews";
import { chipsFor, clip, questionNote } from "../scorecardHelpers";

const P = (i: number, o: number, oi: number | null = null, oo: number | null = null): ModelPrice => ({ input_per_m: i, output_per_m: o, offpeak_input_per_m: oi, offpeak_output_per_m: oo });
const CFG: AIConfig = {
  mode: "cloud", cloud_consent_at: "x", grader_model: "gpt-oss:120b", fallback_model: "deepseek-v4.1-flash", use_fallback: true, conversation_model: "gemma4:31b", fallback_to_local: false,
  enforce_budget: true, daily_budget_usd: 1, total_budget_usd: null,
  prices: { "gpt-oss:120b": P(0.15, 0.6), "deepseek-v4.1-flash": P(0.3, 1.2, 0.15, 0.6), "gemma4:31b": P(0.14, 0.4) },
};

describe("money formatting", () => {
  it("never shows a real cloud cost as $0.00", () => {
    expect(fmtUsd(0.000405)).toBe("$0.0004");
    expect(fmtUsd(0.0123)).toBe("$0.012");
    expect(fmtUsd(1.5)).toBe("$1.50");
    expect(fmtUsd(0)).toBe("$0");
    expect(fmtUsd(null)).toBe("–");
  });
});

describe("model names and prices", () => {
  it("treats the CLI and API spellings as the same model", () => {
    expect(normaliseModel("Gemma4:31b-cloud")).toBe("gemma4:31b");
    expect(priceFor("gemma4:31b:cloud", CFG.prices)).toBe(CFG.prices["gemma4:31b"]);
    expect(priceFor("kimi-k3", CFG.prices)).toBeNull();
  });
});

describe("interview cost estimate", () => {
  it("is a small, honest upper bound for the default models", () => {
    const one = estimateInterviewCost(CFG, 1, 0)!;
    expect(one).toBeGreaterThan(0.0003);
    expect(one).toBeLessThan(0.002);                                    // about a tenth of a cent per question
    const ten = estimateInterviewCost(CFG, 10, 2)!;
    expect(ten).toBeGreaterThan(one * 10);                              // follow-ups are counted
    expect(ten).toBeLessThan(0.1);                                      // a 10-question interview costs well under ten cents
  });
  it("uses the dearer peak price of a model that has an off-peak discount", () => {
    const ds = { ...CFG, grader_model: "deepseek-v4.1-flash" };
    expect(estimateInterviewCost(ds, 5, 1)!).toBeGreaterThan(estimateInterviewCost(CFG, 5, 1)!);
  });
  it("says unknown, not free, when a model has no price", () => {
    expect(estimateInterviewCost({ ...CFG, grader_model: "kimi-k3" }, 3, 1)).toBeNull();
  });
  it("costs nothing for an interview with no questions", () => {
    expect(estimateInterviewCost(CFG, 0, 2)).toBe(0);
  });
});

describe("API key draft", () => {
  it("drops an accidental Bearer prefix and surrounding spaces", () => {
    expect(cleanKeyDraft("  Bearer abcdefgh12345  ")).toBe("abcdefgh12345");
    expect(cleanKeyDraft("bearer   k")).toBe("k");
    expect(cleanKeyDraft("abcdefgh")).toBe("abcdefgh");
  });
  it("mirrors the server rules (8+ characters, no inner spaces)", () => {
    expect(checkKeyDraft("").state).toBe("empty");
    expect(checkKeyDraft("   ").state).toBe("empty");
    expect(checkKeyDraft("abc").state).toBe("short");
    expect(checkKeyDraft("abcdefg").state).toBe("short");
    expect(checkKeyDraft("abcdefgh").state).toBe("ok");
    expect(checkKeyDraft("abcd efgh1234").state).toBe("spaces");
    expect(checkKeyDraft("Bearer abcdefgh1234").state).toBe("ok");
    expect(checkKeyDraft("abcdefgh1234").text).toContain("12 characters");
  });
  it("never echoes the key itself in its message", () => {
    for (const k of ["secret-abcdef-123", "abc def", "x"]) expect(checkKeyDraft(k).text).not.toContain(k);
  });
});

describe("model pickers", () => {
  it("offers exactly the three supported models in every dropdown, marking each role's own recommendation", () => {
    expect(SUPPORTED_MODELS).toEqual(["gpt-oss:120b", "deepseek-v4.1-flash", "gemma4:31b"]);
    expect(RECOMMENDED).toEqual({ grader: "gpt-oss:120b", fallback: "deepseek-v4.1-flash", conversation: "gemma4:31b" });
    expect(modelOptions("grader").map((o) => o.label)).toEqual(["gpt-oss:120b (recommended)", "deepseek-v4.1-flash", "gemma4:31b"]);
    expect(modelOptions("fallback").map((o) => o.label)).toEqual(["gpt-oss:120b", "deepseek-v4.1-flash (recommended)", "gemma4:31b"]);
    expect(modelOptions("conversation").map((o) => o.label)).toEqual(["gpt-oss:120b", "deepseek-v4.1-flash", "gemma4:31b (recommended)"]);
    for (const role of ["grader", "fallback", "conversation"] as const) expect(modelOptions(role).map((o) => o.value)).toEqual([...SUPPORTED_MODELS]);
  });
  it("matches the CLI spelling to the same entry and returns null for any other name", () => {
    const o = modelOptions("grader");
    expect(selectedOption("gpt-oss:120b-cloud", o)).toBe("gpt-oss:120b");
    expect(selectedOption("  GEMMA4:31B ", o)).toBe("gemma4:31b");
    expect(selectedOption("kimi-k3", o)).toBeNull();
    expect(selectedOption("", o)).toBeNull();
  });
  it("shows rates with a steady three decimals", () => {
    expect(fmtRate(0.15)).toBe("$0.150");
    expect(fmtRate(0.6)).toBe("$0.600");
    expect(fmtRate(1.2)).toBe("$1.200");
  });
});

describe("price list lookups", () => {
  const prices = { "gpt-oss:20b": P(0.07, 0.3), "gpt-oss:120b": P(0.15, 0.6) };
  it("finds an exact entry (either spelling) and never guesses a family", () => {
    expect(priceKey("gpt-oss:120b-cloud", prices)).toBe("gpt-oss:120b");
    expect(priceFor("gpt-oss:20b", prices)?.input_per_m).toBe(0.07);
    expect(priceFor("gpt-oss", prices)).toBeNull();
    expect(priceFor("gemma4:31b", prices)).toBeNull();
    expect(priceFor("", prices)).toBeNull();
  });
});

describe("active interview bar helpers", () => {
  const now = Date.parse("2026-11-01T12:00:00Z");
  it("describes how long ago something happened", () => {
    expect(ago("2026-11-01T11:59:40Z", now)).toBe("just now");
    expect(ago("2026-11-01T11:48:00Z", now)).toBe("12 min ago");
    expect(ago("2026-11-01T09:00:00Z", now)).toBe("3 h ago");
    expect(ago("2026-10-30T12:00:00Z", now)).toBe("2 days ago");
    expect(ago("2026-10-31T12:00:00Z", now)).toBe("1 day ago");
    expect(ago(null, now)).toBe("earlier");
    expect(ago("not a date", now)).toBe("earlier");
  });
  it("counts running and paused interviews as active, nothing else", () => {
    const row = (status: string) => ({ status }) as never;
    expect(["in_progress", "paused"].map((s) => isActive(row(s)))).toEqual([true, true]);
    expect(["completed", "ended"].map((s) => isActive(row(s)))).toEqual([false, false]);
  });
});

describe("scorecard helpers", () => {
  const turn = (kind: string, status: string, score: number | null) => ({ kind, status, score }) as never;
  it("labels the answer and each follow-up with its own score", () => {
    const chips = chipsFor({ turns: [turn("main", "evaluated", 8), turn("followup", "evaluated", 6.5), turn("followup", "evaluated", 9)] });
    expect(chips).toEqual([{ label: "Answer", score: 8, note: null }, { label: "Follow-up 1", score: 6.5, note: null }, { label: "Follow-up 2", score: 9, note: null }]);
  });
  it("says why a turn has no score instead of showing a zero", () => {
    expect(chipsFor({ turns: [turn("main", "evaluated", 7), turn("followup", "skipped", null)] })[1]).toEqual({ label: "Follow-up 1", score: null, note: "skipped" });
    expect(chipsFor({ turns: [turn("main", "submitted", null)] })[0].note).toBe("not scored");
    expect(chipsFor({ turns: [turn("main", "evaluated", 5), turn("followup", "asked", null)] })[1].note).toBe("not answered");
    expect(chipsFor({ turns: [] })).toEqual([]);
  });
  it("describes a question without a score", () => {
    expect(questionNote({ status: "skipped", score: null })).toBe("Skipped");
    expect(questionNote({ status: "unanswered", score: null })).toBe("Not reached");
    expect(questionNote({ status: "answered", score: null })).toBe("Not scored");
    expect(questionNote({ status: "answered", score: 7 })).toBeNull();
  });
  it("shortens long questions on a single line", () => {
    expect(clip("a  b\n c", 50)).toBe("a b c");
    expect(clip("x".repeat(200), 20)).toHaveLength(20);
    expect(clip("x".repeat(200), 20).endsWith("…")).toBe(true);
  });
});
