import { useId } from "react";
import type { Stats } from "../types";
import { fmtShort } from "./ui";

export const scoreTone = (s: number) => (s >= 7 ? "good" : s >= 5 ? "mid" : "low");

/** Score history: one point per interview, newest on the right. Points link to their report. */
export function TrendChart({ points }: { points: Stats["trend"] }) {
  const gid = useId();
  const W = 560, H = 236, L = 30, R = 14, T = 12, B = 28;
  const w = W - L - R, h = H - T - B;
  const x = (i: number) => L + (points.length === 1 ? w / 2 : (i * w) / (points.length - 1));
  const y = (s: number) => T + (1 - Math.max(0, Math.min(10, s)) / 10) * h;
  const line = points.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)} ${y(p.score).toFixed(1)}`).join(" ");
  const area = points.length > 1 ? `${line} L${x(points.length - 1).toFixed(1)} ${T + h} L${x(0).toFixed(1)} ${T + h} Z` : "";
  const first = points[0], last = points[points.length - 1];
  return (
    <svg className="trend" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Average score per interview, ${points.length} interview${points.length === 1 ? "" : "s"}; latest ${last.score} out of 10`}>
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" style={{ stopColor: "var(--accent)", stopOpacity: 0.28 }} /><stop offset="1" style={{ stopColor: "var(--accent)", stopOpacity: 0 }} />
        </linearGradient>
      </defs>
      {[0, 5, 10].map((v) => <g key={v}><line className="grid" x1={L} x2={W - R} y1={y(v)} y2={y(v)} /><text x={L - 8} y={y(v) + 4} textAnchor="end">{v}</text></g>)}
      <line className="ref" x1={L} x2={W - R} y1={y(7)} y2={y(7)} /><text x={L + 6} y={y(7) - 5}>strong · 7</text>
      {area && <path d={area} fill={`url(#${gid})`} />}
      {points.length > 1 && <path className="line" d={line} />}
      {points.map((p, i) => (
        <a key={p.id} href={`#/report/${p.id}`} aria-label={`${p.title}: ${p.score} out of 10, ${fmtShort(p.date)}`}>
          <circle className={`pt ${i === points.length - 1 ? "last" : ""}`} cx={x(i)} cy={y(p.score)} r={5} />
          <title>{`${p.title} · ${p.score}/10 · ${fmtShort(p.date)}`}</title>
        </a>
      ))}
      <text x={x(0)} y={H - 6} textAnchor={points.length === 1 ? "middle" : "start"}>{fmtShort(first.date)}</text>
      {points.length > 1 && <text x={x(points.length - 1)} y={H - 6} textAnchor="end">{fmtShort(last.date)}</text>}
    </svg>
  );
}

/** Circular score gauge (0–10). */
export function ScoreRing({ value, label = "out of 10", size = 112 }: { value: number | null; label?: string; size?: number }) {
  const r = 46, c = 2 * Math.PI * r;
  const v = value == null ? 0 : Math.max(0, Math.min(10, value));
  const tone = value == null ? "" : scoreTone(value);
  const color = tone === "good" ? "var(--ok)" : tone === "mid" ? "var(--warn)" : tone === "low" ? "var(--bad)" : "var(--faint)";
  return (
    <div className="ring" style={{ width: size, height: size }} role="img" aria-label={value == null ? "No score" : `Score ${value} out of 10`}>
      <svg viewBox="0 0 112 112"><circle className="bg" cx="56" cy="56" r={r} fill="none" strokeWidth="10" /><circle className="fg" cx="56" cy="56" r={r} fill="none" strokeWidth="10" stroke={color} strokeDasharray={c} strokeDashoffset={c * (1 - v / 10)} /></svg>
      <div className="num" style={{ color }}>{value == null ? "–" : value}<small>{label}</small></div>
    </div>
  );
}
