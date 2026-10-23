/* Plain-English explanations built only from calculated results.
   Every number in these sentences comes from the comparison the engine returned
   for the visitor's current inputs. */
import { compactMoney, money, pct } from "../lib/format";
import type { Comparison, CompareRow, Explanation } from "../lib/types";

export type MetricKey = "avg_monthly_operating_profit" | "revenue" | "min_cash" | "ending_cash" | "waste_rate" | "waste_cost" | "fill_rate";

export const METRIC: Record<MetricKey, { label: string; get: (r: CompareRow) => number; fmt: (v: number) => string; better: "up" | "down"; hint: string }> = {
  avg_monthly_operating_profit: { label: "Profit per month", get: (r) => r.avg_monthly_operating_profit.p50, fmt: money, better: "up", hint: "Operating profit after goods, waste, wages and running costs (median run)." },
  revenue: { label: "Revenue (90 days)", get: (r) => r.revenue.mean, fmt: compactMoney, better: "up", hint: "Sales plus any delivery fees over the 90 simulated days." },
  min_cash: { label: "Lowest cash", get: (r) => r.min_cash.p10, fmt: money, better: "up", hint: "The lowest bank balance in a bad run (10th percentile)." },
  ending_cash: { label: "Cash remaining", get: (r) => r.ending_cash.p50, fmt: money, better: "up", hint: "Bank balance at the end of the 90 days (median run)." },
  waste_rate: { label: "Stock wasted", get: (r) => r.waste_rate.mean, fmt: (v) => pct(v, 1), better: "down", hint: "Share of units that expired before they were sold." },
  waste_cost: { label: "Waste cost (90 days)", get: (r) => r.waste_cost.mean, fmt: compactMoney, better: "down", hint: "Purchase cost of expired stock written off." },
  fill_rate: { label: "Demand served", get: (r) => r.fill_rate.mean, fmt: (v) => pct(v, 1), better: "up", hint: "Share of customer demand the store could actually serve." },
};

const short = (n: string) => n.replace(" World", "");

export function mainRisk(r: CompareRow): string {
  if (r.violations.length) return `Breaks a limit: ${r.violations[0].charAt(0).toLowerCase()}${r.violations[0].slice(1)}${r.violations.length > 1 ? ` (+${r.violations.length - 1} more)` : ""}.`;
  if (r.cash_below_buffer >= 0.01) return `Cash falls below the safety buffer in ${pct(r.cash_below_buffer)} of runs.`;
  if (r.fill_rate.mean < 0.95) return `Turns away ${pct(1 - r.fill_rate.mean)} of customer demand.`;
  if (r.waste_rate.mean > 0.04) return `${pct(r.waste_rate.mean, 1)} of stock expires on the shelf.`;
  return "No limit broken in these runs.";
}

/** Why a world differs from the baseline, from the engine's line-item breakdown. */
export function explainWorld(r: CompareRow, base: CompareRow, ex: Explanation | undefined): string {
  if (!ex || ex.error) return `${short(r.scenario_name)} could not be compared line by line with the baseline.`;
  const change = ex.monthly_operating_profit_change;
  // Revenue lines read "more/less X"; cost lines read "lower/higher X".
  const REVENUE = new Set(["sales_revenue", "delivery_revenue"]);
  const phrase = (d: { key: string; label: string; monthly_effect: number }) => {
    const label = d.label.toLowerCase();
    const word = REVENUE.has(d.key) ? (d.monthly_effect > 0 ? "more" : "less") : (d.monthly_effect > 0 ? "lower" : "higher");
    return `${word} ${label} (${d.monthly_effect > 0 ? "+" : "−"}${money(Math.abs(d.monthly_effect))}/mo)`;
  };
  // Leave out line items too small to matter (under $25/mo or 5% of the change).
  const floor = Math.max(25, Math.abs(change) * 0.05);
  const helps = ex.drivers.filter((d) => d.monthly_effect >= floor).slice(0, 2);
  const hurts = ex.drivers.filter((d) => d.monthly_effect <= -floor).slice(0, 2);
  const headline = `${short(r.scenario_name)} ${Math.abs(change) < 50 ? "earns about the same as" : change > 0 ? `earns ${money(change)} a month more than` : `earns ${money(-change)} a month less than`} the baseline`;
  const main = change >= 0 ? helps : hurts;
  const offset = change >= 0 ? hurts : helps;
  const parts: string[] = [headline + (main.length ? `: ${main.map(phrase).join(" and ")}` : "")];
  if (offset.length) parts.push(`partly offset by ${offset.map(phrase).join(" and ")}`);
  let s = parts.join(", ") + ".";
  const cashDiff = r.min_cash.p10 - base.min_cash.p10;
  if (Math.abs(cashDiff) >= 500) s += ` Its lowest cash in a bad run is ${money(Math.abs(cashDiff))} ${cashDiff < 0 ? "lower" : "higher"} (${money(r.min_cash.p10)}).`;
  const wasteDiff = r.waste_rate.mean - base.waste_rate.mean;
  if (Math.abs(wasteDiff) >= 0.005) s += ` Waste ${wasteDiff < 0 ? "falls" : "rises"} from ${pct(base.waste_rate.mean, 1)} to ${pct(r.waste_rate.mean, 1)} of units.`;
  const fillDiff = r.fill_rate.mean - base.fill_rate.mean;
  if (fillDiff <= -0.01) s += ` It serves less of the demand (${pct(r.fill_rate.mean)} vs ${pct(base.fill_rate.mean)}).`;
  if (r.one_time_costs.mean - base.one_time_costs.mean >= 1) s += ` It needs ${money(r.one_time_costs.mean - base.one_time_costs.mean)} up front.`;
  return s;
}

/** The best option for the selected goal, among worlds that break no limit. */
export function bestForGoal(cmp: Comparison, metrics: MetricKey[]): { row: CompareRow; reason: string } | null {
  const key = metrics[0];
  const m = METRIC[key];
  const ok = cmp.rows.filter((r) => !r.violations.length);
  const pool = ok.length ? ok : cmp.rows;
  const best = [...pool].sort((a, b) => (m.better === "up" ? m.get(b) - m.get(a) : m.get(a) - m.get(b)))[0];
  if (!best) return null;
  return {
    row: best,
    reason: ok.length
      ? `${short(best.scenario_name)} has the best ${m.label.toLowerCase()} (${m.fmt(m.get(best))}) among the options that stay within every limit.`
      : `No option stays within every limit. ${short(best.scenario_name)} has the best ${m.label.toLowerCase()} (${m.fmt(m.get(best))}) but still breaks a limit.`,
  };
}
