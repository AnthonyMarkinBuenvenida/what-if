import { Link } from "react-router-dom";

/** The What-if mark: today's line (Moon) meets the horizon and one path rises
    from it (Signal), the same pairing the charts use for baseline vs scenario. */
export function ForkMark({ size = 28 }: { size?: number; inverted?: boolean }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" className="flex-none">
      <rect x="0.5" y="0.5" width="31" height="31" rx="8" fill="var(--deep)" stroke="var(--line-strong)" />
      <path d="M6 20.5h20" fill="none" stroke="var(--moon)" strokeWidth="1.8" strokeLinecap="round" strokeDasharray="2.6 2.4" opacity="0.75" />
      <path d="M6 20.5h6.5c4.5 0 6-10 13.5-10" fill="none" stroke="var(--signal)" strokeWidth="2.4" strokeLinecap="round" />
      <circle cx="12.5" cy="20.5" r="2.4" fill="var(--moon)" />
    </svg>
  );
}

export function Wordmark({ to = "/", size = 28, className = "" }: { to?: string; size?: number; className?: string }) {
  return (
    <Link to={to} className={`inline-flex items-center gap-2.5 no-underline ${className}`} aria-label="What-if home">
      <ForkMark size={size} />
      <span style={{ fontFamily: "var(--font-display)", fontWeight: 800, fontSize: size * 0.7, letterSpacing: "0.04em" }}>
        What-if
      </span>
    </Link>
  );
}
