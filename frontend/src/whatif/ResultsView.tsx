// Simulation results, visual first: key figures, then charts and tables, each with a short note that reads the
// chart (AI-written when available, otherwise from the calculation), then the overall analysis, risks, the full
// financial table and the assumptions. Every number comes from the engine (backend/app/whatif/engine.py).
import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { BridgeChart, ProjectionChart } from "./charts";
import { BreakEvenChart, PairBars, RangeChart } from "./resultCharts";
import { compact, money, monthLabel, num, pct, signedMoney, signedPct, signedPts } from "./format";
import type { ChartKey, Explanation, Levers, ProfileSpec, RiskReport, SimResult } from "./types";
import { DataLinks } from "./ExternalData";
import { ConfidenceMeter, Delta, KindTag, Section, SeverityBadge, SourceBadge, Spark } from "./ui";
import { Spinner } from "../components/ui";

type Metric = "net_profit" | "revenue" | "cash" | "units";
const METRIC: Record<Metric, string> = { net_profit: "Net profit", revenue: "Revenue", cash: "Cash balance", units: "Units sold" };
const EXPENSES: [string, string][] = [["variable_costs", "Variable costs (products, ingredients)"], ["staff_costs", "Staff"], ["fixed_costs", "Fixed costs (rent, utilities, other)"], ["marketing", "Marketing"], ["tax", "Tax"]];
const totalExpenses = (t: Record<string, number>) => (t.variable_costs ?? 0) + (t.operating_expenses ?? 0) + (t.tax ?? 0);

export interface ResultsProps {
  res: { result: SimResult; risks: { scenario: RiskReport; baseline: RiskReport } };
  expl: Explanation | null; explaining?: boolean; spec: ProfileSpec;
  onTry?: (l: Levers) => void; onAsk?: (q: string) => void; onRefreshAI?: () => void; aiAvailable?: boolean; scenarioId?: number;
}

export function Results({ res, expl, explaining = false, spec, onTry, onAsk, onRefreshAI, aiAvailable, scenarioId }: ResultsProps) {
  const r = res.result;
  const cur = r.currency;
  const [metric, setMetric] = useState<Metric>("net_profit");
  const bt = r.baseline.totals, st = r.scenario.totals, bm = r.baseline.metrics, sm = r.scenario.metrics;
  const H = r.scenario.horizon_months;
  const base = r.is_baseline;
  const m = (v: number) => compact(v, cur);
  const note = (k: ChartKey) => <Insight chart={k} expl={expl} explaining={explaining} />;

  // Time series: only the engine's calculated months (and history the user entered); nothing is interpolated.
  const fmt = (v: number) => (metric === "units" ? num(v) : compact(v, cur));
  const series = (p: typeof r.scenario) => p.months.map((x) => (metric === "cash" ? x.cash : metric === "units" ? x.units : metric === "revenue" ? x.revenue : x.net_profit));
  const band = metric === "net_profit" ? { low: r.bands.worst.monthly_net_profit, high: r.bands.best.monthly_net_profit, label: "Worst to best case" }
    : metric === "cash" ? { low: r.bands.worst.cash, high: r.bands.best.cash, label: "Worst to best case" } : undefined;
  const history = metric === "revenue" ? spec.history.map((h) => ({ month: h.month, value: h.revenue }))
    : metric === "net_profit" ? spec.history.map((h) => ({ month: h.month, value: h.net_profit })) : metric === "units" ? spec.history.map((h) => ({ month: h.month, value: h.units })) : [];
  const risks = res.risks.scenario;

  return (
    <div className="@container grid gap-6" data-testid="results">
      {/* 1. Key figures */}
      <div className="panel glass grid gap-4 p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2 text-[0.82rem] text-text-3">
            <KindTag kind="calculated" />
            <span>{monthLabel(r.scenario.start_month, true)} to {monthLabel(r.scenario.end_month, true)} · {H} months · {r.engine}</span>
          </div>
          {!base && expl && <span className="text-[0.85rem]">{expl.assessment.text}</span>}
        </div>
        <div className="grid grid-cols-2 gap-3 @lg:grid-cols-3 @5xl:grid-cols-6" data-testid="kpis">
          <KpiCard label="Revenue" value={m(st.revenue)} base={m(bt.revenue)} delta={base ? null : <Delta v={bt.revenue ? (st.revenue - bt.revenue) / bt.revenue : null} fmt={(v) => signedPct(v)} />} />
          <KpiCard label="Total expenses" value={m(totalExpenses(st))} base={m(totalExpenses(bt))} delta={base ? null : <Delta v={totalExpenses(bt) ? (totalExpenses(st) - totalExpenses(bt)) / totalExpenses(bt) : null} fmt={(v) => signedPct(v)} invert />} />
          <KpiCard label="Gross profit" value={m(st.gross_profit)} base={m(bt.gross_profit)} delta={base ? null : <Delta v={st.gross_profit - bt.gross_profit} fmt={(v) => signedMoney(v, cur)} />} />
          <KpiCard label={`Net profit, ${H} mo`} value={m(st.net_profit)} base={m(bt.net_profit)} strong delta={base ? null : <Delta v={st.net_profit - bt.net_profit} fmt={(v) => signedMoney(v, cur)} />} />
          <KpiCard label="Net margin" value={pct(sm.net_margin)} base={pct(bm.net_margin)} delta={base ? null : <Delta v={sm.net_margin != null && bm.net_margin != null ? sm.net_margin - bm.net_margin : null} fmt={signedPts} />} />
          <KpiCard label={`Break-even ${spec.unit_label}/mo`} value={sm.break_even_units == null ? "none" : num(sm.break_even_units)} base={bm.break_even_units == null ? "none" : num(bm.break_even_units)}
            delta={base || sm.break_even_units == null || bm.break_even_units == null ? null : <Delta v={sm.break_even_units - bm.break_even_units} fmt={(v) => `${v >= 0 ? "+" : "−"}${num(Math.abs(v))}`} invert />} />
        </div>
      </div>

      {/* 2. Baseline vs scenario */}
      <div className="grid items-start gap-6 @4xl:grid-cols-2">
        <ChartPanel title={base ? "Current course" : "Current course vs this scenario"} sub={`${H}-month totals`}>
          <PairBars ariaLabel="Revenue, expenses and profit: current course and scenario" format={m} showScenario={!base}
            rows={[{ key: "rev", label: "Revenue", base: bt.revenue, scen: st.revenue }, { key: "exp", label: "Total expenses", base: totalExpenses(bt), scen: totalExpenses(st), note: "Variable costs + operating costs + tax" },
              { key: "gp", label: "Gross profit", base: bt.gross_profit, scen: st.gross_profit }, { key: "np", label: "Net profit", base: bt.net_profit, scen: st.net_profit }]} />
          <div className="border-t border-line pt-3">
            <PairBars ariaLabel="Net margin: current course and scenario" format={(v) => pct(v)} changeFormat={signedPts} showScenario={!base}
              rows={[{ key: "nm", label: "Net margin", base: bm.net_margin, scen: sm.net_margin }, { key: "gm", label: "Gross margin", base: bm.gross_margin, scen: sm.gross_margin }]} />
          </div>
          {note("comparison")}
        </ChartPanel>

        {/* 3. Revenue and profit over time (calculated months only) */}
        <ChartPanel title="Month by month" sub={H > 1 ? "Calculated projection; actual results you entered are shown before it" : undefined}
          aside={H > 1 ? <div className="seg" role="tablist" aria-label="Chart metric">{(Object.keys(METRIC) as Metric[]).map((k) => <button key={k} role="tab" aria-selected={metric === k} onClick={() => setMetric(k)}>{METRIC[k]}</button>)}</div> : undefined}>
          {H > 1 ? (
            <>
              <ProjectionChart months={r.scenario.months.map((x) => x.month)} history={history} ariaLabel={`${METRIC[metric]} by month, current course and scenario`} format={fmt} zero={metric !== "units"} height={250}
                series={[{ key: "base", label: "Current course", values: series(r.baseline), color: "var(--series-baseline)", dash: "6 5", shape: "ring" },
                  ...(base ? [] : [{ key: "scen", label: "This scenario", values: series(r.scenario), color: "var(--series-1)", shape: "circle" as const }])]}
                band={base ? undefined : band} />
              {band && !base && <p className="text-[0.76rem] text-text-3">Band: demand ±{r.bands.ranges.demand_pct}%, costs ±{r.bands.ranges.cost_pct}%{r.bands.ranges.elasticity_abs ? `, price response ±${r.bands.ranges.elasticity_abs}` : ""} ({r.bands.cases} cases).</p>}
            </>
          ) : <p className="text-[0.88rem] text-text-2">This run covers a single month, so there is no trend to draw; the comparison on the left shows the result.</p>}
          {H > 1 && note("trend")}
        </ChartPanel>
      </div>

      {/* 4. Expenses and 5. break-even */}
      <div className="grid items-start gap-6 @4xl:grid-cols-2">
        <ChartPanel title="Where the money goes" sub={`Expenses by category, ${H} months`}>
          <PairBars ariaLabel="Expenses by category: current course and scenario" format={m} showScenario={!base}
            rows={EXPENSES.map(([k, label]) => ({ key: k, label, base: bt[k] ?? 0, scen: st[k] ?? 0 }))} />
          <div className="table-wrap">
            <table className="data text-[0.82rem]">
              <thead><tr><th>Category</th><th className="n">{base ? "Amount" : "Scenario"}</th><th className="n">Share</th>{!base && <th className="n">Change</th>}</tr></thead>
              <tbody>
                {EXPENSES.map(([k, label]) => (
                  <tr key={k}><td>{label}</td><td className="n">{money(st[k] ?? 0, cur)}</td><td className="n">{pct(totalExpenses(st) ? (st[k] ?? 0) / totalExpenses(st) : null, 0)}</td>
                    {!base && <td className="n">{signedMoney((st[k] ?? 0) - (bt[k] ?? 0), cur)}</td>}</tr>
                ))}
                <tr className="font-semibold"><td>Total</td><td className="n">{money(totalExpenses(st), cur)}</td><td className="n">100%</td>{!base && <td className="n">{signedMoney(totalExpenses(st) - totalExpenses(bt), cur)}</td>}</tr>
              </tbody>
            </table>
          </div>
          {st.one_time > 0 && <p className="text-[0.78rem] text-text-3">One-time spending of {money(st.one_time, cur)} affects cash, not profit, and is not in this table.</p>}
          {note("expenses")}
        </ChartPanel>

        <ChartPanel title="Break-even" sub={`Average ${spec.unit_label} per month`}>
          <BreakEvenChart unit={spec.unit_label} ariaLabel="Units sold per month against break-even"
            rows={[{ key: "b", label: "Current course", sold: r.baseline.monthly_avg.units, breakEven: bm.break_even_units, solid: false },
              ...(base ? [] : [{ key: "s", label: "This scenario", sold: r.scenario.monthly_avg.units, breakEven: sm.break_even_units, solid: true }])]} />
          <div className="grid gap-1.5 text-[0.86rem]">
            <Row k="Contribution per unit (price − variable cost)" v={`${money(sm.contribution_per_unit, cur, 2)}${base ? "" : ` (was ${money(bm.contribution_per_unit, cur, 2)})`}`} />
            <Row k={`Sales above (below) break-even`} v={sm.break_even_units == null ? "no break-even point" : `${r.scenario.monthly_avg.units - sm.break_even_units >= 0 ? "+" : "−"}${num(Math.abs(r.scenario.monthly_avg.units - sm.break_even_units))} ${spec.unit_label}/month`} />
            <Row k="Safety margin" v={pct(sm.safety_margin)} />
            {expl?.required_volume?.possible && <p className="pt-1 text-[0.8rem] text-text-2">To keep gross profit unchanged, volume would need to change {signedPct(expl.required_volume.needed_change!)}; the demand model gives {signedPct(expl.required_volume.expected_change)}.</p>}
          </div>
          {note("break_even")}
        </ChartPanel>
      </div>

      {/* 6. What changed profit, 7. best and worst case */}
      <div className="grid items-start gap-6 @4xl:grid-cols-2">
        {!base && (
          <ChartPanel title="What changed net profit" sub="Each effect of your changes, from the current course to this scenario">
            <BridgeChart start={bt.net_profit} end={st.net_profit} items={r.bridge} cur={cur} />
            {r.scenario.demand_factors.length > 0 && (
              <details className="text-[0.82rem] text-text-2"><summary className="cursor-pointer text-text-3">Demand factors behind the volume change</summary>
                <ul className="mt-2 grid gap-1">{r.scenario.demand_factors.map((f) => <li key={f.key + f.label} className="flex justify-between gap-3"><span>{f.label} <span className="text-text-3">({f.note})</span></span><span className="num text-text">×{f.multiplier.toFixed(3)}</span></li>)}</ul>
              </details>
            )}
            {note("impact")}
          </ChartPanel>
        )}
        <ChartPanel title="Best and worst case" sub={`Net profit over ${H} months across your uncertainty ranges`}>
          <RangeChart format={m} ariaLabel="Worst, expected and best net profit"
            rows={[{ key: "b", label: "Current course", worst: r.baseline_bands.worst.net_profit, expected: bt.net_profit, best: r.baseline_bands.best.net_profit, solid: false },
              ...(base ? [] : [{ key: "s", label: "This scenario", worst: r.bands.worst.net_profit, expected: st.net_profit, best: r.bands.best.net_profit, solid: true }])]} />
          <p className="text-[0.78rem] text-text-3">Worst case: demand −{r.bands.ranges.demand_pct}%, variable costs +{r.bands.ranges.cost_pct}%{r.bands.ranges.elasticity_abs ? `, stronger price response (${r.bands.ranges.elasticity_abs})` : ""}; best case the opposite. These are the edges of your stated ranges, not predictions.</p>
          {note("range")}
        </ChartPanel>
      </div>

      {/* 8. AI analysis */}
      <Analysis expl={expl} explaining={explaining} onTry={onTry} onAsk={onAsk} onRefreshAI={onRefreshAI} aiAvailable={aiAvailable} />

      {/* 9. Risks */}
      <Section title="Risks in this scenario" aside={<Link to={scenarioId ? `/app/risk?scenario=${scenarioId}` : "/app/risk"} className="text-[0.85rem] underline">Compare with your current business in Risk Radar</Link>}>
        {risks.findings.length === 0 ? <p className="text-text-2">No rule was triggered for this scenario.</p> : (
          <ul className="grid gap-2">
            {risks.findings.slice(0, 5).map((f) => (
              <li key={f.id} className="panel flex flex-wrap items-start gap-3 p-3">
                <SeverityBadge s={f.severity} />
                <div className="grid min-w-0 flex-1 basis-[15rem] gap-0.5"><span className="font-semibold">{f.title}</span><span className="text-[0.85rem] text-text-2">{f.summary}</span></div>
                {onTry && f.actions[0]?.levers && Object.keys(f.actions[0].levers).length > 0 && <button className="btn btn-sm btn-outline" onClick={() => onTry({ ...r.levers, ...f.actions[0].levers, start_month: null })}>{f.actions[0].label}</button>}
              </li>
            ))}
          </ul>
        )}
        {note("risks")}
      </Section>

      {/* 10. Detailed financial table */}
      <Section title="Detailed financial breakdown" aside={<KindTag kind="calculated" />}>
        <div className="table-wrap" data-testid="financial-table">
          <table className="data min-w-[520px]">
            <thead><tr><th>{H} months</th><th className="n">Current course</th>{!base && <><th className="n">This scenario</th><th className="n">Change</th></>}</tr></thead>
            <tbody>
              {([["revenue", "Revenue"], ["variable_costs", "Variable costs"], ["gross_profit", "Gross profit"], ["staff_costs", "Staff"], ["fixed_costs", "Fixed costs"], ["marketing", "Marketing"],
                ["operating_expenses", "Operating costs"], ["operating_profit", "Operating profit"], ["tax", "Tax"], ["net_profit", "Net profit"], ["one_time", "One-time spending"], ["cash_flow", "Cash flow"]] as const).map(([k, label]) => (
                <tr key={k} className={k === "net_profit" || k === "gross_profit" ? "font-semibold" : ""}><td>{label}</td><td className="n">{money(bt[k], cur)}</td>{!base && <><td className="n">{money(st[k], cur)}</td><td className="n">{signedMoney(st[k] - bt[k], cur)}</td></>}</tr>
              ))}
              <tr><td>Units sold</td><td className="n">{num(bt.units)}</td>{!base && <><td className="n">{num(st.units)}</td><td className="n">{`${st.units - bt.units >= 0 ? "+" : "−"}${num(Math.abs(st.units - bt.units))}`}</td></>}</tr>
              <tr><td>Lowest cash</td><td className="n">{money(bm.min_cash, cur)}</td>{!base && <><td className="n">{money(sm.min_cash, cur)}</td><td className="n">{signedMoney(sm.min_cash - bm.min_cash, cur)}</td></>}</tr>
              <tr><td>Ending cash</td><td className="n">{money(bm.ending_cash, cur)}</td>{!base && <><td className="n">{money(sm.ending_cash, cur)}</td><td className="n">{signedMoney(sm.ending_cash - bm.ending_cash, cur)}</td></>}</tr>
            </tbody>
          </table>
        </div>
        <div className="grid gap-x-8 gap-y-1.5 text-[0.84rem] @lg:grid-cols-2">
          <Row k="Capacity use" v={sm.capacity_utilization == null ? "not limited" : pct(sm.capacity_utilization)} />
          <Row k="Demand not served" v={pct(sm.lost_share)} />
          <Row k="Stock cover at end" v={sm.inventory_cover_months == null ? "not tracked" : `${num(sm.inventory_cover_months, 1)} months`} />
          <Row k="Headcount" v={num(sm.headcount, 1)} />
          <Row k="Payback" v={r.payback_months == null ? "—" : `${num(r.payback_months, 1)} months`} />
          <Row k="Runway" v={sm.runway_months == null ? "cash not falling" : `${num(sm.runway_months, 1)} months`} />
          {sm.subscribers_end != null && <Row k="Subscribers at end" v={num(sm.subscribers_end)} />}
        </div>
      </Section>

      {/* 11. Assumptions and data sources */}
      {!!r.levers.data_links?.length && (
        <Section title="External data used in this scenario" aside={<span className="text-[0.78rem] text-text-3">Source, dates and the rule used, as saved</span>}>
          <DataLinks links={r.levers.data_links} />
        </Section>
      )}
      <Section title="Assumptions and data sources" aside={<ConfidenceMeter level={r.confidence.level} score={r.confidence.score} reasons={r.confidence.reasons} />}>
        <details className="panel p-4" data-testid="assumptions">
          <summary className="cursor-pointer text-[0.88rem]">{r.assumptions.length} assumptions behind these numbers</summary>
          <div className="table-wrap mt-3">
            <table className="data min-w-[560px]">
              <thead><tr><th>Assumption</th><th className="n">Value</th><th>Source</th><th>Note</th></tr></thead>
              <tbody>{r.assumptions.map((a, i) => <tr key={a.key + i}><td>{a.label}</td><td className="n">{a.value == null ? "" : `${a.value}${a.unit === "%" ? "%" : a.unit ? ` ${a.unit}` : ""}`}</td><td><SourceBadge s={a.source} /></td><td className="text-text-2">{a.note}</td></tr>)}</tbody>
            </table>
          </div>
          <details className="mt-3 text-[0.84rem] text-text-2"><summary className="cursor-pointer text-text-3">How the engine simplifies</summary><ul className="mt-2 list-disc pl-5">{r.simplifications.map((s) => <li key={s}>{s}</li>)}</ul></details>
        </details>
        {r.history_check && <p className="text-[0.82rem] text-text-3">Check against reality: your last entered month ({monthLabel(r.history_check.last_actual_month, true)}) had revenue of {money(r.history_check.last_actual_revenue, cur)}; the projection's first month is {money(r.history_check.baseline_first_month_revenue, cur)} ({signedPct(r.history_check.gap_pct)}), adjusted for season.</p>}
      </Section>
    </div>
  );
}

function KpiCard({ label, value, base, delta, strong = false }: { label: string; value: string; base: string; delta: ReactNode; strong?: boolean }) {
  return (
    <div className={`grid content-start gap-1 rounded-[var(--r-card)] border border-line p-3 ${strong ? "bg-[var(--surface-2)]" : ""}`}>
      <span className="text-[0.76rem] text-text-3">{label}</span>
      <span className={`kpi whitespace-nowrap ${strong ? "text-[1.5rem]" : "text-[1.25rem]"}`}>{value}</span>
      <span className="flex flex-wrap items-center gap-x-1.5 text-[0.76rem]">{delta}<span className="text-text-3">{delta ? "vs" : "current course"} {delta ? base : ""}</span></span>
    </div>
  );
}

function ChartPanel({ title, sub, aside, children }: { title: string; sub?: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="panel glass grid min-w-0 content-start gap-3 p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="grid gap-0.5"><h3 className="text-[0.98rem] font-semibold">{title}</h3>{sub && <span className="text-[0.78rem] text-text-3">{sub}</span>}</div>
        {aside}
      </div>
      {children}
    </section>
  );
}

/** The note under a chart: AI-written (labelled) when the AI covered this chart, otherwise from the calculation. */
function Insight({ chart, expl, explaining }: { chart: ChartKey; expl: Explanation | null; explaining: boolean }) {
  const text = expl?.chart_notes?.[chart];
  if (!text && !explaining) return null;
  const ai = !!expl?.chart_notes_ai?.includes(chart);
  return (
    <div className={`flex items-start gap-2 rounded-[var(--r-card)] border px-3 py-2 text-[0.84rem] ${explaining ? "stale" : ""}`}
      style={{ borderColor: ai ? "rgb(194 181 255 / 35%)" : "var(--line)" }} data-testid={`insight-${chart}`}>
      <span className="mt-[2px] shrink-0">{ai ? <span className="chip chip-ai"><Spark />AI</span> : <KindTag kind="rules" title="Written from the calculation by fixed rules" />}</span>
      <span className="text-text-2">{text ?? "AI is reading this chart…"}</span>
    </div>
  );
}

function Analysis({ expl, explaining, onTry, onAsk, onRefreshAI, aiAvailable }: {
  expl: Explanation | null; explaining: boolean; onTry?: (l: Levers) => void; onAsk?: (q: string) => void; onRefreshAI?: () => void; aiAvailable?: boolean;
}) {
  const [more, setMore] = useState(false);
  const ai = expl?.mode === "ai";
  return (
    <Section title={ai ? "AI analysis" : "Analysis"} aside={
      <span className="flex flex-wrap items-center gap-2">
        {explaining ? <span className="chip chip-ai"><Spark />AI is writing…</span> : expl && <KindTag kind={ai ? "ai" : "rules"} title={ai ? `Written by ${expl.model}; figures checked against the calculation` : undefined} />}
        {expl?.generated_at && !explaining && <span className="text-[0.76rem] text-text-3">{ai ? expl.model : "from the calculation"} · {new Date(expl.generated_at).toLocaleString()}</span>}
        {onRefreshAI && aiAvailable && !explaining && <button className="btn btn-sm btn-outline" onClick={onRefreshAI}>{ai ? "Regenerate AI analysis" : "Ask AI to analyse"}</button>}
      </span>}>
      <div className="panel grid gap-4 p-4" style={ai ? { borderColor: "rgb(194 181 255 / 35%)" } : undefined} data-testid="analysis">
        {!expl ? <span className="think-text">Waiting for the calculation…</span> : (
          <>
            <p className={`text-[0.95rem] leading-relaxed ${explaining ? "stale" : ""}`}>{expl.summary}</p>
            <div className="grid gap-4 @2xl:grid-cols-2">
              <div className="grid content-start gap-2">
                <h4 className="text-[0.8rem] font-semibold uppercase tracking-[0.06em] text-text-3"><span className="text-[var(--accent)]" aria-hidden="true">✓ </span>Recommended</h4>
                {expl.recommendations.length === 0 ? <p className="text-[0.86rem] text-text-2">No specific change is suggested by these figures.</p> : expl.recommendations.map((rc, i) => (
                  <div key={i} className="flex flex-wrap items-center justify-between gap-2 text-[0.86rem]">
                    <span className="text-text-2">{rc.text}</span>
                    {rc.levers && onTry ? <button className="btn btn-sm btn-outline" onClick={() => onTry(rc.levers!)}>Load it</button>
                      : rc.try_question && onAsk ? <button className="btn btn-sm btn-outline" onClick={() => onAsk(rc.try_question!)}>Ask it</button> : null}
                  </div>
                ))}
              </div>
              <div className="grid content-start gap-2">
                <h4 className="text-[0.8rem] font-semibold uppercase tracking-[0.06em] text-text-3"><span className="text-[var(--sev-high)]" aria-hidden="true">✕ </span>Not recommended</h4>
                {(expl.not_recommended ?? []).length === 0 ? <p className="text-[0.86rem] text-text-2">No action is clearly inadvisable from these figures.</p>
                  : <ul className="grid gap-1.5 text-[0.86rem] text-text-2">{expl.not_recommended!.map((t, i) => <li key={i}>{t}</li>)}</ul>}
              </div>
            </div>
            {expl.next_step && <p className="text-[0.88rem]"><b>Next step:</b> <span className="text-text-2">{expl.next_step}</span></p>}
            {(expl.key_points.length > 0 || expl.caveats.length > 0 || expl.next_scenarios.length > 0) && (
              <button className="justify-self-start text-[0.8rem] text-text-3 underline" onClick={() => setMore(!more)} aria-expanded={more}>{more ? "Hide" : "Show"} detailed analysis</button>
            )}
            {more && (
              <div className="grid gap-3 border-t border-line pt-3">
                {expl.key_points.length > 0 && <ul className="grid list-disc gap-1 pl-5 text-[0.86rem] text-text-2">{expl.key_points.map((k, i) => <li key={i}>{k}</li>)}</ul>}
                {expl.next_scenarios.length > 0 && onAsk && <div className="flex flex-wrap gap-1.5">{expl.next_scenarios.map((q) => <button key={q} className="chip interactive cursor-pointer" onClick={() => onAsk(q)}>{q}</button>)}</div>}
                {expl.caveats.length > 0 && <p className="text-[0.8rem] text-text-3">Depends on: {expl.caveats.join(" ")}</p>}
              </div>
            )}
            {expl.notice && <p className="text-[0.78rem] text-text-3">{expl.notice}</p>}
            {explaining && <span className="inline-flex items-center gap-2 text-[0.8rem] text-text-3"><Spinner />The charts and figures above are final; the AI is only writing the explanation.</span>}
            <p className="text-[0.74rem] text-text-3">Suggestions to consider and test, not guarantees. Every figure comes from the calculation.</p>
          </>
        )}
      </div>
    </Section>
  );
}

function Row({ k, v }: { k: string; v: ReactNode }) {
  return <div className="flex items-baseline justify-between gap-3"><span className="text-text-2">{k}</span><span className="num text-right">{v}</span></div>;
}
