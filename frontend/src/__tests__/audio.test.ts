import { describe, expect, it, vi, beforeEach } from "vitest";
import { AudioController } from "../audio";
import type { SpeakOptions, SystemSpeech } from "../systemVoices";

class FakeAudio {
  static instances: FakeAudio[] = [];
  playbackRate = 1; preservesPitch = false; paused = true; muted = false; currentTime = 0; duration = 4; ontimeupdate: null | (() => void) = null; onloadedmetadata: null | (() => void) = null; onended: null | (() => void) = null; onerror: null | (() => void) = null;
  constructor(public src: string) { FakeAudio.instances.push(this); }
  play = vi.fn(async () => { this.paused = false; });
  pause = vi.fn(() => { this.paused = true; });
}

const blob = () => new Blob([new Uint8Array(500)], { type: "audio/wav" });
const deferred = () => { let resolve!: (b: Blob) => void; const p = new Promise<Blob>((r) => (resolve = r)); return { p, resolve }; };

beforeEach(() => {
  FakeAudio.instances = [];
  URL.createObjectURL = vi.fn(() => "blob:x");
  URL.revokeObjectURL = vi.fn();
});

const make = (fetcher: ConstructorParameters<typeof AudioController>[0]) => {
  const c = new AudioController(fetcher, (u) => new FakeAudio(u) as unknown as HTMLAudioElement, null);
  c.setEngine("phonon");
  return c;
};

describe("AudioController", () => {
  it("plays once and reports status", async () => {
    const c = make(async () => blob());
    await c.play("q1", "Hello", "Harper");
    expect(c.getSnapshot().status).toBe("playing");
    expect(FakeAudio.instances).toHaveLength(1);
    FakeAudio.instances[0].onended?.();
    expect(c.getSnapshot().status).toBe("idle");
  });

  it("a newer request supersedes a slow older one (no duplicate/stale playback)", async () => {
    const slow = deferred();
    const fetcher = vi.fn()
      .mockImplementationOnce(() => slow.p)
      .mockImplementationOnce(async () => blob());
    const c = make(fetcher);
    const first = c.play("q1", "Question one", "Harper");
    await c.play("q2", "Question two", "Harper");
    slow.resolve(blob());
    await first;
    expect(FakeAudio.instances).toHaveLength(1);
    expect(c.getSnapshot().key).toBe("q2");
  });

  it("replaying the previous audio stops it before starting again", async () => {
    const c = make(async () => blob());
    await c.play("q1", "Same", "Harper");
    const a = FakeAudio.instances[0];
    await c.play("q1", "Same", "Harper");
    expect(a.pause).toHaveBeenCalled();
    expect(FakeAudio.instances).toHaveLength(2);
    expect(FakeAudio.instances.filter((x) => !x.paused)).toHaveLength(1);
  });

  it("caches audio per voice+text", async () => {
    const fetcher = vi.fn(async () => blob());
    const c = make(fetcher);
    await c.play("a", "Text", "Harper");
    await c.play("a", "Text", "Harper");
    await c.play("a", "Text", "Hugh");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("stop() cancels in-flight synthesis and playback", async () => {
    const slow = deferred();
    const c = make(() => slow.p);
    const p = c.play("q", "x", "v");
    c.stop();
    slow.resolve(blob());
    await p;
    expect(FakeAudio.instances).toHaveLength(0);
    expect(c.getSnapshot().status).toBe("idle");
  });

  it("surfaces generation errors and autoplay blocking", async () => {
    const c = make(async () => { throw new Error("Speech generation failed (HTTP 502)."); });
    await c.play("q", "x", "v");
    expect(c.getSnapshot()).toMatchObject({ status: "error", error: expect.stringContaining("502") });
    const blocked = new AudioController(async () => blob(), (u) => {
      const a = new FakeAudio(u);
      a.play = vi.fn(async () => { throw Object.assign(new Error("x"), { name: "NotAllowedError" }); });
      return a as unknown as HTMLAudioElement;
    });
    await blocked.play("q", "x", "v");
    expect(blocked.getSnapshot().status).toBe("blocked");
  });

  it("applies playback rate with pitch preserved", async () => {
    const c = make(async () => blob());
    c.setRate(1.25);
    await c.play("q", "x", "v");
    expect(FakeAudio.instances[0].playbackRate).toBe(1.25);
    expect(FakeAudio.instances[0].preservesPitch).toBe(true);
    c.setRate(0.9);
    expect(FakeAudio.instances[0].playbackRate).toBe(0.9);
  });

  it("pause/resume keeps the clip, and mute/time are reflected in the snapshot", async () => {
    const c = make(async () => blob());
    await c.play("q", "x", "v");
    const a = FakeAudio.instances[0];
    a.onloadedmetadata?.(); a.currentTime = 1.5; a.ontimeupdate?.();
    expect(c.getSnapshot()).toMatchObject({ status: "playing", duration: 4, currentTime: 1.5 });
    c.togglePause();
    expect(c.getSnapshot().status).toBe("paused"); expect(a.pause).toHaveBeenCalled();
    c.togglePause(); await Promise.resolve();
    expect(FakeAudio.instances).toHaveLength(1);                       // resumed the same element, not a second playback
    expect(c.getSnapshot().status).toBe("playing");
    c.setMuted(true);
    expect(a.muted).toBe(true); expect(c.getSnapshot().muted).toBe(true);
    c.stop();
    expect(c.getSnapshot()).toMatchObject({ status: "idle", currentTime: 0, duration: 0 });
  });
});


/** Records what the OS speech engine was asked to say, and lets a test fire its events. */
class FakeSystemSpeech implements SystemSpeech {
  spoken: { text: string; o: SpeakOptions }[] = [];
  cancels = 0;
  voices = async () => [];
  speak = (text: string, o: SpeakOptions) => { this.spoken.push({ text, o }); };
  cancel = () => { this.cancels++; };
  get last() { return this.spoken[this.spoken.length - 1]; }
}
const makeSystem = () => {
  const sys = new FakeSystemSpeech();
  const fetcher = vi.fn(async () => blob());
  const c = new AudioController(fetcher, (u) => new FakeAudio(u) as unknown as HTMLAudioElement, sys);
  c.setEngine("system");
  return { c, sys, fetcher };
};

describe("AudioController with the system voice engine (Windows / Linux / no Phonon)", () => {
  it("speaks through the OS voice and never asks the server for audio", async () => {
    const { c, sys, fetcher } = makeSystem();
    await c.play("q1", "What is idempotency in a pipeline?", "Harper");   // a stale Phonon voice name falls back to the default voice
    expect(fetcher).not.toHaveBeenCalled();
    expect(FakeAudio.instances).toHaveLength(0);
    expect(sys.last.text).toBe("What is idempotency in a pipeline?");
    expect(sys.last.o.voiceId).toBeNull();
    expect(c.getSnapshot().status).toBe("loading");
    sys.last.o.onstart();
    expect(c.getSnapshot().status).toBe("playing");
    sys.last.o.onend();
    expect(c.getSnapshot()).toMatchObject({ status: "idle", key: null });
  });

  it("uses the chosen system voice and the requested speed (which the OS engine supports natively)", async () => {
    const { c, sys } = makeSystem();
    c.setRate(1.25);
    await c.play("q1", "Hello there", "sys:Microsoft David - English (United States)");
    expect(sys.last.o).toMatchObject({ voiceId: "sys:Microsoft David - English (United States)", rate: 1.25, volume: 1 });
  });

  it("a sys: voice is spoken locally even if the server says Phonon is active", async () => {
    const fetcher = vi.fn(async () => blob());
    const sys = new FakeSystemSpeech();
    const c = new AudioController(fetcher, (u) => new FakeAudio(u) as unknown as HTMLAudioElement, sys);
    c.setEngine("phonon");
    await c.play("q1", "Hi", "sys:Samantha");
    expect(fetcher).not.toHaveBeenCalled();
    expect(sys.spoken).toHaveLength(1);
  });

  it("progress follows word boundaries", async () => {
    const { c, sys } = makeSystem();
    await c.play("q1", "0123456789", "default");
    sys.last.o.onstart();
    sys.last.o.onboundary(5);
    const s = c.getSnapshot();
    expect(s.duration).toBeGreaterThan(0);
    expect(s.currentTime).toBeCloseTo(s.duration / 2, 5);
  });

  it("pause cancels and resume continues from the last word instead of restarting", async () => {
    const { c, sys } = makeSystem();
    await c.play("q1", "First part. Second part.", "default");
    sys.last.o.onstart();
    sys.last.o.onboundary(12);
    c.togglePause();
    expect(c.getSnapshot().status).toBe("paused");
    const cancelsAtPause = sys.cancels;
    sys.spoken[0].o.onend();                                    // a late event from the cancelled utterance is ignored
    expect(c.getSnapshot().status).toBe("paused");
    c.togglePause();
    expect(sys.cancels).toBeGreaterThanOrEqual(cancelsAtPause);
    expect(sys.last.text).toBe("Second part.");
    sys.last.o.onstart();
    expect(c.getSnapshot().status).toBe("playing");
  });

  it("changing speed or muting mid-sentence continues from the current word", async () => {
    const { c, sys } = makeSystem();
    await c.play("q1", "One two three four", "default");
    sys.last.o.onstart();
    sys.last.o.onboundary(8);
    c.setRate(1.5);
    expect(sys.last.text).toBe("three four");
    expect(sys.last.o.rate).toBe(1.5);
    sys.last.o.onstart();
    c.setMuted(true);
    expect(sys.last.o.volume).toBe(0);
    expect(c.getSnapshot().muted).toBe(true);
  });

  it("a newer request supersedes the older utterance", async () => {
    const { c, sys } = makeSystem();
    await c.play("q1", "First question", "default");
    const first = sys.last;
    await c.play("q2", "Second question", "default");
    first.o.onend();                                            // stale callback from the first one
    expect(c.getSnapshot()).toMatchObject({ key: "q2", status: "loading" });
    expect(sys.last.text).toBe("Second question");
  });

  it("stop cancels speech", async () => {
    const { c, sys } = makeSystem();
    await c.play("q1", "Hello", "default");
    const before = sys.cancels;
    c.stop();
    expect(sys.cancels).toBeGreaterThan(before);
    expect(c.getSnapshot().status).toBe("idle");
  });

  it("reports autoplay blocking and missing voices clearly", async () => {
    const { c, sys } = makeSystem();
    await c.play("q1", "Hello", "default");
    sys.last.o.onerror("interrupted");
    expect(c.getSnapshot().status).toBe("loading");             // interruptions are not failures
    sys.last.o.onerror("not-allowed");
    expect(c.getSnapshot().status).toBe("blocked");
    await c.play("q2", "Hello", "default");
    sys.last.o.onerror("synthesis-unavailable");
    expect(c.getSnapshot()).toMatchObject({ status: "error", error: expect.stringContaining("no offline voice") });
  });

  it("reports a browser without speech support", async () => {
    const c = new AudioController(async () => blob(), (u) => new FakeAudio(u) as unknown as HTMLAudioElement, null);
    c.setEngine("system");
    await c.play("q1", "Hello", "default");
    expect(c.getSnapshot()).toMatchObject({ status: "error", error: expect.stringContaining("no built-in speech") });
  });

  it("waits briefly for the server to name the engine instead of guessing Phonon", async () => {
    const sys = new FakeSystemSpeech();
    const fetcher = vi.fn(async () => blob());
    const c = new AudioController(fetcher, (u) => new FakeAudio(u) as unknown as HTMLAudioElement, sys);
    const playing = c.play("q1", "Hello", "default");
    await Promise.resolve();
    expect(fetcher).not.toHaveBeenCalled();
    c.setEngine("system");
    await playing;
    expect(sys.spoken).toHaveLength(1);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
