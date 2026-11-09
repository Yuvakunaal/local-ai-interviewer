/**
 * The "system" voice engine: the offline text-to-speech voices that ship with the operating system
 * (Windows: Microsoft David/Zira/…, macOS: Samantha/…, Linux: whatever speech-dispatcher provides),
 * reached through the browser's speechSynthesis API. Used wherever the optional Phonon voice
 * (Apple Silicon only) is not available. Only voices with localService === true are offered, so
 * the text of a question is never sent to a cloud voice service.
 */

export const SYS_PREFIX = "sys:";

export interface SystemVoice { id: string; name: string; lang: string }

/** macOS ships joke / effect voices that make no sense for an interviewer. */
const NOVELTY = new Set(["Albert", "Bad News", "Bahh", "Bells", "Boing", "Bubbles", "Cellos", "Deranged", "Fred", "Good News", "Hysterical",
  "Jester", "Junior", "Kathy", "Organ", "Pipe Organ", "Ralph", "Superstar", "Trinoids", "Whisper", "Wobble", "Zarvox"]);
const isNovelty = (name: string) => NOVELTY.has(name.replace(/\s*\(.*$/, "").trim());

export interface SpeakOptions {
  voiceId: string | null;            // "sys:<voiceURI>" or null for the browser's default voice
  rate: number;
  volume: number;
  onstart: () => void;
  onboundary: (charIndex: number) => void;
  onend: () => void;
  onerror: (code: string) => void;
}

/** What AudioController needs from a speech engine (also lets tests inject a fake). */
export interface SystemSpeech {
  voices(): Promise<SystemVoice[]>;
  speak(text: string, o: SpeakOptions): void;
  cancel(): void;
}

export const systemSpeechSupported = () =>
  typeof window !== "undefined" && "speechSynthesis" in window && typeof SpeechSynthesisUtterance !== "undefined";

class BrowserSpeech implements SystemSpeech {
  private synth = window.speechSynthesis;
  private current: SpeechSynthesisUtterance | null = null;   // keeps a reference: Chrome may otherwise drop events

  private loadVoices(timeoutMs = 1500): Promise<SpeechSynthesisVoice[]> {
    return new Promise((resolve) => {
      const now = this.synth.getVoices();
      if (now.length) return resolve(now);
      const done = () => { this.synth.removeEventListener("voiceschanged", done); clearTimeout(t); resolve(this.synth.getVoices()); };
      const t = setTimeout(done, timeoutMs);
      this.synth.addEventListener("voiceschanged", done);
    });
  }

  async voices(): Promise<SystemVoice[]> {
    const local = (await this.loadVoices()).filter((v) => v.localService && !isNovelty(v.name));
    const english = local.filter((v) => /^en([-_]|$)/i.test(v.lang));
    return (english.length ? english : local)
      .map((v) => ({ id: SYS_PREFIX + v.voiceURI, name: v.name, lang: v.lang }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  speak(text: string, o: SpeakOptions): void {
    const u = new SpeechSynthesisUtterance(text);
    u.rate = o.rate;
    u.volume = o.volume;
    const voice = o.voiceId ? this.synth.getVoices().find((v) => SYS_PREFIX + v.voiceURI === o.voiceId && v.localService) : undefined;
    if (voice) { u.voice = voice; u.lang = voice.lang; } else u.lang = "en-US";
    u.onstart = o.onstart;
    u.onboundary = (e) => o.onboundary(e.charIndex);
    u.onend = o.onend;
    u.onerror = (e) => o.onerror(e.error);
    this.current = u;
    // Chrome drops an utterance spoken in the same tick as cancel(); a short defer avoids that.
    setTimeout(() => { if (this.current === u) this.synth.speak(u); }, 40);
  }

  cancel(): void {
    this.current = null;
    this.synth.cancel();
  }
}

let shared: SystemSpeech | null | undefined;
export function browserSpeech(): SystemSpeech | null {
  if (shared === undefined) shared = systemSpeechSupported() ? new BrowserSpeech() : null;
  return shared;
}

/** Rough speaking time, used only to animate the progress bar (about 156 words per minute). */
export const estimateSeconds = (text: string, rate: number) =>
  Math.max(1, text.trim().split(/\s+/).filter(Boolean).length / 2.6 / Math.max(0.25, rate));
