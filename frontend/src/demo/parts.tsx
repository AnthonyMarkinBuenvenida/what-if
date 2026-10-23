/* Building blocks of the simplified demo, shared by the demo page and Presentation Mode. */
import { useState } from "react";
import { motion } from "motion/react";
import { DivergingBars, LineChart, RangeRows, SeriesMark, seriesStyle } from "../components/charts";
import { IconAlert, IconCheck, IconPlay } from "../components/icons";
import { DataTag, Notice, RunStatusChip, Spinner } from "../components/ui";
import { compactMoney, money, money2dp, pct, signedMoney, STATUS_LABEL } from "../lib/format";
import { useReduced } from "../lib/hooks";
import { DEMO_SHOCKS } from "./client";
import { useDemo } from "./DemoContext";
import { bestForGoal, explainWorld, mainRisk, METRIC, type MetricKey } from "./explain";

const EASE = [0.16, 1, 0.3, 1] as const;
const short = (n: string) => n.replace(" World", "");

export function EngineNotice({ big }: { big?: boolean }) {
  const { client } = useDemo();
  if (client?.kind !== "browser") return null;
  return (
    <Notice tone="warn">
      <span className={big ? "text-[1rem]" : ""}><b>Simplified engine.</b> The What-if server can't be reached, so results are calculated in your browser for the expected case only.
        They don't include the uncertainty ranges from the server's 300-run Monte Carlo simulation.</span>
    </Notice>
  );
}

export function StoreFacts({ big }: { big?: boolean }) {
  const { session } = useDemo();
  if (!session) return null;
  const b = session.business;
  const items: [string, string][] = [
    ["Sales per month at average demand", compactMoney(b.expected_monthly_revenue)],
    ["Gross margin", pct(b.gross_margin, 1)],
    ["Fixed costs per month", compactMoney(b.monthly_fixed_costs_incl_labor)],
    ["Cash today", money(b.starting_cash)],
    ["Cash safety buffer", money(b.min_cash_buffer)],
  ];
  return (
    <dl className={`grid border-l border-t border-line ${big ? "grid-cols-2 lg:grid-cols-5" : "grid-cols-2 sm:grid-cols-5"}`}>
      {items.map(([k, v]) => (
        <div key={k} className="grid gap-0.5 border-b border-r border-line p-3">
          <dt className={big ? "text-[0.95rem] text-text-2" : "text-[0.75rem] text-text-2"}>{k}</dt>
          <dd className="num font-semibold" style={{ fontFamily: "var(--font-display)", fontSize: big ? "2rem" : "1.15rem" }}>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export function GoalPicker({ big }: { big?: boolean }) {
  const { session, goal, setGoal } = useDemo();
  if (!session) return null;
  return (
    <fieldset className="grid gap-2">
      <legend className="sr-only">Business goal</legend>
      {session.goals.map((g) => {
        const on = goal?.id === g.id;
        return (
          <label key={g.id} className={`grid cursor-pointer grid-cols-[auto_1fr] gap-x-3 rounded-[var(--r-card)] border p-3 transition-colors ${on ? "border-text bg-surface-2" : "border-line hover:border-text-3"}`}>
            <input type="radio" name="goal" className="mt-1 h-4 w-4" checked={on} onChange={() => setGoal(g.id)} aria-label={g.label} aria-describedby={`goal-${g.id}-desc`} />
            <span className={big ? "text-[1.2rem] font-semibold" : "font-semibold"} aria-hidden="true">{g.label}</span>
            <span />
            <span id={`goal-${g.id}-desc`} className={big ? "text-[1rem] text-text-2" : "text-[0.84rem] text-text-2"}>{g.description}</span>
          </label>
        );
      })}
    </fieldset>
  );
}

export function AssumptionControls() {
  const { assumptions, setAssumption, resetAssumptions } = useDemo();
  const sliders = [
    { k: "demand_change_pct" as const, label: "Customer demand", min: -30, max: 20, step: 5, fmt: (v: number) => `${v > 0 ? "+" : ""}${v}%`,
      help: "How many customers buy, compared with today. −10% means one in ten fewer purchases." },
    { k: "supplier_cost_change_pct" as const, label: "Supplier costs", min: -10, max: 30, step: 2, fmt: (v: number) => `${v > 0 ? "+" : ""}${v}%`,
      help: "What the store pays suppliers for stock, compared with today." },
    { k: "budget" as const, label: "Initial spending budget", min: 0, max: 20000, step: 500, fmt: (v: number) => money(v),
      help: "The most the owner will spend up front on a new idea (for example, delivery setup). Plans that need more break this limit." },
  ];
  return (
    <div className="grid gap-5">
      {sliders.map((s) => (
        <label key={s.k} className="grid gap-1.5">
          <span className="flex items-baseline justify-between gap-3"><span className="font-semibold">{s.label}</span><b className="num text-[1.05rem]">{s.fmt(assumptions[s.k])}</b></span>
          <input type="range" className="range" min={s.min} max={s.max} step={s.step} value={assumptions[s.k]} onChange={(e) => setAssumption(s.k, +e.target.value)}
            aria-label={s.label} aria-valuetext={s.fmt(assumptions[s.k])} aria-describedby={`help-${s.k}`} />
          <span id={`help-${s.k}`} className="text-[0.8rem] text-text-3">{s.help}</span>
        </label>
      ))}
      <button className="w-fit text-[0.82rem] text-text-2 underline" onClick={resetAssumptions}>Restore defaults</button>
    </div>
  );
}

export function RunButton({ big }: { big?: boolean }) {
  const { run, running, runs, outdated, boot } = useDemo();
  return (
    <button className={`btn btn-primary ${big ? "btn-lg w-full" : "btn-lg w-full"}`} onClick={run} disabled={running || boot !== "ready"}>
      {running ? <Spinner /> : <IconPlay size={16} />}
      {running ? "Simulating…" : runs.length && outdated ? "Run again with new settings" : runs.length ? "Run simulation again" : "Run simulation"}
    </button>
  );
}

export function RunProgress({ big }: { big?: boolean }) {
  const { runs, client } = useDemo();
  if (!runs.length) return null;
  return (
    <ul className="grid gap-2" aria-live="polite">
      {runs.map((r) => {
        const t0 = r.timeline[0]?.at;
        const last = r.timeline[r.timeline.length - 1];
        return (
          <li key={r.id} className="grid gap-1.5">
            <div className="flex flex-wrap items-center gap-2">
              <SeriesMark index={r.color_index} />
              <span className={big ? "text-[1.1rem] font-semibold" : "text-[0.9rem] font-semibold"}>{short(r.scenario_name)}</span>
              <span className="ml-auto"><RunStatusChip status={r.status} progress={r.progress} /></span>
            </div>
            <div className="progress" aria-hidden="true"><i style={{ width: `${Math.round(r.progress * 100)}%` }} /></div>
            <span className="num text-[0.72rem] text-text-3">
              {STATUS_LABEL[last?.status] ?? last?.status} {t0 && last ? `after ${Math.max(0, Math.round((last.at - t0) * 1000))} ms` : ""}
              {r.status.startsWith("completed") && ` · ${client?.kind === "browser" ? "expected case, in your browser" : `${r.config.runs} runs`}`}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

export function OutdatedNotice() {
  const { outdated, comparison } = useDemo();
  if (!outdated || !comparison) return null;
  return <Notice tone="warn"><b>Results are out of date.</b> You changed the goal or an assumption after they were calculated. Run the simulation again to update them.</Notice>;
}

/** The essential result: a few goal-relevant measures per world, the main risk, and why. */
export function ResultsSummary({ big }: { big?: boolean }) {
  const { comparison, analysis, comparedGoal, comparedAssumptions, client } = useDemo();
  if (!comparison || !comparedGoal) return null;
  const metrics = comparedGoal.metrics as MetricKey[];
  const base = comparison.rows[0];
  const best = bestForGoal(comparison, metrics);
  const exp = (id: number) => comparison.explanations.find((e) => e.run_id === id);
  const mc = base.mode === "monte_carlo";
  return (
    <div className="grid gap-5">
      <div className="flex flex-wrap items-center gap-2 text-[0.8rem] text-text-2">
        <DataTag kind="calculated" detail={client?.kind === "browser" ? "Calculated in your browser (expected case)" : `Calculated by the What-if engine (${base.runs} runs per world)`} />
        <DataTag kind="sample" />
        <span>Goal: {comparedGoal.label.toLowerCase()} · demand {comparedAssumptions!.demand_change_pct >= 0 ? "+" : ""}{comparedAssumptions!.demand_change_pct}% · supplier costs {comparedAssumptions!.supplier_cost_change_pct >= 0 ? "+" : ""}{comparedAssumptions!.supplier_cost_change_pct}% · budget {money(comparedAssumptions!.budget)}</span>
      </div>
      <OutdatedNotice />
      {best && (
        <div className="border-l-2 border-text pl-4">
          <p className={big ? "text-[1.7rem] leading-snug" : "text-[1.2rem] leading-snug"} style={{ fontFamily: "var(--font-display)" }}>{best.reason}</p>
        </div>
      )}
      <div className="table-wrap">
        <table className="data">
          <thead><tr><th>Scenario</th>{metrics.map((m) => <th key={m} className="n" title={METRIC[m].hint}>{METRIC[m].label}</th>)}<th>Main risk</th></tr></thead>
          <tbody>
            {comparison.rows.map((r) => (
              <tr key={r.run_id} className={best?.row.run_id === r.run_id ? "bg-surface-2" : ""}>
                <td className="whitespace-nowrap"><span className="inline-flex items-center gap-2 font-semibold"><SeriesMark index={r.color_index} />{short(r.scenario_name)}</span>
                  {r.run_id === base.run_id && <div className="text-[0.72rem] text-text-3">today's operations</div>}</td>
                {metrics.map((m) => (
                  <td key={m} className="n">{METRIC[m].fmt(METRIC[m].get(r))}
                    {m === "avg_monthly_operating_profit" && mc && <div className="text-[0.7rem] text-text-3">{compactMoney(r.avg_monthly_operating_profit.p10)} to {compactMoney(r.avg_monthly_operating_profit.p90)}</div>}</td>
                ))}
                <td className="min-w-[14rem] text-[0.85rem]"><span className="inline-flex gap-1.5">{r.violations.length ? <IconAlert size={15} className="mt-0.5 flex-none" /> : <IconCheck size={15} className="mt-0.5 flex-none" />}{mainRisk(r)}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="grid gap-3">
        <h3 className={big ? "text-[1.3rem]" : "text-[1rem]"}>What explains the differences</h3>
        <ul className="grid gap-2.5">
          {comparison.rows.slice(1).map((r) => (
            <li key={r.run_id} className={`flex gap-2.5 ${big ? "text-[1.1rem]" : "text-[0.92rem]"}`}><SeriesMark index={r.color_index} width={18} /><span>{explainWorld(r, base, exp(r.run_id))}</span></li>
          ))}
        </ul>
      </div>
      {analysis && (
        <div className="grid gap-1.5 border-t border-line pt-4">
          <h3 className={big ? "text-[1.3rem]" : "text-[1rem]"}>Suggested next experiment</h3>
          <p className={big ? "text-[1.1rem] text-text-2" : "text-[0.92rem] text-text-2"}>{analysis.output.next_steps[0]}</p>
          <p className="text-[0.75rem] text-text-3">Written by the Decision Analyst ({analysis.mode === "ai" ? `AI: ${analysis.model}` : "deterministic rules"}) from these results. {mc ? "Ranges are the 10th to 90th percentile of runs." : "Expected case only, so there are no ranges."}</p>
        </div>
      )}
    </div>
  );
}

/** Everything else, available on request. */
export function DetailedAnalysis() {
  const d = useDemo();
  const [worldId, setWorldId] = useState<string | null>(null);
  const [shocks, setShocks] = useState<string[]>(["demand_drop", "supplier_increase"]);
  const cmp = d.comparison;
  if (!cmp || !d.session || !d.comparedGoal) return null;
  const rows = cmp.rows;
  const mc = rows[0].mode === "monte_carlo";
  const ids = d.comparedGoal.scenario_ids;
  const scen = d.session.scenarios.filter((s) => ids.includes(s.id));
  const chosen = worldId ?? scen[1]?.id ?? scen[0].id;
  const buffer = d.session.business.min_cash_buffer;
  const target = d.session.business.goals.target_monthly_operating_profit;
  return (
    <div className="grid gap-8">
      <section className="grid gap-3">
        <h3 className="t-h3">All measures</h3>
        <div className="table-wrap"><table className="data">
          <thead><tr><th>Scenario</th><th className="n">Revenue</th><th className="n">Total costs</th><th className="n">Profit / month</th><th className="n">Lowest cash</th><th className="n">Cash remaining</th><th className="n">Stock left</th><th className="n">Served</th><th className="n">Waste</th><th className="n">Up-front spend</th></tr></thead>
          <tbody>{rows.map((r) => (
            <tr key={r.run_id}><td className="whitespace-nowrap"><span className="inline-flex items-center gap-2"><SeriesMark index={r.color_index} />{short(r.scenario_name)}</span></td>
              <td className="n">{compactMoney(r.revenue.mean)}</td><td className="n">{compactMoney(r.cogs.mean + r.waste_cost.mean + r.operating_expenses.mean)}</td>
              <td className="n">{money(r.avg_monthly_operating_profit.p50)}</td><td className="n">{money(r.min_cash.p10)}</td><td className="n">{money(r.ending_cash.p50)}</td>
              <td className="n">{compactMoney(r.ending_inventory_value.mean)}</td><td className="n">{pct(r.fill_rate.mean)}</td><td className="n">{pct(r.waste_rate.mean, 1)}</td><td className="n">{money(r.one_time_costs.mean)}</td></tr>
          ))}</tbody>
        </table></div>
      </section>
      <section className="grid gap-4 xl:grid-cols-2">
        <div className="card card-pad"><h3 className="mb-3 text-[0.98rem]">Cash in the bank, week by week</h3>
          <LineChart ariaLabel="Weekly cash by scenario" xLabels={rows[0].series.cash.p50.map((_, i) => i + 1)} showBands={mc && rows.length <= 3}
            series={rows.map((r) => ({ id: r.run_id, label: short(r.scenario_name), colorIndex: r.color_index, values: r.series.cash.p50, low: r.series.cash.p10, high: r.series.cash.p90 }))}
            refLine={{ value: buffer, label: `Safety buffer ${money(buffer)}` }} /></div>
        <div className="card card-pad"><h3 className="mb-3 text-[0.98rem]">Profit per month: range of outcomes</h3>
          {mc ? <RangeRows ariaLabel="Monthly profit range" refValue={target} refLabel={`the ${money(target)} target`}
            rows={rows.map((r) => ({ label: short(r.scenario_name), colorIndex: r.color_index, ...r.avg_monthly_operating_profit }))} />
            : <p className="text-[0.88rem] text-text-2">Ranges need the Monte Carlo simulation, which runs on the What-if server.</p>}</div>
      </section>
      <section className="grid gap-4 md:grid-cols-2">
        {cmp.explanations.map((e) => !e.error && (
          <div key={e.run_id} className="card card-pad grid gap-2">
            <h3 className="text-[0.95rem]">{short(e.scenario_name)} vs. baseline: <span className="num">{signedMoney(e.monthly_operating_profit_change)}</span>/month</h3>
            <DivergingBars ariaLabel={`Profit drivers for ${e.scenario_name}`} rows={e.drivers.slice(0, 6).map((x) => ({ label: x.label, value: x.monthly_effect }))} />
          </div>
        ))}
      </section>
      <section className="grid gap-4 border-t border-line pt-6">
        <div className="flex flex-wrap items-end gap-3">
          <h3 className="t-h3 mr-auto">Stress test and sensitivity</h3>
          <label className="field"><span>Scenario</span>
            <select className="select" value={chosen} onChange={(e) => setWorldId(e.target.value)}>{scen.map((s) => <option key={s.id} value={s.id}>{short(s.name)}</option>)}</select></label>
        </div>
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="card card-pad grid content-start gap-3">
            <fieldset className="grid gap-1.5"><legend className="label mb-1">Bad conditions to test</legend>
              {DEMO_SHOCKS.map((s) => (
                <label key={s.key} className="flex items-center gap-2 text-[0.88rem]"><input type="checkbox" className="h-4 w-4" checked={shocks.includes(s.key)}
                  onChange={(e) => setShocks(e.target.checked ? [...shocks, s.key] : shocks.filter((x) => x !== s.key))} />{s.label}</label>
              ))}
            </fieldset>
            <div><button className="btn" onClick={() => d.runStress(chosen, shocks)} disabled={d.stressing || !shocks.length}>{d.stressing && <Spinner />}Run stress test</button></div>
            {d.stressError && <p className="error-text">{d.stressError}</p>}
            {d.stress && (
              <div className="grid gap-2">
                <p className="text-[0.85rem] font-semibold">{d.stress.scenario}: change in profit per month</p>
                <DivergingBars ariaLabel="Stress test results" rows={d.stress.result.rows.slice(1).map((r) => ({ label: r.label, value: r.delta.monthly_operating_profit,
                  note: <span>Profit {money(r.headline.monthly_operating_profit.p50)}/mo · lowest cash {money(r.headline.min_cash_p10)}{r.headline.violations.length ? ` · breaks: ${r.headline.violations.join("; ")}` : " · within limits"}</span> }))} />
                <ul className="grid gap-1 text-[0.82rem] text-text-2">{(d.stress.vulnerabilities.length ? d.stress.vulnerabilities : ["No tested condition broke a limit."]).map((v, i) => <li key={i}>• {v}</li>)}</ul>
              </div>
            )}
          </div>
          <div className="card card-pad grid content-start gap-3">
            <p className="text-[0.88rem] text-text-2">Which single assumption moves profit the most? Each is changed on its own while the others stay fixed.</p>
            <div><button className="btn" onClick={() => d.runSensitivity(chosen)} disabled={d.sensing}>{d.sensing && <Spinner />}Run sensitivity analysis</button></div>
            {d.sensitivity && <>
              <p className="text-[0.85rem] font-semibold">{d.sensitivity.scenario}: profit change (down / up)</p>
              <DivergingBars ariaLabel="Sensitivity" rows={d.sensitivity.rows.map((r) => ({ label: r.label, low: r.profit_low, value: r.profit_high }))} />
              <p className="text-[0.72rem] text-text-3">{d.sensitivity.method}</p>
            </>}
          </div>
        </div>
      </section>
      <section className="grid gap-2 border-t border-line pt-6 text-[0.86rem] text-text-2">
        <h3 className="t-h3 text-text">Model details</h3>
        <p>Sample store: {d.session.business.products.length} product lines ({d.session.business.products.map((p) => `${p.name} ${money2dp(p.price)}`).join(", ")}), {d.session.business.staff.reduce((a, s) => a + s.count, 0)} staff, simulated day by day for 90 days.</p>
        <p>Limits: cash stays above {money(buffer)} · profit of at least {money(target)} a month · up-front spending within the budget you set. A scenario "breaks a limit" only when its results cross one of these.</p>
        <p>Assumptions per scenario: {scen.map((s) => `${short(s.name)}: ${s.assumptions.join(" ") || "no changes"}`).join(" · ")}</p>
      </section>
    </div>
  );
}

/** One business branching into the scenarios that test the selected goal. */
export function ForkFigure({ big, ids }: { big?: boolean; ids?: string[] }) {
  const { session, goal } = useDemo();
  const reduced = useReduced();
  if (!session || !goal) return null;
  const worlds = session.scenarios.filter((s) => (ids ?? goal.scenario_ids).includes(s.id));
  const rowH = big ? 92 : 64;
  const h = Math.max(rowH * 2, worlds.length * rowH);
  return (
    <div className="grid items-center gap-6 md:grid-cols-[minmax(0,0.8fr)_120px_minmax(0,1.4fr)]">
      <div className="border border-text p-4">
        <span className={big ? "text-[0.95rem] text-text-3" : "text-[0.78rem] text-text-3"}>One digital twin</span>
        <p className={big ? "text-[1.6rem] font-semibold" : "text-[1.1rem] font-semibold"} style={{ fontFamily: "var(--font-display)" }}>{session.business.name}</p>
        <DataTag kind="sample" />
      </div>
      <svg className="hidden md:block" width="120" height={h} aria-hidden="true">
        {worlds.map((w, i) => {
          const y = (h / worlds.length) * (i + 0.5);
          const st = seriesStyle(w.color_index);
          return <motion.path key={w.id} d={`M0,${h / 2} C60,${h / 2} 60,${y} 120,${y}`} fill="none" stroke={st.color} strokeDasharray={st.dash} strokeWidth={2}
            initial={reduced ? false : { opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.6, delay: 0.1 + i * 0.08, ease: EASE }} />;
        })}
      </svg>
      <ul className="grid gap-2">
        {worlds.map((w, i) => (
          <motion.li key={w.id} className="flex items-start gap-3 border-b border-line pb-2" style={{ minHeight: rowH - 8 }}
            initial={reduced ? false : { opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }} transition={{ duration: 0.5, delay: 0.15 + i * 0.08, ease: EASE }}>
            <span className="mt-1.5"><SeriesMark index={w.color_index} /></span>
            <span className="grid gap-0.5">
              <span className={big ? "text-[1.25rem] font-semibold" : "font-semibold"}>{short(w.name)}</span>
              <span className={big ? "text-[1rem] text-text-2" : "text-[0.84rem] text-text-2"}>{w.description}</span>
            </span>
          </motion.li>
        ))}
      </ul>
    </div>
  );
}
