import { useEffect, useState, type ReactNode } from "react";
import { IconPlus, IconX } from "../components/icons";
import { Spinner } from "../components/ui";
import type { Criteria, Delivery, Levers, ModelVersion, Product, Scenario, SimConfig } from "../lib/types";

export interface ScenarioDraft {
  name: string; description: string; decision: string; kind: string; levers: Levers; assumptions: string[];
  config: SimConfig; success_criteria: Criteria; base_model_version_id: number | null;
}

export const emptyDraft = (): ScenarioDraft => ({
  name: "", description: "", decision: "", kind: "custom", levers: {}, assumptions: [],
  config: { mode: "monte_carlo", runs: 400, horizon_days: 90 }, success_criteria: {}, base_model_version_id: null,
});

export const draftFrom = (s: Scenario): ScenarioDraft => ({
  name: s.name, description: s.description, decision: s.decision, kind: s.kind, levers: structuredClone(s.levers), assumptions: [...s.assumptions],
  config: { mode: s.config.mode, runs: s.config.runs, horizon_days: s.config.horizon_days, seed: s.config.seed }, success_criteria: { ...s.success_criteria },
  base_model_version_id: s.base_model_version_id,
});

function Num({ label, value, onChange, hint, suffix }: { label: string; value: number | undefined | null; onChange: (v: number | undefined) => void; hint?: string; suffix?: string }) {
  const [t, setT] = useState(value == null ? "" : String(value));
  useEffect(() => setT(value == null ? "" : String(value)), [value]);
  return (
    <label className="field"><span>{label}{suffix && <span className="font-normal text-text-3"> ({suffix})</span>}</span>
      <input className="input input-num" inputMode="decimal" value={t} onChange={(e) => setT(e.target.value)} aria-invalid={t !== "" && Number.isNaN(+t)}
        onBlur={() => { if (t === "") onChange(undefined); else if (!Number.isNaN(+t)) onChange(+t); }} />
      {hint && <span className="hint">{hint}</span>}
    </label>
  );
}

function Group({ title, children, open = false }: { title: string; children: ReactNode; open?: boolean }) {
  return (
    <details className="card" open={open}>
      <summary className="cursor-pointer select-none px-4 py-3 font-semibold">{title}</summary>
      <div className="grid gap-3 border-t border-line p-4 sm:grid-cols-2">{children}</div>
    </details>
  );
}

function ProductPicker({ products, value, onChange, label }: { products: Product[]; value: string[] | undefined; onChange: (v: string[]) => void; label: string }) {
  const v = value ?? [];
  return (
    <fieldset className="grid gap-1 sm:col-span-2">
      <legend className="label mb-1">{label} <span className="font-normal text-text-3">(none selected = all products)</span></legend>
      <div className="flex flex-wrap gap-1.5">
        {products.map((p) => {
          const on = v.includes(p.id);
          return <button type="button" key={p.id} aria-pressed={on} onClick={() => onChange(on ? v.filter((x) => x !== p.id) : [...v, p.id])}
            className={`chip cursor-pointer ${on ? "chip-accent" : ""}`}>{p.name}</button>;
        })}
      </div>
    </fieldset>
  );
}

export function ScenarioEditor({ draft, setDraft, versions, products, onSave, saving, error }: {
  draft: ScenarioDraft; setDraft: (d: ScenarioDraft) => void; versions: ModelVersion[]; products: Product[];
  onSave: () => void; saving: boolean; error: string | null;
}) {
  const L = draft.levers;
  const setL = (patch: Partial<Levers>) => {
    const next: Levers = { ...L, ...patch };
    for (const [k, v] of Object.entries(next)) if (v === undefined) delete (next as Record<string, unknown>)[k];
    setDraft({ ...draft, levers: next });
  };
  const d: Partial<Delivery> = L.delivery ?? {};
  const setD = (patch: Partial<Delivery>) => setL({ delivery: { ...d, ...patch } });
  const C = draft.success_criteria;
  const setC = (patch: Partial<Criteria>) => setDraft({ ...draft, success_criteria: { ...C, ...patch } });

  return (
    <form className="grid gap-4" onSubmit={(e) => { e.preventDefault(); onSave(); }}>
      <label className="field"><span>Name</span><input className="input" required value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></label>
      <label className="field"><span>Decision being tested</span><input className="input" value={draft.decision} onChange={(e) => setDraft({ ...draft, decision: e.target.value })} placeholder="e.g. Start a local delivery service" /></label>
      <label className="field"><span>Description</span><textarea className="textarea" rows={2} value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} /></label>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="field"><span>Type</span>
          <select className="select" value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value })}>
            {["baseline", "inventory", "delivery", "price", "staffing", "stress", "custom"].map((k) => <option key={k} value={k}>{k}</option>)}
          </select></label>
        <label className="field"><span>Starting model version</span>
          <select className="select" value={draft.base_model_version_id ?? ""} onChange={(e) => setDraft({ ...draft, base_model_version_id: e.target.value ? +e.target.value : null })}>
            <option value="">Always the active version</option>
            {versions.map((v) => <option key={v.id} value={v.id}>Pin to v{v.version} ({v.calibration})</option>)}
          </select></label>
      </div>

      <h3 className="t-h3 mt-2">What changes in this world</h3>
      <Group title="Prices and demand" open>
        <Num label="Price change" suffix="%" value={L.price_change_pct} onChange={(v) => setL({ price_change_pct: v })} hint="Demand responds through each product's price elasticity." />
        <Num label="Customer demand change" suffix="%" value={L.demand_change_pct} onChange={(v) => setL({ demand_change_pct: v })} hint="An environmental change, e.g. −15 for a downturn." />
        <ProductPicker label="Apply price change to" products={products} value={L.price_products} onChange={(v) => setL({ price_products: v })} />
      </Group>
      <Group title="Inventory and purchasing">
        <Num label="Order quantity change" suffix="%" value={L.order_quantity_change_pct} onChange={(v) => setL({ order_quantity_change_pct: v })} />
        <Num label="Reorder point change" suffix="%" value={L.reorder_point_change_pct} onChange={(v) => setL({ reorder_point_change_pct: v })} />
        <Num label="Shelf life change" suffix="%" value={L.shelf_life_change_pct} onChange={(v) => setL({ shelf_life_change_pct: v })} hint="Perishables only." />
        <Num label="Storage capacity change" suffix="%" value={L.storage_capacity_change_pct} onChange={(v) => setL({ storage_capacity_change_pct: v })} />
        <ProductPicker label="Apply inventory changes to" products={products} value={L.inventory_products} onChange={(v) => setL({ inventory_products: v })} />
      </Group>
      <Group title="Suppliers">
        <Num label="Supplier price change" suffix="%" value={L.supplier_cost_change_pct} onChange={(v) => setL({ supplier_cost_change_pct: v })} />
        <Num label="Lead time change" suffix="days" value={L.lead_time_change_days} onChange={(v) => setL({ lead_time_change_days: v })} />
        <Num label="Chance an order is delayed" suffix="0–1" value={L.supply_disruption_prob} onChange={(v) => setL({ supply_disruption_prob: v })} />
        <Num label="Delay when it happens" suffix="days" value={L.disruption_delay_days} onChange={(v) => setL({ disruption_delay_days: v })} />
      </Group>
      <Group title="Staffing">
        <Num label="Staff hours available change" suffix="%" value={L.staff_hours_change_pct} onChange={(v) => setL({ staff_hours_change_pct: v })} hint="e.g. −25 for absences." />
        <div className="grid gap-2 sm:col-span-2">
          <span className="label">Additional staff</span>
          {(L.extra_staff ?? []).map((s, i) => (
            <div key={i} className="grid grid-cols-[1.4fr_0.6fr_0.8fr_0.8fr_auto] items-end gap-2">
              <label className="field"><span>Role</span><input className="input" value={s.role} onChange={(e) => setL({ extra_staff: (L.extra_staff ?? []).map((x, k) => (k === i ? { ...x, role: e.target.value } : x)) })} /></label>
              <Num label="People" value={s.count} onChange={(v) => setL({ extra_staff: (L.extra_staff ?? []).map((x, k) => (k === i ? { ...x, count: v ?? 0 } : x)) })} />
              <Num label="$/hour" value={s.hourly_wage} onChange={(v) => setL({ extra_staff: (L.extra_staff ?? []).map((x, k) => (k === i ? { ...x, hourly_wage: v ?? 0 } : x)) })} />
              <Num label="Hours/week" value={s.hours_per_week} onChange={(v) => setL({ extra_staff: (L.extra_staff ?? []).map((x, k) => (k === i ? { ...x, hours_per_week: v ?? 0 } : x)) })} />
              <button type="button" className="btn btn-quiet btn-sm mb-1" aria-label="Remove" onClick={() => setL({ extra_staff: (L.extra_staff ?? []).filter((_, k) => k !== i) })}><IconX size={15} /></button>
            </div>
          ))}
          <div><button type="button" className="btn btn-sm" onClick={() => setL({ extra_staff: [...(L.extra_staff ?? []), { role: "Store clerk", count: 1, hourly_wage: 17, hours_per_week: 30 }] })}><IconPlus size={15} />Add staff</button></div>
        </div>
      </Group>
      <Group title="Costs and cash">
        <Num label="All recurring expenses change" suffix="%" value={L.expense_change_pct} onChange={(v) => setL({ expense_change_pct: v })} />
        <Num label="Rent change" suffix="%" value={L.rent_change_pct} onChange={(v) => setL({ rent_change_pct: v })} />
        <Num label="One-time investment on day 1" suffix="$" value={L.one_time_investment} onChange={(v) => setL({ one_time_investment: v })} />
        <Num label="Starting cash change" suffix="$" value={L.starting_cash_change} onChange={(v) => setL({ starting_cash_change: v })} />
        <Num label="Unexpected expense" suffix="$" value={L.unexpected_expense} onChange={(v) => setL({ unexpected_expense: v })} />
        <Num label="Day it arrives" suffix="day number, from 0" value={L.unexpected_expense_day} onChange={(v) => setL({ unexpected_expense_day: v })} />
      </Group>
      <Group title="Delivery service" open={!!d.enabled}>
        <label className="flex items-center gap-2 sm:col-span-2"><input type="checkbox" className="h-4 w-4 accent-[var(--text)]" checked={!!d.enabled} onChange={(e) => setD({ enabled: e.target.checked })} />Offer delivery in this world</label>
        {d.enabled && <>
          <Num label="Orders per day" value={d.orders_per_day} onChange={(v) => setD({ orders_per_day: v ?? 0 })} />
          <Num label="Units per order" value={d.units_per_order} onChange={(v) => setD({ units_per_order: v ?? 0 })} />
          <Num label="Fee charged per order" suffix="$" value={d.fee_per_order} onChange={(v) => setD({ fee_per_order: v ?? 0 })} />
          <Num label="Driver/courier cost per order" suffix="$" value={d.cost_per_order} onChange={(v) => setD({ cost_per_order: v ?? 0 })} />
          <Num label="Fixed cost per month" suffix="$" value={d.fixed_monthly_cost} onChange={(v) => setD({ fixed_monthly_cost: v ?? 0 })} />
          <Num label="Setup cost (one-time)" suffix="$" value={d.setup_cost} onChange={(v) => setD({ setup_cost: v ?? 0 })} />
          <Num label="Share that would have bought in store anyway" suffix="%" value={d.cannibalization_pct} onChange={(v) => setD({ cannibalization_pct: v ?? 0 })} />
        </>}
      </Group>

      <label className="field"><span>Assumptions (one per line)</span>
        <textarea className="textarea" rows={3} value={draft.assumptions.join("\n")} onChange={(e) => setDraft({ ...draft, assumptions: e.target.value.split("\n") })}
          onBlur={() => setDraft({ ...draft, assumptions: draft.assumptions.map((a) => a.trim()).filter(Boolean) })} />
        <span className="hint">Write down what this world takes for granted. It appears in reports next to the results.</span></label>

      <h3 className="t-h3 mt-2">Simulation settings and success criteria</h3>
      <div className="grid gap-3 sm:grid-cols-3">
        <label className="field"><span>Method</span>
          <select className="select" value={draft.config.mode} onChange={(e) => setDraft({ ...draft, config: { ...draft.config, mode: e.target.value as SimConfig["mode"] } })}>
            <option value="monte_carlo">Monte Carlo (ranges)</option><option value="deterministic">Expected case only</option></select></label>
        <Num label="Runs" value={draft.config.runs} onChange={(v) => setDraft({ ...draft, config: { ...draft.config, runs: v ?? 400 } })} hint="20–2000" />
        <Num label="Days to simulate" value={draft.config.horizon_days} onChange={(v) => setDraft({ ...draft, config: { ...draft.config, horizon_days: v ?? 90 } })} hint="7–365" />
      </div>
      <p className="hint -mt-1">Leave criteria empty to use the business goals from the digital twin.</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <Num label="Target operating profit per month" suffix="$" value={C.target_monthly_operating_profit} onChange={(v) => setC({ target_monthly_operating_profit: v })} />
        <Num label="Cash must stay above" suffix="$" value={C.min_cash_floor} onChange={(v) => setC({ min_cash_floor: v })} />
        <Num label="One-time spending limit" suffix="$" value={C.max_investment} onChange={(v) => setC({ max_investment: v })} />
        <Num label="Maximum waste" suffix="0–1" value={C.max_waste_rate} onChange={(v) => setC({ max_waste_rate: v })} />
        <Num label="Minimum share of demand served" suffix="0–1" value={C.min_fill_rate} onChange={(v) => setC({ min_fill_rate: v })} />
      </div>
      {error && <p className="error-text" role="alert">{error}</p>}
      <div className="sticky bottom-0 -mx-5 flex justify-end gap-2 border-t border-line bg-surface px-5 py-3">
        <button className="btn btn-primary" disabled={saving || !draft.name.trim()}>{saving && <Spinner />}Save scenario</button>
      </div>
    </form>
  );
}
