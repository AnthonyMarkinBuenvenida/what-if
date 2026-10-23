import { useState } from "react";
import { SeriesMark } from "../../components/charts";
import { Link, useNavigate } from "react-router-dom";
import { IconAlert, IconFork, IconPlus } from "../../components/icons";
import { CalibrationChip, DemoBadge, Empty, ErrorBox, OutcomeChip, RunStatusChip, Skeleton, Spinner, Stat, useToast } from "../../components/ui";
import { api } from "../../lib/api";
import { money, pct, when } from "../../lib/format";
import { useAsync, usePolling } from "../../lib/hooks";
import type { Business, Issue } from "../../lib/types";
import { useWorkspace } from "../workspace";

interface Dashboard {
  businesses: Business[];
  totals: { businesses: number; scenarios_tested: number; completed_runs: number; reports: number; open_data_issues: number; active_runs: number };
  data_issues: (Issue & { business_id: number; business_name: string; is_demo: boolean })[];
  recent_runs: { id: number; business_id: number; business_name: string; is_demo: boolean; scenario_name: string; kind: string; status: string; progress: number; outcome: string | null; color_index: number; created_at: string; monthly_profit_p50: number | null }[];
  feedback: { id: number; business_name: string; scenario_name: string; period_start: string; period_end: string; comparison: { errors: Record<string, { pct: number | null }>; predicted: Record<string, number>; actual: Record<string, number> } }[];
  activity: { id: number; business_name: string; actor: string; summary: string; created_at: string }[];
}

export default function Overview() {
  const ws = useWorkspace();
  const nav = useNavigate();
  const toast = useToast();
  const { data, error, loading, reload } = useAsync(() => api.get<Dashboard>("/api/dashboard"), []);
  const [creatingDemo, setCreatingDemo] = useState(false);
  usePolling(reload, !!data && data.totals.active_runs > 0, 1500);

  async function openDemo() {
    setCreatingDemo(true);
    try {
      const b = await api.post<Business>("/api/businesses/demo");
      await ws.refresh();
      ws.setCurrentId(b.id);
      toast("Demo workspace created with sample data. Its 5 worlds are simulating now.");
      reload();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "bad");
    } finally {
      setCreatingDemo(false);
    }
  }

  if (error) return <ErrorBox message={error} onRetry={reload} />;
  const t = data?.totals;
  const hasModel = !!ws.current?.active_model;

  return (
    <div className="grid gap-8">
      <header className="grid gap-4 md:grid-cols-[1fr_auto] md:items-end">
        <div className="grid gap-2">
          <h1 className="t-h1">Overview</h1>
          <p className="t-lead">Test a decision on a model of your business before you commit money to it.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button className="btn btn-primary" onClick={() => nav("/app/new")}><IconPlus size={16} />Create business model</button>
          {hasModel && <button className="btn" onClick={() => nav("/app/worlds")}><IconFork size={16} />Run new simulation</button>}
        </div>
      </header>

      {loading && !data ? (
        <div className="grid gap-4 md:grid-cols-5">{[...Array(5)].map((_, i) => <Skeleton key={i} h={84} />)}</div>
      ) : data && data.totals.businesses === 0 ? (
        <Empty title="Start with your business" action={
          <div className="flex flex-wrap justify-center gap-2">
            <button className="btn btn-primary" onClick={() => nav("/app/new")}>Describe your business</button>
            <button className="btn" onClick={openDemo} disabled={creatingDemo}>{creatingDemo && <Spinner />}Open a demo workspace</button>
          </div>}>
          Describe your business and the decision you're weighing. What-if builds the model and a set of parallel worlds to test. The demo workspace uses a fictional store, clearly labelled as sample data.
        </Empty>
      ) : t && (
        <>
          <section aria-label="Totals" className="panel grid grid-cols-2 gap-6 p-5 md:grid-cols-5">
            <Stat label="Businesses" value={t.businesses} />
            <Stat label="Scenarios tested" value={t.scenarios_tested} sub="with a completed run" />
            <Stat label="Completed runs" value={t.completed_runs} sub={t.active_runs ? `${t.active_runs} running now` : undefined} />
            <Stat label="Reports" value={t.reports} />
            <Stat label="Open data issues" value={t.open_data_issues} sub="warnings and errors in active models" tone={t.open_data_issues ? "bad" : undefined} />
          </section>

          <div className="grid gap-6 xl:grid-cols-[1.4fr_1fr]">
            <section className="grid content-start gap-3" aria-labelledby="recent-runs">
              <div className="flex items-center justify-between"><h2 id="recent-runs" className="t-h3">Recent simulation runs</h2><Link to="/app/simulations" className="text-[0.85rem] text-text-2">All runs</Link></div>
              {data.recent_runs.length ? (
                <ul className="card divide">
                  {data.recent_runs.map((r) => (
                    <li key={r.id}>
                      <Link to={`/app/runs/${r.id}`} className="flex flex-wrap items-center gap-3 px-4 py-3 no-underline hover:bg-surface-2">
                        <SeriesMark index={r.color_index} />
                        <span className="min-w-0 flex-1"><span className="font-medium">{r.scenario_name}</span>{r.kind !== "scenario" && <span className="text-text-3"> · {r.kind} test</span>}
                          <span className="block text-[0.78rem] text-text-3">{r.business_name}{r.is_demo ? " (demo)" : ""} · run #{r.id} · {when(r.created_at)}</span></span>
                        {r.monthly_profit_p50 != null && <span className="num text-[0.85rem] text-text-2">{money(r.monthly_profit_p50)}/mo</span>}
                        <OutcomeChip outcome={r.outcome} />
                        <RunStatusChip status={r.status} progress={r.progress} />
                      </Link>
                    </li>
                  ))}
                </ul>
              ) : <p className="card card-pad text-text-2">No runs yet. Open Parallel Worlds and run your scenarios.</p>}
            </section>

            <section className="grid content-start gap-3" aria-labelledby="projects">
              <div className="flex items-center justify-between"><h2 id="projects" className="t-h3">Recent projects</h2><Link to="/app/businesses" className="text-[0.85rem] text-text-2">All businesses</Link></div>
              <ul className="grid gap-2">
                {data.businesses.map((b) => (
                  <li key={b.id}>
                    <button className="card interactive w-full px-4 py-3 text-left" onClick={() => { ws.setCurrentId(b.id); nav("/app/worlds"); }}>
                      <div className="flex flex-wrap items-center gap-2"><span className="font-semibold">{b.name}</span>{b.is_demo && <DemoBadge />}{b.active_model && <CalibrationChip status={b.active_model.calibration} />}</div>
                      <div className="mt-0.5 text-[0.8rem] text-text-3">{b.scenario_count} scenarios · model v{b.active_model?.version ?? "—"} · {b.creation_mode === "plan" ? `plan ${b.plan_status}` : "build mode"}</div>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          </div>

          <div className="grid gap-6 lg:grid-cols-3">
            <section className="grid content-start gap-3" aria-labelledby="issues">
              <h2 id="issues" className="t-h3">Outstanding data issues</h2>
              {data.data_issues.length ? (
                <ul className="card divide">
                  {data.data_issues.map((i, k) => (
                    <li key={k} className="flex gap-2.5 px-4 py-2.5 text-[0.85rem]">
                      <span className={`mt-0.5 ${i.severity === "error" ? "text-[var(--text)]" : "text-[var(--text)]"}`}><IconAlert size={15} /></span>
                      <span><span className="text-text-3">{i.business_name}{i.is_demo ? " (demo)" : ""}: </span>{i.message}</span>
                    </li>
                  ))}
                  <li className="px-4 py-2.5"><Link to="/app/twin" className="text-[0.85rem]">Fix in the Digital Twin Builder</Link></li>
                </ul>
              ) : <p className="card card-pad text-[0.9rem] text-text-2">No open warnings in your active models.</p>}
            </section>
            <section className="grid content-start gap-3" aria-labelledby="actuals">
              <h2 id="actuals" className="t-h3">Actual vs. simulated</h2>
              {data.feedback.length ? (
                <ul className="card divide">
                  {data.feedback.map((f) => {
                    const e = f.comparison.errors.revenue ?? Object.values(f.comparison.errors)[0];
                    return (
                      <li key={f.id} className="px-4 py-2.5 text-[0.85rem]">
                        <div className="font-medium">{f.scenario_name}</div>
                        <div className="text-text-3">{f.period_start} to {f.period_end} · {f.business_name}</div>
                        {e?.pct != null && <div className="num mt-0.5">Actual was {pct(Math.abs(e.pct), 1)} {e.pct >= 0 ? "above" : "below"} the simulation</div>}
                      </li>
                    );
                  })}
                </ul>
              ) : <p className="card card-pad text-[0.9rem] text-text-2">No actual results recorded yet. After you act on a strategy, record what happened in <Link to="/app/feedback">Reality Feedback</Link>.</p>}
            </section>
            <section className="grid content-start gap-3" aria-labelledby="activity">
              <h2 id="activity" className="t-h3">Activity</h2>
              <ol className="card relative grid gap-0 px-4 py-3">
                {data.activity.map((a) => (
                  <li key={a.id} className="relative border-l border-line py-1.5 pl-4 text-[0.82rem]">
                    <span className="absolute -left-[4.5px] top-3 h-2 w-2 rounded-full" style={{ background: a.actor.startsWith("agent") ? "var(--text)" : a.actor === "engine" ? "var(--series-1)" : "var(--text-3)" }} />
                    <span className="text-text-2">{a.summary}</span>
                    <span className="block text-[0.72rem] text-text-3">{a.actor.replace("agent:", "agent · ").replace("_", " ")} · {when(a.created_at)}</span>
                  </li>
                ))}
                {!data.activity.length && <li className="text-text-3">Nothing yet.</li>}
              </ol>
            </section>
          </div>
          {!data.businesses.some((b) => b.is_demo) && (
            <p className="text-[0.85rem] text-text-3">Want to explore first? <button className="underline underline-offset-4" onClick={openDemo} disabled={creatingDemo}>Create a demo workspace</button> with a fictional store, clearly labelled as sample data.</p>
          )}
        </>
      )}
    </div>
  );
}
