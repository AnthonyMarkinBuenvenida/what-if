// Table-first presentation for analysis: one responsive table component (rows become labelled cards on narrow
// screens, so nothing is shrunk or cut off), an impact indicator (symbol + word, never colour alone) and term tooltips.
import type { ReactNode } from "react";

export interface Col<T> {
  key: string;
  label: string;
  /** Short explanation of a technical term, shown as a tooltip on the heading. */
  tip?: string;
  /** Right-aligned tabular numbers. */
  num?: boolean;
  render: (row: T, i: number) => ReactNode;
  className?: string;
}

export function RTable<T>({ cols, rows, rowKey, label, testid, empty = "No rows." }: {
  cols: Col<T>[]; rows: T[]; rowKey: (row: T, i: number) => string | number; label: string; testid?: string; empty?: string;
}) {
  if (rows.length === 0) return <p className="text-[0.86rem] text-text-2">{empty}</p>;
  return (
    <div className="table-wrap rtable-wrap" data-testid={testid}>
      <table className="data rtable" aria-label={label}>
        <thead>
          <tr>{cols.map((c) => (
            <th key={c.key} className={c.num ? "n" : undefined} scope="col">
              {c.tip ? <span className="cursor-help underline decoration-dotted underline-offset-2" title={c.tip}>{c.label}</span> : c.label}
            </th>
          ))}</tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={rowKey(r, i)}>
              {cols.map((c) => <td key={c.key} data-label={c.label} className={[c.num ? "n" : "", c.className ?? ""].join(" ").trim() || undefined}>{c.render(r, i)}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export type ImpactKind = "positive" | "negative" | "neutral" | "stable" | "at_risk";
const IMPACT: Record<ImpactKind, { sym: string; text: string; color: string }> = {
  positive: { sym: "▲", text: "Positive", color: "var(--sev-low)" },
  negative: { sym: "▼", text: "Negative", color: "var(--sev-high)" },
  neutral: { sym: "—", text: "No change", color: "var(--text-3)" },
  stable: { sym: "✓", text: "Stable", color: "var(--sev-low)" },
  at_risk: { sym: "⚠", text: "At risk", color: "var(--sev-moderate)" },
};

export function Impact({ v }: { v: ImpactKind | string | null | undefined }) {
  const k = IMPACT[(v as ImpactKind) ?? "neutral"] ?? IMPACT.neutral;
  return <span className="inline-flex items-center gap-1 whitespace-nowrap font-medium" style={{ color: k.color }}><span aria-hidden="true">{k.sym}</span>{k.text}</span>;
}

/** A signed change with a direction symbol; `good` says whether an increase is good (costs: false). */
export function Change({ v, fmt, good = true }: { v: number | null | undefined; fmt: (n: number) => string; good?: boolean }) {
  if (v == null || !Number.isFinite(v)) return <span className="text-text-3">N/A</span>;
  if (Math.abs(v) < 1e-9) return <span className="text-text-3">no change</span>;
  const up = v > 0;
  const better = up === good;
  return (
    <span className="whitespace-nowrap" style={{ color: better ? "var(--sev-low)" : "var(--sev-high)" }}>
      <span aria-hidden="true">{up ? "▲ " : "▼ "}</span>{up ? "+" : "−"}{fmt(Math.abs(v))}
      <span className="sr-only">{better ? " (better)" : " (worse)"}</span>
    </span>
  );
}

/** Text or an explicit "N/A" — never an empty cell. */
export function Txt({ v }: { v: string | null | undefined }) {
  return v && v.trim() ? <>{v}</> : <span className="text-text-3">N/A</span>;
}

export const TERMS = {
  revenue: "Selling price × units sold",
  expenses: "Variable costs + staff + fixed costs + marketing + tax",
  gross: "Revenue minus variable costs (what is left to pay fixed costs)",
  net: "What remains after all costs and tax",
  margin: "Net profit as a share of revenue",
  breakeven: "Units per month needed to cover all costs before tax",
  contribution: "Selling price minus variable cost per unit",
};
