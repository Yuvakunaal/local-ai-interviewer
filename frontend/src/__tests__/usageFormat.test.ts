import { describe, expect, it } from "vitest";
import type { UsageSummary } from "../types";
import { TASK, headline, taskLabel } from "../pages/usageFormat";

const row = (o: Partial<UsageSummary>): UsageSummary => ({
  provider: "cloud", cost_usd: 0, unpriced_calls: 0, model: "gpt-oss:120b", purpose: "evaluation", calls: 1, prompt_tokens: 1000, output_tokens: 400, avg_seconds: 5, total_seconds: 5, fastest_seconds: 5,
  slowest_seconds: 5, avg_load_seconds: 0, avg_read_seconds: 0.5, avg_write_seconds: 4, tokens_per_second: 100, model_loads: 0, last_at: "", ...o,
});

describe("usage purposes", () => {
  it("every kind of call the backend records has a plain-English name (no raw 'followup' or 'test' on screen)", () => {
    for (const purpose of ["evaluation", "repair", "summary", "followup", "warm", "speech", "test"]) {
      expect(TASK[purpose], purpose).toBeDefined();
      expect(taskLabel(purpose)).not.toBe(purpose);
    }
    expect(taskLabel("something-new")).toBe("something-new");          // an unknown future purpose still shows, never crashes
  });
});

describe("headline numbers with cloud costs", () => {
  it("adds up cost and counts cloud calls", () => {
    const h = headline([row({ cost_usd: 0.00042, calls: 2 }), row({ purpose: "followup", model: "gemma4:31b", cost_usd: 0.000088 }), row({ provider: "local", cost_usd: null, model: "qwen3.5:4b" })]);
    expect(h.cost).toBe(0.000508);
    expect(h.cloudCalls).toBe(3);
    expect(h.calls).toBe(4);
  });
  it("reports calls with no price as unknown instead of counting them as free", () => {
    const h = headline([row({ cost_usd: 0, unpriced_calls: 2, calls: 2, model: "kimi-k3" })]);
    expect(h.unpriced).toBe(2);
    expect(h.cost).toBe(0);
  });
  it("shows no cost for a local-only day", () => {
    const h = headline([row({ provider: "local", cost_usd: null, model: "qwen3.5:4b" })]);
    expect(h.cloudCalls).toBe(0);
    expect(h.cost).toBe(0);
  });
});
