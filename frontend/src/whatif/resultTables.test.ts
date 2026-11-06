import { describe, expect, it } from "vitest";
import { asAvoid, changeRows, fallbackFindings } from "./resultTables";
import type { SimResult } from "./types";

const totals = (rev: number, np: number) => ({ revenue: rev, variable_costs: rev * 0.4, operating_expenses: rev * 0.3, tax: 10, gross_profit: rev * 0.6, net_profit: np, units: 100 });
const sim = (over: Partial<SimResult> = {}): SimResult => ({
  currency: "PHP", unit_label: "orders", is_baseline: false, levers: { price_change_pct: -10, rent_change_pct: 5, one_time_investment: 5000 },
  baseline: { totals: totals(1000, 200), metrics: { net_margin: 0.2, break_even_units: 50 }, monthly_avg: { units: 100 } },
  scenario: { totals: totals(1100, 150), metrics: { net_margin: 150 / 1100, break_even_units: 80 }, monthly_avg: { units: 100 } },
  bridge: [
    { key: "price", label: "Selling price", value: -120, note: "Price change × units sold" },
    { key: "volume", label: "Sales volume", value: 90, note: "Change in units sold × the old margin per unit" },
    { key: "fixed", label: "Rent & fixed costs", value: -30, note: "" },
    { key: "tax", label: "Tax", value: 10, note: "" },
  ],
  ...over,
} as unknown as SimResult);

describe("changeRows", () => {
  it("lists only engine bridge effects, with the scenario changes that drive each", () => {
    const rows = changeRows(sim());
    expect(rows.map((r) => r.key)).toEqual(["price", "volume", "fixed", "tax", "one_time"]);
    expect(rows[0]).toMatchObject({ modification: ["Selling price −10%"], effect: -120 });
    expect(rows[1].modification).toEqual(["Price response to −10%"]);
    expect(rows[2]).toMatchObject({ modification: ["Rent +5%"], effect: -30 });
    expect(rows[2].explanation).toMatch(/rise, so net profit falls/);
    expect(rows[3].modification).toEqual(["Follows the change in profit"]);
    // A one-time investment changes cash, not profit: no invented profit effect.
    expect(rows[4]).toMatchObject({ effect: null, explanation: "Affects cash, not profit." });
  });
  it("sum of effects equals the change in net profit", () => {
    const r = sim();
    const total = changeRows(r).reduce((a, x) => a + (x.effect ?? 0), 0);
    expect(total).toBeCloseTo(r.scenario.totals.net_profit - r.baseline.totals.net_profit);
  });
});

describe("fallbackFindings", () => {
  it("uses the result's figures and leaves the explanation empty (shown as N/A)", () => {
    const rows = fallbackFindings(sim());
    expect(rows.map((r) => [r.key, r.impact])).toEqual([["revenue", "positive"], ["costs", "negative"], ["profitability", "negative"], ["break_even", "stable"]]);
    expect(rows.every((r) => r.explanation === "")).toBe(true);
    expect(rows[2]).toMatchObject({ current: 200, simulated: 150 });
  });
  it("marks break-even at risk when sales are within 10% of it or there is none", () => {
    const close = sim({ scenario: { totals: totals(1100, 150), metrics: { net_margin: 0.1, break_even_units: 95 }, monthly_avg: { units: 98 } } } as never);
    expect(fallbackFindings(close)[3].impact).toBe("at_risk");
    const none = sim({ scenario: { totals: totals(1100, -50), metrics: { net_margin: -0.05, break_even_units: null }, monthly_avg: { units: 98 } } } as never);
    expect(fallbackFindings(none)[3]).toMatchObject({ impact: "at_risk", simulated: null });
  });
});

describe("asAvoid", () => {
  it("keeps structured items and turns legacy sentences into rows with no reason", () => {
    expect(asAvoid(["Cut prices further.", { action: "Hire now", reason: "Margin is thin", consequence: "Losses grow" }])).toEqual([
      { action: "Cut prices further.", reason: "", consequence: null },
      { action: "Hire now", reason: "Margin is thin", consequence: "Losses grow" },
    ]);
    expect(asAvoid(undefined)).toEqual([]);
  });
});
