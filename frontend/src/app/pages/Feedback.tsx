import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { IconCheck, IconLoop } from "../../components/icons";
import { Empty, ErrorBox, Notice, PageHeader, Skeleton, Spinner, useToast } from "../../components/ui";
import { api } from "../../lib/api";
import { int, isDone, money, pct, when } from "../../lib/format";
import { useAsync } from "../../lib/hooks";
import type { Run } from "../../lib/types";
import { useWorkspace } from "../workspace";

interface Obs {
  id: number; run_id: number; scenario_name: string; model_version_id: number; color_index: number; period_start: string; period_end: string; notes: string;
  actual: Record<string, number>; calibration_status: "pending" | "applied" | "dismissed" | "not_applicable"; applied_version_id: number | null; created_at: string;
  comparison: { days: number; predicted: Record<string, number>; actual: Record<string, number>; errors: Record<string, { absolute: number; pct: number | null }>; explanations: string[]; demand_scale_suggestion?: number; simulation_start: string };
}
const LABELS: Record<string, [string, (v: number) => string]> = { revenue: ["Revenue", money], costs: ["Costs", money], units_sold: ["Units sold", int] };

export default function Feedback() {
  const ws = useWorkspace();
  const b = ws.current;
  const nav = useNavigate();
  const toast = useToast();
  const [params] = useSearchParams();
  const obs = useAsync(async () => (b ? api.get<Obs[]>(`/api/businesses/${b.id}/feedback`) : []), [b?.id]);
  const runs = useAsync(async () => (b ? api.get<Run[]>(`/api/businesses/${b.id}/runs?kind=scenario&limit=100`).then((rs) => rs.filter((r) => isDone(r.status))) : []), [b?.id]);
  const [form, setForm] = useState({ run_id: params.get("run") ?? "", period_start: "", period_end: "", revenue: "", costs: "", units_sold: "", notes: "" });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const selectedRun = runs.data?.find((r) => String(r.id) === form.run_id);

  useEffect(() => {
    if (selectedRun?.config.start_date && !form.period_start) {
      const s = new Date(selectedRun.config.start_date);
      const e = new Date(s.getTime() + 13 * 86400000);
      setForm((f) => ({ ...f, period_start: selectedRun.config.start_date!, period_end: e.toISOString().slice(0, 10) }));
    }
  }, [selectedRun, form.period_start]);

  if (!b) return <Empty title="No business selected" action={<button className="btn btn-primary" onClick={() => nav("/app/new")}>Create business model</button>} />;
  if (obs.error) return <ErrorBox message={obs.error} onRetry={obs.reload} />;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setErr(null);
    if (!form.run_id) return setErr("Choose the run whose strategy you followed.");
    if (!form.revenue && !form.costs && !form.units_sold) return setErr("Enter at least one actual figure.");
    setBusy(true);
    try {
      const num = (v: string) => (v === "" ? null : Number(v));
      await api.post(`/api/businesses/${b!.id}/feedback`, { run_id: +form.run_id, period_start: form.period_start, period_end: form.period_end, revenue: num(form.revenue), costs: num(form.costs), units_sold: num(form.units_sold), notes: form.notes });
      toast("Actual results recorded and compared.");
      setForm({ ...form, revenue: "", costs: "", units_sold: "", notes: "" });
      obs.reload();
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : String(e2));
    } finally {
      setBusy(false);
    }
  }
  async function decide(o: Obs, action: "apply" | "dismiss") {
    try {
      const r = await api.post<{ new_version?: { version: number } }>(`/api/feedback/${o.id}/${action}`);
      toast(action === "apply" ? `Model v${r.new_version?.version} created from this calibration. Earlier versions and reports are unchanged.` : "Suggestion dismissed.");
      obs.reload();
      ws.refresh();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "bad");
    }
  }

  return (
    <div className="grid gap-6">
      <PageHeader title="Reality feedback" sub="Record what actually happened and compare it with the simulation over the same days. You decide whether the model should change." />
      <form onSubmit={submit} className="panel grid gap-4 p-5" noValidate>
        <h2 className="t-h3">Record actual results</h2>
        <div className="grid gap-3 md:grid-cols-3">
          <label className="field md:col-span-3"><span>Strategy you followed (a completed run)</span>
            <select className="select" value={form.run_id} onChange={(e) => setForm({ ...form, run_id: e.target.value, period_start: "", period_end: "" })}>
              <option value="">Choose a run…</option>
              {(runs.data ?? []).map((r) => <option key={r.id} value={r.id}>{r.scenario_name} · run #{r.id} · model v{r.model_version} · starts {r.config.start_date}</option>)}
            </select></label>
          <label className="field"><span>Period start</span><input type="date" className="input" value={form.period_start} onChange={(e) => setForm({ ...form, period_start: e.target.value })} /></label>
          <label className="field"><span>Period end</span><input type="date" className="input" value={form.period_end} onChange={(e) => setForm({ ...form, period_end: e.target.value })} /></label>
          <div className="hint self-end">{selectedRun ? `Simulated window: ${selectedRun.config.start_date} plus ${selectedRun.config.horizon_days} days.` : ""}</div>
          <label className="field"><span>Actual revenue ($)</span><input className="input input-num" inputMode="decimal" value={form.revenue} onChange={(e) => setForm({ ...form, revenue: e.target.value })} /></label>
          <label className="field"><span>Actual costs ($)</span><input className="input input-num" inputMode="decimal" value={form.costs} onChange={(e) => setForm({ ...form, costs: e.target.value })} /><span className="hint">Goods sold, waste, labor and recurring costs</span></label>
          <label className="field"><span>Actual units sold</span><input className="input input-num" inputMode="decimal" value={form.units_sold} onChange={(e) => setForm({ ...form, units_sold: e.target.value })} /></label>
          <label className="field md:col-span-3"><span>Notes (what happened that the model might not know?)</span><textarea className="textarea" rows={2} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></label>
        </div>
        {err && <p className="error-text" role="alert">{err}</p>}
        <div><button className="btn btn-primary" disabled={busy}>{busy ? <Spinner /> : <IconLoop size={16} />}Compare with simulation</button></div>
      </form>

      {obs.loading && !obs.data ? <Skeleton h={200} /> : !(obs.data ?? []).length ? (
        <Empty title="No actual results yet">After acting on a strategy for a week or two, record the real figures here to see how close the simulation was.</Empty>
      ) : (
        <ul className="grid gap-4">
          {obs.data!.map((o) => (
            <li key={o.id} className="panel grid gap-4 p-5">
              <div className="flex flex-wrap items-center gap-2"><b>{o.scenario_name}</b><span className="text-[0.82rem] text-text-3">{o.period_start} to {o.period_end} ({o.comparison.days} days) · <Link to={`/app/runs/${o.run_id}`}>run #{o.run_id}</Link> · recorded {when(o.created_at)}</span></div>
              <div className="table-wrap"><table className="data">
                <thead><tr><th>Measure</th><th className="n">Simulated (expected)</th><th className="n">Actual</th><th className="n">Difference</th></tr></thead>
                <tbody>{Object.keys(o.comparison.actual).map((k) => {
                  const [label, fmt] = LABELS[k];
                  const e = o.comparison.errors[k];
                  return <tr key={k}><td>{label}</td><td className="n">{fmt(o.comparison.predicted[k])}</td><td className="n">{fmt(o.comparison.actual[k])}</td>
                    <td className="n">{fmt(e.absolute)} {e.pct != null && <span className="text-text-3">({e.pct >= 0 ? "+" : ""}{pct(e.pct, 1)})</span>}</td></tr>;
                })}</tbody>
              </table></div>
              <ul className="grid gap-1 text-[0.88rem] text-text-2">{o.comparison.explanations.map((x, i) => <li key={i}>• {x}</li>)}</ul>
              {o.notes && <p className="text-[0.85rem] text-text-3">Notes: {o.notes}</p>}
              {o.calibration_status === "pending" && o.comparison.demand_scale_suggestion != null && (
                <Notice tone="warn">
                  <span>Suggested calibration: multiply every product's demand by <b className="num">{o.comparison.demand_scale_suggestion.toFixed(3)}</b>. This creates a new model version; existing runs and reports stay attached to their original versions.</span>
                  <span className="flex gap-2 pt-1"><button className="btn btn-primary btn-sm" onClick={() => decide(o, "apply")}>Approve and create new version</button><button className="btn btn-sm" onClick={() => decide(o, "dismiss")}>Dismiss</button></span>
                </Notice>
              )}
              {o.calibration_status === "applied" && <p className="flex items-center gap-1.5 text-[0.85rem] text-[var(--text)]"><IconCheck size={15} />Calibration applied (new model version id {o.applied_version_id}).</p>}
              {o.calibration_status === "dismissed" && <p className="text-[0.85rem] text-text-3">Calibration suggestion dismissed.</p>}
              {o.calibration_status === "not_applicable" && <p className="text-[0.85rem] text-text-3">Within 5% of the simulation; no calibration suggested.</p>}
            </li>
          ))}
        </ul>
      )}
      <p className="text-[0.8rem] text-text-3">Calibration improves the model over time but cannot make future results certain.</p>
    </div>
  );
}
