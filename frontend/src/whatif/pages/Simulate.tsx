import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { AnimatePresence, motion } from "motion/react";
import { api } from "../../lib/api";
import { useReduced } from "../../lib/hooks";
import { useWorkspace } from "../../app/workspace";
import { useBackdropState } from "../../app/AppShell";
import { ErrorBox, Spinner, useToast } from "../../components/ui";
import { IconPlay, IconPlus, IconRetry, IconTrash, IconCheck } from "../../components/icons";
import { BridgeChart, ProjectionChart } from "../charts";
import { compact, describeLevers, money, monthLabel, num, pct, signedMoney, signedPct, signedPts } from "../format";
import type { Explanation, Interpretation, Levers, ProfileSpec, RiskReport, ScenarioFull, SimResult } from "../types";
import { DataLinks, ExternalData } from "../ExternalData";
import { ConfidenceMeter, Delta, KindTag, Kpi, NeedsProfile, PageTitle, Section, SeverityBadge, SourceBadge, Spark, useProfile } from "../ui";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const clean = (l: Levers): Levers => JSON.parse(JSON.stringify(l, (_k, v) => (v === undefined ? undefined : v)));
const key = (l: Levers) => JSON.stringify(clean(l));

interface SimResponse { result: SimResult; risks: { scenario: RiskReport; baseline: RiskReport }; explanation: Explanation; calc_ms: number; profile_version: number }

export default function Simulate() {
  const { current } = useWorkspace();
  const prof = useProfile(current?.id);
  if (!current || !prof.profile) return <div className="grid gap-6"><PageTitle title="Simulate a decision" /><NeedsProfile state={prof} /></div>;
  return <Workspace key={current.id} businessId={current.id} spec={prof.profile.spec} version={prof.profile.version} suggestions={prof.industry?.suggestions ?? []} elasticityNote={prof.industry?.elasticity_note} />;
}

function Workspace({ businessId, spec, version, suggestions, elasticityNote }: { businessId: number; spec: ProfileSpec; version: number; suggestions: string[]; elasticityNote?: string }) {
  const cur = spec.business.currency;
  const [params, setParams] = useSearchParams();
  const toast = useToast();
  const setBackdrop = useBackdropState();
  const reduced = useReduced();
  const [levers, setLevers] = useState<Levers>({ horizon_months: 12 });
  const [question, setQuestion] = useState("");
  const [interp, setInterp] = useState<Interpretation | null>(null);
  const [reading, setReading] = useState(false);
  const [running, setRunning] = useState(false);
  const [explaining, setExplaining] = useState(false);
  const [res, setRes] = useState<SimResponse | null>(null);
  const [expl, setExpl] = useState<Explanation | null>(null);
  const [ranKey, setRanKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [askAI, setAskAI] = useState(true);
  const [aiConfigured, setAiConfigured] = useState<boolean | null>(null);
  const [saveOpen, setSaveOpen] = useState(false);
  const [savedId, setSavedId] = useState<number | null>(null);
  const names = useMemo(() => Object.fromEntries(spec.products.map((p) => [p.id, p.name])), [spec]);
  const stale = res != null && ranKey !== key(levers);

  useEffect(() => { api.get<{ ai: { configured: boolean } }>("/api/whatif/status").then((s) => setAiConfigured(s.ai.configured)).catch(() => setAiConfigured(false)); }, []);
  useEffect(() => { setBackdrop({ levers: res ? res.result.levers : null }); }, [res, setBackdrop]);

  // Deep links: ?scenario=ID, ?levers=<json>, ?q=question
  useEffect(() => {
    const sid = params.get("scenario"), lv = params.get("levers"), q = params.get("q");
    if (sid) {
      api.get<ScenarioFull>(`/api/whatif/scenarios/${sid}`).then((s) => {
        const l = { ...s.levers, start_month: null };
        setLevers(l);
        setQuestion(s.question);
        setInterp(s.interpretation);
        setRes({ result: s.result, risks: s.risks, explanation: s.explanation!, calc_ms: 0, profile_version: version });
        setExpl(s.explanation);
        setRanKey(key(l));
        setSavedId(s.id);
      }).catch((e) => setError(e.message));
    } else if (lv) {
      try { setLevers({ horizon_months: 12, ...JSON.parse(lv) }); } catch { /* ignore bad link */ }
    }
    if (q && !sid) setQuestion(q);
    if (sid || lv || q) setParams({}, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const read = async (q = question) => {
    if (q.trim().length < 3) return;
    setReading(true);
    setError(null);
    try {
      const r = await api.post<Interpretation>(`/api/whatif/businesses/${businessId}/interpret`, { question: q });
      setInterp(r);
      setLevers({ horizon_months: levers.horizon_months ?? 12, ...r.levers });
      setSavedId(null);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setReading(false); }
  };

  const run = async () => {
    setRunning(true);
    setError(null);
    setExpl(null);
    setSavedId(null);
    const lv = clean(levers);
    setBackdrop({ active: true, levers: lv });
    try {
      const r = await api.post<SimResponse>(`/api/whatif/businesses/${businessId}/simulate`, { levers: lv });
      setRes(r);
      setRanKey(key(levers));
      setExpl(r.explanation);
      setRunning(false);
      setBackdrop({ active: false });
      if (askAI && aiConfigured) {
        setExplaining(true);
        try { setExpl(await api.post<Explanation>(`/api/whatif/businesses/${businessId}/explain`, { levers: lv })); }
        catch (e) { setExpl({ ...r.explanation, notice: `The AI explanation failed (${e instanceof Error ? e.message : e}). This explanation was written from the calculation.` }); }
        finally { setExplaining(false); }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setRunning(false);
      setBackdrop({ active: false });
    }
  };

  const reset = () => {
    setLevers({ horizon_months: levers.horizon_months ?? 12 });
    setInterp(null);
    setQuestion("");
    setSavedId(null);
  };

  const steps: { label: string; state: "done" | "active" | "idle" | "skip" }[] = [
    { label: "Read the question", state: reading ? "active" : interp ? "done" : "skip" },
    { label: "Calculate projections and risks", state: running ? "active" : res && !stale ? "done" : "idle" },
    { label: aiConfigured ? "AI explanation" : "Explanation from the calculation", state: explaining ? "active" : expl && !stale && !running ? "done" : "idle" },
  ];

  return (
    <div className="grid gap-6">
      <PageTitle title="Simulate a decision"
        sub={<>Describe a decision or change the controls, then run it against <b className="text-text">{spec.business.name}</b> (profile v{version}). Results are calculated; nothing is a guarantee.</>}
        actions={<Link to="/app/setup" className="btn btn-outline btn-sm">Edit business figures</Link>} />

      <Ask question={question} setQuestion={setQuestion} onRead={read} reading={reading} suggestions={suggestions} interp={interp} cur={cur} />
      {error && <ErrorBox message={error} />}

      <div className="grid items-start gap-6 xl:grid-cols-[380px_minmax(0,1fr)]">
        <div className="grid gap-4 xl:sticky xl:top-20">
          <Controls spec={spec} levers={levers} setLevers={(l) => { setLevers(l); setSavedId(null); }} names={names} elasticityNote={elasticityNote}
            external={<ExternalData businessId={businessId} spec={spec} levers={levers} setLevers={(l) => { setLevers(l); setSavedId(null); }} />} />
          <div className="panel glass grid gap-3 p-4">
            <label className="flex items-center gap-2 text-[0.85rem]">
              <input type="checkbox" checked={askAI && !!aiConfigured} disabled={!aiConfigured} onChange={(e) => setAskAI(e.target.checked)} />
              Ask AI to explain the result
              {aiConfigured === false && <Link to="/app/settings#ai" className="text-text-3 underline">AI not connected</Link>}
            </label>
            <div className="flex flex-wrap gap-2">
              <button className="btn btn-signal flex-1" onClick={run} disabled={running}>{running ? <Spinner /> : <IconPlay size={15} />}{res && stale ? "Run again" : "Run simulation"}</button>
              <button className="btn btn-outline" onClick={reset} title="Remove every change and go back to the current course"><IconRetry size={15} />Reset</button>
            </div>
            <Steps steps={steps} />
          </div>
        </div>

        <div className="grid gap-6">
          {!res && !running && <EmptyResults />}
          {running && !res && <div className="panel grid min-h-[320px] place-items-center"><span className="think-text text-[1.1rem]">Calculating {levers.horizon_months ?? 12} months…</span></div>}
          {res && (
            <div className={`grid gap-6 ${stale || running ? "stale" : ""}`}>
              {stale && !running && (
                <div className="panel flex flex-wrap items-center justify-between gap-3 border-dashed p-3 text-[0.88rem]" role="status" style={{ opacity: 1 }}>
                  <span>Inputs changed since this result was calculated. It shows the previous run.</span>
                  <button className="btn btn-sm btn-signal" onClick={run}>Run again</button>
                </div>
              )}
              <Results res={res} expl={expl} explaining={explaining} spec={spec} onTry={(lv) => setLevers({ horizon_months: levers.horizon_months ?? 12, ...lv })} onAsk={(q) => { setQuestion(q); read(q); }} />
              <div className="flex flex-wrap items-center gap-2">
                {savedId ? (
                  <><span className="chip chip-good"><IconCheck size={13} />Saved</span><Link className="btn btn-sm btn-outline" to="/app/compare">Compare scenarios</Link><Link className="btn btn-sm btn-outline" to="/app/risk">Open Risk Radar</Link></>
                ) : (
                  <button className="btn btn-primary" disabled={stale || running} onClick={() => setSaveOpen(true)}><IconPlus size={15} />Save scenario</button>
                )}
              </div>
              <AnimatePresence>{saveOpen && (
                <SaveForm initial={interp?.name || describeLevers(res.result.levers, cur, names).slice(0, 2).join(", ") || "Current course"} reduced={reduced}
                  onCancel={() => setSaveOpen(false)}
                  onSave={async (name) => {
                    const s = await api.post<ScenarioFull>(`/api/whatif/businesses/${businessId}/scenarios`, { name, question, levers: clean(levers), interpretation: interp, explanation: expl });
                    setSavedId(s.id);
                    setSaveOpen(false);
                    toast("Scenario saved.");
                  }} />
              )}</AnimatePresence>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function EmptyResults() {
  return (
    <div className="panel glass grid min-h-[320px] content-center gap-3 p-8">
      <h2 className="t-display-tight text-[1.6rem]">Nothing calculated yet</h2>
      <p className="max-w-[56ch] text-text-2">Ask a question above or set a change on the left, then run the simulation. You will see the current course next to the scenario, why the numbers changed, the risks, and the assumptions behind every figure.</p>
    </div>
  );
}

function Steps({ steps }: { steps: { label: string; state: "done" | "active" | "idle" | "skip" }[] }) {
  return (
    <ol className="grid gap-1.5 text-[0.8rem]" aria-label="Progress">
      {steps.filter((s) => s.state !== "skip").map((s) => (
        <li key={s.label} className="flex items-center gap-2">
          {s.state === "done" ? <span className="text-sev-low" style={{ color: "var(--sev-low)" }}><IconCheck size={14} /></span>
            : s.state === "active" ? <span className="pulse-dot" style={{ width: 7, height: 7, margin: "0 3.5px" }} />
              : <span className="inline-block h-[7px] w-[7px] rounded-full border border-text-3" style={{ margin: "0 3.5px" }} />}
          <span className={s.state === "active" ? "think-text" : s.state === "done" ? "text-text" : "text-text-3"}>{s.label}</span>
        </li>
      ))}
    </ol>
  );
}

// ------------------------------------------------------------------- ask

function Ask({ question, setQuestion, onRead, reading, suggestions, interp, cur }: {
  question: string; setQuestion: (q: string) => void; onRead: (q?: string) => void; reading: boolean; suggestions: string[]; interp: Interpretation | null; cur: string;
}) {
  return (
    <section className="panel glass grid gap-3 p-4 sm:p-5">
      <form className="flex flex-col gap-2 sm:flex-row" onSubmit={(e) => { e.preventDefault(); onRead(); }}>
        <label htmlFor="whatif-q" className="sr-only">Describe a decision</label>
        <input id="whatif-q" className="input !min-h-[3rem] flex-1 !text-[1.02rem]" placeholder="What if I lower my selling price by 10%?" value={question} onChange={(e) => setQuestion(e.target.value)} maxLength={1000} />
        <button className="btn btn-primary btn-lg" disabled={reading || question.trim().length < 3}>{reading && <Spinner />}Read my question</button>
      </form>
      {!interp && (
        <div className="flex flex-wrap gap-1.5">
          {suggestions.map((s) => <button key={s} className="chip interactive cursor-pointer" onClick={() => { setQuestion(s); onRead(s); }}>{s}</button>)}
        </div>
      )}
      {interp && (
        <motion.div initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} className="grid gap-2.5 border-t border-line pt-3">
          <div className="flex flex-wrap items-center gap-2 text-[0.85rem]">
            <span className="font-semibold">Recognised changes</span>
            <KindTag kind={interp.mode === "ai" ? "ai" : "rules"} title={interp.mode === "ai" ? `Read by ${interp.model}` : "Read by What-if's rule-based parser (no AI)"} />
            {interp.notice && <span className="text-text-3">{interp.notice}</span>}
          </div>
          {interp.recognized.length ? (
            <ul className="grid gap-1.5">
              {interp.recognized.map((r, i) => (
                <li key={i} className="flex flex-wrap items-center gap-2 text-[0.88rem]">
                  <SourceBadge s={r.source === "assumed" && interp.mode === "ai" ? "ai" : r.source} />
                  <span>{r.label}{r.value != null && r.unit !== "" ? <b className="num ml-1">{r.value > 0 && r.unit !== "people" && r.unit !== "months" ? "+" : ""}{r.value}{r.unit === "%" ? "%" : r.unit === "points" ? " pts" : ` ${r.unit}`}</b> : r.value != null ? <b className="num ml-1">{money(r.value, cur)}</b> : null}</span>
                  {r.text && <span className="text-text-3">“{r.text}”</span>}
                </li>
              ))}
            </ul>
          ) : null}
          {interp.questions.length > 0 && (
            <div className="grid gap-1 rounded-[var(--r-card)] border border-dashed border-line-strong p-3 text-[0.85rem]">
              <span className="font-semibold">To make this more accurate</span>
              <ul className="list-disc pl-5 text-text-2">{interp.questions.map((q, i) => <li key={i}>{q}</li>)}</ul>
              <span className="text-text-3">Change the values in the controls before running.</span>
            </div>
          )}
          {interp.unrecognized && interp.recognized.length > 0 && <p className="text-[0.82rem] text-text-3">Not simulated: “{interp.unrecognized}”.</p>}
        </motion.div>
      )}
    </section>
  );
}

// -------------------------------------------------------------- controls

function Group({ title, children, open: startOpen = false, active = false }: { title: string; children: ReactNode; open?: boolean; active?: boolean }) {
  const [open, setOpen] = useState(startOpen);
  const show = open || active;
  return (
    <div className="border-t border-line first:border-t-0">
      <button className="flex w-full items-center justify-between py-2.5 text-left text-[0.88rem] font-semibold" onClick={() => setOpen(!show)} aria-expanded={show}>
        <span className="flex items-center gap-2">{title}{active && <span className="inline-block h-1.5 w-1.5 rounded-full bg-signal" aria-label="changed" />}</span>
        <span aria-hidden="true" className="text-text-3">{show ? "−" : "+"}</span>
      </button>
      {show && <div className="grid gap-3 pb-3">{children}</div>}
    </div>
  );
}

function Slider({ label, value, onChange, min, max, step = 1, unit = "%", hint }: { label: string; value: number; onChange: (v: number) => void; min: number; max: number; step?: number; unit?: string; hint?: string }) {
  const id = label.replace(/\W+/g, "-").toLowerCase();
  return (
    <div className="grid gap-1">
      <div className="flex items-center justify-between gap-2">
        <label htmlFor={id} className="text-[0.82rem] text-text-2">{label}</label>
        <div className="flex items-center gap-1">
          <input aria-label={`${label} value`} className="input input-num !min-h-[1.9rem] w-[5.2rem] !py-0.5 !text-[0.85rem]" type="number" step={step} min={min} max={max}
            value={Number.isFinite(value) ? value : 0} onChange={(e) => onChange(e.target.value === "" ? 0 : Math.max(min, Math.min(max, +e.target.value)))} />
          <span className="w-6 text-[0.78rem] text-text-3">{unit}</span>
        </div>
      </div>
      <input id={id} type="range" className="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(+e.target.value)} />
      {hint && <span className="hint">{hint}</span>}
    </div>
  );
}

function NumField({ label, value, onChange, step = 1, min = 0, suffix }: { label: string; value: number | null | undefined; onChange: (v: number) => void; step?: number; min?: number; suffix?: string }) {
  return (
    <label className="field">
      <span>{label}</span>
      <div className="flex items-center gap-1.5">
        <input className="input input-num" type="number" step={step} min={min} value={value ?? 0} onChange={(e) => onChange(e.target.value === "" ? 0 : +e.target.value)} />
        {suffix && <span className="text-[0.78rem] text-text-3">{suffix}</span>}
      </div>
    </label>
  );
}

function Controls({ spec, levers: l, setLevers, names, elasticityNote, external }: { spec: ProfileSpec; levers: Levers; setLevers: (l: Levers) => void; names: Record<string, string>; elasticityNote?: string; external: ReactNode }) {
  const cur = spec.business.currency;
  const set = (p: Partial<Levers>) => setLevers({ ...l, ...p });
  const sub = spec.subscription.enabled;
  const avgWage = spec.staff.length ? spec.staff.reduce((a, s) => a + s.count * s.monthly_wage, 0) / Math.max(1, spec.staff.reduce((a, s) => a + s.count, 0)) : 0;
  const changed = describeLevers(l, cur, names);
  return (
    <div className="panel glass grid gap-0 px-4 pb-1 pt-2">
      <div className="flex items-center justify-between pb-1 pt-1">
        <h2 className="text-[0.95rem] font-semibold">Changes to test</h2>
        <span className="text-[0.78rem] text-text-3">{changed.length ? `${changed.length} change${changed.length > 1 ? "s" : ""}` : "current course"}</span>
      </div>
      <Group title="Price & demand" open active={!!(l.price_change_pct || l.demand_change_pct)}>
        <Slider label="Selling price" value={l.price_change_pct ?? 0} onChange={(v) => set({ price_change_pct: v })} min={-50} max={50} step={0.5} />
        {spec.products.length > 1 && (l.price_change_pct ?? 0) !== 0 && (
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Products the price change applies to">
            {spec.products.map((p) => {
              const on = !l.price_product_ids?.length || l.price_product_ids.includes(p.id);
              return <button key={p.id} className={`chip cursor-pointer ${on ? "chip-calc" : ""}`} aria-pressed={on}
                onClick={() => { const ids = l.price_product_ids?.length ? l.price_product_ids : spec.products.map((x) => x.id); const next = on ? ids.filter((i) => i !== p.id) : [...ids, p.id]; set({ price_product_ids: next.length === spec.products.length ? [] : next }); }}>{p.name}</button>;
            })}
          </div>
        )}
        <Slider label={sub ? "New sign-ups (market demand)" : "Customer demand"} value={l.demand_change_pct ?? 0} onChange={(v) => set({ demand_change_pct: v })} min={-80} max={100} />
      </Group>
      <Group title="Costs" active={!!(l.unit_cost_change_pct || l.rent_change_pct || l.fixed_cost_change_pct || l.wage_change_pct)}>
        <Slider label={spec.industry === "food_beverage" ? "Ingredient & packaging cost" : spec.industry === "technology" ? "Hosting cost per subscriber" : "Variable cost per unit"} value={l.unit_cost_change_pct ?? 0} onChange={(v) => set({ unit_cost_change_pct: v })} min={-50} max={100} step={0.5} />
        <Slider label="Rent" value={l.rent_change_pct ?? 0} onChange={(v) => set({ rent_change_pct: v })} min={-50} max={100} />
        <Slider label="Other fixed costs" value={l.fixed_cost_change_pct ?? 0} onChange={(v) => set({ fixed_cost_change_pct: v })} min={-50} max={100} />
        <Slider label="Wages" value={l.wage_change_pct ?? 0} onChange={(v) => set({ wage_change_pct: v })} min={-30} max={60} />
      </Group>
      <Group title="Marketing" active={!!(l.marketing_change_pct || l.marketing_budget != null)}>
        <Slider label={`Marketing budget (today ${money(spec.marketing.monthly_budget, cur)}/month)`} value={l.marketing_change_pct ?? 0} onChange={(v) => set({ marketing_change_pct: v, marketing_budget: null })} min={-100} max={300} step={5}
          hint={spec.marketing.monthly_budget === 0 ? "Today's budget is zero; set extra sales per 1,000 spent in Business setup for new spending to have an effect." : `Response assumption: demand × (new ÷ current spend)^${spec.marketing.elasticity}`} />
      </Group>
      <Group title="Staff" active={!!l.staff_changes?.length}>
        {(l.staff_changes ?? []).map((s, i) => (
          <div key={i} className="grid grid-cols-[1fr_4.5rem_6.5rem_auto] items-end gap-1.5">
            <label className="field"><span>Role</span><input className="input" value={s.role} onChange={(e) => set({ staff_changes: l.staff_changes!.map((x, j) => j === i ? { ...x, role: e.target.value } : x) })} /></label>
            <label className="field"><span>People</span><input className="input input-num" type="number" step={1} value={s.count} onChange={(e) => set({ staff_changes: l.staff_changes!.map((x, j) => j === i ? { ...x, count: +e.target.value } : x) })} /></label>
            <label className="field"><span>Cost/month</span><input className="input input-num" type="number" placeholder={num(avgWage)} value={s.monthly_wage ?? ""} onChange={(e) => set({ staff_changes: l.staff_changes!.map((x, j) => j === i ? { ...x, monthly_wage: e.target.value === "" ? null : +e.target.value } : x) })} /></label>
            <button className="btn btn-quiet btn-sm" aria-label="Remove staff change" onClick={() => set({ staff_changes: l.staff_changes!.filter((_, j) => j !== i) })}><IconTrash size={15} /></button>
          </div>
        ))}
        <button className="btn btn-sm btn-outline justify-self-start" onClick={() => set({ staff_changes: [...(l.staff_changes ?? []), { role: spec.staff[0]?.role ?? "New staff", count: 1, monthly_wage: null }] })}><IconPlus size={14} />Add or remove people</button>
        <span className="hint">Negative numbers remove people. Empty cost = current average ({money(avgWage, cur)}).</span>
      </Group>
      <Group title="Capacity & growth" active={!!(l.capacity_change_pct || l.seasonal?.length)}>
        {!sub && <Slider label="Capacity" value={l.capacity_change_pct ?? 0} onChange={(v) => set({ capacity_change_pct: v })} min={-50} max={200} step={5} />}
        {(l.seasonal ?? []).map((s, i) => (
          <div key={i} className="grid gap-2 rounded-[var(--r-card)] border border-line p-2.5">
            <div className="flex items-center justify-between gap-2">
              <input className="input !min-h-[1.9rem] !py-0.5" value={s.label} aria-label="Seasonal change name" onChange={(e) => set({ seasonal: l.seasonal!.map((x, j) => j === i ? { ...x, label: e.target.value } : x) })} />
              <button className="btn btn-quiet btn-sm" aria-label="Remove seasonal change" onClick={() => set({ seasonal: l.seasonal!.filter((_, j) => j !== i) })}><IconTrash size={15} /></button>
            </div>
            <div className="flex flex-wrap gap-1" role="group" aria-label="Months">
              {MONTHS.map((m, k) => {
                const on = s.months.includes(k + 1);
                return <button key={m} className={`chip cursor-pointer !px-1.5 ${on ? "chip-calc" : ""}`} aria-pressed={on}
                  onClick={() => { const months = on ? s.months.filter((x) => x !== k + 1) : [...s.months, k + 1].sort((a, b) => a - b); if (months.length) set({ seasonal: l.seasonal!.map((x, j) => j === i ? { ...x, months } : x) }); }}>{m}</button>;
              })}
            </div>
            <Slider label="Demand in those months" value={s.demand_change_pct} onChange={(v) => set({ seasonal: l.seasonal!.map((x, j) => j === i ? { ...x, demand_change_pct: v } : x) })} min={-90} max={200} step={5} />
          </div>
        ))}
        <button className="btn btn-sm btn-outline justify-self-start" onClick={() => set({ seasonal: [...(l.seasonal ?? []), { months: [11, 12], demand_change_pct: 20, label: "Holiday season" }] })}><IconPlus size={14} />Add a seasonal change</button>
      </Group>
      {sub && (
        <Group title="Subscribers" active={!!(l.churn_change_pts || l.new_customers_change_pct)}>
          <Slider label={`Monthly churn (today ${spec.subscription.monthly_churn_pct}%)`} value={l.churn_change_pts ?? 0} onChange={(v) => set({ churn_change_pts: v })} min={-5} max={15} step={0.5} unit="pts" />
          <Slider label={`New sign-ups (today ${num(spec.subscription.new_customers_per_month)}/month)`} value={l.new_customers_change_pct ?? 0} onChange={(v) => set({ new_customers_change_pct: v })} min={-80} max={300} step={5} />
        </Group>
      )}
      <Group title="Growth moves" active={!!(l.new_branch || l.new_product || l.one_time_investment)}>
        <label className="flex items-center gap-2 text-[0.85rem]"><input type="checkbox" checked={!!l.new_branch} onChange={(e) => {
          const monthly = spec.staff.reduce((a, s) => a + s.count * s.monthly_wage, 0) + spec.fixed_costs.reduce((a, c) => a + c.monthly_amount, 0);
          set({ new_branch: e.target.checked ? { setup_cost: Math.round(monthly * 4 / 100) * 100, monthly_fixed_cost: Math.round(monthly * 0.9 / 100) * 100, demand_share_pct: 70, ramp_months: 4 } : null });
        }} />Open another location</label>
        {l.new_branch && (
          <div className="grid grid-cols-2 gap-2">
            <NumField label={`Set-up cost (${cur})`} value={l.new_branch.setup_cost} onChange={(v) => set({ new_branch: { ...l.new_branch!, setup_cost: v } })} step={100} />
            <NumField label={`Running cost/month`} value={l.new_branch.monthly_fixed_cost} onChange={(v) => set({ new_branch: { ...l.new_branch!, monthly_fixed_cost: v } })} step={100} />
            <NumField label="Demand vs today" value={l.new_branch.demand_share_pct} onChange={(v) => set({ new_branch: { ...l.new_branch!, demand_share_pct: v } })} suffix="%" />
            <NumField label="Ramp-up" value={l.new_branch.ramp_months} onChange={(v) => set({ new_branch: { ...l.new_branch!, ramp_months: Math.round(v) } })} suffix="months" />
          </div>
        )}
        <label className="flex items-center gap-2 text-[0.85rem]"><input type="checkbox" checked={!!l.new_product} onChange={(e) => {
          const p0 = spec.products[0];
          set({ new_product: e.target.checked ? { name: "New product", price: p0?.price ?? 10, unit_cost: p0?.unit_cost ?? 4, monthly_units: Math.round((p0?.monthly_units ?? 400) * 0.25), cannibalization_pct: 25, launch_cost: 0 } : null });
        }} />Introduce a new product</label>
        {l.new_product && (
          <div className="grid grid-cols-2 gap-2">
            <label className="field col-span-2"><span>Name</span><input className="input" value={l.new_product.name} onChange={(e) => set({ new_product: { ...l.new_product!, name: e.target.value } })} /></label>
            <NumField label={`Price (${cur})`} value={l.new_product.price} onChange={(v) => set({ new_product: { ...l.new_product!, price: v } })} step={0.5} />
            <NumField label={`Unit cost (${cur})`} value={l.new_product.unit_cost} onChange={(v) => set({ new_product: { ...l.new_product!, unit_cost: v } })} step={0.5} />
            <NumField label={`${spec.unit_label}/month`} value={l.new_product.monthly_units} onChange={(v) => set({ new_product: { ...l.new_product!, monthly_units: v } })} step={10} />
            <NumField label="Taken from others" value={l.new_product.cannibalization_pct} onChange={(v) => set({ new_product: { ...l.new_product!, cannibalization_pct: v } })} suffix="%" />
            <NumField label={`Launch cost (${cur})`} value={l.new_product.launch_cost} onChange={(v) => set({ new_product: { ...l.new_product!, launch_cost: v } })} step={100} />
          </div>
        )}
        <div className="grid grid-cols-2 gap-2">
          <NumField label={`One-time investment (${cur})`} value={l.one_time_investment ?? 0} onChange={(v) => set({ one_time_investment: v })} step={100} />
          <NumField label="In month" value={l.investment_month ?? 1} onChange={(v) => set({ investment_month: Math.max(1, Math.round(v)) })} min={1} />
        </div>
      </Group>
      <Group title="External data" active={!!l.data_links?.length}>
        {external}
      </Group>
      <Group title="Assumptions & period" active={l.elasticity_override != null}>
        <div className="grid gap-1">
          <label className="flex items-center gap-2 text-[0.85rem]"><input type="checkbox" checked={l.elasticity_override != null} onChange={(e) => set({ elasticity_override: e.target.checked ? spec.products[0]?.elasticity ?? -1 : null })} />Override price elasticity for this scenario</label>
          {l.elasticity_override != null && <Slider label="Price elasticity" value={l.elasticity_override} onChange={(v) => set({ elasticity_override: v })} min={-4} max={0} step={0.1} unit="" hint="0 means price has no effect on demand; −2 means a 1% price cut raises demand 2%." />}
          {elasticityNote && <span className="hint">{elasticityNote} Set your own per product in Business setup.</span>}
        </div>
        <div className="grid grid-cols-2 gap-2">
          <label className="field"><span>Period</span>
            <select className="select" value={l.horizon_months ?? 12} onChange={(e) => set({ horizon_months: +e.target.value })}>
              {[3, 6, 12, 18, 24, 36].map((m) => <option key={m} value={m}>{m} months</option>)}
            </select>
          </label>
          <label className="field"><span>Starting</span><input className="input" type="month" value={l.start_month ?? ""} onChange={(e) => set({ start_month: e.target.value || null })} /></label>
        </div>
        <span className="hint">Empty start = next month.</span>
      </Group>
    </div>
  );
}

// --------------------------------------------------------------- results

type Metric = "net_profit" | "revenue" | "cash" | "units";
const METRIC: Record<Metric, string> = { net_profit: "Net profit", revenue: "Revenue", cash: "Cash balance", units: "Units sold" };

export function Results({ res, expl, explaining, spec, onTry, onAsk, compactView = false }: {
  res: SimResponse | { result: SimResult; risks: { scenario: RiskReport; baseline: RiskReport } }; expl: Explanation | null; explaining?: boolean; spec: ProfileSpec;
  onTry?: (l: Levers) => void; onAsk?: (q: string) => void; compactView?: boolean;
}) {
  const r = res.result;
  const cur = r.currency;
  const [metric, setMetric] = useState<Metric>("net_profit");
  const d = r.delta;
  const sm = r.scenario.metrics, bm = r.baseline.metrics;
  const H = r.scenario.horizon_months;
  const fmt = (v: number) => (metric === "units" ? num(v) : compact(v, cur));
  const series = (p: typeof r.scenario) => p.months.map((m) => (metric === "cash" ? m.cash : metric === "units" ? m.units : metric === "revenue" ? m.revenue : m.net_profit));
  const band = metric === "net_profit" ? { low: r.bands.worst.monthly_net_profit, high: r.bands.best.monthly_net_profit, label: "Worst to best case" }
    : metric === "cash" ? { low: r.bands.worst.cash, high: r.bands.best.cash, label: "Worst to best case" } : undefined;
  const history = metric === "revenue" ? spec.history.map((h) => ({ month: h.month, value: h.revenue }))
    : metric === "net_profit" ? spec.history.map((h) => ({ month: h.month, value: h.net_profit })) : metric === "units" ? spec.history.map((h) => ({ month: h.month, value: h.units })) : [];
  const risks = res.risks.scenario;
  return (
    <div className="grid gap-6">
      <div className="panel glass grid gap-5 p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2 text-[0.82rem] text-text-3">
            <KindTag kind="calculated" />
            <span>{monthLabel(r.scenario.start_month, true)} to {monthLabel(r.scenario.end_month, true)} · {r.engine}</span>
          </div>
          {!r.is_baseline && <span className="text-[0.85rem]">{expl?.assessment.text}</span>}
        </div>
        <div className="grid grid-cols-2 gap-x-6 gap-y-5 lg:grid-cols-[1.5fr_1fr_1fr_1fr]">
          <Kpi label={`Net profit, ${H} months`} value={money(d.net_profit.scenario, cur)} sub={<>{r.is_baseline ? "current course" : <Delta v={d.net_profit.change} fmt={(v) => signedMoney(v, cur)} />}{!r.is_baseline && <span className="text-text-3"> vs {money(d.net_profit.baseline, cur)}</span>}</>} big />
          <Kpi label="Revenue" value={compact(d.revenue.scenario, cur)} sub={r.is_baseline ? undefined : <Delta v={d.revenue.change_pct ?? null} fmt={(v) => signedPct(v)} />} />
          <Kpi label="Net margin" value={pct(sm.net_margin)} sub={r.is_baseline ? undefined : <Delta v={sm.net_margin != null && bm.net_margin != null ? sm.net_margin - bm.net_margin : null} fmt={signedPts} />} />
          <Kpi label="Lowest cash" value={compact(sm.min_cash, cur)} sub={<span className="text-text-3">in {monthLabel(sm.min_cash_month, true)}</span>} />
        </div>
        <div className="grid gap-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="seg" role="tablist" aria-label="Chart metric">
              {(Object.keys(METRIC) as Metric[]).map((m) => <button key={m} role="tab" aria-selected={metric === m} onClick={() => setMetric(m)}>{METRIC[m]}</button>)}
            </div>
            <span className="text-[0.78rem] text-text-3">Band: demand ±{r.bands.ranges.demand_pct}%, costs ±{r.bands.ranges.cost_pct}%{r.bands.ranges.elasticity_abs ? `, elasticity ±${r.bands.ranges.elasticity_abs}` : ""} ({r.bands.cases} cases)</span>
          </div>
          <ProjectionChart months={r.scenario.months.map((m) => m.month)} history={history} ariaLabel={`${METRIC[metric]} by month, current course and scenario`} format={fmt} zero={metric !== "units"}
            series={[
              { key: "base", label: "Current course", values: series(r.baseline), color: "var(--series-baseline)", dash: "6 5", shape: "ring" },
              ...(r.is_baseline ? [] : [{ key: "scen", label: "This scenario", values: series(r.scenario), color: "var(--series-1)", shape: "circle" as const }]),
            ]} band={r.is_baseline ? undefined : band} />
        </div>
      </div>

      <div className="grid items-start gap-6 lg:grid-cols-2">
        {!r.is_baseline && (
          <Section title="Why net profit changes" aside={<KindTag kind="calculated" />}>
            <div className="panel p-4"><BridgeChart start={d.net_profit.baseline ?? 0} end={d.net_profit.scenario ?? 0} items={r.bridge} cur={cur} /></div>
            {r.scenario.demand_factors.length > 0 && (
              <ul className="grid gap-1 text-[0.84rem] text-text-2">
                {r.scenario.demand_factors.map((f) => <li key={f.key + f.label} className="flex justify-between gap-3"><span>{f.label} <span className="text-text-3">({f.note})</span></span><span className="num text-text">×{f.multiplier.toFixed(3)}</span></li>)}
              </ul>
            )}
          </Section>
        )}
        <Explain expl={expl} explaining={!!explaining} onTry={onTry} onAsk={onAsk} />
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <Section title="Break-even">
          <div className="panel grid gap-2 p-4 text-[0.88rem]">
            <Row k={`Break-even ${spec.unit_label}/month`} v={sm.break_even_units == null ? "none (each unit loses money)" : num(sm.break_even_units)} />
            <Row k="Average sold/month" v={num(r.scenario.monthly_avg.units)} />
            <Row k="Safety margin" v={pct(sm.safety_margin)} />
            <Row k="Contribution per unit" v={money(sm.contribution_per_unit, cur, 2)} />
            {expl?.required_volume?.possible && <p className="pt-1 text-[0.8rem] text-text-2">To keep gross profit unchanged, volume would need to change {signedPct(expl.required_volume.needed_change!)}; the demand model gives {signedPct(expl.required_volume.expected_change)}.</p>}
          </div>
        </Section>
        <Section title="Capacity & stock">
          <div className="panel grid gap-2 p-4 text-[0.88rem]">
            <Row k="Capacity use" v={sm.capacity_utilization == null ? "not limited" : pct(sm.capacity_utilization)} />
            <Row k="Demand not served" v={pct(sm.lost_share)} />
            <Row k="Stock cover at end" v={sm.inventory_cover_months == null ? "not tracked" : `${num(sm.inventory_cover_months, 1)} months`} />
            {sm.subscribers_end != null && <Row k="Subscribers at end" v={num(sm.subscribers_end)} />}
            <Row k="Headcount" v={num(sm.headcount, 1)} />
          </div>
        </Section>
        <Section title="Cash">
          <div className="panel grid gap-2 p-4 text-[0.88rem]">
            <Row k="Starting cash" v={money(sm.starting_cash, cur)} />
            <Row k="Ending cash" v={money(sm.ending_cash, cur)} />
            <Row k="One-time spending" v={money(r.scenario.totals.one_time, cur)} />
            <Row k="Payback" v={r.payback_months == null ? "—" : `${num(r.payback_months, 1)} months`} />
            <Row k="Runway" v={sm.runway_months == null ? "cash not falling" : `${num(sm.runway_months, 1)} months`} />
          </div>
        </Section>
      </div>

      <Section title="Risks in this scenario" aside={<Link to="/app/risk" className="text-[0.85rem] underline">Open Risk Radar</Link>}>
        {risks.findings.length === 0 ? <p className="text-text-2">No rule was triggered for this scenario.</p> : (
          <ul className="grid gap-2">
            {risks.findings.slice(0, compactView ? 3 : 5).map((f) => (
              <li key={f.id} className="panel flex flex-wrap items-start gap-3 p-3">
                <SeverityBadge s={f.severity} />
                <div className="grid min-w-0 flex-1 basis-[15rem] gap-0.5"><span className="font-semibold">{f.title}</span><span className="text-[0.85rem] text-text-2">{f.summary}</span></div>
                {onTry && f.actions[0]?.levers && Object.keys(f.actions[0].levers).length > 0 && <button className="btn btn-sm btn-outline" onClick={() => onTry({ ...r.levers, ...f.actions[0].levers, start_month: null })}>{f.actions[0].label}</button>}
              </li>
            ))}
          </ul>
        )}
      </Section>

      {!!r.levers.data_links?.length && (
        <Section title="External data used in this scenario" aside={<span className="text-[0.78rem] text-text-3">Applied by you; shown with source, dates and the rule used</span>}>
          <DataLinks links={r.levers.data_links} />
        </Section>
      )}

      <Section title="Assumptions behind these numbers" aside={<ConfidenceMeter level={r.confidence.level} score={r.confidence.score} reasons={r.confidence.reasons} />}>
        <div className="table-wrap">
          <table className="data min-w-[560px]">
            <thead><tr><th>Assumption</th><th className="n">Value</th><th>Source</th><th>Note</th></tr></thead>
            <tbody>
              {r.assumptions.map((a, i) => (
                <tr key={a.key + i}><td>{a.label}</td><td className="n">{a.value == null ? "" : `${a.value}${a.unit === "%" ? "%" : a.unit ? ` ${a.unit}` : ""}`}</td><td><SourceBadge s={a.source} /></td><td className="text-text-2">{a.note}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
        <details className="text-[0.84rem] text-text-2"><summary className="cursor-pointer text-text-3">How the engine simplifies</summary><ul className="mt-2 list-disc pl-5">{r.simplifications.map((s) => <li key={s}>{s}</li>)}</ul></details>
        {r.history_check && <p className="text-[0.82rem] text-text-3">Check against reality: your last entered month ({monthLabel(r.history_check.last_actual_month, true)}) had revenue of {money(r.history_check.last_actual_revenue, cur)}; the projection's first month is {money(r.history_check.baseline_first_month_revenue, cur)} ({signedPct(r.history_check.gap_pct)}), adjusted for season.</p>}
      </Section>
    </div>
  );
}

function Row({ k, v }: { k: string; v: ReactNode }) {
  return <div className="flex items-baseline justify-between gap-3"><span className="text-text-2">{k}</span><span className="num text-right">{v}</span></div>;
}

function Explain({ expl, explaining, onTry, onAsk }: { expl: Explanation | null; explaining: boolean; onTry?: (l: Levers) => void; onAsk?: (q: string) => void }) {
  return (
    <Section title="What this means" aside={explaining ? <span className="chip chip-ai"><Spark />AI is writing…</span> : expl && <KindTag kind={expl.mode === "ai" ? "ai" : "rules"} title={expl.mode === "ai" ? `Written by ${expl.model}; figures checked against the calculation` : undefined} />}>
      <div className="panel grid gap-3 p-4" style={expl?.mode === "ai" ? { borderColor: "rgb(194 181 255 / 35%)" } : undefined}>
        {!expl ? <span className="think-text">Waiting for the calculation…</span> : (
          <>
            <p className={`text-[0.95rem] leading-relaxed ${explaining ? "stale" : ""}`}>{expl.summary}</p>
            {expl.key_points.length > 0 && <ul className="grid list-disc gap-1 pl-5 text-[0.88rem] text-text-2">{expl.key_points.map((k, i) => <li key={i}>{k}</li>)}</ul>}
            {expl.risk_notes.length > 0 && <div className="grid gap-1 text-[0.85rem]">{expl.risk_notes.map((n) => <p key={n.finding_id} className="text-text-2">{n.explanation}</p>)}</div>}
            {expl.recommendations.length > 0 && (
              <div className="grid gap-1.5">
                <span className="text-[0.82rem] font-semibold">Worth testing next</span>
                {expl.recommendations.map((rc, i) => (
                  <div key={i} className="flex flex-wrap items-center justify-between gap-2 text-[0.86rem]">
                    <span className="text-text-2">{rc.text}</span>
                    {rc.levers && onTry ? <button className="btn btn-sm btn-outline" onClick={() => onTry(rc.levers!)}>Load it</button>
                      : rc.try_question && onAsk ? <button className="btn btn-sm btn-outline" onClick={() => onAsk(rc.try_question!)}>Ask it</button> : null}
                  </div>
                ))}
              </div>
            )}
            {expl.next_scenarios.length > 0 && onAsk && <div className="flex flex-wrap gap-1.5">{expl.next_scenarios.map((q) => <button key={q} className="chip interactive cursor-pointer" onClick={() => onAsk(q)}>{q}</button>)}</div>}
            {expl.caveats.length > 0 && <p className="text-[0.8rem] text-text-3">Depends on: {expl.caveats.join(" ")}</p>}
            {expl.notice && <p className="text-[0.78rem] text-text-3">{expl.notice}</p>}
          </>
        )}
      </div>
    </Section>
  );
}

function SaveForm({ initial, onSave, onCancel, reduced }: { initial: string; onSave: (name: string) => Promise<void>; onCancel: () => void; reduced: boolean }) {
  const [name, setName] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return (
    <motion.form initial={reduced ? false : { opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="panel flex flex-wrap items-end gap-2 p-4"
      onSubmit={async (e) => { e.preventDefault(); setBusy(true); try { await onSave(name.trim() || "Scenario"); } catch (x) { setErr(x instanceof Error ? x.message : String(x)); } finally { setBusy(false); } }}>
      <label className="field min-w-[240px] flex-1"><span>Scenario name</span><input className="input" autoFocus value={name} maxLength={160} onChange={(e) => setName(e.target.value)} /></label>
      <button className="btn btn-primary" disabled={busy}>{busy && <Spinner />}Save scenario</button>
      <button type="button" className="btn btn-quiet" onClick={onCancel}>Cancel</button>
      {err && <p className="error-text w-full">{err}</p>}
    </motion.form>
  );
}
