import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { IconAlert, IconInfo, IconPlus, IconTrash, IconX } from "../../components/icons";
import { CalibrationChip, DemoBadge, Empty, ErrorBox, Notice, PageHeader, ProvenanceBadge, Skeleton, Spinner, useToast } from "../../components/ui";
import { api } from "../../lib/api";
import { money, pct, when } from "../../lib/format";
import { useAsync } from "../../lib/hooks";
import type { Expense, ModelVersion, Product, Provenance, Spec, Staff, Validation } from "../../lib/types";
import { ImportPanel } from "../shared";
import { useWorkspace } from "../workspace";

type Guide = Record<string, { label: string; unit: string; effect: string }>;
const TABS = ["Products", "Costs and staff", "Cash and goals", "Operations", "Import data", "Check and versions"] as const;
const PRODUCT_FIELDS: (keyof Product)[] = ["price", "unit_cost", "avg_daily_demand", "demand_cv", "starting_inventory", "shelf_life_days", "reorder_point", "order_quantity", "lead_time_days", "price_elasticity"];

function NumCell({ value, onChange, path, prov, step = "any", allowEmpty = false, label }: {
  value: number | null; onChange: (v: number | null) => void; path: string; prov?: Provenance; step?: string; allowEmpty?: boolean; label: string;
}) {
  const [text, setText] = useState(value == null ? "" : String(value));
  useEffect(() => setText(value == null ? "" : String(value)), [value]);
  const bad = text !== "" && Number.isNaN(Number(text));
  const isDefault = prov === "default";
  return (
    <div className="grid gap-1">
      <input className={`input input-num !min-h-[2rem] !px-2 !py-1 text-[0.85rem] ${isDefault ? "!border-dashed !border-[var(--text)]" : ""}`} inputMode="decimal" step={step} value={text}
        aria-label={isDefault ? `${label} (What-if default)` : label} title={isDefault ? "What-if default. Replace it with your own figure." : undefined} aria-invalid={bad} data-path={path}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          if (text === "" && allowEmpty) return onChange(null);
          const n = Number(text);
          if (text !== "" && !Number.isNaN(n)) onChange(n);
          else setText(value == null ? "" : String(value));
        }} />
      {prov && !isDefault && <ProvenanceBadge p={prov} />}
    </div>
  );
}

export default function TwinBuilder() {
  const ws = useWorkspace();
  const b = ws.current;
  const nav = useNavigate();
  const toast = useToast();
  const [tab, setTab] = useState<(typeof TABS)[number]>("Products");
  const guide = useAsync(() => api.get<{ variables: Guide }>("/api/industries").then((r) => r.variables), []);
  const version = useAsync(async () => (b?.active_model_version_id ? api.get<ModelVersion>(`/api/models/${b.active_model_version_id}`) : null), [b?.active_model_version_id]);
  const versions = useAsync(async () => (b ? api.get<(ModelVersion & { active: boolean })[]>(`/api/businesses/${b.id}/models`) : []), [b?.id, b?.active_model_version_id]);
  const [draft, setDraft] = useState<Spec | null>(null);
  const [validation, setValidation] = useState<Validation | null>(null);
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (version.data?.spec) {
      setDraft(structuredClone(version.data.spec));
      setValidation(version.data.validation);
    }
  }, [version.data]);

  const dirty = useMemo(() => !!draft && !!version.data?.spec && JSON.stringify(draft) !== JSON.stringify(version.data.spec), [draft, version.data]);

  // Re-validate edits as they happen (debounced); validation never changes the draft.
  useEffect(() => {
    if (!draft || !dirty) return;
    const t = setTimeout(() => api.post<Validation>("/api/models/validate", { spec: draft }).then(setValidation).catch(() => {}), 400);
    return () => clearTimeout(t);
  }, [draft, dirty]);

  if (!b) return <Empty title="No business selected" action={<button className="btn btn-primary" onClick={() => nav("/app/new")}>Create business model</button>} />;
  if (version.error) return <ErrorBox message={version.error} onRetry={version.reload} />;
  if (!draft || !version.data) return <div className="grid gap-3"><Skeleton h={40} w={320} /><Skeleton h={300} /></div>;

  const prov = draft.provenance;
  const g = guide.data ?? {};
  const update = (fn: (s: Spec) => void, paths: string[]) => {
    const next = structuredClone(draft);
    fn(next);
    for (const p of paths) next.provenance[p] = "user";
    setDraft(next);
  };
  const setProduct = (i: number, f: keyof Product, v: number | null | string) =>
    update((s) => { (s.products[i] as unknown as Record<string, unknown>)[f] = v; }, [`products.${draft.products[i].id}.${f}`]);

  async function save() {
    setSaving(true);
    try {
      const v = await api.post<ModelVersion>(`/api/businesses/${b!.id}/models`, { spec: draft, change_note: note || "Edited in the Digital Twin Builder." });
      toast(`Saved as model version ${v.version} (${v.calibration}). Earlier runs keep their original version.`);
      setNote("");
      await ws.refresh();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "bad");
    } finally {
      setSaving(false);
    }
  }

  async function activate(id: number) {
    try {
      await api.post(`/api/models/${id}/activate`);
      toast("Version activated. New runs will use it.");
      await ws.refresh();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "bad");
    }
  }

  const issues = validation?.issues ?? [];
  const counts = Object.values(prov).reduce<Record<string, number>>((a, p) => ({ ...a, [p]: (a[p] || 0) + 1 }), {});

  return (
    <div className="grid gap-6">
      <PageHeader title="Digital twin" sub={<>{b.name} · model v{version.data.version}{dirty ? " (unsaved edits)" : ""}</>}
        actions={<>{b.is_demo && <DemoBadge />}{validation && <CalibrationChip status={validation.status} />}</>} />

      <div className="panel grid gap-3 p-4 sm:grid-cols-[1fr_auto] sm:items-center">
        <div className="flex flex-wrap gap-x-5 gap-y-1 text-[0.85rem] text-text-2">
          <span><b className="text-text">{(counts.confirmed || 0) + (counts.user || 0)}</b> values from you</span>
          <span><b className="text-text">{counts.inferred || 0}</b> inferred from your data</span>
          <span><b className="text-text">{counts.calibrated || 0}</b> calibrated</span>
          <span><b className="text-[var(--text)]">{counts.default || 0}</b> What-if defaults</span>
          {validation && <span>{validation.counts.error} errors · {validation.counts.warning} warnings</span>}
        </div>
        {dirty && (
          <div className="flex flex-wrap items-center gap-2">
            <input className="input !min-h-[2rem] w-56" placeholder="What changed? (optional)" value={note} onChange={(e) => setNote(e.target.value)} aria-label="Change note" />
            <button className="btn btn-sm" onClick={() => setDraft(structuredClone(version.data!.spec!))}>Discard</button>
            <button className="btn btn-primary btn-sm" onClick={save} disabled={saving}>{saving && <Spinner />}Save as v{(versions.data?.[0]?.version ?? version.data.version) + 1}</button>
          </div>
        )}
      </div>

      <div className="seg max-w-full overflow-x-auto" role="tablist" aria-label="Model sections">
        {TABS.map((t) => <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)} className="whitespace-nowrap">{t}{t === "Check and versions" && validation && validation.counts.warning + validation.counts.error > 0 ? ` (${validation.counts.warning + validation.counts.error})` : ""}</button>)}
      </div>

      {tab === "Products" && (
        <section className="grid gap-3" role="tabpanel" aria-label="Products">
          <div className="table-wrap">
            <table className="data min-w-[1100px]">
              <thead><tr>
                <th>Product</th>
                {PRODUCT_FIELDS.map((f) => <th key={f} className="n" title={g[f]?.effect}><span className="inline-flex items-center gap-1">{g[f]?.label ?? f}<IconInfo size={12} /></span><div className="font-normal text-text-3">{g[f]?.unit}</div></th>)}
                <th />
              </tr></thead>
              <tbody>
                {draft.products.map((p, i) => (
                  <tr key={p.id}>
                    <td className="min-w-[10rem]">
                      <input className="input !min-h-[2rem] !px-2 !py-1 text-[0.85rem]" value={p.name} aria-label="Product name" onChange={(e) => update((s) => { s.products[i].name = e.target.value; }, [])} />
                      <input className="input mt-1 !min-h-[1.8rem] !px-2 !py-0.5 text-[0.75rem]" value={p.category} aria-label="Category" onChange={(e) => update((s) => { s.products[i].category = e.target.value; }, [])} />
                    </td>
                    {PRODUCT_FIELDS.map((f) => (
                      <td key={f} className="n min-w-[6.5rem]">
                        <NumCell label={`${p.name} ${g[f]?.label ?? f}`} path={`products.${p.id}.${f}`} value={p[f] as number | null} prov={prov[`products.${p.id}.${f}`]}
                          allowEmpty={f === "shelf_life_days"} onChange={(v) => setProduct(i, f, v)} />
                      </td>
                    ))}
                    <td><button className="btn btn-quiet btn-sm" aria-label={`Remove ${p.name}`} onClick={() => update((s) => { s.products.splice(i, 1); }, [])}><IconTrash size={15} /></button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div><button className="btn btn-sm" onClick={() => update((s) => { s.products.push({ id: `product-${Date.now() % 100000}`, name: "New product", category: "General", price: 1, unit_cost: 0.5, avg_daily_demand: 10, demand_cv: 0.3, starting_inventory: 50, shelf_life_days: null, reorder_point: 20, order_quantity: 50, lead_time_days: 3, price_elasticity: -1 }); }, [])}><IconPlus size={15} />Add product</button></div>
          <p className="hint">A dashed amber box is a What-if default; replace it with your own figure. Values you edit are marked as yours. Leave shelf life empty for goods that don't expire. Hover a column heading for how it affects the simulation.</p>
        </section>
      )}

      {tab === "Costs and staff" && (
        <section className="grid gap-6 lg:grid-cols-2" role="tabpanel" aria-label="Costs and staff">
          <div className="grid content-start gap-2">
            <h2 className="t-h3">Recurring expenses</h2>
            <div className="table-wrap"><table className="data">
              <thead><tr><th>Expense</th><th>Category</th><th className="n">Amount</th><th>Every</th><th /></tr></thead>
              <tbody>{draft.expenses.map((e, i) => (
                <tr key={e.id}>
                  <td><input className="input !min-h-[2rem] text-[0.85rem]" value={e.name} aria-label="Expense name" onChange={(ev) => update((s) => { s.expenses[i].name = ev.target.value; }, [])} /></td>
                  <td><select className="select !min-h-[2rem] text-[0.85rem]" value={e.category} aria-label="Category" onChange={(ev) => update((s) => { s.expenses[i].category = ev.target.value; }, [])}>
                    {["rent", "utilities", "insurance", "fees", "marketing", "other"].map((c) => <option key={c}>{c}</option>)}</select></td>
                  <td className="n"><NumCell label={`${e.name} amount`} path={`expenses.${e.id}.amount`} value={e.amount} prov={prov[`expenses.${e.id}.amount`]} onChange={(v) => update((s) => { s.expenses[i].amount = v ?? 0; }, [`expenses.${e.id}.amount`])} /></td>
                  <td><select className="select !min-h-[2rem] text-[0.85rem]" value={e.frequency} aria-label="Frequency" onChange={(ev) => update((s) => { s.expenses[i].frequency = ev.target.value as Expense["frequency"]; }, [])}>
                    <option value="daily">day</option><option value="weekly">week</option><option value="monthly">month</option></select></td>
                  <td><button className="btn btn-quiet btn-sm" aria-label={`Remove ${e.name}`} onClick={() => update((s) => { s.expenses.splice(i, 1); }, [])}><IconX size={15} /></button></td>
                </tr>))}</tbody>
            </table></div>
            <div><button className="btn btn-sm" onClick={() => update((s) => { s.expenses.push({ id: `expense-${Date.now() % 100000}`, name: "New expense", category: "other", amount: 0, frequency: "monthly" }); }, [])}><IconPlus size={15} />Add expense</button></div>
          </div>
          <div className="grid content-start gap-2">
            <h2 className="t-h3">Staff and working hours</h2>
            <div className="table-wrap"><table className="data">
              <thead><tr><th>Role</th><th className="n">People</th><th className="n">$/hour</th><th className="n">Hours/week each</th><th /></tr></thead>
              <tbody>{draft.staff.map((st, i) => (
                <tr key={st.id}>
                  <td><input className="input !min-h-[2rem] text-[0.85rem]" value={st.role} aria-label="Role" onChange={(ev) => update((s) => { s.staff[i].role = ev.target.value; }, [])} /></td>
                  {(["count", "hourly_wage", "hours_per_week"] as (keyof Staff)[]).map((f) => (
                    <td key={f} className="n"><NumCell label={`${st.role} ${f}`} path={`staff.${st.id}.${f}`} value={st[f] as number} prov={prov[`staff.${st.id}.${f}`]} onChange={(v) => update((s) => { (s.staff[i] as unknown as Record<string, number>)[f] = v ?? 0; }, [`staff.${st.id}.${f}`])} /></td>
                  ))}
                  <td><button className="btn btn-quiet btn-sm" aria-label={`Remove ${st.role}`} onClick={() => update((s) => { s.staff.splice(i, 1); }, [])}><IconX size={15} /></button></td>
                </tr>))}</tbody>
            </table></div>
            <div><button className="btn btn-sm" onClick={() => update((s) => { s.staff.push({ id: `staff-${Date.now() % 100000}`, role: "New role", count: 1, hourly_wage: 15, hours_per_week: 20 }); }, [])}><IconPlus size={15} />Add role</button></div>
          </div>
        </section>
      )}

      {tab === "Cash and goals" && (
        <section className="grid gap-6 md:grid-cols-2" role="tabpanel" aria-label="Cash and goals">
          <div className="panel grid content-start gap-4 p-5">
            <h2 className="t-h3">Cash</h2>
            <label className="field"><span>Cash available today ($)</span><NumCell label="Starting cash" path="finance.starting_cash" value={draft.finance.starting_cash} prov={prov["finance.starting_cash"]} onChange={(v) => update((s) => { s.finance.starting_cash = v ?? 0; }, ["finance.starting_cash"])} /></label>
            <label className="field"><span>Lowest balance you're comfortable with ($)</span><NumCell label="Cash buffer" path="finance.min_cash_buffer" value={draft.finance.min_cash_buffer} prov={prov["finance.min_cash_buffer"]} onChange={(v) => update((s) => { s.finance.min_cash_buffer = v ?? 0; }, ["finance.min_cash_buffer"])} /></label>
            <p className="hint">A scenario fails if cash falls below this buffer in more runs than your risk tolerance allows.</p>
          </div>
          <div className="panel grid content-start gap-4 p-5">
            <h2 className="t-h3">Goals and limits</h2>
            {([
              ["target_monthly_operating_profit", "Target operating profit per month ($)"], ["max_investment_budget", "Most you'll spend on a new initiative ($)"],
            ] as const).map(([k, label]) => (
              <label key={k} className="field"><span>{label}</span>
                <NumCell label={label} path={`goals.${k}`} value={draft.goals[k]} allowEmpty onChange={(v) => update((s) => { s.goals[k] = v; }, [])} /></label>
            ))}
            <label className="field"><span>Maximum waste (share of units)</span><NumCell label="Max waste" path="goals.max_waste_rate" value={draft.goals.max_waste_rate} allowEmpty onChange={(v) => update((s) => { s.goals.max_waste_rate = v; }, [])} /><span className="hint">e.g. 0.05 for 5%. Empty = no limit.</span></label>
            <label className="field"><span>Minimum share of demand served</span><NumCell label="Min fill rate" path="goals.min_fill_rate" value={draft.goals.min_fill_rate} allowEmpty onChange={(v) => update((s) => { s.goals.min_fill_rate = v; }, [])} /><span className="hint">e.g. 0.95 for 95%. Empty = no limit.</span></label>
            <label className="field"><span>Risk tolerance</span>
              <select className="select" value={draft.goals.risk_tolerance} onChange={(e) => update((s) => { s.goals.risk_tolerance = e.target.value as Spec["goals"]["risk_tolerance"]; }, [])}>
                <option value="low">Low: fail if cash dips below the buffer in more than 5% of runs</option>
                <option value="medium">Medium: more than 10% of runs</option>
                <option value="high">High: more than 20% of runs</option>
              </select></label>
          </div>
        </section>
      )}

      {tab === "Operations" && (
        <section className="grid gap-6 md:grid-cols-2" role="tabpanel" aria-label="Operations">
          <div className="panel grid content-start gap-4 p-5">
            <h2 className="t-h3">Capacity</h2>
            {([
              ["open_days_per_week", "Open days per week", "Spreads weekly staff hours over trading days."],
              ["units_per_labor_hour", "Units served per staff hour", "Caps daily sales by available staff time. 0 = no limit."],
              ["storage_capacity_units", "Storage capacity (units)", "Orders are cut back if they wouldn't fit. 0 = no limit."],
              ["delivery_minutes_per_order", "Staff minutes per delivery order", "Picking and packing time taken from store capacity."],
            ] as const).map(([k, label, hint]) => (
              <label key={k} className="field"><span>{label}</span>
                <NumCell label={label} path={`operations.${k}`} value={draft.operations[k]} prov={prov[`operations.${k}`]} onChange={(v) => update((s) => { s.operations[k] = v ?? 0; }, [`operations.${k}`])} />
                <span className="hint">{hint}</span></label>
            ))}
          </div>
          <div className="panel grid content-start gap-4 p-5">
            <h2 className="t-h3">Uncertainty</h2>
            <p className="text-[0.88rem] text-text-2">Monte Carlo runs draw a different overall demand level and supplier-price level for each run, on top of daily variation per product.</p>
            <label className="field"><span>Uncertainty in average demand (± %)</span><NumCell label="Demand uncertainty" path="uncertainty.demand_level_pct" value={draft.uncertainty.demand_level_pct} prov={prov["uncertainty.demand_level_pct"]} onChange={(v) => update((s) => { s.uncertainty.demand_level_pct = v ?? 0; }, ["uncertainty.demand_level_pct"])} /></label>
            <label className="field"><span>Uncertainty in supplier prices (± %)</span><NumCell label="Supplier uncertainty" path="uncertainty.supplier_cost_pct" value={draft.uncertainty.supplier_cost_pct} prov={prov["uncertainty.supplier_cost_pct"]} onChange={(v) => update((s) => { s.uncertainty.supplier_cost_pct = v ?? 0; }, ["uncertainty.supplier_cost_pct"])} /></label>
          </div>
        </section>
      )}

      {tab === "Import data" && (
        <section className="panel grid gap-3 p-5" role="tabpanel" aria-label="Import data">
          {dirty && <Notice tone="warn">Save or discard your unsaved edits first; imports are applied to the saved active version.</Notice>}
          <ImportPanel businessId={b.id} onApplied={() => ws.refresh()} />
        </section>
      )}

      {tab === "Check and versions" && (
        <section className="grid gap-6 lg:grid-cols-[1.3fr_1fr]" role="tabpanel" aria-label="Check and versions">
          <div className="grid content-start gap-3">
            <h2 className="t-h3">Model check {dirty && <span className="text-[0.85rem] font-normal text-text-3">(includes unsaved edits)</span>}</h2>
            {validation?.status === "invalid" && <Notice tone="warn">The model has errors. Fix them before simulating.</Notice>}
            {validation?.status === "exploratory" && <Notice>Runs are allowed, but results are labelled exploratory until the warnings below are resolved and defaults replaced.</Notice>}
            <ul className="card divide">
              {issues.map((i, k) => (
                <li key={k} className="flex gap-3 px-4 py-3 text-[0.88rem]">
                  <span className={`mt-0.5 ${i.severity === "error" ? "text-[var(--text)]" : i.severity === "warning" ? "text-[var(--text)]" : "text-text-3"}`}>{i.severity === "info" ? <IconInfo size={15} /> : <IconAlert size={15} />}</span>
                  <span className="grid gap-0.5"><span>{i.message}</span>{i.fix && <span className="text-text-3">{i.fix}</span>}<span className="text-[0.72rem] uppercase tracking-wide text-text-3">{i.severity}</span></span>
                </li>
              ))}
              {!issues.length && <li className="px-4 py-3 text-text-2">No issues found.</li>}
            </ul>
          </div>
          <div className="grid content-start gap-3">
            <h2 className="t-h3">Version history</h2>
            <ol className="card divide">
              {(versions.data ?? []).map((v) => (
                <li key={v.id} className="grid gap-1 px-4 py-3 text-[0.86rem]">
                  <div className="flex flex-wrap items-center gap-2"><b>v{v.version}</b><CalibrationChip status={v.calibration} />{v.active && <span className="chip chip-accent">Active</span>}
                    {!v.active && <button className="btn btn-quiet btn-sm ml-auto" onClick={() => activate(v.id)}>Make active</button>}</div>
                  <span className="text-text-2">{v.change_note}</span>
                  <span className="text-[0.75rem] text-text-3">{v.created_by} · {when(v.created_at)} · {v.provenance_counts.default ?? 0} defaults</span>
                </li>
              ))}
            </ol>
            <p className="hint">Saving never edits an old version. Each run and report keeps the version it was produced from.</p>
          </div>
        </section>
      )}

      <p className="text-[0.8rem] text-text-3">Expected sales at average demand: {money(draft.products.reduce((a, p) => a + p.avg_daily_demand * p.price, 0) * 30)} a month · gross margin {pct(1 - draft.products.reduce((a, p) => a + p.avg_daily_demand * p.unit_cost, 0) / Math.max(1, draft.products.reduce((a, p) => a + p.avg_daily_demand * p.price, 0)), 1)}.</p>
    </div>
  );
}
