import { useState } from "react";
import { SeriesMark } from "../../components/charts";
import { Link, useNavigate } from "react-router-dom";
import { IconRetry, IconStop } from "../../components/icons";
import { Empty, ErrorBox, OutcomeChip, PageHeader, RunStatusChip, Skeleton, useToast } from "../../components/ui";
import { api } from "../../lib/api";
import { duration, isActive, money, when } from "../../lib/format";
import { useAsync, usePolling } from "../../lib/hooks";
import type { Run } from "../../lib/types";
import { useWorkspace } from "../workspace";

export default function Simulations() {
  const ws = useWorkspace();
  const b = ws.current;
  const nav = useNavigate();
  const toast = useToast();
  const [kind, setKind] = useState("");
  const [status, setStatus] = useState("");
  const runs = useAsync(async () => (b ? api.get<Run[]>(`/api/businesses/${b.id}/runs?limit=200${kind ? `&kind=${kind}` : ""}`) : []), [b?.id, kind]);
  const active = (runs.data ?? []).some((r) => isActive(r.status));
  usePolling(runs.reload, active, 800);

  if (!b) return <Empty title="No business selected" action={<button className="btn btn-primary" onClick={() => nav("/app/new")}>Create business model</button>} />;
  if (runs.error) return <ErrorBox message={runs.error} onRetry={runs.reload} />;

  async function act(path: string, msg: string) {
    try {
      await api.post(path);
      toast(msg);
      runs.reload();
      ws.refresh();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "bad");
    }
  }

  const list = (runs.data ?? []).filter((r) => !status || (status === "active" ? isActive(r.status) : r.status === status));
  return (
    <div className="grid gap-5">
      <PageHeader title="Simulations" sub="Every run records its model version, settings and seed, so it can be traced and repeated." />
      <div className="flex flex-wrap gap-3">
        <div className="seg" role="group" aria-label="Run type">
          {[["", "All"], ["scenario", "Scenario runs"], ["stress", "Stress tests"], ["sensitivity", "Sensitivity"]].map(([v, l]) => <button key={v} aria-pressed={kind === v} onClick={() => setKind(v)}>{l}</button>)}
        </div>
        <select className="select w-auto" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status filter">
          <option value="">Any status</option><option value="active">Queued or running</option><option value="completed">Completed</option>
          <option value="completed_with_warnings">Completed with warnings</option><option value="failed">Failed</option><option value="cancelled">Cancelled</option>
        </select>
      </div>
      {runs.loading && !runs.data ? <Skeleton h={300} /> : !list.length ? (
        <Empty title="No runs here yet" action={<Link to="/app/worlds" className="btn btn-primary no-underline">Go to Parallel Worlds</Link>}>Run your scenarios from Parallel Worlds. Each one executes on the simulation engine and appears here with its status.</Empty>
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>Run</th><th>Scenario</th><th>Status</th><th>Settings</th><th className="n">Profit / month</th><th>Started</th><th /></tr></thead>
            <tbody>
              {list.map((r) => (
                <tr key={r.id}>
                  <td className="num"><Link to={`/app/runs/${r.id}`}>#{r.id}</Link><div className="text-[0.72rem] text-text-3">{r.kind}</div></td>
                  <td><span className="inline-flex items-center gap-2"><SeriesMark index={r.color_index} />{r.scenario_name}</span>
                    <div className="text-[0.72rem] text-text-3">model v{r.model_version}{r.parent_run_id ? ` · from run #${r.parent_run_id}` : ""}</div>
                    {r.outdated.length > 0 && !isActive(r.status) && <div className="text-[0.72rem] text-[var(--text)]">Out of date</div>}</td>
                  <td className="min-w-[11rem]"><div className="flex flex-wrap gap-1"><RunStatusChip status={r.status} progress={r.progress} /><OutcomeChip outcome={r.outcome} /></div>
                    {isActive(r.status) && <><div className="progress mt-1.5"><i style={{ width: `${Math.round(r.progress * 100)}%` }} /></div><div className="mt-0.5 text-[0.72rem] text-text-3">{r.stage}</div></>}
                    {r.error && <div className="mt-1 max-w-xs text-[0.75rem] text-[var(--text)]">{r.error}</div>}</td>
                  <td className="text-[0.8rem] text-text-2">{r.config.mode === "monte_carlo" ? `${r.config.runs} runs` : "expected case"} · {r.config.horizon_days} d · seed {r.config.seed}</td>
                  <td className="n">{r.headline ? money(r.headline.avg_monthly_operating_profit.p50) : "—"}</td>
                  <td className="text-[0.8rem] text-text-2">{when(r.created_at)}{duration(r.started_at, r.finished_at) && <div className="text-text-3">took {duration(r.started_at, r.finished_at)}</div>}</td>
                  <td className="whitespace-nowrap">
                    {isActive(r.status) ? <button className="btn btn-quiet btn-sm" onClick={() => act(`/api/runs/${r.id}/cancel`, `Cancelling run #${r.id}.`)}><IconStop size={14} />Cancel</button>
                      : <button className="btn btn-quiet btn-sm" onClick={() => act(`/api/runs/${r.id}/retry`, `Run #${r.id} queued again with the same settings.`)}><IconRetry size={14} />{r.status === "failed" || r.status === "cancelled" ? "Retry" : "Rerun"}</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
