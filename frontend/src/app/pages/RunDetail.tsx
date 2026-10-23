import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { DivergingBars, LineChart, SeriesMark } from "../../components/charts";
import { IconAlert, IconArrowLeft, IconCheck, IconMuseum, IconRetry, IconStop } from "../../components/icons";
import { ErrorBox, Modal, Notice, OutcomeChip, RunStatusChip, Skeleton, Spinner, Stat, useToast } from "../../components/ui";
import { api } from "../../lib/api";
import { compactMoney, duration, int, isActive, isDone, money, pct, signedMoney, when } from "../../lib/format";
import { useAsync, usePolling } from "../../lib/hooks";
import type { Run, SensitivityResults, SimResults, StressResults } from "../../lib/types";

interface Shock { key: string; label: string }

function StressView({ res }: { res: StressResults }) {
  return (
    <div className="grid gap-5">
      <div className="grid gap-4 md:grid-cols-3">
        <Stat label="Conditions tested" value={res.summary.conditions_tested} />
        <Stat label="Still within limits" value={res.summary.conditions_passed} tone={res.summary.conditions_passed < res.summary.conditions_tested ? "bad" : undefined} />
        <Stat label="Largest profit impact" value={`${signedMoney(res.summary.largest_profit_impact.monthly_change)}/mo`} sub={res.summary.largest_profit_impact.label} />
      </div>
      <div className="card card-pad"><h3 className="mb-3 text-[1rem]">Change in monthly operating profit</h3>
        <DivergingBars ariaLabel="Profit change per stress condition" rows={res.rows.slice(1).map((r) => ({ label: r.label, value: r.delta.monthly_operating_profit }))} /></div>
      <div className="card card-pad"><h3 className="mb-3 text-[1rem]">Cash in a bad run (10th percentile), week by week</h3>
        <LineChart ariaLabel="Cash in a bad run per condition" xLabels={res.rows[0].series_cash_p10.map((_, i) => i + 1)}
          series={res.rows.map((r, i) => ({ id: r.key, label: r.label, colorIndex: i, values: r.series_cash_p10, dashed: r.key === "unstressed" }))} /></div>
      <div className="table-wrap"><table className="data">
        <thead><tr><th>Condition</th><th className="n">Profit / month (median)</th><th className="n">Change</th><th className="n">Lowest cash (p10)</th><th className="n">Runs below buffer</th><th>Limits</th></tr></thead>
        <tbody>{res.rows.map((r) => (
          <tr key={r.key}><td>{r.label}</td><td className="n">{money(r.headline.monthly_operating_profit.p50)}</td><td className="n">{r.key === "unstressed" ? "—" : signedMoney(r.delta.monthly_operating_profit)}</td>
            <td className="n">{money(r.headline.min_cash_p10)}</td><td className="n">{pct(r.headline.cash_below_buffer)}</td>
            <td>{r.headline.violations.length ? <span className="text-[0.82rem] text-[var(--text)]">{r.headline.violations.join("; ")}</span> : <span className="chip chip-good"><IconCheck size={13} />Within limits</span>}</td></tr>
        ))}</tbody>
      </table></div>
    </div>
  );
}

function SensitivityView({ res }: { res: SensitivityResults }) {
  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <div className="card card-pad"><h3 className="mb-1 text-[1rem]">Monthly operating profit</h3><p className="mb-3 text-[0.8rem] text-text-3">Baseline {money(res.baseline_monthly_operating_profit)}/month. Each bar pair: assumption moved down / up.</p>
        <DivergingBars ariaLabel="Profit sensitivity" rows={res.rows.map((r) => ({ label: r.label, low: r.profit_low, value: r.profit_high }))} /></div>
      <div className="card card-pad"><h3 className="mb-1 text-[1rem]">Lowest cash balance</h3><p className="mb-3 text-[0.8rem] text-text-3">Baseline lowest cash {money(res.baseline_min_cash)}.</p>
        <DivergingBars ariaLabel="Cash sensitivity" rows={res.rows.map((r) => ({ label: r.label, low: r.cash_low, value: r.cash_high }))} /></div>
      <p className="text-[0.8rem] text-text-3 lg:col-span-2">{res.method}</p>
    </div>
  );
}

function ScenarioView({ run, res }: { run: Run; res: SimResults }) {
  const S = res.summary;
  const mc = res.config.mode === "monte_carlo";
  const weeks = res.series.weeks;
  const P = res.probabilities;
  return (
    <div className="grid gap-6">
      <section className="panel grid grid-cols-2 gap-5 p-5 md:grid-cols-4">
        <Stat label="Operating profit / month" value={money(S.avg_monthly_operating_profit.p50)} sub={mc ? `${compactMoney(S.avg_monthly_operating_profit.p10)} to ${compactMoney(S.avg_monthly_operating_profit.p90)} (p10–p90)` : "expected case"} tone={S.avg_monthly_operating_profit.p50 < 0 ? "bad" : undefined} />
        <Stat label="Revenue" value={compactMoney(S.revenue.mean)} sub={`over ${res.config.horizon_days} days`} />
        <Stat label="Lowest cash" value={money(S.min_cash.p10)} sub={mc ? "in a bad run (p10)" : "expected"} tone={S.min_cash.p10 < 0 ? "bad" : undefined} />
        <Stat label="Ending cash" value={money(S.ending_cash.p50)} />
        <Stat label="Demand served" value={pct(S.fill_rate.mean, 1)} sub={`${int(S.lost_sales_units.mean)} units turned away`} />
        <Stat label="Waste" value={pct(S.waste_rate.mean, 1)} sub={`${money(S.waste_cost.mean)} written off`} />
        <Stat label="Staff time used" value={pct(S.labor_utilization.mean)} sub={S.capacity_limited_day_share.mean > 0 ? `capacity limited ${pct(S.capacity_limited_day_share.mean)} of days` : "no capacity limit hit"} />
        <Stat label="Stock left at end" value={compactMoney(S.ending_inventory_value.mean)} sub={`${int(S.ending_inventory_units.mean)} units`} />
      </section>

      <section className="grid gap-4 lg:grid-cols-2">
        <div className="card card-pad"><h3 className="mb-3 text-[1rem]">Cash balance</h3>
          <LineChart ariaLabel="Weekly cash balance" xLabels={weeks} series={[{ id: "cash", label: run.scenario_name, colorIndex: run.color_index, values: res.series.cash.p50, low: mc ? res.series.cash.p10 : undefined, high: mc ? res.series.cash.p90 : undefined }]}
            refLine={run.criteria.min_cash_floor != null ? { value: Number(run.criteria.min_cash_floor), label: `Cash floor ${money(Number(run.criteria.min_cash_floor))}` } : undefined} /></div>
        <div className="card card-pad"><h3 className="mb-3 text-[1rem]">Cumulative operating profit</h3>
          <LineChart ariaLabel="Cumulative operating profit" xLabels={weeks} series={[{ id: "cp", label: run.scenario_name, colorIndex: run.color_index, values: res.series.cumulative_operating_profit.p50, low: mc ? res.series.cumulative_operating_profit.p10 : undefined, high: mc ? res.series.cumulative_operating_profit.p90 : undefined }]} /></div>
        <div className="card card-pad"><h3 className="mb-3 text-[1rem]">Units in stock (end of week)</h3>
          <LineChart ariaLabel="Inventory units" format={(v) => int(v)} xLabels={weeks} series={[{ id: "inv", label: "Units", colorIndex: run.color_index, values: res.series.inventory_units.p50, low: mc ? res.series.inventory_units.p10 : undefined, high: mc ? res.series.inventory_units.p90 : undefined }]} /></div>
        <div className="card card-pad"><h3 className="mb-3 text-[1rem]">Weekly revenue</h3>
          <LineChart ariaLabel="Weekly revenue" xLabels={weeks} series={[{ id: "rev", label: "Revenue", colorIndex: run.color_index, values: res.series.revenue.p50, low: mc ? res.series.revenue.p10 : undefined, high: mc ? res.series.revenue.p90 : undefined }]} /></div>
      </section>

      <section className="grid gap-4 lg:grid-cols-[1fr_1fr]">
        <div className="grid content-start gap-2"><h3 className="t-h3">Limits</h3>
          <ul className="card divide">{res.constraints.map((c) => (
            <li key={c.key} className="flex gap-3 px-4 py-3 text-[0.88rem]">
              <span className={c.violated ? "text-[var(--text)]" : "text-[var(--text)]"}>{c.violated ? <IconAlert size={16} /> : <IconCheck size={16} />}</span>
              <span className="grid gap-0.5"><span className="font-medium">{c.label}</span><span className="text-text-2">Result: {c.value}. Limit: {c.limit}.</span><span className="text-[0.75rem] text-text-3">{c.basis}</span></span>
            </li>))}</ul>
          <p className="text-[0.8rem] text-text-3">Chance cash falls below zero: {pct(P.cash_below_zero)} · below the buffer: {pct(P.cash_below_buffer)}{P.meets_profit_target != null && <> · profit target met: {pct(P.meets_profit_target)}</>}. {P.basis}.</p>
        </div>
        <div className="grid content-start gap-2"><h3 className="t-h3">Profit and loss over the period</h3>
          <div className="table-wrap"><table className="data"><tbody>
            {([["Store sales", S.sales_revenue], ["Delivery fees", S.delivery_revenue], ["Cost of goods sold", S.cogs, -1], ["Expired stock written off", S.waste_cost, -1], ["Gross profit", S.gross_profit, 0, true],
              ["Labor", S.labor_cost, -1], ["Rent and recurring expenses", S.recurring_expenses, -1], ["Delivery costs", S.delivery_costs, -1], ["Operating profit", S.operating_profit, 0, true],
              ["One-time costs (cash only)", S.one_time_costs, -1], ["Purchases paid (cash)", S.purchases_paid, -1]] as const).map(([l, d, sign, bold]) => (
              <tr key={l}><td className={bold ? "font-semibold" : ""}>{l}</td><td className={`n ${bold ? "font-semibold" : ""}`}>{sign === -1 && d.mean ? "−" : ""}{money(Math.abs(d.mean))}</td></tr>
            ))}
          </tbody></table></div>
          <p className="text-[0.75rem] text-text-3">Mean across runs. One-time costs and purchases affect cash, not operating profit.</p>
        </div>
      </section>

      {res.per_product.length > 0 && (
        <section className="grid gap-2"><h3 className="t-h3">By product</h3>
          <div className="table-wrap"><table className="data">
            <thead><tr><th>Product</th><th className="n">Price</th><th className="n">Demand / day</th><th className="n">Units sold</th><th className="n">Revenue</th><th className="n">Wasted</th><th className="n">Turned away</th><th className="n">Days out of stock</th></tr></thead>
            <tbody>{res.per_product.map((p) => (
              <tr key={p.id}><td>{p.name}</td><td className="n">{money(p.price)}</td><td className="n">{p.expected_daily_demand.toFixed(1)}</td><td className="n">{int(p.units_sold)}</td><td className="n">{money(p.revenue)}</td>
                <td className="n">{int(p.waste_units)}</td><td className="n">{int(p.lost_sales_units)}</td><td className="n">{pct(p.stockout_day_share)}</td></tr>))}</tbody>
          </table></div>
        </section>
      )}
    </div>
  );
}

export default function RunDetail() {
  const { runId } = useParams();
  const nav = useNavigate();
  const toast = useToast();
  const run = useAsync(() => api.get<Run>(`/api/runs/${runId}`), [runId]);
  const children = useAsync(async () => (run.data ? api.get<Run[]>(`/api/businesses/${run.data.business_id}/runs?limit=200`).then((rs) => rs.filter((r) => r.parent_run_id === run.data!.id)) : []), [run.data?.id, run.data?.status]);
  const shocks = useAsync(() => api.get<{ shocks: Shock[] }>("/api/scenario-levers").then((r) => r.shocks), []);
  const [stressOpen, setStressOpen] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const [custom, setCustom] = useState({ demand_change_pct: "", supplier_cost_change_pct: "", unexpected_expense: "" });
  const [failOpen, setFailOpen] = useState(false);
  const [lessons, setLessons] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const r = run.data;
  usePolling(run.reload, !!r && isActive(r.status), 700);
  usePolling(children.reload, (children.data ?? []).some((c) => isActive(c.status)), 900);

  if (run.error) return <ErrorBox message={run.error} onRetry={run.reload} />;
  if (!r) return <div className="grid gap-3"><Skeleton h={40} w={360} /><Skeleton h={320} /></div>;

  async function post(path: string, body: Record<string, unknown> | undefined, msg: string, go?: (x: Run) => string) {
    setBusy(true);
    try {
      const x = await api.post<Run>(path, body);
      toast(msg);
      if (go) nav(go(x));
      else run.reload();
      children.reload();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "bad");
    } finally {
      setBusy(false);
    }
  }

  async function recordFailure() {
    setBusy(true);
    try {
      await api.post(`/api/businesses/${r!.business_id}/failures`, { run_id: r!.id, lessons, rejected_reason: reason });
      toast("Added to the Failure Museum.");
      setFailOpen(false);
      nav("/app/failures");
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "bad");
    } finally {
      setBusy(false);
    }
  }

  const res = r.results;
  return (
    <div className="grid gap-6">
      <div className="grid gap-3">
        <Link to="/app/simulations" className="inline-flex w-fit items-center gap-1.5 text-[0.85rem] text-text-2 no-underline"><IconArrowLeft size={15} />All simulations</Link>
        <div className="flex flex-wrap items-center gap-3">
          <SeriesMark index={r.color_index} />
          <h1 className="t-h1">{r.scenario_name}{r.kind !== "scenario" && <span className="text-text-3"> · {r.kind === "stress" ? "stress test" : "sensitivity"}</span>}</h1>
          <RunStatusChip status={r.status} progress={r.progress} /><OutcomeChip outcome={r.outcome} />
        </div>
        <p className="num text-[0.85rem] text-text-2">
          Run #{r.id} · model v{r.model_version} · {r.config.mode === "monte_carlo" ? `${r.config.runs} Monte Carlo runs` : "expected case"} · {r.config.horizon_days} days from {r.config.start_date} · seed {r.config.seed}
          {r.parent_run_id && <> · based on <Link to={`/app/runs/${r.parent_run_id}`}>run #{r.parent_run_id}</Link></>} · {when(r.created_at)}{duration(r.started_at, r.finished_at) && ` · took ${duration(r.started_at, r.finished_at)}`}
          {res && "engine_version" in res && ` · ${res.engine_version}`}
        </p>
        <div className="flex flex-wrap gap-2">
          {isActive(r.status) && <button className="btn btn-sm" onClick={() => post(`/api/runs/${r.id}/cancel`, undefined, "Cancelling.")}><IconStop size={14} />Cancel</button>}
          {!isActive(r.status) && <button className="btn btn-sm" disabled={busy} onClick={() => post(`/api/runs/${r.id}/retry`, undefined, "Queued again with the same settings and seed.", (x) => `/app/runs/${x.id}`)}><IconRetry size={14} />{isDone(r.status) ? "Rerun" : "Retry"}</button>}
          {r.kind === "scenario" && isDone(r.status) && <>
            <button className="btn btn-sm" onClick={() => setStressOpen(true)}>Stress test this world</button>
            <button className="btn btn-sm" disabled={busy} onClick={() => post(`/api/runs/${r.id}/sensitivity`, undefined, "Sensitivity analysis queued.", (x) => `/app/runs/${x.id}`)}>Sensitivity analysis</button>
            <button className="btn btn-sm" onClick={() => setFailOpen(true)}><IconMuseum size={14} />{r.outcome === "failed_constraints" ? "Add to Failure Museum" : "Reject this experiment"}</button>
            <Link className="btn btn-sm no-underline" to={`/app/feedback?run=${r.id}`}>Record actual results</Link>
          </>}
        </div>
      </div>

      {r.outdated.map((o, i) => <Notice key={i} tone="warn">{o}</Notice>)}
      {r.inputs?.validation_status === "exploratory" && <Notice>Exploratory run: the model had warnings or default values ({pct(r.inputs.default_share ?? 0)} defaults). Treat results as indicative.</Notice>}
      {r.warnings.filter((w) => !w.startsWith("Exploratory")).map((w, i) => <Notice key={i} tone="warn">{w}</Notice>)}
      {r.status === "failed" && <ErrorBox message={r.error ?? "The run failed."} />}
      {isActive(r.status) && (
        <div className="panel grid gap-2 p-5"><div className="flex items-center gap-2 text-text-2"><span className="pulse-dot" />{r.stage || "Waiting for a worker"}</div>
          <div className="progress"><i style={{ width: `${Math.round(r.progress * 100)}%` }} /></div></div>
      )}
      {res && r.kind === "scenario" && "applied_changes" in res && (
        <div className="card card-pad text-[0.88rem]"><b>What this world changes: </b><span className="text-text-2">{res.applied_changes.length ? res.applied_changes.join("; ") : "Nothing (baseline)."}</span></div>
      )}
      {res && r.kind === "scenario" && <ScenarioView run={r} res={res as SimResults} />}
      {res && r.kind === "stress" && <StressView res={res as StressResults} />}
      {res && r.kind === "sensitivity" && <SensitivityView res={res as SensitivityResults} />}

      {(children.data ?? []).length > 0 && (
        <section className="grid gap-2"><h3 className="t-h3">Follow-up analyses</h3>
          <ul className="card divide">{children.data!.map((c) => (
            <li key={c.id}><Link to={`/app/runs/${c.id}`} className="flex flex-wrap items-center gap-3 px-4 py-2.5 no-underline hover:bg-surface-2"><span className="num">#{c.id}</span><span className="flex-1">{c.kind === "stress" ? `Stress test: ${(c.config.shocks ?? []).length} conditions` : "Sensitivity analysis"}</span><RunStatusChip status={c.status} progress={c.progress} /></Link></li>
          ))}</ul></section>
      )}

      <Modal open={stressOpen} onClose={() => setStressOpen(false)} title="Stress test this world">
        <div className="grid gap-4">
          <p className="text-[0.9rem] text-text-2">Each condition runs on top of this world's settings with the same random draws, then all together.</p>
          <fieldset className="grid gap-1.5">{(shocks.data ?? []).map((s) => (
            <label key={s.key} className="flex items-center gap-2 text-[0.9rem]"><input type="checkbox" className="h-4 w-4 accent-[var(--text)]" checked={picked.includes(s.key)} onChange={(e) => setPicked(e.target.checked ? [...picked, s.key] : picked.filter((x) => x !== s.key))} />{s.label}</label>
          ))}</fieldset>
          <details><summary className="cursor-pointer text-[0.9rem] font-medium">Custom condition</summary>
            <div className="mt-3 grid gap-3 sm:grid-cols-3">
              <label className="field"><span>Demand change %</span><input className="input input-num" value={custom.demand_change_pct} onChange={(e) => setCustom({ ...custom, demand_change_pct: e.target.value })} /></label>
              <label className="field"><span>Supplier price %</span><input className="input input-num" value={custom.supplier_cost_change_pct} onChange={(e) => setCustom({ ...custom, supplier_cost_change_pct: e.target.value })} /></label>
              <label className="field"><span>Surprise bill $</span><input className="input input-num" value={custom.unexpected_expense} onChange={(e) => setCustom({ ...custom, unexpected_expense: e.target.value })} /></label>
            </div></details>
          <div className="flex justify-end"><button className="btn btn-primary" disabled={busy || (!picked.length && !Object.values(custom).some(Boolean))}
            onClick={() => post(`/api/runs/${r.id}/stress`, { shocks: picked, custom: Object.fromEntries(Object.entries(custom).filter(([, v]) => v !== "").map(([k, v]) => [k, +v])), runs: 300 }, "Stress test queued.", (x) => `/app/runs/${x.id}`)}>
            {busy && <Spinner />}Run stress test</button></div>
        </div>
      </Modal>

      <Modal open={failOpen} onClose={() => setFailOpen(false)} title={r.outcome === "failed_constraints" ? "Add to the Failure Museum" : "Reject this experiment"}>
        <div className="grid gap-4">
          {r.outcome === "failed_constraints"
            ? <p className="text-[0.9rem] text-text-2">This run broke at least one defined limit. The record keeps what was tested, which limits were exceeded and the assumptions behind it.</p>
            : <><p className="text-[0.9rem] text-text-2">This run stayed within every defined limit, so it is not a failure. You can still keep it as a rejected experiment if you give the reason.</p>
              <label className="field"><span>Why are you rejecting it?</span><textarea className="textarea" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} /></label></>}
          <label className="field"><span>What did you learn? (optional)</span><textarea className="textarea" rows={3} value={lessons} onChange={(e) => setLessons(e.target.value)} /></label>
          <div className="flex justify-end"><button className="btn btn-primary" onClick={recordFailure} disabled={busy || (r.outcome !== "failed_constraints" && !reason.trim())}>{busy && <Spinner />}Save to the museum</button></div>
        </div>
      </Modal>
    </div>
  );
}
