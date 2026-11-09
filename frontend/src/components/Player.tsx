import { useMemo, useState } from "react";
import { speaker } from "../audio";
import { useSpeaker } from "../pages/useSpeaker";
import Icon, { Pause, Play, Stop } from "./Icon";

const RATES = [1, 1.25, 1.5, 0.75];
const BARS = 72;
const mmss = (s: number) => `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

/** The glowing "AI Interviewer" orb with its waveform. */
export function Orb({ live, size = 1 }: { live: boolean; size?: number }) {
  return (
    <div className="orb-glow" style={size !== 1 ? { width: 124 * size, height: 124 * size } : undefined} aria-hidden>
      <div className={`orb ${live ? "live" : ""}`} style={size !== 1 ? { width: 92 * size, height: 92 * size } : undefined}>
        <div className="bars">{Array.from({ length: 17 }, (_, i) => <i key={i} style={{ height: 6 + Math.abs(Math.sin(i * 1.7) * 26) }} />)}</div>
      </div>
    </div>
  );
}

/**
 * Question audio player (storyboard screen 5): pause/play, waveform progress, elapsed/total, speed, mute — plus replay and stop.
 * `children` is rendered between the orb and the controls so the question text can sit in the card.
 */
export default function Player({ audioKey, text, voice, initialRate = 1, children }: { audioKey: string; text: string; voice: string; initialRate?: number; children?: React.ReactNode }) {
  const sp = useSpeaker();
  const [rate, setRate] = useState(initialRate);
  const mine = sp.key === audioKey;
  const status = mine ? sp.status : "idle";
  const live = status === "playing";
  const play = () => { speaker.setRate(rate); void speaker.play(audioKey, text, voice); };
  const cycle = () => { const next = RATES[(RATES.indexOf(rate) + 1) % RATES.length] ?? 1; setRate(next); speaker.setRate(next); };
  const pct = mine && sp.duration > 0 ? Math.min(1, sp.currentTime / sp.duration) : 0;
  const heights = useMemo(() => Array.from({ length: BARS }, (_, i) => 8 + Math.abs(Math.sin(i * 0.9) * Math.cos(i * 0.31)) * 26 + (i % 7 === 0 ? 4 : 0)), []);

  return (
    <>
      <div className="orb-wrap">
        <Orb live={live} />
        <div className="orb-label" aria-live="polite">{status === "loading" ? "Generating audio locally…" : status === "paused" ? "Paused" : "AI Interviewer"}</div>
      </div>
      <div className="qcard">
        {children}
        <div className="player">
          <button className="play" disabled={status === "loading"} aria-label={live ? "Pause audio" : status === "paused" ? "Resume audio" : "Play question audio"}
            onClick={() => (live || status === "paused" ? speaker.togglePause() : play())}>
            {status === "loading" ? <span className="spinner" style={{ width: 16, height: 16, borderWidth: 2 }} /> : live ? <Pause /> : <Play />}</button>
          <div className="wave" role="progressbar" aria-label="Audio position" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct * 100)}>
            {heights.map((h, i) => <i key={i} className={i / BARS < pct ? "on" : ""} style={{ height: h }} />)}
          </div>
          <span className="time">{mmss(mine ? sp.currentTime : 0)} / {mmss(mine ? sp.duration : 0)}</span>
          <button className="pbtn" onClick={cycle} aria-label={`Playback speed ${rate}x`} title="Playback speed">{rate}x</button>
          <button className="pbtn" onClick={() => speaker.setMuted(!sp.muted)} aria-label={sp.muted ? "Unmute" : "Mute"}><Icon name={sp.muted ? "mute" : "vol"} /></button>
          <button className="pbtn" onClick={play} aria-label="Replay question" title="Replay from the start"><Icon name="replay" /></button>
          <button className="pbtn" onClick={() => speaker.stop()} disabled={status === "idle"} aria-label="Stop audio" title="Stop"><Stop /></button>
        </div>
        {mine && status === "blocked" && <div className="notice info small" style={{ marginTop: 12 }}>Your browser blocks audio that starts without a click (for example after a page refresh). Press <b>Play</b> to hear the question.</div>}
        {mine && status === "error" && <div className="notice error small" style={{ marginTop: 12 }}>{sp.error} <button className="btn" onClick={play}>Retry audio</button></div>}
      </div>
    </>
  );
}
