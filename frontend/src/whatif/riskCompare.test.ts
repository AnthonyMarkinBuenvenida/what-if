import { describe, expect, it } from "vitest";
import { ruleDiff } from "./RiskCompare";
import type { Finding, Severity } from "./types";

const f = (rule: string, severity: Severity, key = rule): Finding => ({
  id: `${rule}:${key}`, rule, category: "c", category_label: "Cat", severity, title: rule, summary: "",
  metric: { key, label: key, value: 0, threshold: 0, unit: "" }, evidence: [], triggered_by: [], impact: null, actions: [],
  if_no_action: "", threshold: "", why: "", data_kind: "calculated", scope: "x",
});

describe("ruleDiff", () => {
  it("classifies each rule as appears, cleared, worse, better or unchanged", () => {
    const d = Object.fromEntries(ruleDiff(
      [f("net_margin", "moderate"), f("goal", "moderate"), f("concentration", "moderate"), f("capacity", "high")],
      [f("net_margin", "critical"), f("cash_shortfall", "critical"), f("concentration", "moderate"), f("capacity", "moderate")],
    ).map((r) => [r.rule.split(":")[0], r.change]));
    expect(d).toEqual({ net_margin: "worse", goal: "cleared", concentration: "same", capacity: "better", cash_shortfall: "new" });
  });
  it("does not call a history-based warning cleared: scenarios do not re-check entered results", () => {
    const d = ruleDiff([f("opex_vs_revenue", "moderate", "cost_trend")], []);
    expect(d[0].change).toBe("history");
  });
  it("keeps different measurements of one rule apart", () => {
    const d = ruleDiff([f("opex_vs_revenue", "moderate", "cost_trend")], [f("opex_vs_revenue", "high", "operating_expenses")]);
    expect(d.map((r) => r.change).sort()).toEqual(["history", "new"]);
  });
  it("uses the most severe finding when a rule fires more than once", () => {
    const d = ruleDiff([f("unit_economics", "moderate")], [f("unit_economics", "moderate"), f("unit_economics", "critical")]);
    expect(d[0].change).toBe("worse");
  });
});
