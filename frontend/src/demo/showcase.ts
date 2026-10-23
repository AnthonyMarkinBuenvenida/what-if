import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import { SAMPLE, combineLevers, simulateDeterministic } from "./fallbackEngine";

export interface ShowWorld {
  kind: string; name: string; color_index: number; monthly_operating_profit: number; revenue: number; min_cash: number;
  ending_cash: number; fill_rate: number; waste_rate: number; cash_series: number[]; outcome: string; violations: string[];
}
export interface Showcase { worlds: ShowWorld[]; source: "server" | "browser" | "pending"; store: string; horizon_days: number }

export function browserShowcase(demand = 0, supplier = 0): Showcase {
  const extra = { demand_change_pct: demand, supplier_cost_change_pct: supplier };
  return {
    source: "browser", store: "Maple Street Grocer", horizon_days: 90,
    worlds: SAMPLE.scenarios.map((s) => {
      const r = simulateDeterministic(SAMPLE.spec, combineLevers(s.levers, extra), 90);
      return {
        kind: s.kind, name: s.name, color_index: s.color_index, monthly_operating_profit: r.summary.avg_monthly_operating_profit,
        revenue: r.summary.revenue, min_cash: r.summary.min_cash, ending_cash: r.summary.ending_cash, fill_rate: r.summary.fill_rate,
        waste_rate: r.summary.waste_rate, cash_series: r.weeklyCash, outcome: r.outcome, violations: r.constraints.filter((c) => c.violated).map((c) => c.label),
      };
    }),
  };
}

/** Live engine output for the landing page; falls back to the labelled in-browser engine. */
export function useShowcase(demand: number, supplier: number) {
  // First paint uses the in-browser engine so the page is never empty; it is
  // labelled "pending" until the server answers or is known to be unreachable.
  const [data, setData] = useState<Showcase>(() => ({ ...browserShowcase(demand, supplier), source: "pending" }));
  const [loading, setLoading] = useState(false);
  const seq = useRef(0);
  useEffect(() => {
    const id = ++seq.current;
    setLoading(true);
    const t = setTimeout(async () => {
      try {
        const res = await api.get<Omit<Showcase, "source">>(`/api/public/showcase?demand=${demand}&supplier=${supplier}`);
        if (id === seq.current) setData({ ...res, source: "server" });
      } catch {
        if (id === seq.current) setData(browserShowcase(demand, supplier));
      } finally {
        if (id === seq.current) setLoading(false);
      }
    }, 160);
    return () => clearTimeout(t);
  }, [demand, supplier]);
  return { data, loading };
}
