import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { AnimatePresence, motion } from "motion/react";
import { IconPlay, IconTwin } from "../../components/icons";
import { Notice, Spinner, useToast } from "../../components/ui";
import { api } from "../../lib/api";
import type { Business, Plan } from "../../lib/types";
import { AgentSteps, ImportPanel, PlanReview, type Step } from "../shared";
import { useWorkspace } from "../workspace";

const TYPES = ["grocery", "convenience", "bakery", "pharmacy", "boutique", "hardware", "general retail"];
const EXAMPLE = "I operate a neighborhood grocery store. I want to reduce expired inventory and determine whether starting a delivery service would increase profit without exceeding my $15,000 budget.";

const MODES = {
  build: { label: "Build", text: "Prepare a model and a ready-to-run set of parallel worlds now. Best when you want results quickly." },
  plan: { label: "Plan", text: "Review the model's assumptions and a proposed simulation plan first. Nothing is created or run until you approve it." },
} as const;

export default function NewProject() {
  const nav = useNavigate();
  const ws = useWorkspace();
  const toast = useToast();
  const [mode, setMode] = useState<"build" | "plan">("build");
  const [name, setName] = useState("");
  const [type, setType] = useState("grocery");
  const [desc, setDesc] = useState("");
  const [guided, setGuided] = useState(false);
  const [facts, setFacts] = useState({ starting_cash: "", monthly_rent: "", staff_count: "", budget: "", target_monthly_profit: "", min_cash_buffer: "" });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ business: Business; steps: Step[]; missing_information: string[] } | null>(null);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [running, setRunning] = useState(false);

  function validate() {
    const e: Record<string, string> = {};
    if (!name.trim()) e.name = "Give the business a name.";
    if (!guided && desc.trim().length < 20) e.desc = "Describe the business and the decision in a sentence or two.";
    for (const [k, v] of Object.entries(facts)) if (v !== "" && (Number.isNaN(+v) || +v < 0)) e[k] = "Enter a number of zero or more.";
    setErrors(e);
    return !Object.keys(e).length;
  }

  async function submit(ev: FormEvent) {
    ev.preventDefault();
    if (!validate()) return;
    setBusy(true);
    try {
      const guidedFacts = Object.fromEntries(Object.entries(facts).filter(([, v]) => v !== "").map(([k, v]) => [k, +v]));
      const res = await api.post<{ business: Business; steps: Step[]; missing_information: string[] }>("/api/businesses", {
        name: name.trim(), business_type: type, description: desc.trim(), mode, guided: guidedFacts,
      });
      setResult(res);
      await ws.refresh();
      ws.setCurrentId(res.business.id);
      if (mode === "plan") setPlan((await api.get<Business>(`/api/businesses/${res.business.id}`)).plan ?? null);
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "bad");
    } finally {
      setBusy(false);
    }
  }

  async function runAll() {
    if (!result) return;
    setRunning(true);
    try {
      const scenarios = await api.get<{ id: number }[]>(`/api/businesses/${result.business.id}/scenarios`);
      await api.post(`/api/businesses/${result.business.id}/runs/batch`, { scenario_ids: scenarios.map((s) => s.id) });
      await ws.refresh();
      nav("/app/simulations");
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "bad");
      setRunning(false);
    }
  }

  return (
    <div className="mx-auto grid max-w-3xl gap-8 pt-4">
      <AnimatePresence mode="wait">
        {!result ? (
          <motion.form key="compose" onSubmit={submit} noValidate className="grid gap-6" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }}>
            <div className="grid gap-2 text-center">
              <h1 className="t-display text-[clamp(2.2rem,1.6rem+2.4vw,3.4rem)]">What do you want to test?</h1>
              <p className="t-lead mx-auto">Describe your business and the decision on your mind. What-if builds the model; you stay in control of every assumption.</p>
            </div>

            <div className="panel overflow-hidden shadow-[var(--shadow-1)] focus-within:border-[var(--focus)]">
              <div className="grid gap-3 border-b border-line p-4 sm:grid-cols-[1fr_auto]">
                <label className="field"><span>Business name</span>
                  <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Maple Street Grocer" aria-invalid={!!errors.name} />
                  {errors.name && <span className="error-text">{errors.name}</span>}</label>
                <label className="field"><span>Business type</span>
                  <select className="select" value={type} onChange={(e) => setType(e.target.value)}>{TYPES.map((t) => <option key={t} value={t}>{t[0].toUpperCase() + t.slice(1)}</option>)}</select></label>
              </div>
              <label className="sr-only" htmlFor="desc">Describe your business and decision</label>
              <textarea id="desc" className="block min-h-[150px] w-full resize-y border-0 bg-transparent px-4 py-3 text-[1.02rem] outline-none" value={desc} onChange={(e) => setDesc(e.target.value)}
                placeholder={EXAMPLE} aria-invalid={!!errors.desc} />
              {errors.desc && <p className="error-text px-4 pb-2">{errors.desc}</p>}
              <div className="flex flex-wrap items-center gap-3 border-t border-line bg-surface-2 px-4 py-3">
                <div className="seg" role="group" aria-label="Mode">
                  {(Object.keys(MODES) as ("build" | "plan")[]).map((m) => (
                    <button key={m} type="button" aria-pressed={mode === m} onClick={() => setMode(m)}>{MODES[m].label}</button>
                  ))}
                </div>
                <button type="button" className="btn btn-quiet btn-sm" onClick={() => setDesc(EXAMPLE)}>Use example</button>
                <button type="button" className="btn btn-quiet btn-sm" aria-expanded={guided} onClick={() => setGuided((g) => !g)}>{guided ? "Hide guided setup" : "Guided setup"}</button>
                <button className="btn btn-primary ml-auto" disabled={busy}>{busy && <Spinner />}{mode === "build" ? "Create business model" : "Prepare simulation plan"}</button>
              </div>
            </div>
            <p className="-mt-3 text-center text-[0.85rem] text-text-3"><b className="text-text-2">{MODES[mode].label} mode:</b> {MODES[mode].text}</p>

            <AnimatePresence>
              {guided && (
                <motion.fieldset className="panel grid gap-4 p-5" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }}>
                  <legend className="sr-only">Guided setup</legend>
                  <p className="text-[0.9rem] text-text-2">Answer what you know; leave the rest blank. Answers are saved as your own values, and everything else starts as a labelled default you can replace.</p>
                  <div className="grid gap-4 sm:grid-cols-3">
                    {([
                      ["starting_cash", "Cash available today ($)"], ["min_cash_buffer", "Lowest cash you're comfortable with ($)"], ["monthly_rent", "Monthly rent ($)"],
                      ["staff_count", "People on staff"], ["budget", "Budget for a new initiative ($)"], ["target_monthly_profit", "Target monthly operating profit ($)"],
                    ] as const).map(([k, label]) => (
                      <label key={k} className="field"><span>{label}</span>
                        <input className="input input-num" inputMode="decimal" value={facts[k]} onChange={(e) => setFacts({ ...facts, [k]: e.target.value })} aria-invalid={!!errors[k]} />
                        {errors[k] && <span className="error-text">{errors[k]}</span>}</label>
                    ))}
                  </div>
                </motion.fieldset>
              )}
            </AnimatePresence>

            {busy && <AgentSteps steps={[]} working workingLabel={mode === "build" ? "Digital Twin, Data Analyst and Scenario Designer are preparing your model and worlds…" : "Agents are reviewing the business and drafting a simulation plan…"} />}
            <Notice>Starting with retail. Your description is used to set up the model. Only the facts you state are written into it; everything else is a labelled default until you replace it with your data.</Notice>
          </motion.form>
        ) : (
          <motion.div key="done" className="grid gap-6" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}>
            <div className="grid gap-2">
              <h1 className="t-h1">{result.business.name} is set up</h1>
              <p className="t-lead">{mode === "build" ? `Model v1 and ${result.business.scenario_count} parallel worlds are ready. Results will be exploratory until defaults are replaced with your data.` : "Review the plan below. Nothing will run until you approve it."}</p>
            </div>
            <AgentSteps steps={result.steps} />
            {mode === "plan" && plan ? (
              <PlanReview businessId={result.business.id} plan={plan} onApproved={() => { ws.refresh(); nav("/app/worlds"); }} />
            ) : (
              <>
                <div className="flex flex-wrap gap-2">
                  <button className="btn btn-primary" onClick={runAll} disabled={running}>{running ? <Spinner /> : <IconPlay size={16} />}Run all {result.business.scenario_count} worlds now</button>
                  <button className="btn" onClick={() => nav("/app/twin")}><IconTwin size={16} />Review the digital twin first</button>
                </div>
                <section className="panel grid gap-3 p-5">
                  <h2 className="t-h3">Add your own data</h2>
                  <p className="text-[0.9rem] text-text-2">To move from exploratory to calibrated results, the model needs:</p>
                  <ul className="grid gap-1 text-[0.88rem] text-text-2">{result.missing_information.map((m) => <li key={m}>• {m}</li>)}</ul>
                  <ImportPanel businessId={result.business.id} onApplied={() => ws.refresh()} />
                </section>
              </>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
