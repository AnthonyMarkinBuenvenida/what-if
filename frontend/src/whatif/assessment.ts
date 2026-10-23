// Pure helpers for the Risk Radar assessment panel (RiskAssessment.tsx).
import type { AssessmentItem, Levers, Severity } from "./types";

/** A proposed change is tested on top of the assessed scope (the current course or a saved scenario), never instead of it. */
export function mergeProposal(scopeLevers: Levers, change: Levers, horizon: number): Levers {
  const { data_links: _ignored, ...base } = scopeLevers;
  return { horizon_months: base.horizon_months ?? horizon, ...base, ...change, start_month: null };
}

/** High and critical assessments separate immediate steps from later ones; lower levels show one list. */
export function splitByTiming(level: Severity, items: AssessmentItem[]): { now: AssessmentItem[]; later: AssessmentItem[] } {
  if (level !== "high" && level !== "critical") return { now: items, later: [] };
  return { now: items.filter((r) => r.timing === "immediate"), later: items.filter((r) => r.timing !== "immediate") };
}
