import { describe, expect, it } from "vitest";
import { mergeProposal, splitByTiming } from "./assessment";
import type { AssessmentItem } from "./types";

describe("mergeProposal", () => {
  it("keeps the assessed scenario's levers and adds the proposed change", () => {
    const m = mergeProposal({ price_change_pct: -10, horizon_months: 24, start_month: "2027-03" }, { unit_cost_change_pct: -8 }, 12);
    expect(m).toEqual({ price_change_pct: -10, unit_cost_change_pct: -8, horizon_months: 24, start_month: null });
  });
  it("lets the proposal override the same lever and uses the page period for the current course", () => {
    expect(mergeProposal({}, { price_change_pct: 5 }, 12)).toEqual({ price_change_pct: 5, horizon_months: 12, start_month: null });
    expect(mergeProposal({ price_change_pct: -10 }, { price_change_pct: 3 }, 12).price_change_pct).toBe(3);
  });
  it("never carries retrieved-data links into a proposal", () => {
    const m = mergeProposal({ data_links: [{ id: "x" } as never], demand_change_pct: 2 }, {}, 12);
    expect(m.data_links).toBeUndefined();
  });
});

describe("splitByTiming", () => {
  const items: AssessmentItem[] = [
    { action: "a", reason: "", finding_ids: [], timing: "immediate" },
    { action: "b", reason: "", finding_ids: [], timing: "next" },
  ];
  it("separates immediate steps for high and critical", () => {
    expect(splitByTiming("critical", items).now.map((i) => i.action)).toEqual(["a"]);
    expect(splitByTiming("high", items).later.map((i) => i.action)).toEqual(["b"]);
  });
  it("shows one list for low and moderate", () => {
    expect(splitByTiming("moderate", items)).toEqual({ now: items, later: [] });
  });
});
