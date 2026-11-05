import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { AnimatePresence, motion } from "motion/react";
import { api } from "../../lib/api";
import { useReduced } from "../../lib/hooks";
import { useWorkspace } from "../../app/workspace";
import { useBackdropState } from "../../app/AppShell";
import { ErrorBox, Spinner, useToast } from "../../components/ui";
import { IconPlay, IconPlus, IconRetry, IconTrash, IconCheck } from "../../components/icons";
import { describeLevers, money, num } from "../format";
import type { Explanation, Interpretation, Levers, ProfileSpec, RiskReport, ScenarioFull, ScenarioSummary, SimResult } from "../types";
import { ExternalData } from "../ExternalData";
import { Results } from "../ResultsView";
import { KindTag, NeedsProfile, PageTitle, SourceBadge, useProfile } from "../ui";

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

type SaveState = "idle" | "saving" | "saved" | "failed";
interface Saved { id: number; name: string; origin: string; created_at: string; computed_at?: string }
const PENDING = "whatif-pending-run";
const newKey = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`).replace(/[^A-Za-z0-9_-]/g, "");

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
  const [nameOpen, setNameOpen] = useState<"rename" | "copy" | null>(null);
  const [saved, setSaved] = useState<Saved | null>(null);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [pendingSave, setPendingSave] = useState<{ key: string; levers: Levers; name: string } | null>(null);
  const [restored, setRestored] = useState<Saved | null>(null);
  const [interrupted, setInterrupted] = useState<string | null>(null);
  const names = useMemo(() => Object.fromEntries(spec.products.map((p) => [p.id, p.name])), [spec]);
  const stale = res != null && ranKey !== key(levers);
  // Once the user types, reads a question, changes a control or runs, the background restore must not replace their work.
  const touched = useRef(false);
  const touch = () => { touched.current = true; };
  const editLevers = (l: Levers) => { touch(); setLevers(l); };

  useEffect(() => { api.get<{ ai: { configured: boolean } }>("/api/whatif/status").then((s) => setAiConfigured(s.ai.configured)).catch(() => setAiConfigured(false)); }, []);
  useEffect(() => { setBackdrop({ levers: res ? res.result.levers : null }); }, [res, setBackdrop]);

  /** Show a saved simulation exactly as stored (no recalculation) and remember it as the last one viewed. */
  const openSaved = async (id: number, restoredView = false) => {
    const s = await api.get<ScenarioFull>(`/api/whatif/scenarios/${id}?open=true`);
    if (restoredView && touched.current) return;
    const l = { ...s.levers, start_month: null };
    setLevers(l);
    setQuestion(s.question);
    setInterp(s.interpretation);
    setRes({ result: s.result, risks: s.risks, explanation: s.explanation!, calc_ms: s.calc_ms ?? 0, profile_version: s.profile?.version ?? version });
    setExpl(s.explanation);
    setRanKey(key(l));
    setSaved({ id: s.id, name: s.name, origin: s.origin, created_at: s.created_at, computed_at: s.computed_at });
    setSaveState("saved");
    setRestored(restoredView ? { id: s.id, name: s.name, origin: s.origin, created_at: s.created_at } : null);
  };

  // Deep links: ?scenario=ID, ?levers=<json>, ?q=question. Without one, reopen the last saved simulation.
  useEffect(() => {
    const sid = params.get("scenario"), lv = params.get("levers"), q = params.get("q");
    try {
      const p = sessionStorage.getItem(PENDING);
      if (p) { const { at } = JSON.parse(p); setInterrupted(at); sessionStorage.removeItem(PENDING); }
    } catch { /* storage unavailable */ }
    if (sid) {
      openSaved(+sid).catch((e) => setError(e.message));
    } else if (lv) {
      try { setLevers({ horizon_months: 12, ...JSON.parse(lv) }); } catch { /* ignore bad link */ }
    } else if (!q) {
      api.get<{ scenario: ScenarioSummary | null }>(`/api/whatif/businesses/${businessId}/scenarios/latest`)
        .then((r) => { if (r.scenario && !touched.current) return openSaved(r.scenario.id, true); }).catch(() => { /* nothing saved yet */ });
    }
    if (q && !sid) setQuestion(q);
    if (sid || lv || q) setParams({}, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const read = async (q = question) => {
    if (q.trim().length < 3) return;
    touch();
    setReading(true);
    setError(null);
    try {
      const r = await api.post<Interpretation>(`/api/whatif/businesses/${businessId}/interpret`, { question: q });
      setInterp(r);
      setLevers({ horizon_months: levers.horizon_months ?? 12, ...r.levers });
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setReading(false); }
  };

  /** Store the completed run. The same key is reused on retry, so the server never stores it twice. */
  const save = async (p: { key: string; levers: Levers; name: string }): Promise<ScenarioFull | null> => {
    setSaveState("saving");
    setSaveError(null);
    setPendingSave(p);
    try {
      const s = await api.post<ScenarioFull>(`/api/whatif/businesses/${businessId}/scenarios`,
        { name: p.name, question, levers: p.levers, interpretation: interp, client_key: p.key, origin: "auto" });
      setSaved({ id: s.id, name: s.name, origin: s.origin, created_at: s.created_at, computed_at: s.computed_at });
      // Show exactly what was stored (same inputs, recalculated identically on the server).
      setRes((prev) => ({ result: s.result, risks: s.risks, explanation: s.explanation!, calc_ms: s.calc_ms ?? prev?.calc_ms ?? 0, profile_version: s.profile?.version ?? version }));
      setExpl((e) => (e?.mode === "ai" ? e : s.explanation));
      setSaveState("saved");
      setPendingSave(null);
      try { sessionStorage.removeItem(PENDING); } catch { /* storage unavailable */ }
      return s;
    } catch (e) {
      setSaveState("failed");
      setSaveError(e instanceof Error ? e.message : String(e));
      return null;
    }
  };

  const explain = async (s: ScenarioFull | null, lv: Levers, fallback: Explanation, refresh = false) => {
    setExplaining(true);
    try {
      setExpl(s ? await api.post<Explanation>(`/api/whatif/scenarios/${s.id}/explain`, { refresh })
        : await api.post<Explanation>(`/api/whatif/businesses/${businessId}/explain`, { levers: lv }));
    } catch (e) { setExpl({ ...fallback, notice: `The AI explanation failed (${e instanceof Error ? e.message : e}). This explanation was written from the calculation.` }); }
    finally { setExplaining(false); }
  };

  const run = async () => {
    touch();
    setRunning(true);
    setError(null);
    setExpl(null);
    setSaved(null);
    setRestored(null);
    setInterrupted(null);
    setSaveState("idle");
    const lv = clean(levers);
    const ck = newKey();
    try { sessionStorage.setItem(PENDING, JSON.stringify({ at: new Date().toISOString() })); } catch { /* storage unavailable */ }
    setBackdrop({ active: true, levers: lv });
    try {
      const r = await api.post<SimResponse>(`/api/whatif/businesses/${businessId}/simulate`, { levers: lv });
      setRes(r);
      setRanKey(key(levers));
      setExpl(r.explanation);
      setRunning(false);
      setBackdrop({ active: false });
      const name = interp?.name || describeLevers(r.result.levers, cur, names).slice(0, 2).join(", ") || "Current course";
      const s = await save({ key: ck, levers: lv, name });
      if (askAI && aiConfigured) await explain(s, lv, (s?.explanation ?? r.explanation));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setRunning(false);
      setBackdrop({ active: false });
      try { sessionStorage.removeItem(PENDING); } catch { /* storage unavailable */ }
    }
  };

  const reset = () => {
    setLevers({ horizon_months: levers.horizon_months ?? 12 });
    setInterp(null);
    setQuestion("");
  };

  const steps: { label: string; state: "done" | "active" | "idle" | "skip" }[] = [
    { label: "Read the question", state: reading ? "active" : interp ? "done" : "skip" },
    { label: "Calculate projections and risks", state: running ? "active" : res && !stale ? "done" : "idle" },
    { label: "Save to your history", state: saveState === "saving" ? "active" : saveState === "saved" && !stale ? "done" : "idle" },
    { label: aiConfigured ? "AI explanation" : "Explanation from the calculation", state: explaining ? "active" : expl && !stale && !running ? "done" : "idle" },
  ];

  return (
    <div className="grid gap-6">
      <PageTitle title="Simulate a decision"
        sub={<>Describe a decision or change the controls, then run it against <b className="text-text">{spec.business.name}</b> (profile v{version}). Every run is saved to your history automatically. Results are calculated; nothing is a guarantee.</>}
        actions={<><Link to="/app/history" className="btn btn-outline btn-sm">History</Link><Link to="/app/setup" className="btn btn-outline btn-sm">Edit business figures</Link></>} />

      {interrupted && (
        <div className="panel flex flex-wrap items-center justify-between gap-2 border-dashed p-3 text-[0.86rem]" role="status">
          <span>A simulation started {new Date(interrupted).toLocaleString()} was interrupted before it was saved, so it is not in your history. Run it again to keep it.</span>
          <button className="btn btn-sm btn-quiet" onClick={() => setInterrupted(null)}>Dismiss</button>
        </div>
      )}

      <Ask question={question} setQuestion={(q) => { touch(); setQuestion(q); }} onRead={read} reading={reading} suggestions={suggestions} interp={interp} cur={cur} />
      {error && <ErrorBox message={error} />}

      <div className="grid items-start gap-6 xl:grid-cols-[380px_minmax(0,1fr)]">
        <div className="grid gap-4 xl:sticky xl:top-20">
          <Controls spec={spec} levers={levers} setLevers={editLevers} names={names} elasticityNote={elasticityNote}
            external={<ExternalData businessId={businessId} spec={spec} levers={levers} setLevers={editLevers} />} />
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
              <SaveBar saved={saved} state={saveState} error={saveError} restored={restored} stale={stale}
                onRetry={() => pendingSave && save(pendingSave)} onName={() => setNameOpen("rename")} onCopy={() => setNameOpen("copy")} />
              <AnimatePresence>{nameOpen && saved && (
                <SaveForm key={nameOpen} initial={nameOpen === "copy" ? `${saved.name} (copy)` : saved.name} reduced={reduced} label={nameOpen === "copy" ? "Save a copy" : "Save name"}
                  onCancel={() => setNameOpen(null)}
                  onSave={async (name) => {
                    if (nameOpen === "copy") {
                      const c = await api.post<ScenarioFull>(`/api/whatif/scenarios/${saved.id}/duplicate`, { name });
                      setSaved({ id: c.id, name: c.name, origin: c.origin, created_at: c.created_at, computed_at: c.computed_at });
                      toast("Copy saved.");
                    } else {
                      const s = await api.patch<ScenarioSummary>(`/api/whatif/scenarios/${saved.id}`, { name });
                      setSaved({ ...saved, name: s.name, origin: s.origin });
                      toast("Name saved.");
                    }
                    setNameOpen(null);
                  }} />
              )}</AnimatePresence>
              {stale && !running && (
                <div className="panel flex flex-wrap items-center justify-between gap-3 border-dashed p-3 text-[0.88rem]" role="status" style={{ opacity: 1 }}>
                  <span>Inputs changed since this result was calculated. It shows the {saved ? "saved" : "previous"} run.</span>
                  <button className="btn btn-sm btn-signal" onClick={run}>Run again</button>
                </div>
              )}
              <Results scenarioId={saved?.id} res={res} expl={expl} explaining={explaining} spec={spec} aiAvailable={!!aiConfigured}
                onTry={(lv) => editLevers({ horizon_months: levers.horizon_months ?? 12, ...lv })} onAsk={(q) => { setQuestion(q); read(q); }}
                onRefreshAI={saved ? () => explain({ id: saved.id } as ScenarioFull, clean(levers), expl ?? res.explanation, true) : undefined} />
              {saved && <div className="flex flex-wrap items-center gap-2"><Link className="btn btn-sm btn-outline" to={`/app/compare?ids=${saved.id}`}>Compare with other scenarios</Link><Link className="btn btn-sm btn-outline" to={`/app/risk?scenario=${saved.id}`}>Open Risk Radar for this scenario</Link></div>}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** Where this result lives: its saved name and time, the save status (only "Saved" once the database confirmed it), and naming. */
function SaveBar({ saved, state, error, restored, stale, onRetry, onName, onCopy }: {
  saved: Saved | null; state: SaveState; error: string | null; restored: Saved | null; stale: boolean; onRetry: () => void; onName: () => void; onCopy: () => void;
}) {
  return (
    <div className="panel glass flex flex-wrap items-center justify-between gap-3 px-4 py-3" data-testid="save-bar">
      <div className="grid min-w-0 gap-0.5">
        <span className="truncate font-semibold">{saved?.name ?? "New simulation"}</span>
        <span className="text-[0.78rem] text-text-3">
          {restored ? <>Restored from your history · saved {new Date(restored.created_at).toLocaleString()}</> : saved ? <>Saved {new Date(saved.created_at).toLocaleString()}{saved.origin === "auto" ? " · automatic" : ""}</> : "Not saved yet"}
          {stale && saved ? " · inputs changed since" : ""}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-2" aria-live="polite">
        {state === "saving" && <span className="chip"><Spinner size={12} />Saving…</span>}
        {state === "saved" && <span className="chip chip-good" data-testid="save-status"><IconCheck size={13} />Saved</span>}
        {state === "failed" && <><span className="chip chip-bad" data-testid="save-status">Save failed</span><button className="btn btn-sm btn-primary" onClick={onRetry}>Retry</button></>}
        {state === "saved" && saved && <><button className="btn btn-sm btn-outline" onClick={onName}>{saved.origin === "auto" ? "Name this scenario" : "Rename"}</button><button className="btn btn-sm btn-quiet" onClick={onCopy}>Save a copy</button></>}
      </div>
      {state === "failed" && error && <p className="error-text w-full text-[0.8rem]">{error} The result is still shown here, but it is not in your history until it saves.</p>}
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
          {suggestions.map((s) => <button key={s} className="chip interactive max-w-full cursor-pointer whitespace-normal text-left" onClick={() => { setQuestion(s); onRead(s); }}>{s}</button>)}
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

function SaveForm({ initial, onSave, onCancel, reduced, label = "Save" }: { initial: string; onSave: (name: string) => Promise<void>; onCancel: () => void; reduced: boolean; label?: string }) {
  const [name, setName] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return (
    <motion.form initial={reduced ? false : { opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="panel flex flex-wrap items-end gap-2 p-4"
      onSubmit={async (e) => { e.preventDefault(); setBusy(true); try { await onSave(name.trim() || "Scenario"); } catch (x) { setErr(x instanceof Error ? x.message : String(x)); } finally { setBusy(false); } }}>
      <label className="field min-w-[240px] flex-1"><span>Scenario name</span><input className="input" autoFocus value={name} maxLength={160} onChange={(e) => setName(e.target.value)} /></label>
      <button className="btn btn-primary" disabled={busy}>{busy && <Spinner />}{label}</button>
      <button type="button" className="btn btn-quiet" onClick={onCancel}>Cancel</button>
      {err && <p className="error-text w-full">{err}</p>}
    </motion.form>
  );
}
