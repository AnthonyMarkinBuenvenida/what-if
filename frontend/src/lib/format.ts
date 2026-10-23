const money0 = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const money2 = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });
const num0 = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const num1 = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });

export const money = (v: number | null | undefined) => (v == null || Number.isNaN(v) ? "—" : money0.format(v));
export const money2dp = (v: number | null | undefined) => (v == null ? "—" : money2.format(v));
export const signedMoney = (v: number) => (v > 0 ? "+" : v < 0 ? "−" : "") + money0.format(Math.abs(v));
export const compactMoney = (v: number) => {
  const a = Math.abs(v);
  const s = a >= 1e6 ? `${num1.format(a / 1e6)}M` : a >= 1e4 ? `${num0.format(a / 1e3)}k` : a >= 1e3 ? `${num1.format(a / 1e3)}k` : num0.format(a);
  return `${v < 0 ? "−" : ""}$${s}`;
};
export const int = (v: number | null | undefined) => (v == null ? "—" : num0.format(v));
export const dec1 = (v: number) => num1.format(v);
export const pct = (v: number | null | undefined, digits = 0) => (v == null ? "—" : `${(v * 100).toFixed(digits)}%`);
export const signedPct = (v: number, digits = 0) => `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v * 100).toFixed(digits)}%`;

export function when(iso: string | null | undefined) {
  if (!iso) return "—";
  const d = new Date(iso);
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)} min ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} h ago`;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: d.getFullYear() === new Date().getFullYear() ? undefined : "numeric" });
}

export function duration(a: string | null, b: string | null) {
  if (!a || !b) return null;
  const ms = new Date(b).getTime() - new Date(a).getTime();
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

export const STATUS_LABEL: Record<string, string> = {
  queued: "Queued",
  preparing: "Preparing inputs",
  running: "Running",
  completed: "Completed",
  completed_with_warnings: "Completed with warnings",
  failed: "Failed",
  cancelled: "Cancelled",
};
export const isActive = (s: string) => s === "queued" || s === "preparing" || s === "running";
export const isDone = (s: string) => s === "completed" || s === "completed_with_warnings";

export const seriesVar = (i: number) => `var(--series-${(i % 8) + 1})`;
