// Current business risk next to one scenario's risk, and what changes between them rule by rule.
// The current business is the profile as it is today; a scenario never replaces it. Both come from the same 19 rules.
import { Link } from "react-router-dom";
import { RiskDial } from "./charts";
import { compact, num, pct } from "./format";
import type { Finding, RiskReport, Severity } from "./types";
import { SeverityBadge, sevLabel } from "./ui";

export interface RadarScenario {
  id: number; name: string; created_at: string; origin?: string; score: number; level: Severity; counts: Record<Severity, number>; findings: Finding[]; net_profit: number;
  levers: Record<string, unknown>;
  saved?: { level: Severity | null; score: number | null; net_profit: number | null; profile_version: number | null; computed_at: string | null };
  inputs_changed?: boolean; financials?: Financials;
}
export interface Financials {
  horizon_months: number; revenue: number; total_expenses: number; gross_profit: number; net_profit: number;
  net_margin: number | null; break_even_units: number | null; units_per_month: number;
}

/** The engine's headline figures under each dial, so the risk score is never the only number shown. */
function Figures({ f, cur, unit }: { f?: Financials; cur: string; unit: string }) {
  if (!f) return null;
  const row = (k: string, v: string) => <div className="flex justify-between gap-3"><dt className="text-text-3">{k}</dt><dd className="num">{v}</dd></div>;
  return (
    <dl className="grid w-full max-w-[22rem] gap-1 border-t border-line pt-2 text-[0.8rem]" data-testid="risk-figures">
      {row(`Revenue, ${f.horizon_months} mo`, compact(f.revenue, cur))}
      {row("Total expenses", compact(f.total_expenses, cur))}
      {row("Gross profit", compact(f.gross_profit, cur))}
      {row("Net profit", compact(f.net_profit, cur))}
      {row("Net margin", pct(f.net_margin))}
      {row(`Break-even ${unit}/month`, f.break_even_units == null ? "none" : `${num(f.break_even_units)} (selling ${num(f.units_per_month)})`)}
    </dl>
  );
}

const RANK: Record<Severity, number> = { low: 0, moderate: 1, high: 2, critical: 3 };

// Trend checks on your entered past results run for the current business only, never for scenarios.
const HISTORY_METRICS = new Set(["revenue_trend", "cost_trend"]);

/** Highest severity per rule and measurement in one assessment (a rule can fire once per product or supplier,
    and one rule can check different measurements, e.g. the history trend vs the scenario comparison). */
function byRule(findings: Finding[]) {
  const m = new Map<string, Finding>();
  for (const f of findings) {
    const k = `${f.rule}:${f.metric.key}`;
    const prev = m.get(k);
    if (!prev || RANK[f.severity] > RANK[prev.severity]) m.set(k, f);
  }
  return m;
}

export function ruleDiff(base: Finding[], scen: Finding[]) {
  const a = byRule(base), b = byRule(scen);
  const rules = [...new Set([...a.keys(), ...b.keys()])];
  return rules.map((rule) => {
    const x = a.get(rule), y = b.get(rule);
    const change = !x ? "new" : !y ? (HISTORY_METRICS.has(x.metric.key) ? "history" : "cleared")
      : RANK[y.severity] > RANK[x.severity] ? "worse" : RANK[y.severity] < RANK[x.severity] ? "better" : "same";
    return { rule, label: (y ?? x)!.metric.label, category: (y ?? x)!.category_label, base: x, scen: y, change } as const;
  }).sort((p, q) => (RANK[q.scen?.severity ?? "low"] - RANK[p.scen?.severity ?? "low"]) || (RANK[q.base?.severity ?? "low"] - RANK[p.base?.severity ?? "low"]));
}

const CHANGE: Record<string, string> = { new: "Appears", cleared: "Cleared", worse: "Worse", better: "Better", same: "Unchanged",
  history: "Not re-checked (based on your entered results)" };

export function RiskCompare({ baseline, baselineFinancials, profileVersion, scenarios, selected, onSelect, cur, unit }: {
  baseline: RiskReport; baselineFinancials?: Financials; profileVersion: number; scenarios: RadarScenario[]; selected: RadarScenario | null;
  onSelect: (id: number) => void; cur: string; unit: string;
}) {
  const diff = selected ? ruleDiff(baseline.findings, selected.findings) : [];
  return (
    <div className="grid gap-4" data-testid="risk-compare">
      <div className="grid gap-4 md:grid-cols-2">
        <div className="panel glass grid content-start justify-items-center gap-2 p-5" data-testid="risk-current">
          <span className="label-soft">Current business</span>
          <RiskDial score={baseline.score} level={baseline.level} size={200} />
          <span className="text-center text-[0.76rem] text-text-3">Risk score {baseline.score} out of 100 (rises with the number and severity of warnings; not a percentage)</span>
          <span className="text-center text-[0.78rem] text-text-3">Your saved business figures today (profile v{profileVersion}), no changes applied.</span>
          <Figures f={baselineFinancials} cur={cur} unit={unit} />
        </div>
        <div className="panel glass grid content-start justify-items-center gap-2 p-5" data-testid="risk-scenario">
          {scenarios.length === 0 ? (
            <div className="grid min-h-[200px] content-center justify-items-center gap-2 text-center">
              <span className="label-soft">Scenario</span>
              <p className="max-w-[34ch] text-[0.88rem] text-text-2">No saved scenario yet. Run a simulation and its risk appears here next to your current business.</p>
              <Link to="/app/simulate" className="btn btn-sm btn-signal">Simulate a decision</Link>
            </div>
          ) : selected && (
            <>
              <label className="field w-full max-w-[22rem]"><span className="text-center">Scenario</span>
                <select className="select" value={selected.id} onChange={(e) => onSelect(+e.target.value)} aria-label="Scenario to compare">
                  {scenarios.map((s) => <option key={s.id} value={s.id}>{s.name}{s.origin === "auto" ? " (automatic)" : ""}</option>)}
                </select>
              </label>
              <RiskDial score={selected.score} level={selected.level} size={200} />
              <span className="text-center text-[0.76rem] text-text-3">Risk score {selected.score} out of 100</span>
              <span className="text-center text-[0.78rem] text-text-3">Hypothetical: the scenario's changes applied to today's figures.</span>
              <Figures f={selected.financials} cur={cur} unit={unit} />
              {selected.inputs_changed && selected.saved?.level && (
                <span className="text-center text-[0.78rem]" data-testid="risk-saved-note">
                  As saved on profile v{selected.saved.profile_version}: <SeverityBadge s={selected.saved.level} suffix={`· ${selected.saved.score}`} />{" "}
                  <span className="text-text-3">Your business figures have changed since, so today's result differs.</span>
                </span>
              )}
              <Link className="text-[0.8rem] underline" to={`/app/simulate?scenario=${selected.id}`}>Open the saved simulation</Link>
            </>
          )}
        </div>
      </div>
      {selected && (
        <div className="table-wrap" data-testid="risk-diff">
          <table className="data min-w-[560px]">
            <thead><tr><th>Rule</th><th>Current business</th><th>{selected.name}</th><th>Change</th></tr></thead>
            <tbody>
              {diff.length === 0 ? <tr><td colSpan={4} className="text-text-2">No rule is triggered in either.</td></tr> : diff.map((d) => (
                <tr key={d.rule} data-change={d.change}>
                  <td><span className="font-medium">{d.label}</span><br /><span className="text-[0.76rem] text-text-3">{d.category}</span></td>
                  <td>{d.base ? <SeverityBadge s={d.base.severity} /> : <span className="text-text-3">not triggered</span>}</td>
                  <td>{d.scen ? <SeverityBadge s={d.scen.severity} /> : <span className="text-text-3">{d.change === "history" ? "not checked" : "not triggered"}</span>}</td>
                  <td className={d.change === "worse" || d.change === "new" ? "font-semibold" : "text-text-2"}>{CHANGE[d.change]}{d.change === "worse" || d.change === "better" ? ` (${sevLabel(d.base!.severity)} → ${sevLabel(d.scen!.severity)})` : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
