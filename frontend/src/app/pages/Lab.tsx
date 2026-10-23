import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { DivergingBars, LineChart, RangeRows, SeriesMark } from "../../components/charts";
import { IconAlert, IconCheck, IconPlay, IconReport } from "../../components/icons";
import { Empty, ErrorBox, Notice, PageHeader, Skeleton, Spinner, useToast } from "../../components/ui";
import { api } from "../../lib/api";
import { compactMoney, int, isActive, isDone, money, pct, signedMoney } from "../../lib/format";
import { useAsync, usePolling } from "../../lib/hooks";
import type { AgentEnvelope, Analysis, Comparison, Scenario } from "../../lib/types";
import { useWorkspace } from "../workspace";

const METRICS = {
  cash: { label: "Cash balance", fmt: compactMoney },
  cumulative_operating_profit: { label: "Cumulative operating profit", fmt: compactMoney },
  revenue: { label: "Weekly revenue", fmt: compactMoney },
  inventory_units: { label: "Units in stock", fmt: (v: number) => int(v) },
} as const;
type MetricKey = keyof typeof METRICS;

const QUICK: [keyof Scenario["levers"], string][] = [["price_change_pct", "Price %"], ["demand_change_pct", "Demand %"], ["supplier_cost_change_pct", "Supplier price %"], ["order_quantity_change_pct", "Order quantity %"]];

export default function Lab() {
  const ws = useWorkspace();
  const b = ws.current;
  const nav = useNavigate();
  const toast = useToast();
  const scen = useAsync(async () => (b ? api.get<Scenario[]>(`/api/businesses/${b.id}/scenarios`) : []), [b?.id]);
  const [chosen, setChosen] = useState<number[] | null>(null);
  const [cmp, setCmp] = useState<{ comparison: Comparison; analysis: AgentEnvelope<Analysis>; outdated: Record<string, string[]> } | null>(null);
  const [cmpError, setCmpError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [metric, setMetric] = useState<MetricKey>("cash");
  const [bands, setBands] = useState(false);
  const [adjust, setAdjust] = useState<{ id: number; values: Record<string, string> } | null>(null);
  const [busy, setBusy] = useState(false);

  const list = scen.data ?? [];
  const withRuns = list.filter((s) => s.latest_run && isDone(s.latest_run.status));
  const anyActive = list.some((s) => s.latest_run && isActive(s.latest_run.status));
  usePolling(scen.reload, anyActive, 1000);

  // Default selection: the latest completed run of up to five scenarios.
  const runIds = useMemo(() => (chosen ?? withRuns.slice(0, 5).map((s) => s.id)).map((sid) => list.find((s) => s.id === sid)?.latest_run).filter((r) => r && isDone(r.status)).map((r) => r!.id), [chosen, withRuns, list]);
  const key = runIds.join(",");

  useEffect(() => {
    if (!b || !runIds.length) { setCmp(null); return; }
    let stale = false;
    setLoading(true);
    api.post<{ comparison: Comparison; analysis: AgentEnvelope<Analysis>; outdated: Record<string, string[]> }>(`/api/businesses/${b.id}/compare`, { run_ids: runIds })
      .then((r) => { if (!stale) { setCmp(r); setCmpError(null); } })
      .catch((e) => !stale && setCmpError(e instanceof Error ? e.message : String(e)))
      .finally(() => !stale && setLoading(false));
    return () => { stale = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [b?.id, key]);

  if (!b) return <Empty title="No business selected" action={<button className="btn btn-primary" onClick={() => nav("/app/new")}>Create business model</button>} />;
  if (scen.error) return <ErrorBox message={scen.error} onRetry={scen.reload} />;
  if (scen.loading && !scen.data) return <Skeleton h={400} />;
  if (!withRuns.length) return (
    <div><PageHeader title="Parallel Decision Lab" sub="Compare worlds side by side once they have results." />
      <Empty title={anyActive ? "Simulations are running" : "No completed results yet"} action={<Link to="/app/worlds" className="btn btn-primary no-underline">Go to Parallel Worlds</Link>}>
        {anyActive ? "Results appear here as soon as the engine finishes." : "Run at least one scenario (ideally a baseline and an alternative) to compare them here."}</Empty></div>
  );

  const selectedScenarioIds = chosen ?? withRuns.slice(0, 5).map((s) => s.id);
  const outdatedScenarios = list.filter((s) => selectedScenarioIds.includes(s.id) && s.latest_run && s.latest_run.outdated.some((o) => o.includes("assumptions changed")));

  async function recalc(ids: number[]) {
    setBusy(true);
    try {
      const sample = list.find((s) => ids.includes(s.id))?.latest_run?.config;
      await api.post(`/api/businesses/${b!.id}/runs/batch`, { scenario_ids: ids, config: sample ? { mode: sample.mode, runs: sample.runs, horizon_days: sample.horizon_days } : {} });
      toast("Recalculating. The comparison updates when the engine finishes.");
      scen.reload();
      ws.refresh();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "bad");
    } finally {
      setBusy(false);
    }
  }

  async function saveAdjust() {
    if (!adjust) return;
    const s = list.find((x) => x.id === adjust.id)!;
    const levers = { ...s.levers } as Record<string, unknown>;
    for (const [k, v] of Object.entries(adjust.values)) {
      if (v === "" || Number(v) === 0) delete levers[k];
      else if (!Number.isNaN(Number(v))) levers[k] = Number(v);
    }
    setBusy(true);
    try {
      await api.patch(`/api/scenarios/${s.id}`, { levers });
      toast(`${s.name} updated. Its results are now marked out of date.`);
      setAdjust(null);
      scen.reload();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "bad");
    } finally {
      setBusy(false);
    }
  }

  async function makeReport() {
    setBusy(true);
    try {
      const r = await api.post<{ id: number }>(`/api/businesses/${b!.id}/reports`, { run_ids: runIds });
      nav(`/app/reports/${r.id}`);
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "bad");
      setBusy(false);
    }
  }

  const rows = cmp?.comparison.rows ?? [];
  const mc = rows.some((r) => r.mode === "monte_carlo");
  const a = cmp?.analysis.output;
  // The profit target each run was judged against (stored with the run).
  const refRun = list.find((s) => s.latest_run?.id === rows[0]?.run_id)?.latest_run;
  const target = refRun?.criteria.target_monthly_operating_profit ?? null;

  return (
    <div className="grid gap-6">
      <PageHeader title="Parallel Decision Lab" sub="The same business, different decisions, compared on equal terms."
        actions={<button className="btn btn-primary" onClick={makeReport} disabled={busy || !rows.length}><IconReport size={16} />Create report</button>} />

      <section className="panel grid gap-3 p-4">
        <span className="label">Worlds in this comparison (up to 5; the baseline is the reference)</span>
        <div className="flex flex-wrap gap-2">
          {list.map((s) => {
            const done = s.latest_run && isDone(s.latest_run.status);
            const on = selectedScenarioIds.includes(s.id);
            return (
              <button key={s.id} disabled={!done || (!on && selectedScenarioIds.length >= 5)} aria-pressed={on}
                onClick={() => setChosen(on ? selectedScenarioIds.filter((x) => x !== s.id) : [...selectedScenarioIds, s.id])}
                className={`chip cursor-pointer !h-8 !px-3 ${on ? "chip-accent" : ""} disabled:cursor-not-allowed disabled:opacity-50`} title={done ? undefined : "No completed run yet"}>
                <SeriesMark index={s.color_index} />{s.name}
                {s.latest_run && isActive(s.latest_run.status) && <Spinner size={11} />}
              </button>
            );
          })}
        </div>
      </section>

      {outdatedScenarios.length > 0 && (
        <div role="status" className="flex flex-wrap items-center gap-3 rounded-[10px] border px-4 py-3" style={{ borderColor: "color-mix(in srgb, var(--text) 45%, var(--line))", background: "color-mix(in srgb, var(--text) 8%, var(--surface))" }}>
          <span className="text-[var(--text)]"><IconAlert size={16} /></span>
          <span className="text-[0.9rem]">Out of date: {outdatedScenarios.map((s) => s.name).join(", ")}. Their assumptions changed after the last run.</span>
          <button className="btn btn-sm ml-auto" onClick={() => recalc(outdatedScenarios.map((s) => s.id))} disabled={busy || anyActive}><IconPlay size={14} />Recalculate</button>
        </div>
      )}
      {cmp && !cmp.comparison.comparable && <Notice tone="warn">These runs used different horizons or methods. Differences may reflect the settings, not the decisions.</Notice>}
      {cmp && !cmp.comparison.same_model_version && <Notice tone="warn">These runs come from different model versions.</Notice>}
      {cmpError && <ErrorBox message={cmpError} />}
      {loading && !cmp && <Skeleton h={320} />}

      {cmp && a && (
        <>
          <section className="grid gap-4 xl:grid-cols-[1.35fr_1fr]">
            <div className="card card-pad grid gap-3">
              <div className="flex flex-wrap items-center gap-3">
                <select className="select w-auto" value={metric} onChange={(e) => setMetric(e.target.value as MetricKey)} aria-label="Chart metric">
                  {(Object.keys(METRICS) as MetricKey[]).map((k) => <option key={k} value={k}>{METRICS[k].label}</option>)}
                </select>
                {mc && <label className="flex items-center gap-2 text-[0.85rem]"><input type="checkbox" className="accent-[var(--text)]" checked={bands} onChange={(e) => setBands(e.target.checked)} />Show p10–p90 ranges</label>}
              </div>
              <LineChart ariaLabel={`${METRICS[metric].label} by world`} format={METRICS[metric].fmt} xLabels={rows[0].series[metric].p50.map((_, i) => i + 1)} showBands={bands}
                series={rows.map((r) => ({ id: r.run_id, label: r.scenario_name, colorIndex: r.color_index, values: r.series[metric].p50, low: r.series[metric].p10, high: r.series[metric].p90 }))} />
            </div>
            <div className="card card-pad">
              <h2 className="mb-3 text-[1rem]">Operating profit per month</h2>
              <RangeRows ariaLabel="Monthly operating profit range" rows={rows.map((r) => ({ label: r.scenario_name, colorIndex: r.color_index, ...r.avg_monthly_operating_profit }))}
                refValue={target} refLabel={target != null ? `the ${money(target)} target` : undefined} />
            </div>
          </section>

          <section className="table-wrap">
            <table className="data">
              <thead><tr><th>World</th><th className="n">Revenue</th><th className="n">Costs</th><th className="n">Profit / month</th><th className="n">Lowest cash</th><th className="n">Ending cash</th><th className="n">Served</th><th className="n">Waste</th><th className="n">Staff time</th><th className="n">Stock value</th><th>Risk</th></tr></thead>
              <tbody>{rows.map((r) => (
                <tr key={r.run_id}>
                  <td><Link to={`/app/runs/${r.run_id}`} className="inline-flex items-center gap-2 font-medium no-underline"><SeriesMark index={r.color_index} />{r.scenario_name}</Link>
                    {(cmp.outdated[r.run_id] ?? []).length > 0 && <div className="text-[0.72rem] text-[var(--text)]">Out of date</div>}</td>
                  <td className="n">{compactMoney(r.revenue.mean)}</td><td className="n">{compactMoney(r.cogs.mean + r.waste_cost.mean + r.operating_expenses.mean)}</td>
                  <td className="n">{money(r.avg_monthly_operating_profit.p50)}{mc && <div className="text-[0.7rem] text-text-3">{compactMoney(r.avg_monthly_operating_profit.p10)} to {compactMoney(r.avg_monthly_operating_profit.p90)}</div>}</td>
                  <td className="n">{money(r.min_cash.p10)}</td><td className="n">{money(r.ending_cash.p50)}</td><td className="n">{pct(r.fill_rate.mean)}</td><td className="n">{pct(r.waste_rate.mean, 1)}</td>
                  <td className="n">{pct(r.labor_utilization.mean)}</td><td className="n">{compactMoney(r.ending_inventory_value.mean)}</td>
                  <td>{r.violations.length ? <span className="text-[0.8rem] text-[var(--text)]">{r.violations.join("; ")}</span> : <span className="chip chip-good"><IconCheck size={13} />Within limits</span>}
                    {mc && <div className="text-[0.7rem] text-text-3">{pct(r.cash_below_buffer)} runs below cash buffer</div>}</td>
                </tr>))}</tbody>
            </table>
          </section>

          <section className="grid gap-4 lg:grid-cols-[1fr_1.1fr]">
            <div className="card card-pad grid content-start gap-3">
              <span className="text-[0.8rem] text-text-3">Decision Analyst · {cmp.analysis.mode === "ai" ? `AI (${cmp.analysis.model})` : "deterministic rules"}</span>
              <p className="text-[1.1rem] leading-snug" style={{ fontFamily: "var(--font-display)" }}>{a.recommendation}</p>
              <p className="text-[0.88rem] text-text-2">{a.summary}</p>
              {a.depends_on_assumptions && <Notice tone="warn">The top options overlap. The ranking depends on assumptions; run a small real-world test first.</Notice>}
              <ul className="grid gap-1 text-[0.86rem] text-text-2">{a.risks.map((x, i) => <li key={i}>• {x}</li>)}</ul>
              <ul className="grid gap-1 text-[0.86rem]">{a.next_steps.map((x, i) => <li key={i}>→ {x}</li>)}</ul>
              {cmp.analysis.notes.map((n, i) => <p key={i} className="text-[0.75rem] text-text-3">{n}</p>)}
              <p className="text-[0.75rem] text-text-3">{a.ranking_rule}</p>
            </div>
            <div className="grid content-start gap-3">
              {cmp.comparison.explanations.map((e) => (
                <div key={e.run_id} className="card card-pad grid gap-2">
                  <h3 className="text-[0.95rem]">{e.scenario_name} vs. {rows[0].scenario_name}: <span className="num">{signedMoney(e.monthly_operating_profit_change)}</span>/month</h3>
                  {e.error ? <p className="text-[0.85rem] text-[var(--text)]">{e.error}</p> : <>
                    <DivergingBars ariaLabel={`Why ${e.scenario_name} differs`} rows={e.drivers.map((d) => ({ label: d.label, value: d.monthly_effect }))} />
                    {e.notes.map((n, i) => <p key={i} className="text-[0.78rem] text-text-3">{n}</p>)}</>}
                </div>
              ))}
            </div>
          </section>

          <section className="panel grid gap-3 p-5">
            <h2 className="t-h3">Adjust assumptions</h2>
            <p className="text-[0.88rem] text-text-2">Changing a world's assumptions marks its results out of date until you recalculate. Nothing changes silently.</p>
            <div className="flex flex-wrap items-end gap-3">
              <label className="field"><span>World</span>
                <select className="select" value={adjust?.id ?? ""} onChange={(e) => {
                  const s = list.find((x) => x.id === +e.target.value);
                  setAdjust(s ? { id: s.id, values: Object.fromEntries(QUICK.map(([k]) => [k, String((s.levers as Record<string, unknown>)[k] ?? "")])) } : null);
                }}><option value="">Choose…</option>{list.filter((s) => selectedScenarioIds.includes(s.id)).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
              {adjust && QUICK.map(([k, label]) => (
                <label key={k} className="field w-32"><span>{label}</span><input className="input input-num" value={adjust.values[k]} onChange={(e) => setAdjust({ ...adjust, values: { ...adjust.values, [k]: e.target.value } })} /></label>
              ))}
              {adjust && <button className="btn btn-primary" onClick={saveAdjust} disabled={busy}>Save changes</button>}
              {adjust && <Link to="/app/worlds" className="text-[0.85rem]">All settings</Link>}
            </div>
          </section>
        </>
      )}
    </div>
  );
}
