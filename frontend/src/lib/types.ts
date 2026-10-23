export type Dist = { mean: number; p10: number; p50: number; p90: number; min: number; max: number };
export type Bands = { p10: number[]; p50: number[]; p90: number[]; mean: number[] };
export type Provenance = "confirmed" | "user" | "inferred" | "calibrated" | "default";
export type RunStatus = "queued" | "preparing" | "running" | "completed" | "completed_with_warnings" | "failed" | "cancelled";

export interface User { id: number; name: string; email: string }

export interface Product {
  id: string; name: string; category: string; price: number; unit_cost: number; avg_daily_demand: number;
  demand_cv: number; starting_inventory: number; shelf_life_days: number | null; reorder_point: number;
  order_quantity: number; lead_time_days: number; price_elasticity: number;
}
export interface Expense { id: string; name: string; category: string; amount: number; frequency: "daily" | "weekly" | "monthly" }
export interface Staff { id: string; role: string; count: number; hourly_wage: number; hours_per_week: number }
export interface Spec {
  industry: string;
  business: { name: string; type: string; currency: string; sample_data?: boolean };
  products: Product[];
  expenses: Expense[];
  staff: Staff[];
  operations: { open_days_per_week: number; units_per_labor_hour: number; storage_capacity_units: number; delivery_minutes_per_order: number };
  finance: { starting_cash: number; min_cash_buffer: number };
  goals: { target_monthly_operating_profit: number | null; max_investment_budget: number | null; risk_tolerance: "low" | "medium" | "high"; max_waste_rate: number | null; min_fill_rate: number | null; stated?: string[] };
  uncertainty: { demand_level_pct: number; supplier_cost_pct: number };
  provenance: Record<string, Provenance>;
  sales_history_days?: number | null;
}

export interface Issue { severity: "error" | "warning" | "info"; code: string; message: string; path: string | null; fix?: string | null }
export interface Validation { status: "invalid" | "exploratory" | "calibrated"; issues: Issue[]; counts: { error: number; warning: number; info: number }; default_share: number }

export interface Business {
  id: number; name: string; industry: string; business_type: string; description: string; decision: string;
  creation_mode: "build" | "plan"; plan_status: "none" | "draft" | "approved"; is_demo: boolean; created_at: string;
  active_model_version_id: number | null;
  active_model: { id: number; version: number; calibration: Validation["status"]; counts: Validation["counts"] } | null;
  scenario_count: number; run_counts: Record<string, number>; active_runs: number;
  plan?: Plan | null;
}

export interface ScenarioProposal { kind: string; name: string; description: string; decision: string; rationale?: string; assumptions: string[]; levers: Levers }
export interface Plan {
  created_by: string[]; modes: Record<string, string>; business_summary: string[];
  assumptions_to_verify: { message: string; path: string | null; fix?: string | null }[];
  proposed_scenarios: ScenarioProposal[]; proposed_config: SimConfig; success_criteria: Record<string, number | null>;
  questions: string[]; notes: string[];
}

export interface ModelVersion {
  id: number; business_id: number; version: number; calibration: Validation["status"]; validation: Validation;
  change_note: string; created_by: string; created_at: string; provenance_counts: Record<Provenance, number>;
  spec?: Spec; active?: boolean;
}

export interface Delivery { enabled: boolean; orders_per_day: number; units_per_order: number; fee_per_order: number; cost_per_order: number; fixed_monthly_cost: number; setup_cost: number; cannibalization_pct: number }
export interface Levers {
  price_change_pct?: number; price_products?: string[]; demand_change_pct?: number; supplier_cost_change_pct?: number;
  order_quantity_change_pct?: number; reorder_point_change_pct?: number; inventory_products?: string[];
  lead_time_change_days?: number; shelf_life_change_pct?: number;
  extra_staff?: { role: string; count: number; hourly_wage: number; hours_per_week: number }[];
  staff_hours_change_pct?: number; expense_change_pct?: number; rent_change_pct?: number; one_time_investment?: number;
  unexpected_expense?: number; unexpected_expense_day?: number; starting_cash_change?: number; storage_capacity_change_pct?: number;
  supply_disruption_prob?: number; disruption_delay_days?: number; delivery?: Partial<Delivery>;
}
export interface SimConfig { mode: "monte_carlo" | "deterministic"; runs: number; horizon_days: number; seed?: number; start_date?: string }
export interface Criteria { min_cash_floor?: number | null; target_monthly_operating_profit?: number | null; max_waste_rate?: number | null; min_fill_rate?: number | null; max_investment?: number | null; risk_tolerance?: string; max_shortfall_probability?: number }

export interface Scenario {
  id: number; business_id: number; name: string; description: string; decision: string; kind: string; color_index: number;
  is_baseline: boolean; base_model_version_id: number | null; levers: Levers; assumptions: string[]; config: SimConfig;
  success_criteria: Criteria; origin: string; created_at: string; updated_at: string; latest_run: Run | null;
}

export interface Constraint { key: string; label: string; limit: string; value: string; violated: boolean; basis: string }
export interface SimResults {
  engine_version: string; config: SimConfig; applied_changes: string[];
  summary: Record<string, Dist>;
  probabilities: { cash_below_zero: number; cash_below_buffer: number; meets_profit_target: number | null; basis: string };
  constraints: Constraint[]; outcome: "passed" | "failed_constraints"; warnings: string[];
  series: { weeks: number[]; cash: Bands; revenue: Bands; operating_profit: Bands; cumulative_operating_profit: Bands; inventory_units: Bands; waste_units: Bands };
  daily_expected: Record<string, number[]>;
  per_product: { id: string; name: string; price: number; unit_cost: number; expected_daily_demand: number; units_sold: number; revenue: number; waste_units: number; lost_sales_units: number; stockout_day_share: number }[];
}
export interface StressRow { key: string; label: string; levers: Levers; headline: Headline; delta: { monthly_operating_profit: number; min_cash_p10: number; cash_below_buffer: number }; series_cash_p10: number[]; series_cash_p50: number[]; constraints: Constraint[] }
export interface Headline { monthly_operating_profit: Dist; revenue: number; min_cash_p10: number; min_cash_mean: number; ending_cash: number; fill_rate: number; waste_rate: number; cash_below_zero: number; cash_below_buffer: number; meets_profit_target: number | null; outcome: string; violations: string[] }
export interface StressResults { config: SimConfig; rows: StressRow[]; summary: { conditions_tested: number; conditions_passed: number; largest_profit_impact: { label: string; monthly_change: number }; breaking_conditions: { label: string; violations: string[] }[] } }
export interface SensitivityResults { baseline_monthly_operating_profit: number; baseline_min_cash: number; method: string; rows: { key: string; label: string; profit_low: number; profit_high: number; cash_low: number; cash_high: number }[] }

export interface Run {
  id: number; business_id: number; scenario_id: number | null; scenario_name: string; color_index: number;
  kind: "scenario" | "stress" | "sensitivity"; parent_run_id: number | null; model_version_id: number; model_version: number | null;
  status: RunStatus; progress: number; stage: string; config: SimConfig & { shocks?: string[] }; levers: Levers; criteria: Criteria;
  inputs: { validation_status?: string; default_share?: number; model_version?: number }; warnings: string[]; error: string | null;
  outcome: "passed" | "failed_constraints" | null; created_at: string; started_at: string | null; finished_at: string | null;
  outdated: string[];
  headline?: { avg_monthly_operating_profit: Dist; revenue: number; min_cash_p10: number; fill_rate: number; waste_rate: number; cash_below_buffer: number };
  results?: SimResults | StressResults | SensitivityResults | null;
}

export interface CompareRow {
  run_id: number; scenario_name: string; color_index: number; model_version_id: number; mode: string; runs: number; horizon_days: number;
  revenue: Dist; operating_profit: Dist; avg_monthly_operating_profit: Dist; gross_profit: Dist; operating_expenses: Dist; cogs: Dist;
  waste_cost: Dist; one_time_costs: Dist; ending_cash: Dist; min_cash: Dist; fill_rate: Dist; waste_rate: Dist; stockout_rate: Dist;
  labor_utilization: Dist; ending_inventory_value: Dist; cash_below_zero: number; cash_below_buffer: number; meets_profit_target: number | null;
  outcome: string; violations: string[];
  series: { cash: Bands; cumulative_operating_profit: Bands; revenue: Bands; inventory_units: Bands };
}
export interface Explanation { run_id: number; scenario_name: string; monthly_operating_profit_change: number; drivers: { key: string; label: string; monthly_effect: number }[]; notes: string[]; error?: string }
export interface Comparison { reference_run_id: number; rows: CompareRow[]; explanations: Explanation[]; comparable: boolean; same_model_version: boolean }
export interface AgentEnvelope<T> { agent: string; mode: "ai" | "deterministic"; model: string | null; output: T; notes: string[] }
export interface Analysis { summary: string; scenario_facts?: string[]; recommendation: string; risks: string[]; next_steps: string[]; ranking: { run_id: number; scenario_name: string; violations: string[] }[]; recommended_run_id: number; depends_on_assumptions: boolean; ranking_rule: string; error?: string }
