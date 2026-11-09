import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FIRST_PING_MS, MAX_PINGS, PING_EVERY_MS, useModelKeepAlive } from "../pages/useModelKeepAlive";

let ping: ReturnType<typeof vi.fn<() => Promise<unknown>>>;
const setVisible = (v: "visible" | "hidden") => Object.defineProperty(document, "visibilityState", { configurable: true, get: () => v });

beforeEach(() => { vi.useFakeTimers(); ping = vi.fn<() => Promise<unknown>>().mockResolvedValue({ status: "loaded" }); setVisible("visible"); });
afterEach(() => { vi.useRealTimers(); });

describe("model keep-alive while an interview is open", () => {
  it("loads the model early (6 s in), then renews it every 4 minutes", () => {
    renderHook(() => useModelKeepAlive(true, 1, ping));
    expect(ping).not.toHaveBeenCalled();
    vi.advanceTimersByTime(FIRST_PING_MS);
    expect(ping).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(PING_EVERY_MS);
    expect(ping).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(PING_EVERY_MS);
    expect(ping).toHaveBeenCalledTimes(3);
  });

  it("does nothing when no interview is active", () => {
    renderHook(() => useModelKeepAlive(false, 1, ping));
    vi.advanceTimersByTime(PING_EVERY_MS * 3);
    expect(ping).not.toHaveBeenCalled();
  });

  it("stops pinging when the interview stops being active", () => {
    const { rerender } = renderHook(({ on }) => useModelKeepAlive(on, 1, ping), { initialProps: { on: true } });
    vi.advanceTimersByTime(FIRST_PING_MS);
    rerender({ on: false });
    vi.advanceTimersByTime(PING_EVERY_MS * 3);
    expect(ping).toHaveBeenCalledTimes(1);
  });

  it("never pings a hidden tab, so a forgotten tab cannot keep 4 GB loaded", () => {
    setVisible("hidden");
    renderHook(() => useModelKeepAlive(true, 1, ping));
    vi.advanceTimersByTime(FIRST_PING_MS + PING_EVERY_MS * 3);
    expect(ping).not.toHaveBeenCalled();
    setVisible("visible");
    vi.advanceTimersByTime(PING_EVERY_MS);
    expect(ping).toHaveBeenCalledTimes(1);                     // resumes as soon as you are looking at it again
  });

  it("gives up after a bounded number of pings per question (~24 minutes)", () => {
    renderHook(() => useModelKeepAlive(true, 1, ping));
    vi.advanceTimersByTime(FIRST_PING_MS + PING_EVERY_MS * 20);
    expect(ping).toHaveBeenCalledTimes(MAX_PINGS);
  });

  it("starts the cycle again for the next question", () => {
    const { rerender } = renderHook(({ q }) => useModelKeepAlive(true, q, ping), { initialProps: { q: 1 } });
    vi.advanceTimersByTime(FIRST_PING_MS);
    rerender({ q: 2 });
    vi.advanceTimersByTime(FIRST_PING_MS);
    expect(ping).toHaveBeenCalledTimes(2);
  });

  it("ignores a failing request (it is only an optimisation)", async () => {
    ping.mockRejectedValue(new Error("offline"));
    renderHook(() => useModelKeepAlive(true, 1, ping));
    expect(() => vi.advanceTimersByTime(FIRST_PING_MS)).not.toThrow();
    await vi.advanceTimersByTimeAsync(10);
  });
});
