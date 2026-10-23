/* In-browser fallback engine — used ONLY when the What-if server cannot be reached.

   A line-by-line port of the deterministic mode of backend/app/engine/simulation.py
   (expected inputs, no Monte Carlo). The parity test (fallbackEngine.test.ts) checks it
   against reference outputs exported from the Python engine, so both produce the same
   numbers for the sample store. Every screen that uses it says so. */
import sample from "./sample.json";
import type { Constraint, Levers, Spec } from "../lib/types";

export const SAMPLE = sample as unknown as {
  spec: Spec;
  criteria: Record<string, number | string | null>;
  scenarios: { id: string; kind: string; name: string; description: string; decision: string; levers: Levers; assumptions: string[]; color_index: number }[];
  goals: { id: string; label: string; short: string; description: string; scenario_ids: string[]; metrics: string[] }[];
  parity_cases: { scenario: string; extra: Levers; budget: number | null; expected: Record<string, number>; outcome: string; violations: string[] }[];
};

/** The sample owner's limits, with the visitor's spending budget when given (mirrors backend demo_criteria). */
export const criteriaFor = (budget: number | null | undefined) => (budget == null ? SAMPLE.criteria : { ...SAMPLE.criteria, max_investment: Math.max(0, budget) });

const PERIOD: Record<string, number> = { daily: 1, weekly: 7, monthly: 30 };
const ADDITIVE = new Set(["demand_change_pct", "supplier_cost_change_pct", "lead_time_change_days", "staff_hours_change_pct", "rent_change_pct", "expense_change_pct", "shelf_life_change_pct", "unexpected_expense", "starting_cash_change", "one_time_investment", "price_change_pct", "order_quantity_change_pct", "reorder_point_change_pct", "storage_capacity_change_pct"]);

export function combineLevers(base: Levers, extra: Levers): Levers {
  const out: Record<string, unknown> = { ...base, delivery: { ...(base.delivery || {}) } };
  for (const [k, v] of Object.entries(extra)) {
    if (ADDITIVE.has(k) && typeof v === "number") out[k] = Number(out[k] || 0) + v;
    else if (k === "delivery" && v && typeof v === "object") out.delivery = { ...(out.delivery as object), ...(v as object) };
    else out[k] = v;
  }
  return out as Levers;
}

const pct = (x: number | undefined) => (x || 0) / 100;
const pyRound = (x: number) => {
  // Python's round(): banker's rounding at .5
  const r = Math.round(x);
  return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
};

export interface FallbackResult {
  summary: Record<string, number>;
  constraints: Constraint[];
  outcome: "passed" | "failed_constraints";
  weeklyCash: number[];
  weeklyCumProfit: number[];
  appliedChanges: string[];
}

export function simulateDeterministic(spec: Spec, levers: Levers, horizon = 90, criteria: Record<string, unknown> = SAMPLE.criteria): FallbackResult {
  const L = { delivery: {}, ...levers } as Required<Pick<Levers, "delivery">> & Levers;
  const prods = spec.products;
  const P = prods.length;
  const H = horizon;
  const ids = prods.map((p) => p.id);
  const changes: string[] = [];

  const basePrice = prods.map((p) => p.price);
  const priceMask = ids.map((id) => !L.price_products?.length || L.price_products.includes(id));
  const price = basePrice.map((v, i) => (L.price_change_pct && priceMask[i] ? v * (1 + pct(L.price_change_pct)) : v));
  if (L.price_change_pct) changes.push(`Selling price ${L.price_change_pct > 0 ? "+" : ""}${L.price_change_pct}%`);
  const demand = prods.map((p, i) => {
    const ratio = basePrice[i] > 0 ? price[i] / basePrice[i] : 1;
    let d = p.avg_daily_demand * Math.pow(Math.max(ratio, 1e-6), p.price_elasticity ?? -1);
    if (L.demand_change_pct) d *= 1 + pct(L.demand_change_pct);
    return d;
  });
  if (L.demand_change_pct) changes.push(`Customer demand ${L.demand_change_pct > 0 ? "+" : ""}${L.demand_change_pct}%`);
  const cost = prods.map((p) => p.unit_cost * (1 + pct(L.supplier_cost_change_pct)));
  if (L.supplier_cost_change_pct) changes.push(`Supplier prices ${L.supplier_cost_change_pct > 0 ? "+" : ""}${L.supplier_cost_change_pct}%`);
  const invMask = ids.map((id) => !L.inventory_products?.length || L.inventory_products.includes(id));
  const orderQty = prods.map((p, i) => (L.order_quantity_change_pct && invMask[i] ? p.order_quantity * (1 + pct(L.order_quantity_change_pct)) : p.order_quantity));
  const reorder = prods.map((p, i) => (L.reorder_point_change_pct && invMask[i] ? p.reorder_point * (1 + pct(L.reorder_point_change_pct)) : p.reorder_point));
  if (L.order_quantity_change_pct) changes.push(`Order quantity ${L.order_quantity_change_pct > 0 ? "+" : ""}${L.order_quantity_change_pct}%`);
  const lead = prods.map((p) => Math.min(90, Math.max(0, pyRound(p.lead_time_days) + Math.trunc(L.lead_time_change_days || 0))));
  let shelf = prods.map((p) => (p.shelf_life_days == null ? Infinity : p.shelf_life_days));
  if (L.shelf_life_change_pct) shelf = shelf.map((s) => (Number.isFinite(s) ? Math.max(1, pyRound(s * (1 + pct(L.shelf_life_change_pct)))) : s));
  shelf = shelf.map((s) => (Number.isFinite(s) ? Math.min(120, Math.max(1, pyRound(s))) : s));

  const ops = spec.operations;
  const openDays = Math.max(1, ops.open_days_per_week || 7);
  const staff = [...spec.staff, ...(L.extra_staff || [])];
  const hoursFactor = 1 + pct(L.staff_hours_change_pct);
  const weeklyHours = staff.reduce((a, s) => a + s.count * s.hours_per_week, 0) * hoursFactor;
  const laborWeekly = staff.reduce((a, s) => a + s.count * s.hours_per_week * s.hourly_wage, 0) * hoursFactor;
  const laborHoursPerDay = staff.length ? weeklyHours / openDays : 0;
  const uplh = ops.units_per_labor_hour || 0;
  const recurring = spec.expenses.map((e) => {
    let amt = e.amount;
    if (L.expense_change_pct) amt *= 1 + pct(L.expense_change_pct);
    if (e.category === "rent" && L.rent_change_pct) amt *= 1 + pct(L.rent_change_pct);
    return { amt, period: PERIOD[e.frequency] ?? 30 };
  });
  const d = { enabled: false, orders_per_day: 0, units_per_order: 4, fee_per_order: 0, cost_per_order: 0, fixed_monthly_cost: 0, setup_cost: 0, cannibalization_pct: 30, ...(L.delivery || {}) };
  let oneTime = L.one_time_investment || 0;
  if (d.enabled) {
    oneTime += d.setup_cost || 0;
    changes.push(`Delivery service: ${d.orders_per_day} orders/day`);
  }
  const unexpected = { amt: L.unexpected_expense || 0, day: Math.trunc(L.unexpected_expense_day ?? 30) };
  const startCash = spec.finance.starting_cash + (L.starting_cash_change || 0);
  const capRaw = (ops.storage_capacity_units || 0) * (1 + pct(L.storage_capacity_change_pct));
  const capacity = capRaw > 0 ? capRaw : Infinity;
  const disProb = L.supply_disruption_prob || 0;
  const disDelay = Math.trunc(L.disruption_delay_days || 0);

  const perishable = shelf.map(Number.isFinite);
  const A = perishable.some(Boolean) ? Math.max(...shelf.filter(Number.isFinite)) + 1 : 1;
  const shelfInt = shelf.map((s, i) => (perishable[i] ? s : A + 1));
  const maxLead = Math.max(...lead) + disDelay + 1;
  const T = H + maxLead + 1;
  const inv = prods.map((p) => {
    const row = new Array(A).fill(0);
    row[0] = p.starting_inventory;
    return row;
  });
  const pipe = prods.map(() => new Array(T).fill(0));
  let cash = startCash;
  const deliveryOn = !!d.enabled && (d.orders_per_day || 0) > 0;
  const dSum = demand.reduce((a, b) => a + b, 0);
  const mix = demand.map((v) => (dSum > 0 ? v / dSum : 1 / P));
  const cannib = Math.min(1, Math.max(0, pct(d.cannibalization_pct)));
  const capacityUnits = uplh > 0 && laborHoursPerDay > 0 ? laborHoursPerDay * uplh : Infinity;
  const dailyRecurring = recurring.reduce((a, r) => a + r.amt / r.period, 0);
  const dailyLabor = laborWeekly / 7;
  const dailyDelFixed = deliveryOn ? (d.fixed_monthly_cost || 0) / 30 : 0;

  const acc: Record<string, number> = {};
  const add = (k: string, v: number) => (acc[k] = (acc[k] || 0) + v);
  cash -= oneTime;
  add("one_time_costs", oneTime);
  let minCash = cash;
  const dailyCash: number[] = [];
  const dailyProfit: number[] = [];

  for (let t = 0; t < H; t++) {
    for (let p = 0; p < P; p++) inv[p][0] += pipe[p][t];
    let dayWasteCost = 0;
    for (let p = 0; p < P; p++) {
      if (!perishable[p]) continue;
      for (let a = shelfInt[p]; a < A; a++) {
        const e = inv[p][a];
        if (e) {
          add("waste_units", e);
          dayWasteCost += e * cost[p];
          inv[p][a] = 0;
        }
      }
    }
    add("waste_cost", dayWasteCost);

    const orders = deliveryOn ? d.orders_per_day : 0;
    const want = demand.map((mu, p) => mu + (deliveryOn ? orders * d.units_per_order * (1 - cannib) * mix[p] : 0));
    const totalWant = want.reduce((a, b) => a + b, 0);
    add("units_demanded", totalWant);
    let served = want;
    if (Number.isFinite(capacityUnits)) {
      const handling = orders * (ops.delivery_minutes_per_order || 0) / 60 * uplh;
      const cap = Math.max(0, capacityUnits - handling);
      const scale = totalWant > cap ? cap / Math.max(totalWant, 1e-9) : 1;
      if (scale < 0.999) add("capacity_limited_days", 1);
      served = want.map((w) => w * scale);
      add("labor_hours_needed", totalWant / uplh + orders * (ops.delivery_minutes_per_order || 0) / 60);
    }
    let units = 0, salesRev = 0, cogs = 0;
    for (let p = 0; p < P; p++) {
      let remaining = served[p];
      for (let a = A - 1; a >= 0; a--) {
        const take = Math.min(inv[p][a], remaining);
        inv[p][a] -= take;
        remaining -= take;
      }
      const sold = served[p] - remaining;
      if (remaining > 1e-6 && want[p] > 0) add("stockout_product_days", 1);
      units += sold;
      salesRev += sold * price[p];
      cogs += sold * cost[p];
    }
    add("units_sold", units);
    const fill = totalWant > 0 ? units / Math.max(totalWant, 1e-9) : 1;
    const delRev = deliveryOn ? orders * fill * (d.fee_per_order || 0) : 0;
    const delVar = deliveryOn ? orders * (d.cost_per_order || 0) : 0;
    add("sales_revenue", salesRev);
    add("delivery_revenue", delRev);
    add("cogs", cogs);
    cash += salesRev + delRev;
    let paid = delVar;
    for (const r of recurring) if (t % r.period === 0) paid += r.amt;
    if (t % 7 === 6) paid += laborWeekly;
    if (deliveryOn && t % 30 === 0) paid += d.fixed_monthly_cost || 0;
    if (unexpected.amt && t === Math.min(H - 1, unexpected.day)) {
      paid += unexpected.amt;
      add("one_time_costs", unexpected.amt);
    }
    cash -= paid;
    add("labor_cost", dailyLabor);
    add("recurring_expenses", dailyRecurring);
    add("delivery_costs", delVar + dailyDelFixed);

    const onHand = inv.map((row) => row.reduce((a, b) => a + b, 0));
    const onOrder = pipe.map((row) => row.slice(t + 1).reduce((a, b) => a + b, 0));
    let q = prods.map((_, p) => (onHand[p] + onOrder[p] <= reorder[p] && orderQty[p] > 0 ? orderQty[p] : 0));
    const requested = q.reduce((a, b) => a + b, 0);
    if (requested > 0) {
      let sSpace = 1;
      if (Number.isFinite(capacity)) {
        const free = Math.max(0, capacity - onHand.reduce((a, b) => a + b, 0) - onOrder.reduce((a, b) => a + b, 0));
        sSpace = Math.min(1, free / Math.max(requested, 1e-9));
      }
      const costReq = q.reduce((a, v, p) => a + v * cost[p], 0) * sSpace;
      const sCash = costReq > 0 ? Math.min(1, Math.max(0, Math.max(cash, 0) / Math.max(costReq, 1e-9))) : 1;
      q = q.map((v) => v * sSpace * sCash);
      const spend = q.reduce((a, v, p) => a + v * cost[p], 0);
      cash -= spend;
      add("purchases_paid", spend);
      const extraDelay = disProb > 0 && disDelay > 0 ? pyRound(disProb * disDelay) : 0;
      q.forEach((v, p) => {
        if (v > 0) pipe[p][Math.min(t + Math.max(1, lead[p]) + extraDelay, T - 1)] += v;
      });
    }
    if (A > 1) {
      for (let p = 0; p < P; p++) {
        const oldest = inv[p][A - 1] + inv[p][A - 2];
        for (let a = A - 1; a >= 1; a--) inv[p][a] = inv[p][a - 1];
        inv[p][0] = 0;
        inv[p][A - 1] = oldest;
      }
    }
    minCash = Math.min(minCash, cash);
    dailyCash.push(cash);
    dailyProfit.push(salesRev + delRev - cogs - dayWasteCost - (dailyLabor + dailyRecurring + delVar + dailyDelFixed));
  }

  const months = H / 30;
  const revenue = (acc.sales_revenue || 0) + (acc.delivery_revenue || 0);
  const gross = revenue - (acc.cogs || 0) - (acc.waste_cost || 0);
  const opex = (acc.labor_cost || 0) + (acc.recurring_expenses || 0) + (acc.delivery_costs || 0);
  const op = gross - opex;
  const endUnits = inv.reduce((a, row) => a + row.reduce((x, y) => x + y, 0), 0);
  const endValue = inv.reduce((a, row, p) => a + row.reduce((x, y) => x + y, 0) * cost[p], 0);
  const sold = acc.units_sold || 0, waste = acc.waste_units || 0, dem = acc.units_demanded || 0;
  const summary: Record<string, number> = {
    revenue, sales_revenue: acc.sales_revenue || 0, delivery_revenue: acc.delivery_revenue || 0, cogs: acc.cogs || 0,
    waste_cost: acc.waste_cost || 0, gross_profit: gross, labor_cost: acc.labor_cost || 0, recurring_expenses: acc.recurring_expenses || 0,
    delivery_costs: acc.delivery_costs || 0, operating_expenses: opex, operating_profit: op, avg_monthly_operating_profit: op / months,
    one_time_costs: acc.one_time_costs || 0, ending_cash: cash, min_cash: minCash, units_sold: sold, units_demanded: dem,
    waste_units: waste, fill_rate: dem > 0 ? sold / dem : 1, waste_rate: sold + waste > 0 ? waste / (sold + waste) : 0,
    stockout_rate: (acc.stockout_product_days || 0) / (H * P), ending_inventory_units: endUnits, ending_inventory_value: endValue,
    purchases_paid: acc.purchases_paid || 0, labor_utilization: laborHoursPerDay > 0 ? (acc.labor_hours_needed || 0) / (laborHoursPerDay * H) : 0,
    capacity_limited_day_share: (acc.capacity_limited_days || 0) / H,
  };

  const constraints: Constraint[] = [];
  const floor = Number(criteria.min_cash_floor ?? spec.finance.min_cash_buffer);
  constraints.push({ key: "cash_floor", label: `Cash stays above $${floor.toLocaleString()}`, limit: `$${floor.toLocaleString()}`, value: `lowest point $${Math.round(minCash).toLocaleString()}`, violated: minCash < floor, basis: "Deterministic run with expected inputs" });
  if (criteria.target_monthly_operating_profit != null) {
    const target = Number(criteria.target_monthly_operating_profit);
    constraints.push({ key: "profit_target", label: `Operating profit of at least $${target.toLocaleString()}/month`, limit: `$${target.toLocaleString()}/month`, value: `$${Math.round(op / months).toLocaleString()}/month`, violated: op / months < target, basis: "Deterministic run with expected inputs" });
  }
  if (criteria.max_investment != null) {
    const lim = Number(criteria.max_investment);
    constraints.push({ key: "budget", label: `One-time spending within $${lim.toLocaleString()} budget`, limit: `$${lim.toLocaleString()}`, value: `$${Math.round(summary.one_time_costs).toLocaleString()}`, violated: summary.one_time_costs > lim + 1e-6, basis: "Largest one-time spend" });
  }
  const weeks = Math.ceil(H / 7);
  const weeklyCash: number[] = [];
  const weeklyCumProfit: number[] = [];
  let cum = 0;
  for (let w = 0; w < weeks; w++) {
    const seg = dailyProfit.slice(w * 7, (w + 1) * 7);
    cum += seg.reduce((a, b) => a + b, 0);
    weeklyCumProfit.push(cum);
    weeklyCash.push(dailyCash[Math.min(H - 1, (w + 1) * 7 - 1)]);
  }
  return { summary, constraints, outcome: constraints.some((c) => c.violated) ? "failed_constraints" : "passed", weeklyCash, weeklyCumProfit, appliedChanges: changes };
}
