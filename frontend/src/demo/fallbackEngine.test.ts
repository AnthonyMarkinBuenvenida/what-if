import { describe, expect, it } from "vitest";
import { SAMPLE, combineLevers, criteriaFor, simulateDeterministic } from "./fallbackEngine";

describe("fallback engine matches the Python engine (deterministic mode)", () => {
  for (const c of SAMPLE.parity_cases) {
    it(`${c.scenario} ${JSON.stringify(c.extra)} budget=${c.budget}`, () => {
      const sc = SAMPLE.scenarios.find((s) => s.id === c.scenario)!;
      const levers = Object.keys(c.extra).length ? combineLevers(sc.levers, c.extra) : sc.levers;
      const res = simulateDeterministic(SAMPLE.spec, levers, 90, criteriaFor(c.budget));
      for (const [k, v] of Object.entries(c.expected)) {
        expect(res.summary[k], k).toBeCloseTo(v, 4);
      }
      expect(res.outcome).toBe(c.outcome);
      expect(res.constraints.filter((x) => x.violated).map((x) => x.key).sort()).toEqual([...c.violations].sort());
    });
  }
});
