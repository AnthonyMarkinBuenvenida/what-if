import type { ReactNode } from "react";
import { Link, useParams } from "react-router-dom";
import { DivergingBars, LineChart, RangeRows, SeriesMark } from "../../components/charts";
import { IconAlert, IconArrowLeft, IconCheck, IconDownload, IconPrint } from "../../components/icons";
import { CalibrationChip, DemoBadge, ErrorBox, Notice, Skeleton } from "../../components/ui";
import { api } from "../../lib/api";
import { compactMoney, money, pct, signedMoney } from "../../lib/format";
import { useAsync } from "../../lib/hooks";
import type { Analysis, Comparison, Constraint, Provenance } from "../../lib/types";

interface ReportContent {
  business: { name: string; type: string; description: string; is_demo: boolean; facts: Record<string, number | null | object>; findings: string[] };
  decision: string;
  data: { sources: { filename: string; kind: string; rows: number; uploaded_at: string }[]; model_versions: { id: number; version: number; calibration: string; provenance_counts: Record<Provenance, number>; default_share: number; issues: { message: string; severity: string }[] }[]; engine_version: string };
  assumptions: { accounting: string[]; goals: Record<string, number | string | null>; uncertainty: Record<string, number> };
  scenarios: { run_id: number; name: string; color_index: number; description: string; decision: string; assumptions: string[]; applied_changes: string[]; constraints: Constraint[]; outcome: string; warnings: string[]; config: { mode: string; runs: number; horizon_days: number; seed: number; start_date?: string } }[];
  comparison: Comparison;
  outcomes: { name: string; mode: string; adverse: number; expected: number; best: number; cash_adverse: number; supported: boolean }[];
  risks: string[];
  sensitivity: { scenario: string; baseline_monthly_operating_profit: number; rows: { label: string; profit_low: number; profit_high: number }[]; method: string };
  recommendation: Analysis & { scenario_facts?: string[] };
  agent_notes: { decision_analyst: { mode: string; model: string | null; notes: string[] } };
  limitations: string[];
  confidence: string[];
}
interface Report { id: number; title: string; run_ids: number[]; model_version_ids: number[]; created_at: string; content: ReportContent }

function Section({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <section className="grid gap-3 border-t border-line pt-6" aria-labelledby={`s${n}`}>
      <h2 id={`s${n}`} className="t-h2"><span className="num mr-2 text-text-3">{n}.</span>{title}</h2>
      {children}
    </section>
  );
}

export default function ReportView() {
  const { reportId } = useParams();
  const rep = useAsync(() => api.get<Report>(`/api/reports/${reportId}`), [reportId]);
  if (rep.error) return <ErrorBox message={rep.error} onRetry={rep.reload} />;
  if (!rep.data) return <Skeleton h={500} />;
  const { content: c } = rep.data;
  const rows = c.comparison.rows;
  const mc = rows.some((r) => r.mode === "monte_carlo");
  const rec = c.recommendation;
  const target = c.assumptions.goals.target_monthly_operating_profit;
  const f = c.business.facts as Record<string, number | null>;

  return (
    <article className="mx-auto grid max-w-[980px] gap-8">
      <div className="no-print flex flex-wrap items-center gap-2">
        <Link to="/app/reports" className="inline-flex items-center gap-1.5 text-[0.85rem] text-text-2 no-underline"><IconArrowLeft size={15} />All reports</Link>
        <div className="ml-auto flex gap-2">
          <button className="btn btn-sm" onClick={() => window.print()}><IconPrint size={15} />Save as PDF</button>
          <a className="btn btn-sm no-underline" href={`/api/reports/${rep.data.id}/csv`} download><IconDownload size={15} />Download CSV</a>
        </div>
      </div>

      <header className="grid gap-3">
        <div className="flex flex-wrap items-center gap-2">{c.business.is_demo && <DemoBadge />}{c.data.model_versions.map((v) => <CalibrationChip key={v.id} status={v.calibration} />)}</div>
        <h1 className="t-display text-[clamp(2rem,1.4rem+2vw,3rem)]">{rep.data.title}</h1>
        <p className="num text-[0.85rem] text-text-3">Report #{rep.data.id} · {new Date(rep.data.created_at).toLocaleString()} · runs {rep.data.run_ids.join(", ")} · {c.data.engine_version}</p>
        <Notice>These are simulation results under the assumptions listed below, not forecasts or guarantees.{c.business.is_demo ? " This report uses fictional demo data." : ""}</Notice>
      </header>

      <section className="panel grid gap-2 p-5" style={{ boxShadow: `inset 4px 0 0 var(--text)` }}>
        <span className="text-[0.8rem] text-text-3">Recommendation · Decision Analyst ({c.agent_notes.decision_analyst.mode === "ai" ? `AI: ${c.agent_notes.decision_analyst.model}` : "deterministic rules"})</span>
        <p className="text-[1.25rem] leading-snug" style={{ fontFamily: "var(--font-display)" }}>{rec.recommendation}</p>
        {rec.depends_on_assumptions && <p className="chip chip-warn w-fit">Depends on unresolved assumptions; test before committing</p>}
      </section>

      <Section n={1} title="Business overview">
        <p className="text-text-2">{c.business.name} · {c.business.type}{c.business.description ? `. ${c.business.description}` : ""}</p>
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4 text-[0.9rem]">
          <div><div className="text-text-3">Expected sales / month</div><b className="num">{money(f.expected_monthly_revenue)}</b></div>
          <div><div className="text-text-3">Gross margin</div><b className="num">{pct(f.gross_margin as number, 1)}</b></div>
          <div><div className="text-text-3">Fixed costs / month</div><b className="num">{money(f.monthly_fixed_costs_incl_labor)}</b></div>
          <div><div className="text-text-3">Starting cash</div><b className="num">{money(f.starting_cash)}</b></div>
        </div>
        <ul className="grid gap-1 text-[0.88rem] text-text-2">{c.business.findings.slice(0, 6).map((x, i) => <li key={i}>• {x}</li>)}</ul>
      </Section>

      <Section n={2} title="Decision being evaluated"><p className="text-[1.05rem]">{c.decision || "Not stated."}</p></Section>

      <Section n={3} title="Data sources and model version">
        {c.data.model_versions.map((v) => (
          <p key={v.id} className="text-[0.9rem] text-text-2">Model v{v.version} ({v.calibration}): {v.provenance_counts.confirmed ?? 0} values from imported data, {v.provenance_counts.user ?? 0} entered by the owner, {v.provenance_counts.inferred ?? 0} inferred, {v.provenance_counts.calibrated ?? 0} calibrated, {v.provenance_counts.default ?? 0} What-if defaults ({pct(v.default_share)}).</p>
        ))}
        {c.data.sources.length ? <ul className="text-[0.88rem] text-text-2">{c.data.sources.map((s, i) => <li key={i}>• {s.filename} ({s.kind}, {s.rows} rows)</li>)}</ul> : <p className="text-[0.88rem] text-text-3">No files imported; values were entered by hand or are defaults.</p>}
      </Section>

      <Section n={4} title="Important assumptions">
        <ul className="grid gap-1 text-[0.88rem] text-text-2">{c.assumptions.accounting.map((x, i) => <li key={i}>• {x}</li>)}</ul>
        <p className="text-[0.88rem] text-text-2">Demand-level uncertainty ±{c.assumptions.uncertainty.demand_level_pct}%, supplier-price uncertainty ±{c.assumptions.uncertainty.supplier_cost_pct}%. Limits: cash floor {money(Number(c.assumptions.goals.min_cash_floor ?? 0))}{target != null ? `, operating profit at least ${money(Number(target))}/month` : ""}{c.assumptions.goals.max_investment != null ? `, one-time spending within ${money(Number(c.assumptions.goals.max_investment))}` : ""}; risk tolerance {String(c.assumptions.goals.risk_tolerance)}.</p>
        {c.data.model_versions.flatMap((v) => v.issues).length > 0 && <ul className="grid gap-1 text-[0.85rem]">{c.data.model_versions.flatMap((v) => v.issues).slice(0, 8).map((x, i) => <li key={i} className="flex gap-2 text-[var(--text)]"><IconAlert size={14} />{x.message}</li>)}</ul>}
      </Section>

      <Section n={5} title="Scenario descriptions">
        <div className="grid gap-3">{c.scenarios.map((s) => (
          <div key={s.run_id} className="card card-pad grid gap-1">
            <b>{s.name} <span className="font-normal text-text-3">(run #{s.run_id}, {s.config.mode === "monte_carlo" ? `${s.config.runs} runs` : "expected case"}, {s.config.horizon_days} days, seed {s.config.seed})</span></b>
            {s.description && <p className="text-[0.88rem] text-text-2">{s.description}</p>}
            <p className="text-[0.85rem]"><span className="text-text-3">Changes: </span>{s.applied_changes.join("; ") || "none (baseline)"}</p>
            {s.assumptions.length > 0 && <p className="text-[0.85rem]"><span className="text-text-3">Assumes: </span>{s.assumptions.join(" ")}</p>}
          </div>))}</div>
      </Section>

      <Section n={6} title="Comparison of key measures">
        <div className="table-wrap"><table className="data">
          <thead><tr><th>Scenario</th><th className="n">Revenue</th><th className="n">Gross profit</th><th className="n">Operating profit</th><th className="n">Per month</th><th className="n">One-time</th><th className="n">Ending cash</th><th className="n">Served</th><th className="n">Waste</th></tr></thead>
          <tbody>{rows.map((r) => (
            <tr key={r.run_id}><td><span className="inline-flex items-center gap-2"><SeriesMark index={r.color_index} />{r.scenario_name}</span></td>
              <td className="n">{compactMoney(r.revenue.mean)}</td><td className="n">{compactMoney(r.gross_profit.mean)}</td><td className="n">{compactMoney(r.operating_profit.mean)}</td>
              <td className="n">{money(r.avg_monthly_operating_profit.mean)}</td><td className="n">{money(r.one_time_costs.mean)}</td><td className="n">{money(r.ending_cash.mean)}</td>
              <td className="n">{pct(r.fill_rate.mean, 1)}</td><td className="n">{pct(r.waste_rate.mean, 1)}</td></tr>))}</tbody>
        </table></div>
        <div className="card card-pad"><LineChart ariaLabel="Weekly cash by scenario" xLabels={rows[0].series.cash.p50.map((_, i) => i + 1)} animate={false}
          series={rows.map((r) => ({ id: r.run_id, label: r.scenario_name, colorIndex: r.color_index, values: r.series.cash.p50 }))} /></div>
        {c.comparison.explanations.map((e) => !e.error && (
          <div key={e.run_id} className="card card-pad grid gap-2"><h3 className="text-[0.95rem]">{e.scenario_name} vs. {rows[0].scenario_name}: {signedMoney(e.monthly_operating_profit_change)}/month</h3>
            <DivergingBars ariaLabel={`Drivers for ${e.scenario_name}`} rows={e.drivers.map((d) => ({ label: d.label, value: d.monthly_effect }))} />
            {e.notes.map((n, i) => <p key={i} className="text-[0.8rem] text-text-3">{n}</p>)}</div>))}
      </Section>

      <Section n={7} title="Best-case, expected and adverse outcomes">
        {mc ? <>
          <div className="table-wrap"><table className="data">
            <thead><tr><th>Scenario</th><th className="n">Adverse (p10)</th><th className="n">Expected (mean)</th><th className="n">Best (p90)</th><th className="n">Lowest cash, adverse</th></tr></thead>
            <tbody>{c.outcomes.map((o) => <tr key={o.name}><td>{o.name}</td><td className="n">{money(o.adverse)}</td><td className="n">{money(o.expected)}</td><td className="n">{money(o.best)}</td><td className="n">{money(o.cash_adverse)}</td></tr>)}</tbody>
          </table></div>
          <div className="card card-pad"><RangeRows ariaLabel="Monthly operating profit range" refValue={target != null ? Number(target) : null} refLabel="the profit target"
            rows={rows.map((r) => ({ label: r.scenario_name, colorIndex: r.color_index, ...r.avg_monthly_operating_profit }))} /></div>
          <p className="text-[0.8rem] text-text-3">Operating profit per month across Monte Carlo runs. Adverse and best are the 10th and 90th percentiles, not worst or best possible cases.</p>
        </> : <p className="text-text-2">These runs used the expected case only, so the model does not support best/adverse ranges. Rerun with Monte Carlo to get them.</p>}
      </Section>

      <Section n={8} title="Main risks and constraints">
        <ul className="grid gap-1.5 text-[0.9rem]">{c.risks.map((r, i) => <li key={i} className="flex gap-2"><span className="mt-1 text-[var(--text)]"><IconAlert size={14} /></span>{r}</li>)}</ul>
        <div className="grid gap-2">{c.scenarios.map((s) => (
          <div key={s.run_id} className="text-[0.86rem]"><b>{s.name}:</b> {s.constraints.map((k) => <span key={k.key} className={`mr-3 inline-flex items-center gap-1 ${k.violated ? "text-[var(--text)]" : "text-[var(--text)]"}`}>{k.violated ? <IconAlert size={13} /> : <IconCheck size={13} />}{k.label} ({k.value})</span>)}</div>))}</div>
      </Section>

      <Section n={9} title="Sensitivity analysis">
        <p className="text-[0.88rem] text-text-2">How monthly operating profit for <b>{c.sensitivity.scenario}</b> ({money(c.sensitivity.baseline_monthly_operating_profit)}/month) moves when one assumption changes. {c.sensitivity.method}</p>
        <div className="card card-pad"><DivergingBars ariaLabel="Sensitivity of monthly profit" rows={c.sensitivity.rows.map((r) => ({ label: r.label, low: r.profit_low, value: r.profit_high }))} /></div>
      </Section>

      <Section n={10} title="Recommended next steps">
        <p className="text-text-2">{rec.summary}</p>
        {rec.scenario_facts && <ul className="grid gap-1 text-[0.86rem] text-text-2">{rec.scenario_facts.map((x, i) => <li key={i}>• {x}</li>)}</ul>}
        <ol className="grid gap-1.5 text-[0.92rem]">{rec.next_steps.map((x, i) => <li key={i}><span className="num mr-2 text-text-3">{i + 1}.</span>{x}</li>)}</ol>
        <p className="text-[0.78rem] text-text-3">Ranking rule: {rec.ranking_rule}</p>
        {c.agent_notes.decision_analyst.notes.map((n, i) => <p key={i} className="text-[0.78rem] text-text-3">{n}</p>)}
      </Section>

      <Section n={11} title="Data limitations and confidence">
        <ul className="grid gap-1 text-[0.88rem] text-text-2">{c.confidence.map((x, i) => <li key={i}>• {x}</li>)}{c.limitations.map((x, i) => <li key={`l${i}`}>• {x}</li>)}</ul>
      </Section>
    </article>
  );
}
