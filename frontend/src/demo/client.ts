/* One interface over two engines for the public demo:
     server  – the real What-if engine (Monte Carlo or deterministic), via an anonymous in-memory demo session
     browser – the deterministic fallback engine, used only when the server cannot be reached
   Both run real calculations on the fictional sample store. Statuses come from
   what actually happened; nothing is replayed from a recording. */
import { api, ApiError } from "../lib/api";
import type { AgentEnvelope, Analysis, Comparison, CompareRow, Dist, Levers, RunStatus, SimResults, Spec, StressResults, Validation } from "../lib/types";
import { SAMPLE, combineLevers, criteriaFor, simulateDeterministic } from "./fallbackEngine";

export interface DemoScenario { id: string; kind: string; name: string; description: string; decision: string; levers: Levers; assumptions: string[]; color_index: number }
export interface DemoOverview {
  name: string; type: string; products: { name: string; category: string; price: number; unit_cost: number; avg_daily_demand: number; stock: number; shelf_life_days: number | null }[];
  expected_monthly_revenue: number; gross_margin: number; monthly_fixed_costs_incl_labor: number; monthly_labor: number;
  expenses: Spec["expenses"]; staff: Spec["staff"]; inventory_units: number; inventory_value: number; starting_cash: number; min_cash_buffer: number; goals: Spec["goals"];
}
export interface DemoGoal { id: string; label: string; short: string; description: string; scenario_ids: string[]; metrics: string[] }
export interface DemoSession { session_id: string; label: string; business: DemoOverview; spec: Spec; validation: Validation; scenarios: DemoScenario[]; criteria: Record<string, number | string | null>; goals: DemoGoal[] }
/** The few assumptions a visitor can change. budget is the most the owner will spend up front (a limit, not a cost). */
export interface Assumptions { demand_change_pct: number; supplier_cost_change_pct: number; budget: number }
export interface SensitivityPayload { scenario: string; baseline_monthly_operating_profit: number; baseline_min_cash: number; method: string; rows: { key: string; label: string; profit_low: number; profit_high: number; cash_low: number; cash_high: number }[] }
export interface DemoRun {
  id: number; scenario_id: string; scenario_name: string; color_index: number; status: RunStatus; progress: number; stage: string;
  timeline: { status: string; at: number }[]; config: { mode: string; runs: number; horizon_days: number }; error: string | null; results?: SimResults;
}
export interface StressPayload { scenario: string; result: StressResults; vulnerabilities: string[] }

export const DEMO_SHOCKS = [
  { key: "demand_drop", label: "Demand falls 20%", levers: { demand_change_pct: -20 } },
  { key: "supplier_increase", label: "Supplier prices rise 12%", levers: { supplier_cost_change_pct: 12 } },
  { key: "staff_shortage", label: "25% fewer staff hours", levers: { staff_hours_change_pct: -25 } },
  { key: "faster_spoilage", label: "Perishables spoil 30% faster", levers: { shelf_life_change_pct: -30 } },
  { key: "delivery_delays", label: "Supplier deliveries 3 days late", levers: { lead_time_change_days: 3 } },
  { key: "unexpected_bill", label: "$6,000 unexpected bill on day 20", levers: { unexpected_expense: 6000, unexpected_expense_day: 19 } },
] as const;

export interface DemoClient {
  kind: "server" | "browser";
  start(): Promise<DemoSession>;
  run(ids: string[], a: Assumptions, mode: "monte_carlo" | "deterministic", runs: number): Promise<DemoRun[]>;
  poll(ids: number[]): Promise<DemoRun[]>;
  compare(ids: number[]): Promise<{ comparison: Comparison; analysis: AgentEnvelope<Analysis> }>;
  stress(scenarioId: string, shocks: string[], a: Assumptions): Promise<StressPayload>;
  sensitivity(scenarioId: string, a: Assumptions): Promise<SensitivityPayload>;
}

function assumptionLevers(a: Assumptions): Levers {
  const out: Levers = {};
  if (a.demand_change_pct) out.demand_change_pct = a.demand_change_pct;
  if (a.supplier_cost_change_pct) out.supplier_cost_change_pct = a.supplier_cost_change_pct;
  return out;
}

// ------------------------------------------------------------------ server

export class ServerClient implements DemoClient {
  kind = "server" as const;
  sid = "";
  async start() {
    const s = await api.post<DemoSession>("/api/public/demo/session");
    this.sid = s.session_id;
    return s;
  }
  run(ids: string[], a: Assumptions, mode: "monte_carlo" | "deterministic", runs: number) {
    return api.post<DemoRun[]>("/api/public/demo/runs", { session_id: this.sid, scenario_ids: ids, assumptions: assumptionLevers(a), budget: a.budget, mode, runs, horizon_days: 90 });
  }
  async poll(ids: number[]) {
    const runs = await api.get<DemoRun[]>(`/api/public/demo/runs?session_id=${encodeURIComponent(this.sid)}&ids=${ids.join(",")}`);
    const done = runs.filter((r) => r.status.startsWith("completed")).map((r) => r.id);
    if (!done.length) return runs;
    const full = await api.get<DemoRun[]>(`/api/public/demo/runs?session_id=${encodeURIComponent(this.sid)}&ids=${done.join(",")}&results=true`);
    const byId = new Map(full.map((r) => [r.id, r]));
    return runs.map((r) => byId.get(r.id) ?? r);
  }
  compare(ids: number[]) {
    return api.post<{ comparison: Comparison; analysis: AgentEnvelope<Analysis> }>("/api/public/demo/compare", { session_id: this.sid, run_ids: ids });
  }
  stress(scenarioId: string, shocks: string[], a: Assumptions) {
    return api.post<StressPayload>("/api/public/demo/stress", { session_id: this.sid, scenario_id: scenarioId, shocks, runs: 200, budget: a.budget });
  }
  sensitivity(scenarioId: string, a: Assumptions) {
    return api.post<SensitivityPayload>("/api/public/demo/sensitivity", { session_id: this.sid, scenario_id: scenarioId, assumptions: assumptionLevers(a), budget: a.budget });
  }
}

// ----------------------------------------------------------------- browser

const point = (v: number): Dist => ({ mean: v, p10: v, p50: v, p90: v, min: v, max: v });
const band = (v: number[]) => ({ mean: v, p10: v, p50: v, p90: v });

function toResults(levers: Levers, criteria: Record<string, unknown> = SAMPLE.criteria): SimResults {
  const r = simulateDeterministic(SAMPLE.spec, levers, 90, criteria);
  const summary: Record<string, Dist> = {};
  for (const [k, v] of Object.entries(r.summary)) summary[k] = point(v);
  const weeks = r.weeklyCash.map((_, i) => i + 1);
  return {
    engine_version: "browser fallback (deterministic)", config: { mode: "deterministic", runs: 1, horizon_days: 90 }, applied_changes: r.appliedChanges,
    summary, probabilities: { cash_below_zero: r.summary.min_cash < 0 ? 1 : 0, cash_below_buffer: r.summary.min_cash < SAMPLE.spec.finance.min_cash_buffer ? 1 : 0,
      meets_profit_target: r.summary.avg_monthly_operating_profit >= Number(SAMPLE.spec.goals.target_monthly_operating_profit) ? 1 : 0, basis: "Deterministic run in your browser" },
    constraints: r.constraints, outcome: r.outcome, warnings: [],
    series: { weeks, cash: band(r.weeklyCash), revenue: band([]), operating_profit: band([]), cumulative_operating_profit: band(r.weeklyCumProfit), inventory_units: band([]), waste_units: band([]) },
    daily_expected: {}, per_product: [],
  };
}

const DRIVERS: [string, string, number][] = [
  ["sales_revenue", "Store sales revenue", 1], ["delivery_revenue", "Delivery fees", 1], ["cogs", "Cost of goods sold", -1],
  ["waste_cost", "Expired stock written off", -1], ["labor_cost", "Labor", -1], ["recurring_expenses", "Rent and other recurring expenses", -1], ["delivery_costs", "Delivery costs", -1],
];

export function rowFrom(run: { id: number; scenario_name: string; color_index: number }, res: SimResults): CompareRow {
  const S = res.summary;
  return {
    run_id: run.id, scenario_name: run.scenario_name, color_index: run.color_index, model_version_id: 1, mode: res.config.mode, runs: res.config.runs,
    horizon_days: res.config.horizon_days, revenue: S.revenue, operating_profit: S.operating_profit, avg_monthly_operating_profit: S.avg_monthly_operating_profit,
    gross_profit: S.gross_profit, operating_expenses: S.operating_expenses, cogs: S.cogs, waste_cost: S.waste_cost, one_time_costs: S.one_time_costs,
    ending_cash: S.ending_cash, min_cash: S.min_cash, fill_rate: S.fill_rate, waste_rate: S.waste_rate, stockout_rate: S.stockout_rate,
    labor_utilization: S.labor_utilization, ending_inventory_value: S.ending_inventory_value, cash_below_zero: res.probabilities.cash_below_zero,
    cash_below_buffer: res.probabilities.cash_below_buffer, meets_profit_target: res.probabilities.meets_profit_target, outcome: res.outcome,
    violations: res.constraints.filter((c) => c.violated).map((c) => c.label),
    series: { cash: res.series.cash, cumulative_operating_profit: res.series.cumulative_operating_profit, revenue: res.series.revenue, inventory_units: res.series.inventory_units },
  };
}

export class BrowserClient implements DemoClient {
  kind = "browser" as const;
  next = 1;
  runs = new Map<number, DemoRun & { levers: Levers; criteria: Record<string, unknown> }>();
  async start(): Promise<DemoSession> {
    const spec = SAMPLE.spec;
    const fixed = spec.expenses.reduce((a, e) => a + (e.frequency === "monthly" ? e.amount : e.frequency === "weekly" ? (e.amount * 30) / 7 : e.amount * 30), 0);
    const labor = spec.staff.reduce((a, s) => a + s.count * s.hourly_wage * s.hours_per_week, 0) * 30 / 7;
    const rev = spec.products.reduce((a, p) => a + p.avg_daily_demand * p.price, 0);
    const cogs = spec.products.reduce((a, p) => a + p.avg_daily_demand * p.unit_cost, 0);
    return {
      session_id: "browser", label: "Sample data — fictional store", spec, scenarios: SAMPLE.scenarios, criteria: SAMPLE.criteria, goals: SAMPLE.goals,
      validation: { status: "exploratory", issues: [], counts: { error: 0, warning: 0, info: 0 }, default_share: 1 },
      business: {
        name: spec.business.name, type: "Neighborhood grocery", expected_monthly_revenue: rev * 30, gross_margin: (rev - cogs) / rev,
        monthly_fixed_costs_incl_labor: fixed + labor, monthly_labor: labor, expenses: spec.expenses, staff: spec.staff,
        products: spec.products.map((p) => ({ name: p.name, category: p.category, price: p.price, unit_cost: p.unit_cost, avg_daily_demand: p.avg_daily_demand, stock: p.starting_inventory, shelf_life_days: p.shelf_life_days })),
        inventory_units: spec.products.reduce((a, p) => a + p.starting_inventory, 0), inventory_value: spec.products.reduce((a, p) => a + p.starting_inventory * p.unit_cost, 0),
        starting_cash: spec.finance.starting_cash, min_cash_buffer: spec.finance.min_cash_buffer, goals: spec.goals,
      },
    };
  }
  async run(ids: string[], a: Assumptions) {
    const created: DemoRun[] = [];
    for (const id of ids) {
      const sc = SAMPLE.scenarios.find((s) => s.id === id);
      if (!sc) continue;
      const levers = combineLevers(JSON.parse(JSON.stringify(sc.levers)) as Levers, assumptionLevers(a));
      const run = { id: this.next++, scenario_id: id, scenario_name: sc.name, color_index: sc.color_index, status: "queued" as RunStatus, progress: 0, stage: "Waiting",
        timeline: [{ status: "queued", at: Date.now() / 1000 }], config: { mode: "deterministic", runs: 1, horizon_days: 90 }, error: null, levers, criteria: criteriaFor(a.budget) };
      this.runs.set(run.id, run);
      created.push({ ...run });
      // Execute after the current tick so the queued state is real and visible.
      setTimeout(() => this.exec(run.id), 30 * created.length);
    }
    return created;
  }
  private exec(id: number) {
    const r = this.runs.get(id)!;
    const mark = (s: RunStatus, stage: string) => { r.status = s; r.stage = stage; r.timeline.push({ status: s, at: Date.now() / 1000 }); };
    mark("preparing", "Validating inputs");
    mark("running", "Simulating 90 days");
    try {
      r.results = toResults(r.levers, r.criteria);
      r.progress = 1;
      mark("completed", "Finished");
    } catch (e) {
      r.error = String(e);
      mark("failed", "Failed");
    }
  }
  async poll(ids: number[]) {
    return ids.map((i) => this.runs.get(i)).filter(Boolean).map((r) => ({ ...r! }));
  }
  async compare(ids: number[]) {
    const runs = ids.map((i) => this.runs.get(i)!).filter((r) => r?.results).sort((a, b) => (a.scenario_id === "baseline" ? -1 : b.scenario_id === "baseline" ? 1 : a.color_index - b.color_index));
    if (!runs.length) throw new ApiError(422, "Run the scenarios first.");
    const rows = runs.map((r) => rowFrom(r, r.results!));
    const ref = runs[0].results!;
    const explanations = runs.slice(1).map((r) => {
      const drivers = DRIVERS.map(([k, label, sign]) => ({ key: k, label, monthly_effect: ((r.results!.summary[k].mean - ref.summary[k].mean) * sign) / 3 })).filter((d) => Math.abs(d.monthly_effect) >= 1).sort((a, b) => Math.abs(b.monthly_effect) - Math.abs(a.monthly_effect));
      return { run_id: r.id, scenario_name: r.scenario_name, monthly_operating_profit_change: (r.results!.summary.operating_profit.mean - ref.summary.operating_profit.mean) / 3, drivers, notes: [] as string[] };
    });
    const ranked = [...rows].sort((a, b) => (a.violations.length ? 1 : 0) - (b.violations.length ? 1 : 0) || a.cash_below_buffer - b.cash_below_buffer || b.avg_monthly_operating_profit.p50 - a.avg_monthly_operating_profit.p50);
    const best = ranked[0];
    const viable = ranked.filter((r) => !r.violations.length);
    const analysis: Analysis = {
      summary: `${rows.length} scenarios compared over 90 days with expected inputs in your browser. ${viable.length} met all limits.`,
      recommendation: viable.length ? `Prefer ${best.scenario_name}: it is the strongest option that breaks none of the limits.` : `No option met every limit. ${best.scenario_name} comes closest.`,
      risks: rows.filter((r) => r.violations.length).map((r) => `${r.scenario_name} breaks: ${r.violations.join(", ").toLowerCase()}.`),
      next_steps: ["Connect to the What-if server to run Monte Carlo ranges instead of a single expected case.", `Stress-test ${best.scenario_name} before committing.`],
      ranking: ranked.map((r) => ({ run_id: r.run_id, scenario_name: r.scenario_name, violations: r.violations })), recommended_run_id: best.run_id,
      depends_on_assumptions: false, ranking_rule: "Scenarios that break a limit rank below those that do not; then lower chance of dipping below the cash buffer; then higher profit.",
    };
    return {
      comparison: { reference_run_id: rows[0].run_id, rows, explanations, comparable: true, same_model_version: true },
      analysis: { agent: "Decision Analyst", mode: "deterministic" as const, model: null, output: analysis, notes: ["Browser fallback: deterministic rules, no AI model."] },
    };
  }
  async sensitivity(scenarioId: string, a: Assumptions): Promise<SensitivityPayload> {
    // Same one-at-a-time method as run_sensitivity in backend/app/engine/analysis.py.
    const sc = SAMPLE.scenarios.find((s) => s.id === scenarioId)!;
    const base = combineLevers(sc.levers, assumptionLevers(a));
    const crit = criteriaFor(a.budget);
    const sim = (extra: Levers) => simulateDeterministic(SAMPLE.spec, combineLevers(base, extra), 90, crit).summary;
    const b = sim({});
    const params: [string, string, Levers, Levers][] = [
      ["demand", "Customer demand ±15%", { demand_change_pct: -15 }, { demand_change_pct: 15 }],
      ["price", "Selling prices ±5%", { price_change_pct: -5 }, { price_change_pct: 5 }],
      ["supplier", "Supplier prices ±10%", { supplier_cost_change_pct: 10 }, { supplier_cost_change_pct: -10 }],
      ["expenses", "Operating expenses ±10%", { expense_change_pct: 10 }, { expense_change_pct: -10 }],
      ["staff", "Staff hours ±20%", { staff_hours_change_pct: -20 }, { staff_hours_change_pct: 20 }],
      ["lead", "Supplier lead time +3 / −1 days", { lead_time_change_days: 3 }, { lead_time_change_days: -1 }],
      ["shelf", "Perishable shelf life ±30%", { shelf_life_change_pct: -30 }, { shelf_life_change_pct: 30 }],
      ["order", "Order quantity ±25%", { order_quantity_change_pct: -25 }, { order_quantity_change_pct: 25 }],
    ];
    const rows = params.map(([key, label, lo, hi]) => {
      const l = sim(lo), h = sim(hi);
      return { key, label, profit_low: l.avg_monthly_operating_profit - b.avg_monthly_operating_profit, profit_high: h.avg_monthly_operating_profit - b.avg_monthly_operating_profit,
        cash_low: l.min_cash - b.min_cash, cash_high: h.min_cash - b.min_cash };
    }).sort((x, y) => Math.max(Math.abs(y.profit_low), Math.abs(y.profit_high)) - Math.max(Math.abs(x.profit_low), Math.abs(x.profit_high)));
    return { scenario: sc.name, baseline_monthly_operating_profit: b.avg_monthly_operating_profit, baseline_min_cash: b.min_cash, rows,
      method: "One-at-a-time changes on the expected case (calculated in your browser); other assumptions fixed." };
  }
  async stress(scenarioId: string, shocks: string[], a: Assumptions): Promise<StressPayload> {
    const sc = SAMPLE.scenarios.find((s) => s.id === scenarioId)!;
    const chosen = DEMO_SHOCKS.filter((s) => shocks.includes(s.key));
    const plan: { key: string; label: string; levers: Levers }[] = [{ key: "unstressed", label: "No added stress", levers: {} }, ...chosen.map((s) => ({ key: s.key, label: s.label, levers: s.levers as Levers }))];
    if (chosen.length > 1) plan.push({ key: "combined", label: "All selected conditions together", levers: chosen.reduce((acc, s) => combineLevers(acc, s.levers as Levers), {} as Levers) });
    const rows = plan.map((p) => {
      const res = toResults(combineLevers(combineLevers(sc.levers, assumptionLevers(a)), p.levers), criteriaFor(a.budget));
      const S = res.summary;
      return { key: p.key, label: p.label, levers: p.levers, constraints: res.constraints, series_cash_p10: res.series.cash.p10, series_cash_p50: res.series.cash.p50,
        headline: { monthly_operating_profit: S.avg_monthly_operating_profit, revenue: S.revenue.mean, min_cash_p10: S.min_cash.p10, min_cash_mean: S.min_cash.mean, ending_cash: S.ending_cash.mean,
          fill_rate: S.fill_rate.mean, waste_rate: S.waste_rate.mean, cash_below_zero: res.probabilities.cash_below_zero, cash_below_buffer: res.probabilities.cash_below_buffer,
          meets_profit_target: res.probabilities.meets_profit_target, outcome: res.outcome, violations: res.constraints.filter((c) => c.violated).map((c) => c.label) },
        delta: { monthly_operating_profit: 0, min_cash_p10: 0, cash_below_buffer: 0 } };
    });
    const base = rows[0].headline;
    rows.forEach((r) => { r.delta = { monthly_operating_profit: r.headline.monthly_operating_profit.mean - base.monthly_operating_profit.mean, min_cash_p10: r.headline.min_cash_p10 - base.min_cash_p10, cash_below_buffer: r.headline.cash_below_buffer - base.cash_below_buffer }; });
    const worst = rows.slice(1).reduce((a, b) => (b.delta.monthly_operating_profit < a.delta.monthly_operating_profit ? b : a), rows[1]);
    return {
      scenario: sc.name,
      result: { config: { mode: "deterministic", runs: 1, horizon_days: 90 }, rows, summary: { conditions_tested: rows.length - 1, conditions_passed: rows.slice(1).filter((r) => r.headline.outcome === "passed").length,
        largest_profit_impact: { label: worst.label, monthly_change: worst.delta.monthly_operating_profit }, breaking_conditions: rows.slice(1).filter((r) => r.headline.violations.length).map((r) => ({ label: r.label, violations: r.headline.violations })) } },
      vulnerabilities: rows.slice(1).filter((r) => r.headline.violations.length).map((r) => `${r.label}: breaks ${r.headline.violations.join(", ").toLowerCase()}.`),
    };
  }
}
