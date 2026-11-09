import { useId } from "react";

/**
 * The one and only AI Interviewer logo (same artwork as public/logo.svg, used for the favicon and the app icon):
 * a speech bubble (conversation) holding an "i" (interviewer) whose dot is an AI sparkle. Teal, cream and amber.
 */
export default function Logo({ size = 42, className = "" }: { size?: number; className?: string }) {
  const id = useId().replace(/:/g, "");
  return (
    <svg className={`logo-mark ${className}`} width={size} height={size} viewBox="0 0 64 64" role="img" aria-label="AI Interviewer logo" style={{ flex: "none", display: "block" }}>
      <defs>
        <linearGradient id={`bg${id}`} x1="6" y1="2" x2="58" y2="62" gradientUnits="userSpaceOnUse"><stop offset="0" stopColor="#14A89D" /><stop offset="1" stopColor="#0A5456" /></linearGradient>
      </defs>
      <rect width="64" height="64" rx="15" fill={`url(#bg${id})`} />
      <rect x="11" y="10" width="42" height="36" rx="11.5" fill="#FFF4DD" />
      <path d="M18 38 L16 54.5 L32.5 45.5 Z" fill="#FFF4DD" stroke="#FFF4DD" strokeWidth="2" strokeLinejoin="round" />
      <rect x="29.2" y="30.4" width="5.6" height="11.6" rx="2.8" fill="#0B5557" />
      <path d="M32 12.2 L34.1 17.1 L39 19.2 L34.1 21.3 L32 26.2 L29.9 21.3 L25 19.2 L29.9 17.1 Z" fill="#FF9F2E" />
    </svg>
  );
}
