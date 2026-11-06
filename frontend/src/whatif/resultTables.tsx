// The table-first parts of the results page. Every figure comes from the engine result; AI text (when present) only
// fills the explanation columns and has already been checked against the calculation on the server.
import { money, num, pct, signedPct } from "./format";
import type { AvoidItem, Explanation, FindingRow, Levers, RiskReport, Severity, SimResult } from "./types";
import { Change, Impact, RTable, TERMS, Txt, type Col } from "./RTable";
import { SeverityBadge, Spark } from "./ui";

const totalExpenses = (t: Record<string, number>) => (t.variable_costs ?? 0) + (t.operating_expenses ?? 0) + (t.tax ?? 0);
const pts = (v: number) => `${(v * 100).toFixed(1)} pts`;

// ------------------------------------------------------------- A. Financial performance summary

interface SumRow { key: string; label: string; tip: string; cur: number | null; sim: number | null; kind: "money" | "ratio"; good: boolean; strong?: boolean }

export function SummaryTable({ r }: { r: SimResult }) {
  const cur = r.currency, bt = r.baseline.totals, st = r.scenario.totals, bm = r.baseline.metrics, sm = r.scenario.metrics;
  const base = r.is_baseline;
  const rows: SumRow[] = [
    { key: "revenue", label: "Revenue", tip: TERMS.revenue, cur: bt.revenue, sim: st.revenue, kind: "money", good: true },
    { key: "expenses", label: "Expenses", tip: TERMS.expenses, cur: totalExpenses(bt), sim: totalExpenses(st), kind: "money", good: false },
    { key: "gross", label: "Gross profit", tip: TERMS.gross, cur: bt.gross_profit, sim: st.gross_profit, kind: "money", good: true },
    { key: "net", label: "Net profit", tip: TERMS.net, cur: bt.net_profit, sim: st.net_profit, kind: "money", good: true, strong: true },
    { key: "margin", label: "Profit margin", tip: TERMS.margin, cur: bm.net_margin, sim: sm.net_margin, kind: "ratio", good: true },
  ];
  const show = (v: number | null, k: SumRow["kind"]) => (v == null ? <span className="text-text-3">N/A</span> : k === "money" ? money(v, cur) : pct(v));
  const cols: Col<SumRow>[] = [
    { key: "m", label: "Financial metric", render: (x) => <span className={x.strong ? "font-semibold" : undefined} title={x.tip}>{x.label}</span> },
    { key: "c", label: "Current business", num: true, render: (x) => show(x.cur, x.kind) },
    { key: "s", label: base ? "Simulated result (no changes)" : "Simulated result", num: true, render: (x) => <span className={x.strong ? "font-semibold" : undefined}>{show(x.sim, x.kind)}</span> },
    { key: "d", label: "Difference", num: true, render: (x) => {
      if (x.cur == null || x.sim == null) return <span className="text-text-3">N/A</span>;
      const d = x.sim - x.cur;
      const rel = x.kind === "money" && x.cur !== 0 && Math.abs(d) > 1e-9 ? <span className="ml-1 text-[0.76rem] text-text-3">({signedPct(d / Math.abs(x.cur))})</span> : null;
      return <span><Change v={d} good={x.good} fmt={(v) => (x.kind === "money" ? money(v, cur) : pts(v))} />{rel}</span>;
    } },
  ];
  return <RTable label="Financial performance summary" testid="kpis" cols={cols} rows={rows} rowKey={(x) => x.key} />;
}

// ------------------------------------------------------------- B. AI analysis findings

/** Rows for saved explanations written before the findings table existed: figures and impact from the result, no text. */
export function fallbackFindings(r: SimResult): FindingRow[] {
  const bt = r.baseline.totals, st = r.scenario.totals, sm = r.scenario.metrics, bm = r.baseline.metrics;
  const same = (a: number, c: number) => Math.abs(c - a) <= Math.max(1, Math.abs(a) * 0.005);
  const dir = (a: number, c: number, up = true) => (same(a, c) ? "neutral" : (c > a) === up ? "positive" : "negative");
  const be = sm.break_even_units, units = r.scenario.monthly_avg.units;
  return [
    { key: "revenue", label: "Revenue", current: bt.revenue, simulated: st.revenue, unit: r.currency, impact: dir(bt.revenue, st.revenue), explanation: "" },
    { key: "costs", label: "Operating costs and expenses", current: totalExpenses(bt), simulated: totalExpenses(st), unit: r.currency, impact: dir(totalExpenses(bt), totalExpenses(st), false), explanation: "" },
    { key: "profitability", label: "Net profit", current: bt.net_profit, simulated: st.net_profit, unit: r.currency, impact: dir(bt.net_profit, st.net_profit), explanation: "" },
    { key: "break_even", label: `Break-even (${r.unit_label}/month)`, current: bm.break_even_units, simulated: be, unit: r.unit_label,
      impact: be == null || (be > 0 && (units - be) / be < 0.1) ? "at_risk" : "stable", explanation: "" },
  ];
}

export function FindingsTable({ expl, r }: { expl: Explanation; r: SimResult }) {
  const rows = expl.findings?.length ? expl.findings : fallbackFindings(r);
  const ai = new Set(expl.findings_ai ?? []);
  const fig = (v: number | null, unit: string) => (v == null ? "none" : unit === r.currency ? money(v, r.currency) : `${num(v)} ${unit}`);
  const cols: Col<FindingRow>[] = [
    { key: "f", label: "Finding", render: (x) => (
      <span className="grid gap-0.5"><span className="font-medium">{x.label}</span>
        <span className="num text-[0.76rem] text-text-3">{r.is_baseline ? fig(x.simulated, x.unit) : `${fig(x.current, x.unit)} → ${fig(x.simulated, x.unit)}`}</span></span>) },
    { key: "e", label: expl.mode === "ai" ? "AI explanation" : "Explanation", className: "text-text-2", render: (x) => (
      <span>{ai.has(x.key) && <span className="chip chip-ai mr-1.5 align-middle" title="Written by the AI and checked against the calculation" style={{ height: "1.15rem", fontSize: "0.66rem", padding: "0 0.35rem" }}><Spark size={9} />AI</span>}<Txt v={x.explanation} /></span>) },
    { key: "i", label: "Impact", render: (x) => <Impact v={x.impact} /> },
  ];
  return <RTable label="Analysis findings" testid="findings-table" cols={cols} rows={rows} rowKey={(x) => x.key} />;
}

// ------------------------------------------------------------- recommendations

type Rec = Explanation["recommendations"][number];
export function RecTable({ recs, onTry, onAsk }: { recs: Rec[]; onTry?: (l: Levers) => void; onAsk?: (q: string) => void }) {
  const cols: Col<Rec>[] = [
    { key: "p", label: "Priority", render: (_, i) => <span className="num font-semibold">{i + 1}</span> },
    { key: "a", label: "Recommended action", render: (x) => <span className="font-medium">{x.text}</span> },
    { key: "r", label: "Reason", className: "text-text-2", render: (x) => <Txt v={x.reason} /> },
    { key: "t", label: "Simulator", render: (x) => (x.levers && onTry ? <button className="btn btn-sm btn-outline" onClick={() => onTry(x.levers!)}>Load it</button>
      : x.try_question && onAsk ? <button className="btn btn-sm btn-outline" onClick={() => onAsk(x.try_question!)}>Ask it</button> : <span className="text-text-3">N/A</span>) },
  ];
  return <RTable label="Recommended actions" testid="rec-table" cols={cols} rows={recs} rowKey={(x, i) => i + x.text} empty="No specific change is suggested by these figures." />;
}

/** Saved explanations from before the table update stored "not recommended" as plain sentences. */
export function asAvoid(items: (string | AvoidItem)[] | undefined): AvoidItem[] {
  return (items ?? []).map((x) => (typeof x === "string" ? { action: x, reason: "", consequence: null } : x));
}

export function AvoidTable({ items, empty }: { items: AvoidItem[]; empty: string }) {
  const cols: Col<AvoidItem>[] = [
    { key: "a", label: "Action to avoid", render: (x) => <span className="font-medium">{x.action}</span> },
    { key: "w", label: "Why", className: "text-text-2", render: (x) => <Txt v={x.reason} /> },
    { key: "c", label: "Possible consequence", className: "text-text-2", render: (x) => <Txt v={x.consequence} /> },
  ];
  return <RTable label="Not recommended" testid="avoid-table" cols={cols} rows={items} rowKey={(x, i) => i + x.action} empty={empty} />;
}

// ------------------------------------------------------------- C. What changed the result?

interface ChangeRow { key: string; variable: string; modification: string[]; effect: number | null; explanation: string }

const p = (v: number | undefined | null, label: string, unit = "%") => (v ? `${label} ${v > 0 ? "+" : "−"}${Math.abs(v)}${unit}` : null);

/** The engine's profit bridge (each line is a calculated effect on net profit), with the changes in the scenario that drive it. */
export function changeRows(r: SimResult): ChangeRow[] {
  const l = r.levers, cur = r.currency;
  const has = (...xs: (string | null | false | undefined)[]) => xs.filter(Boolean) as string[];
  const drivers: Record<string, string[]> = {
    price: has(p(l.price_change_pct, "Selling price")),
    unit_cost: has(p(l.unit_cost_change_pct, "Variable cost per unit")),
    volume: has(p(l.demand_change_pct, "Customer demand"), p(l.price_change_pct, "Price response to"), p(l.marketing_change_pct, "Marketing response to"),
      l.marketing_budget != null && "Marketing response to new budget", p(l.capacity_change_pct, "Capacity"), p(l.churn_change_pts, "Monthly churn", " pts"),
      p(l.new_customers_change_pct, "New sign-ups"), l.new_branch && "New location demand", ...(l.seasonal ?? []).map((s) => `${s.label}: demand ${s.demand_change_pct > 0 ? "+" : "−"}${Math.abs(s.demand_change_pct)}%`),
      l.new_product?.cannibalization_pct ? `New product takes ${l.new_product.cannibalization_pct}% of sales` : null),
    new_product: has(l.new_product && `New product “${l.new_product.name}” at ${money(l.new_product.price, cur, 2)}`),
    staff: has(p(l.wage_change_pct, "Wages"), ...(l.staff_changes ?? []).map((s) => `${s.count > 0 ? "Add" : "Remove"} ${Math.abs(s.count)} ${s.role}`)),
    fixed: has(p(l.rent_change_pct, "Rent"), p(l.fixed_cost_change_pct, "Other fixed costs"), l.new_branch && `New location ${money(l.new_branch.monthly_fixed_cost, cur)}/month`,
      ...(l.extra_monthly_costs ?? []).map((c) => `${c.label}: ${money(c.amount, cur)}/month`)),
    marketing: has(p(l.marketing_change_pct, "Marketing budget"), l.marketing_budget != null && `Marketing set to ${money(l.marketing_budget, cur)}/month`),
    tax: has(l.tax_rate_pct != null && `Tax rate ${l.tax_rate_pct}%`),
  };
  const follow: Record<string, string> = { tax: "Follows the change in profit", volume: "Follows from the other changes" };
  const why = (k: string, label: string, v: number, note: string) => {
    if (note) return note;
    const costUp = v < 0;
    if (k === "tax") return costUp ? "Higher profit or rate means more tax." : "Lower profit or rate means less tax.";
    return `${label} ${costUp ? "rise" : "fall"}, so net profit ${costUp ? "falls" : "rises"} by the same amount.`;
  };
  const rows: ChangeRow[] = r.bridge.map((b) => ({
    key: b.key, variable: b.label, modification: drivers[b.key]?.length ? drivers[b.key] : [follow[b.key] ?? (b.key === "other" ? "Unexplained remainder" : "Follows from the other changes")],
    effect: b.value, explanation: why(b.key, b.label, b.value, b.note),
  }));
  if (l.one_time_investment) rows.push({ key: "one_time", variable: "One-time investment", modification: [`${money(l.one_time_investment, cur)} in month ${l.investment_month ?? 1}`], effect: null, explanation: "Affects cash, not profit." });
  return rows;
}

export function ChangesTable({ r }: { r: SimResult }) {
  const rows = changeRows(r);
  const cols: Col<ChangeRow>[] = [
    { key: "v", label: "Changed variable", render: (x) => <span className="font-medium">{x.variable}</span> },
    { key: "m", label: "Modification", render: (x) => <span className="grid gap-0.5">{x.modification.map((t) => <span key={t}>{t}</span>)}</span> },
    { key: "e", label: "Effect on net profit", num: true, tip: "Calculated by the engine for the whole period", render: (x) => (x.effect == null ? <span className="text-text-3">None (cash only)</span> : <Change v={x.effect} fmt={(v) => money(v, r.currency)} />) },
    { key: "x", label: "Explanation", className: "text-text-2", render: (x) => <Txt v={x.explanation} /> },
  ];
  return <RTable label="What changed the result" testid="changes-table" cols={cols} rows={rows} rowKey={(x) => x.key} empty="Nothing in this scenario changes net profit." />;
}

// ------------------------------------------------------------- D. Best / expected / worst

interface CaseRow { key: string; label: string; revenue: number; net: number; margin: number | null; risk: Severity | null }

export function CasesTable({ r, risk }: { r: SimResult; risk: Severity }) {
  const cur = r.currency;
  const rows: CaseRow[] = [
    { key: "best", label: "Best case", revenue: r.bands.best.revenue, net: r.bands.best.net_profit, margin: r.bands.best.net_margin, risk: null },
    { key: "exp", label: "Expected", revenue: r.scenario.totals.revenue, net: r.scenario.totals.net_profit, margin: r.scenario.metrics.net_margin, risk },
    { key: "worst", label: "Worst case", revenue: r.bands.worst.revenue, net: r.bands.worst.net_profit, margin: r.bands.worst.net_margin, risk: null },
  ];
  const cols: Col<CaseRow>[] = [
    { key: "c", label: "Case", render: (x) => <span className={x.key === "exp" ? "font-semibold" : "font-medium"}>{x.label}</span> },
    { key: "r", label: "Revenue", num: true, render: (x) => money(x.revenue, cur) },
    { key: "n", label: "Net profit", num: true, tip: TERMS.net, render: (x) => <span style={x.net < 0 ? { color: "var(--sev-high)" } : undefined}>{x.net < 0 && <span aria-hidden="true">▼ </span>}{money(x.net, cur)}{x.net < 0 && <span className="sr-only"> (loss)</span>}</span> },
    { key: "m", label: "Profit margin", num: true, tip: TERMS.margin, render: (x) => (x.margin == null ? <span className="text-text-3">N/A</span> : pct(x.margin)) },
    { key: "k", label: "Risk", tip: "Risk Radar checks the expected case; best and worst cases are not rated", render: (x) => (x.risk ? <SeverityBadge s={x.risk} /> : <span className="text-text-3">Not rated</span>) },
  ];
  return <RTable label="Best, expected and worst case" testid="cases-table" cols={cols} rows={rows} rowKey={(x) => x.key} />;
}

// ------------------------------------------------------------- Risks in this scenario

type F = RiskReport["findings"][number];
export function RisksTable({ findings, onTry, levers }: { findings: F[]; onTry?: (l: Levers) => void; levers: Levers }) {
  const cols: Col<F>[] = [
    { key: "r", label: "Risk", render: (x) => <span className="font-medium">{x.title}</span> },
    { key: "s", label: "Severity", render: (x) => <SeverityBadge s={x.severity} /> },
    { key: "e", label: "Evidence", className: "text-text-2", render: (x) => x.summary },
    { key: "a", label: "Test a fix", render: (x) => (onTry && x.actions[0]?.levers && Object.keys(x.actions[0].levers).length > 0
      ? <button className="btn btn-sm btn-outline" onClick={() => onTry({ ...levers, ...x.actions[0].levers, start_month: null })}>{x.actions[0].label}</button> : <span className="text-text-3">N/A</span>) },
  ];
  return <RTable label="Risks in this scenario" testid="risks-table" cols={cols} rows={findings} rowKey={(x) => x.id} />;
}
