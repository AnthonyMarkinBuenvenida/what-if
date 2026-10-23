// Shapes returned by /api/whatif (see backend/app/whatif). Numbers are calculated by the engine.

export type Industry = "food_beverage" | "retail" | "manufacturing" | "technology" | "agriculture" | "services";
export type Severity = "low" | "moderate" | "high" | "critical";
export type Source = "user" | "default" | "imported" | "observed" | "demo";

export interface WIProduct {
  id: string; name: string; price: number; unit_cost: number; monthly_units: number; elasticity: number;
  stock_units: number | null; restock_units_per_month: number | null;
}
export interface WIStaff { id: string; role: string; count: number; monthly_wage: number }
export interface WIFixed { id: string; name: string; category: string; monthly_amount: number }
export interface HistoryRow { month: string; revenue: number; units: number | null; total_costs: number | null; net_profit: number | null }

export interface ProfileSpec {
  industry: Industry;
  business: { name: string; business_type: string; country: string; currency: string; description: string };
  unit_label: string;
  products: WIProduct[];
  staff: WIStaff[];
  fixed_costs: WIFixed[];
  marketing: { monthly_budget: number; elasticity: number; units_per_1000: number | null };
  operations: { monthly_capacity_units: number | null; capacity_per_staff: number | null; inventory_lead_time_days: number | null };
  subscription: { enabled: boolean; monthly_churn_pct: number; new_customers_per_month: number };
  finance: { starting_cash: number; min_cash_buffer: number; tax_rate_pct: number; monthly_debt_payment: number };
  growth: { monthly_growth_pct: number; seasonality: number[] };
  goals: { target_monthly_profit: number | null; max_investment: number | null; min_margin_pct: number | null };
  suppliers: { name: string; share_pct: number }[];
  history: HistoryRow[];
  location: { city: string; latitude: number | null; longitude: number | null };
  external: { foreign_currency: string; imported_cost_share_pct: number | null; market_symbol?: string };
  uncertainty: { demand_pct: number; cost_pct: number; elasticity_abs: number };
  provenance: Record<string, Source>;
}

export interface ProfileRow {
  id: number; version: number; spec: ProfileSpec; note: string; created_by: string; created_at: string;
  validation: { status: string; issues: { severity: "warning" | "info" | "error"; code: string; message: string; path: string | null }[] };
}

export interface IndustryInfo {
  id: Industry; label: string; examples: string; unit_label: string; unit_cost_label: string; sections: string[];
  background: string; external: string[]; elasticity_note: string; suggestions: string[];
}

export interface Levers {
  price_change_pct?: number; price_product_ids?: string[]; unit_cost_change_pct?: number; cost_product_ids?: string[];
  demand_change_pct?: number; seasonal?: { months: number[]; demand_change_pct: number; label: string; year_month?: string | null }[];
  marketing_change_pct?: number; marketing_budget?: number | null;
  staff_changes?: { role: string; count: number; monthly_wage?: number | null }[];
  wage_change_pct?: number; rent_change_pct?: number; fixed_cost_change_pct?: number; capacity_change_pct?: number;
  new_branch?: { setup_cost: number; monthly_fixed_cost: number; demand_share_pct: number; ramp_months: number } | null;
  new_product?: { name: string; price: number; unit_cost: number; monthly_units: number; cannibalization_pct: number; launch_cost: number } | null;
  one_time_investment?: number; investment_month?: number; tax_rate_pct?: number | null;
  churn_change_pts?: number; new_customers_change_pct?: number; elasticity_override?: number | null;
  horizon_months?: number; start_month?: string | null;
  extra_monthly_costs?: { label: string; amount: number }[];
  data_links?: DataLink[];
}

export interface DataLink {
  id: string; signal: "fx" | "inflation" | "lending" | "gdp" | "weather" | "market"; rule: string; source: string; indicator: string;
  value: number | null; unit: string; observed_at: string | null; retrieved_at: string | null; kind: "observed" | "historical" | "forecast" | "user";
  rule_text: string; params: Record<string, unknown>; applied: Record<string, unknown>; source_url: string | null;
}

export interface MonthRow {
  month: string; demand_units: number; units: number; lost_units: number; stockout_units: number; capacity: number | null;
  revenue: number; variable_costs: number; gross_profit: number; staff_costs: number; fixed_costs: number; marketing: number;
  operating_expenses: number; operating_profit: number; tax: number; net_profit: number; one_time: number; purchases: number;
  cash_flow: number; cash: number; inventory_units: number | null; inventory_value: number | null;
}
export interface Metrics {
  net_margin: number | null; gross_margin: number | null; operating_margin: number | null; contribution_per_unit: number | null;
  contribution_ratio: number | null; break_even_units: number | null; break_even_revenue: number | null; safety_margin: number | null;
  capacity: number | null; capacity_utilization: number | null; lost_share: number | null; starting_cash: number; ending_cash: number;
  min_cash: number; min_cash_month: string; months_below_buffer: number; runway_months: number | null;
  inventory_cover_months: number | null; inventory_value_end: number | null; marketing_share: number | null; staff_share: number | null;
  headcount: number; tax_rate: number; subscribers_end: number | null; churn_rate: number | null;
}
export interface Projection {
  months: MonthRow[]; totals: Record<string, number>; monthly_avg: Record<string, number>; metrics: Metrics;
  products: { id: string; name: string; is_new: boolean; price: number; base_price: number | null; unit_cost: number; units: number; revenue: number; gross_profit: number; share_of_revenue: number | null; contribution_per_unit: number }[];
  demand_factors: { key: string; label: string; multiplier: number; note: string }[];
  flags: string[]; horizon_months: number; start_month: string; end_month: string;
}
export interface Band { assumption: { demand_mult: number; cost_mult: number; elasticity_shift: number }; net_profit: number; revenue: number; min_cash: number; ending_cash: number; net_margin: number | null; monthly_net_profit: number[]; cash: number[] }
export interface Assumption { key: string; label: string; value: number | null; unit: string; source: string; note: string }
export interface SimResult {
  engine: string; computed_at: string; currency: string; unit_label: string; levers: Levers; is_baseline: boolean;
  baseline: Projection; scenario: Projection;
  bands: { best: Band; worst: Band; cases: number; ranges: { demand_pct: number; cost_pct: number; elasticity_abs: number } };
  baseline_bands: { best: Band; worst: Band };
  delta: Record<string, { baseline: number | null; scenario: number | null; change: number | null; change_pct?: number | null }>;
  bridge: { key: string; label: string; value: number; note: string }[];
  payback_months: number | null;
  confidence: { score: number; level: "high" | "medium" | "low"; reasons: { impact: number; text: string }[]; default_share: number; method: string };
  assumptions: Assumption[]; simplifications: string[];
  history_trend: { slope_pct_per_month: number | null; first_month: string; last_month: string; seasonally_adjusted: boolean } | null;
  history_check: { last_actual_month: string; last_actual_revenue: number; baseline_first_month_revenue: number; gap_pct: number | null } | null;
}

export interface Finding {
  id: string; rule: string; category: string; category_label: string; severity: Severity; title: string; summary: string;
  metric: { key: string; label: string; value: number | null; threshold: number | null; unit: string };
  evidence: { label: string; value: number | string | null; unit: string }[];
  triggered_by: string[]; impact: { value: number; unit: string; period: string; label: string } | null;
  actions: { label: string; levers: Levers }[]; if_no_action: string; threshold: string; why: string;
  data_kind: "calculated" | "actual" | "forecast" | "historical"; scope: string;
  scenario_id?: number | null; scenario_name?: string; created_at?: string;
}
export interface RiskReport { scope: string; score: number; level: Severity; counts: Record<Severity, number>; findings: Finding[]; method: string }

export interface Explanation {
  mode: "ai" | "calculation"; model: string | null; provider?: string;
  assessment: { key: string; text: string; net_profit_change: number };
  required_volume: { possible: boolean; needed_change?: number; expected_change: number | null; contribution_before: number; contribution_after: number } | null;
  summary: string; key_points: string[]; risk_notes: { finding_id: string; explanation: string }[];
  recommendations: { text: string; try_question: string | null; levers?: Levers }[];
  next_scenarios: string[]; caveats: string[]; dropped: number; notice: string | null;
}

export interface Interpretation {
  mode: "ai" | "rules"; model?: string; levers: Levers; name: string; notice: string | null; elapsed_ms?: number;
  recognized: { lever: string; label: string; value: number | null; unit: string; source: "stated" | "assumed"; text: string }[];
  questions: string[]; unrecognized: string | null;
}

export interface ScenarioSummary {
  id: number; business_id: number; profile_id: number; name: string; question: string; levers: Levers; origin: string; pinned: boolean;
  created_at: string; updated_at: string | null;
  summary: { horizon_months: number | null; net_profit: number | null; net_profit_baseline: number | null; revenue: number | null; net_margin: number | null; risk_score: number | null; risk_level: Severity | null; confidence: string | null; is_baseline: boolean | null; assessment: string | null };
}
export interface ScenarioFull extends ScenarioSummary {
  result: SimResult; risks: { scenario: RiskReport; baseline: RiskReport }; explanation: Explanation | null; interpretation: Interpretation | null;
}

export interface Signal { key?: string; label: string; source: string; kind: string; status: "ok" | "failed" | "unavailable" | "stale"; terms?: string; age_hours?: number | null; refresh_error?: { message: string } | null; summary?: string; retrieved_at: string | null; reason?: string; error?: { message: string }; source_url?: string | null; data?: unknown }

export interface AIStatus { provider: string; configured: boolean; model: string | null; setup_hint: string | null; timeout_seconds: number; calls: number; failures: number; last_success_at: string | null; last_error: string | null; last_error_at: string | null }

/** Risk Radar assessment (backend/app/whatif/advisor.py). Severity and figures come from the Radar; AI only writes the text. */
export interface AssessmentItem { action: string; reason: string; finding_ids: string[]; timing?: "immediate" | "next" | "ongoing" }
export interface RiskAssessment {
  mode: "ai" | "rules"; model: string | null; provider: string | null; level: Severity; overall_level: Severity; score: number;
  counts: Record<Severity, number>; scope: { kind: "baseline" | "scenario"; id: number | null; name: string };
  focus: { finding_id: string; title: string; severity: Severity } | null;
  labels: { overview: string; recommended: string; next: string | null; avoid: string; impact: string; monitor: string; verify: string };
  detected: { finding_id: string; severity: Severity; title: string; summary: string; metric: Finding["metric"]; rule_thresholds: string; data_kind: Finding["data_kind"] }[];
  overview: string; priority: string | null; relationships: string | null;
  recommended: AssessmentItem[]; not_recommended: AssessmentItem[]; not_recommended_none: string | null;
  expected_impact: { if_followed: string; if_ignored: string };
  monitor: { indicator: string; why: string; finding_ids: string[] }[];
  scenarios: { title: string; rationale: string; finding_ids: string[]; levers: Levers }[];
  verify: string[]; limitations: string[]; dropped: number; filled_from_rules: string[]; level_corrected: boolean;
  disclaimer: string; notice: string | null; created_at: string; elapsed_ms?: number;
}
