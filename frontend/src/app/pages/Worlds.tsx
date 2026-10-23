import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { motion } from "motion/react";
import { seriesStyle } from "../../components/charts";
import { IconAlert, IconCopy, IconFork, IconPlay, IconPlus, IconTrash } from "../../components/icons";
import { Drawer, Empty, ErrorBox, Modal, OutcomeChip, PageHeader, RunStatusChip, Skeleton, Spinner, useToast } from "../../components/ui";
import { api } from "../../lib/api";
import { isActive, money } from "../../lib/format";
import { useAsync, usePolling, useReduced } from "../../lib/hooks";
import type { AgentEnvelope, Business, ModelVersion, Scenario, ScenarioProposal } from "../../lib/types";
import { draftFrom, emptyDraft, ScenarioEditor, type ScenarioDraft } from "../ScenarioEditor";
import { PlanReview } from "../shared";
import { useWorkspace } from "../workspace";

function leverSummary(s: Scenario) {
  const L = s.levers, out: string[] = [];
  const p = (v?: number) => `${v! > 0 ? "+" : ""}${v}%`;
  if (L.price_change_pct) out.push(`price ${p(L.price_change_pct)}`);
  if (L.demand_change_pct) out.push(`demand ${p(L.demand_change_pct)}`);
  if (L.supplier_cost_change_pct) out.push(`supplier ${p(L.supplier_cost_change_pct)}`);
  if (L.order_quantity_change_pct) out.push(`order qty ${p(L.order_quantity_change_pct)}`);
  if (L.reorder_point_change_pct) out.push(`reorder ${p(L.reorder_point_change_pct)}`);
  if (L.lead_time_change_days) out.push(`lead time ${L.lead_time_change_days > 0 ? "+" : ""}${L.lead_time_change_days}d`);
  if (L.extra_staff?.length) out.push(`+${L.extra_staff.reduce((a, x) => a + x.count, 0)} staff`);
  if (L.staff_hours_change_pct) out.push(`staff hours ${p(L.staff_hours_change_pct)}`);
  if (L.delivery?.enabled) out.push(`delivery ${L.delivery.orders_per_day}/day`);
  if (L.one_time_investment) out.push(`invest ${money(L.one_time_investment)}`);
  if (L.unexpected_expense) out.push(`surprise bill ${money(L.unexpected_expense)}`);
  if (L.rent_change_pct) out.push(`rent ${p(L.rent_change_pct)}`);
  if (L.expense_change_pct) out.push(`expenses ${p(L.expense_change_pct)}`);
  return out.length ? out.join(" · ") : "No changes (current operations)";
}

export default function Worlds() {
  const ws = useWorkspace();
  const b = ws.current;
  const nav = useNavigate();
  const toast = useToast();
  const reduced = useReduced();
  const scen = useAsync(async () => (b ? api.get<Scenario[]>(`/api/businesses/${b.id}/scenarios`) : []), [b?.id]);
  const detail = useAsync(async () => (b ? api.get<Business>(`/api/businesses/${b.id}`) : null), [b?.id, b?.plan_status]);
  const versions = useAsync(async () => (b ? api.get<ModelVersion[]>(`/api/businesses/${b.id}/models`) : []), [b?.id, b?.active_model_version_id]);
  const model = useAsync(async () => (b?.active_model_version_id ? api.get<ModelVersion>(`/api/models/${b.active_model_version_id}`) : null), [b?.active_model_version_id]);
  const [selected, setSelected] = useState<number[]>([]);
  const [editing, setEditing] = useState<{ id: number | null; draft: ScenarioDraft } | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [runCfg, setRunCfg] = useState({ mode: "monte_carlo", runs: 400, horizon_days: 90 });
  const [launching, setLaunching] = useState(false);
  const [suggest, setSuggest] = useState<{ open: boolean; loading: boolean; decision: string; result: AgentEnvelope<{ proposals: ScenarioProposal[] }> | null }>({ open: false, loading: false, decision: "", result: null });

  const list = scen.data ?? [];
  const anyActive = list.some((s) => s.latest_run && isActive(s.latest_run.status));
  usePolling(scen.reload, anyActive, 1000);
  const allIds = useMemo(() => list.map((s) => s.id), [list]);

  if (!b) return <Empty title="No business selected" action={<button className="btn btn-primary" onClick={() => nav("/app/new")}>Create business model</button>} />;
  if (scen.error) return <ErrorBox message={scen.error} onRetry={scen.reload} />;

  async function launch(ids: number[]) {
    if (!ids.length) return;
    setLaunching(true);
    try {
      await api.post(`/api/businesses/${b!.id}/runs/batch`, { scenario_ids: ids, config: runCfg });
      toast(`${ids.length} simulation${ids.length > 1 ? "s" : ""} queued. Independent worlds run in parallel.`);
      setSelected([]);
      await Promise.all([scen.reload(), ws.refresh()]);
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "bad");
    } finally {
      setLaunching(false);
    }
  }

  async function save() {
    if (!editing) return;
    setSaving(true);
    setSaveError(null);
    try {
      const body = { ...editing.draft, assumptions: editing.draft.assumptions.map((a) => a.trim()).filter(Boolean) };
      if (editing.id) await api.patch(`/api/scenarios/${editing.id}`, body);
      else await api.post(`/api/businesses/${b!.id}/scenarios`, { ...body, origin: "user" });
      toast(editing.id ? "Scenario saved. Its previous results are marked out of date until you rerun." : "Scenario created.");
      setEditing(null);
      scen.reload();
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  async function act(path: string, method: "post" | "del", msg: string) {
    try {
      await (method === "post" ? api.post(path) : api.del(path));
      toast(msg);
      scen.reload();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "bad");
    }
  }

  async function runSuggest() {
    setSuggest((s) => ({ ...s, loading: true }));
    try {
      const r = await api.post<AgentEnvelope<{ proposals: ScenarioProposal[] }>>(`/api/businesses/${b!.id}/agents/suggest-scenarios`, { decision: suggest.decision });
      setSuggest((s) => ({ ...s, loading: false, result: r }));
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "bad");
      setSuggest((s) => ({ ...s, loading: false }));
    }
  }

  async function addProposal(p: ScenarioProposal) {
    try {
      await api.post(`/api/businesses/${b!.id}/scenarios`, { name: p.name, description: p.description, decision: p.decision, kind: p.kind, levers: p.levers, assumptions: p.assumptions, origin: `agent:scenario_designer (${suggest.result?.mode})` });
      toast(`Added ${p.name}.`);
      scen.reload();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "bad");
    }
  }

  const plan = detail.data?.plan;
  const h = Math.max(120, list.length * 44);

  return (
    <div className="grid gap-6">
      <PageHeader title="Parallel worlds" sub={`Each world is ${b.name} under one decision or condition, branched from the same model.`}
        actions={<>
          <button className="btn" onClick={() => setSuggest({ open: true, loading: false, decision: b.decision, result: null })}><IconFork size={16} />Suggest scenarios</button>
          <button className="btn btn-primary" onClick={() => { setSaveError(null); setEditing({ id: null, draft: emptyDraft() }); }}><IconPlus size={16} />New scenario</button>
        </>} />

      {b.plan_status === "draft" && plan && (
        <section className="panel p-5"><h2 className="t-h2 mb-4">Simulation plan awaiting approval</h2>
          <PlanReview businessId={b.id} plan={plan} onApproved={() => { ws.refresh(); detail.reload(); scen.reload(); }} /></section>
      )}

      {scen.loading && !scen.data ? <div className="grid gap-3">{[0, 1, 2].map((i) => <Skeleton key={i} h={88} />)}</div>
        : !list.length ? (
          b.plan_status !== "draft" && <Empty title="No scenarios yet" action={<div className="flex flex-wrap justify-center gap-2">
            <button className="btn btn-primary" onClick={() => act(`/api/businesses/${b.id}/scenarios/standard`, "post", "Added the five standard retail worlds.")}>Add the standard retail worlds</button>
            <button className="btn" onClick={() => setEditing({ id: null, draft: emptyDraft() })}>Create one yourself</button></div>}>
            Start with a baseline and a few alternatives, or ask the Scenario Designer for suggestions.</Empty>
        ) : (
          <>
            <div className="panel flex flex-wrap items-end gap-3 p-4">
              <label className="field"><span>Method</span><select className="select" value={runCfg.mode} onChange={(e) => setRunCfg({ ...runCfg, mode: e.target.value })}>
                <option value="monte_carlo">Monte Carlo (ranges)</option><option value="deterministic">Expected case only</option></select></label>
              <label className="field w-28"><span>Runs</span><input className="input input-num" type="number" min={20} max={2000} value={runCfg.runs} disabled={runCfg.mode === "deterministic"} onChange={(e) => setRunCfg({ ...runCfg, runs: +e.target.value })} /></label>
              <label className="field w-28"><span>Days</span><input className="input input-num" type="number" min={7} max={365} value={runCfg.horizon_days} onChange={(e) => setRunCfg({ ...runCfg, horizon_days: +e.target.value })} /></label>
              <div className="ml-auto flex flex-wrap gap-2">
                <button className="btn" onClick={() => launch(selected)} disabled={!selected.length || launching}><IconPlay size={16} />Run selected ({selected.length})</button>
                <button className="btn btn-primary" onClick={() => launch(allIds)} disabled={launching}>{launching ? <Spinner /> : <IconPlay size={16} />}Run all {list.length} worlds</button>
              </div>
            </div>

            <div className="grid items-stretch gap-0 md:grid-cols-[150px_1fr]">
              <div className="relative hidden md:block" aria-hidden="true">
                <div className="absolute left-0 top-1/2 w-[60px] -translate-y-1/2 rounded-[10px] border border-line bg-surface px-2 py-2 text-center text-[0.72rem] text-text-2">Model v{b.active_model?.version}</div>
                <svg className="absolute inset-0 h-full w-full" preserveAspectRatio="none" viewBox={`0 0 150 ${h}`}>
                  {list.map((s, i) => {
                    const y = (h / list.length) * (i + 0.5);
                    return <motion.path key={s.id} d={`M60,${h / 2} C105,${h / 2} 105,${y} 150,${y}`} fill="none" stroke={seriesStyle(s.color_index).color} strokeDasharray={seriesStyle(s.color_index).dash} strokeWidth={2} vectorEffect="non-scaling-stroke"
                      initial={reduced ? false : { pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ duration: 0.8, delay: i * 0.06, ease: [0.16, 1, 0.3, 1] }} />;
                  })}
                </svg>
              </div>
              <ul className="grid gap-2.5">
                {list.map((s) => {
                  const r = s.latest_run;
                  return (
                    <li key={s.id} className="card grid gap-2 px-4 py-3">
                      <div className="flex flex-wrap items-start gap-3">
                        <input type="checkbox" className="mt-1.5 h-4 w-4 accent-[var(--text)]" aria-label={`Select ${s.name}`} checked={selected.includes(s.id)} onChange={(e) => setSelected(e.target.checked ? [...selected, s.id] : selected.filter((x) => x !== s.id))} />
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2"><span className="font-semibold">{s.name}</span>{s.is_baseline && <span className="chip">Baseline</span>}
                            {s.origin.startsWith("agent") && <span className="chip" title={s.origin}>Suggested by agent</span>}</div>
                          <p className="text-[0.85rem] text-text-2">{leverSummary(s)}</p>
                          {s.assumptions[0] && <p className="text-[0.78rem] text-text-3">Assumes: {s.assumptions.join(" ")}</p>}
                        </div>
                        <div className="flex flex-wrap items-center gap-2">
                          {r && r.headline && <span className="num text-[0.88rem]">{money(r.headline.avg_monthly_operating_profit.p50)}/mo</span>}
                          {r && <OutcomeChip outcome={r.outcome} />}
                          {r ? <Link to={`/app/runs/${r.id}`} className="no-underline"><RunStatusChip status={r.status} progress={r.progress} /></Link> : <span className="chip">Not run yet</span>}
                        </div>
                      </div>
                      {r && isActive(r.status) && <div className="progress ml-7"><i style={{ width: `${Math.round(r.progress * 100)}%` }} /></div>}
                      {r && r.outdated.length > 0 && !isActive(r.status) && <p className="ml-7 flex items-center gap-1.5 text-[0.8rem] text-[var(--text)]"><IconAlert size={14} />{r.outdated.join(" ")}</p>}
                      <div className="ml-7 flex flex-wrap gap-1.5">
                        <button className="btn btn-sm" onClick={() => launch([s.id])} disabled={!!r && isActive(r.status)}><IconPlay size={14} />{r ? "Rerun" : "Run"}</button>
                        <button className="btn btn-quiet btn-sm" onClick={() => { setSaveError(null); setEditing({ id: s.id, draft: draftFrom(s) }); }}>Edit</button>
                        <button className="btn btn-quiet btn-sm" onClick={() => act(`/api/scenarios/${s.id}/duplicate`, "post", `Copied ${s.name}.`)}><IconCopy size={14} />Duplicate</button>
                        {!s.is_baseline && <button className="btn btn-quiet btn-sm btn-danger" onClick={() => act(`/api/scenarios/${s.id}`, "del", `Archived ${s.name}. Its runs and reports are kept.`)}><IconTrash size={14} />Archive</button>}
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
            <div className="flex flex-wrap gap-2"><Link to="/app/lab" className="btn no-underline">Compare in the Decision Lab</Link></div>
          </>
        )}

      <Drawer open={!!editing} onClose={() => setEditing(null)} title={editing?.id ? "Edit scenario" : "New scenario"}>
        {editing && <ScenarioEditor draft={editing.draft} setDraft={(d) => setEditing({ ...editing, draft: d })} versions={versions.data ?? []}
          products={model.data?.spec?.products ?? []} onSave={save} saving={saving} error={saveError} />}
      </Drawer>

      <Modal wide open={suggest.open} onClose={() => setSuggest({ ...suggest, open: false })} title="Scenario Designer">
        <div className="grid gap-4">
          <label className="field"><span>What decision are you weighing?</span>
            <textarea className="textarea" rows={3} value={suggest.decision} onChange={(e) => setSuggest({ ...suggest, decision: e.target.value })} /></label>
          <div><button className="btn btn-primary" onClick={runSuggest} disabled={suggest.loading}>{suggest.loading && <Spinner />}Suggest scenarios</button></div>
          {suggest.loading && <p className="flex items-center gap-2 text-text-2"><span className="pulse-dot" />Scenario Designer is drafting experiments…</p>}
          {suggest.result && (
            <div className="grid gap-2">
              <p className="text-[0.82rem] text-text-3">{suggest.result.mode === "ai" ? `Proposed by ${suggest.result.model}.` : "Proposed by What-if's deterministic rules."} {suggest.result.notes.join(" ")} Suggestions are not added until you choose them.</p>
              {suggest.result.output.proposals.map((p, i) => (
                <div key={i} className="card flex flex-wrap items-start gap-3 px-4 py-3">
                  <div className="min-w-0 flex-1"><b>{p.name}</b><p className="text-[0.85rem] text-text-2">{p.description}</p>{p.rationale && <p className="text-[0.78rem] text-text-3">Why: {p.rationale}</p>}</div>
                  <button className="btn btn-sm" onClick={() => addProposal(p)}><IconPlus size={14} />Add</button>
                </div>
              ))}
            </div>
          )}
        </div>
      </Modal>
    </div>
  );
}
