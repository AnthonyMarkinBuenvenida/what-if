import type { Levers } from "./types";

// Currency-aware formatting for What-if (the business's own currency, never assumed USD).

const cache = new Map<string, Intl.NumberFormat>();
function nf(key: string, make: () => Intl.NumberFormat) {
  let f = cache.get(key);
  if (!f) {
    f = make();
    cache.set(key, f);
  }
  return f;
}

export function money(v: number | null | undefined, cur = "USD", digits = 0) {
  if (v == null || Number.isNaN(v)) return "—";
  try {
    return nf(`m${cur}${digits}`, () => new Intl.NumberFormat(undefined, { style: "currency", currency: cur, maximumFractionDigits: digits, minimumFractionDigits: digits })).format(v);
  } catch {
    return `${v.toFixed(digits)} ${cur}`;
  }
}

export function compact(v: number | null | undefined, cur?: string) {
  if (v == null || Number.isNaN(v)) return "—";
  const f = nf(`c${cur ?? ""}`, () => cur
    ? new Intl.NumberFormat(undefined, { style: "currency", currency: cur, notation: "compact", maximumFractionDigits: 1 })
    : new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }));
  return f.format(v);
}

export const signedMoney = (v: number | null | undefined, cur = "USD") =>
  v == null ? "—" : `${v > 0 ? "+" : v < 0 ? "−" : ""}${money(Math.abs(v), cur)}`;

export const num = (v: number | null | undefined, digits = 0) =>
  v == null || Number.isNaN(v) ? "—" : nf(`n${digits}`, () => new Intl.NumberFormat(undefined, { maximumFractionDigits: digits, minimumFractionDigits: digits })).format(v);

export const pct = (v: number | null | undefined, digits = 1) => (v == null || Number.isNaN(v) ? "—" : `${(v * 100).toFixed(digits)}%`);
export const signedPct = (v: number | null | undefined, digits = 1) =>
  v == null || Number.isNaN(v) ? "—" : `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v * 100).toFixed(digits)}%`;
export const signedPts = (v: number | null | undefined) => (v == null ? "—" : `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v * 100).toFixed(1)} pts`);

export function monthLabel(m: string, long = false) {
  const [y, mm] = m.split("-").map(Number);
  return new Date(y, mm - 1, 1).toLocaleDateString(undefined, long ? { month: "long", year: "numeric" } : { month: "short", year: "2-digit" });
}

export function when(iso: string | null | undefined) {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export function ago(iso: string | null | undefined) {
  if (!iso) return "never";
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
}

/** Value with its unit, for evidence and metric rows coming from the risk engine. */
export function withUnit(v: number | string | null | undefined, unit: string, cur: string) {
  if (v == null) return "—";
  if (typeof v === "string") return v;
  if (unit === cur) return money(v, cur, Math.abs(v) < 100 ? 2 : 0);
  if (unit === "%" || unit === "% per month" || unit === "% per year") return `${pct(v)}${unit.length > 1 ? unit.slice(1) : ""}`;
  if (unit === "×") return `${v.toFixed(2)}×`;
  if (unit === "months") return `${num(v, 1)} months`;
  if (!unit) return num(v, Math.abs(v) < 10 ? 2 : 0);
  return `${num(v, Math.abs(v) < 10 ? 1 : 0)} ${unit}`;
}

export const LEVER_LABELS: Record<string, string> = {
  price_change_pct: "Selling price", unit_cost_change_pct: "Variable cost per unit", demand_change_pct: "Customer demand",
  marketing_change_pct: "Marketing budget", marketing_budget: "Marketing budget (new)", wage_change_pct: "Wages", rent_change_pct: "Rent",
  fixed_cost_change_pct: "Other fixed costs", capacity_change_pct: "Capacity", one_time_investment: "One-time investment",
  tax_rate_pct: "Tax rate", churn_change_pts: "Monthly churn", new_customers_change_pct: "New sign-ups", elasticity_override: "Price elasticity",
  horizon_months: "Period", staff_changes: "Staff", new_branch: "New location", new_product: "New product", seasonal: "Seasonal demand",
};

/** One-line description of each active lever, for lists of "recognised changes". */
export function describeLevers(l: Levers, cur: string, productNames: Record<string, string> = {}): string[] {
  const out: string[] = [];
  const p = (k: keyof Levers, label: string, unit = "%") => {
    const v = l[k] as number | undefined;
    if (v) out.push(`${label} ${v > 0 ? "+" : "−"}${Math.abs(v)}${unit}`);
  };
  p("price_change_pct", "Selling price" + (l.price_product_ids?.length ? ` (${l.price_product_ids.map((i) => productNames[i] ?? i).join(", ")})` : ""));
  p("unit_cost_change_pct", "Variable cost per unit");
  p("demand_change_pct", "Customer demand");
  p("marketing_change_pct", "Marketing budget");
  if (l.marketing_budget != null) out.push(`Marketing budget set to ${money(l.marketing_budget, cur)}/month`);
  p("wage_change_pct", "Wages");
  p("rent_change_pct", "Rent");
  p("fixed_cost_change_pct", "Other fixed costs");
  p("capacity_change_pct", "Capacity");
  p("churn_change_pts", "Monthly churn", " pts");
  p("new_customers_change_pct", "New sign-ups");
  for (const s of l.staff_changes ?? []) out.push(`${s.count > 0 ? "Add" : "Remove"} ${Math.abs(s.count)} ${s.role}${s.monthly_wage ? ` at ${money(s.monthly_wage, cur)}/month` : ""}`);
  for (const s of l.seasonal ?? []) out.push(`${s.label}: demand ${s.demand_change_pct > 0 ? "+" : "−"}${Math.abs(s.demand_change_pct)}%`);
  if (l.new_branch) out.push(`New location: set-up ${money(l.new_branch.setup_cost, cur)}, ${money(l.new_branch.monthly_fixed_cost, cur)}/month`);
  if (l.new_product) out.push(`New product “${l.new_product.name}” at ${money(l.new_product.price, cur, 2)}`);
  if (l.one_time_investment) out.push(`One-time investment ${money(l.one_time_investment, cur)} in month ${l.investment_month ?? 1}`);
  if (l.tax_rate_pct != null) out.push(`Tax rate ${l.tax_rate_pct}%`);
  if (l.elasticity_override != null) out.push(`Price elasticity set to ${l.elasticity_override}`);
  for (const c of l.extra_monthly_costs ?? []) out.push(`${c.label}: ${money(c.amount, cur)}/month`);
  if (l.data_links?.length) out.push(`${l.data_links.length} external data point${l.data_links.length > 1 ? "s" : ""} applied`);
  return out;
}

