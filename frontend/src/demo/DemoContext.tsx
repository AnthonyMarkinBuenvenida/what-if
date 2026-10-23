import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Outlet } from "react-router-dom";
import { ApiError } from "../lib/api";
import { isActive } from "../lib/format";
import type { AgentEnvelope, Analysis, Comparison } from "../lib/types";
import { BrowserClient, ServerClient, type Assumptions, type DemoClient, type DemoGoal, type DemoRun, type DemoSession, type SensitivityPayload, type StressPayload } from "./client";

export const DEFAULT_ASSUMPTIONS: Assumptions = { demand_change_pct: 0, supplier_cost_change_pct: 0, budget: 15000 };

interface DemoState {
  client: DemoClient | null; session: DemoSession | null; boot: "starting" | "ready" | "error"; bootError: string | null;
  goal: DemoGoal | null; setGoal: (id: string) => void;
  assumptions: Assumptions; setAssumption: (k: keyof Assumptions, v: number) => void; resetAssumptions: () => void;
  mode: "monte_carlo" | "deterministic"; setMode: (m: "monte_carlo" | "deterministic") => void;
  runs: DemoRun[]; running: boolean; outdated: boolean; runError: string | null; run: () => Promise<void>;
  comparison: Comparison | null; analysis: AgentEnvelope<Analysis> | null; comparedGoal: DemoGoal | null; comparedAssumptions: Assumptions | null;
  stress: StressPayload | null; stressing: boolean; stressError: string | null; runStress: (scenarioId: string, shocks: string[]) => Promise<void>;
  sensitivity: SensitivityPayload | null; sensing: boolean; runSensitivity: (scenarioId: string) => Promise<void>;
  reset: () => Promise<void>;
}

const Ctx = createContext<DemoState | null>(null);
export const useDemo = () => {
  const v = useContext(Ctx);
  if (!v) throw new Error("useDemo outside DemoProvider");
  return v;
};

/** Shared by the demo page and Presentation Mode, so both show the same session. */
export function DemoProvider({ children }: { children?: ReactNode }) {
  const [client, setClient] = useState<DemoClient | null>(null);
  const [session, setSession] = useState<DemoSession | null>(null);
  const [boot, setBoot] = useState<DemoState["boot"]>("starting");
  const [bootError, setBootError] = useState<string | null>(null);
  const [goalId, setGoalId] = useState("profit");
  const [assumptions, setAssumptions] = useState<Assumptions>(DEFAULT_ASSUMPTIONS);
  const [mode, setMode] = useState<"monte_carlo" | "deterministic">("monte_carlo");
  const [runs, setRuns] = useState<DemoRun[]>([]);
  const [ranKey, setRanKey] = useState<string | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [comparison, setComparison] = useState<Comparison | null>(null);
  const [analysis, setAnalysis] = useState<AgentEnvelope<Analysis> | null>(null);
  const [compared, setCompared] = useState<{ goal: DemoGoal; assumptions: Assumptions } | null>(null);
  const [stress, setStress] = useState<StressPayload | null>(null);
  const [stressing, setStressing] = useState(false);
  const [stressError, setStressError] = useState<string | null>(null);
  const [sensitivity, setSensitivity] = useState<SensitivityPayload | null>(null);
  const [sensing, setSensing] = useState(false);
  const pending = useRef<{ goal: DemoGoal; assumptions: Assumptions } | null>(null);

  const start = useCallback(async () => {
    setBoot("starting");
    setBootError(null);
    let c: DemoClient = new ServerClient();
    let s: DemoSession;
    try {
      s = await c.start();
    } catch (e) {
      // Server unreachable: use the labelled in-browser engine. Other errors are shown.
      if (e instanceof ApiError && e.status !== 0 && e.status < 500) {
        setBoot("error");
        setBootError(e.message);
        return;
      }
      c = new BrowserClient();
      s = await c.start();
    }
    setClient(c);
    setSession(s);
    setBoot("ready");
  }, []);

  useEffect(() => { start(); }, [start]);

  const goal = useMemo(() => session?.goals.find((g) => g.id === goalId) ?? session?.goals[0] ?? null, [session, goalId]);
  const settingsKey = JSON.stringify({ goalId, assumptions, mode });
  const running = runs.some((r) => isActive(r.status));
  const outdated = runs.length > 0 && ranKey !== settingsKey;

  const finish = useCallback(async (done: DemoRun[]) => {
    if (!client) return;
    const ok = done.filter((r) => r.status.startsWith("completed"));
    if (!ok.length) {
      setRunError("No simulation completed. Reset the demo and try again.");
      return;
    }
    try {
      const res = await client.compare(ok.map((r) => r.id));
      setComparison(res.comparison);
      setAnalysis(res.analysis);
      setCompared(pending.current);
    } catch (e) {
      setRunError(e instanceof Error ? e.message : String(e));
    }
  }, [client]);

  // Poll only while the engine reports active runs, then compare once they finish.
  useEffect(() => {
    if (!client || !running) return;
    let stop = false;
    const tick = async () => {
      try {
        const updated = await client.poll(runs.map((r) => r.id));
        if (stop) return;
        setRuns(updated);
        if (!updated.some((r) => isActive(r.status))) await finish(updated);
      } catch (e) {
        if (!stop) setRunError(e instanceof Error ? e.message : String(e));
      }
    };
    const t = setInterval(tick, client.kind === "browser" ? 60 : 180);
    return () => { stop = true; clearInterval(t); };
  }, [client, running, runs, finish]);

  const run = useCallback(async () => {
    if (!client || running || !goal) return;
    setRunError(null);
    setStress(null);
    setSensitivity(null);
    pending.current = { goal, assumptions };
    try {
      const created = await client.run(goal.scenario_ids, assumptions, mode, 300);
      setRuns(created);
      setRanKey(settingsKey);
    } catch (e) {
      setRunError(e instanceof Error ? e.message : String(e));
    }
  }, [client, running, goal, assumptions, mode, settingsKey]);

  const runStress = useCallback(async (scenarioId: string, shocks: string[]) => {
    if (!client) return;
    setStressing(true);
    setStressError(null);
    try { setStress(await client.stress(scenarioId, shocks, assumptions)); }
    catch (e) { setStressError(e instanceof Error ? e.message : String(e)); }
    finally { setStressing(false); }
  }, [client, assumptions]);

  const runSensitivity = useCallback(async (scenarioId: string) => {
    if (!client) return;
    setSensing(true);
    try { setSensitivity(await client.sensitivity(scenarioId, assumptions)); }
    catch (e) { setStressError(e instanceof Error ? e.message : String(e)); }
    finally { setSensing(false); }
  }, [client, assumptions]);

  const reset = useCallback(async () => {
    setGoalId("profit");
    setAssumptions(DEFAULT_ASSUMPTIONS);
    setMode("monte_carlo");
    setRuns([]);
    setRanKey(null);
    setComparison(null);
    setAnalysis(null);
    setCompared(null);
    setStress(null);
    setSensitivity(null);
    setRunError(null);
    setStressError(null);
    await start();
  }, [start]);

  const value: DemoState = {
    client, session, boot, bootError, goal, setGoal: setGoalId,
    assumptions, setAssumption: (k, v) => setAssumptions((a) => ({ ...a, [k]: v })), resetAssumptions: () => setAssumptions(DEFAULT_ASSUMPTIONS),
    mode, setMode, runs, running, outdated, runError, run, comparison, analysis,
    comparedGoal: compared?.goal ?? null, comparedAssumptions: compared?.assumptions ?? null,
    stress, stressing, stressError, runStress, sensitivity, sensing, runSensitivity, reset,
  };
  return <Ctx.Provider value={value}>{children ?? <Outlet />}</Ctx.Provider>;
}
