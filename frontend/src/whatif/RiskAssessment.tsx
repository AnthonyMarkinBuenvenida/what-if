// Risk Radar assessment: what the detected risks mean, what to consider, what to avoid, and scenarios to test.
// Severity and every figure come from the Risk Radar and the engine (backend/app/whatif/advisor.py); the AI only
// writes the text, and is replaced by the rules when it is unavailable. Suggested scenarios are never run
// automatically: the owner reviews the values, may change them, and runs the simulation here or in the simulator.

import { forwardRef, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../lib/api";
import { ErrorBox, Notice, Spinner } from "../components/ui";
import { ago, describeLevers, LEVER_LABELS, money, withUnit } from "./format";
import type { Levers, RiskAssessment as Assessment, RiskReport, Severity, SimResult } from "./types";
import { KindTag, SeverityBadge, SevShape, sevLabel } from "./ui";
import { mergeProposal, splitByTiming } from "./assessment";

export interface AssessTarget { scope: string; findingId: string | null; title?: string }
interface Got { assessment: Assessment | null; current: boolean; cached?: boolean; ai?: { configured: boolean; model: string | null } }
interface ScopeOption { value: string; label: string; levers: Levers }

/** Numeric levers that can be edited inline; anything else is reviewed in the simulator. */
const EDITABLE = ["price_change_pct", "unit_cost_change_pct", "demand_change_pct", "marketing_change_pct", "wage_change_pct", "rent_change_pct",
  "fixed_cost_change_pct", "capacity_change_pct", "churn_change_pts", "new_customers_change_pct", "marketing_budget", "one_time_investment", "investment_month"] as const;

export const RiskAssessmentPanel = forwardRef<HTMLDivElement, {
  businessId: number; cur: string; horizon: number; computedAt: string; scopes: ScopeOption[];
  target: AssessTarget; setTarget: (t: AssessTarget) => void;
}>(function RiskAssessmentPanel({ businessId, cur, horizon, computedAt, scopes, target, setTarget }, ref) {
  const [got, setGot] = useState<Got | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const q = `scope=${encodeURIComponent(target.scope)}&horizon_months=${horizon}${target.findingId ? `&finding_id=${encodeURIComponent(target.findingId)}` : ""}`;

  // Load the saved assessment for this scope and check it against the current figures (no AI call).
  useEffect(() => {
    let live = true;
    setError(null);
    api.get<Got>(`/api/whatif/businesses/${businessId}/risk/assessment?${q}`).then((g) => live && setGot(g)).catch((e) => live && setError(e.message));
    return () => { live = false; };
  }, [businessId, q, computedAt]);

  const request = async (refresh: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const g = await api.post<Got>(`/api/whatif/businesses/${businessId}/risk/assessment`,
        { scope: target.scope, finding_id: target.findingId, horizon_months: horizon, refresh });
      setGot((old) => ({ ...g, ai: old?.ai }));
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };

  const a = got?.assessment ?? null;
  const scopeLevers = scopes.find((s) => s.value === target.scope)?.levers ?? {};
  const aiOn = got?.ai?.configured;
  return (
    <div ref={ref} className="panel glass grid gap-5 p-4 md:p-5" aria-busy={busy} data-testid="risk-assessment">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-wrap items-end gap-2">
          <label className="field"><span>Assess</span>
            <select className="select" value={target.scope} onChange={(e) => setTarget({ scope: e.target.value, findingId: null })}>
              {scopes.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
            </select>
          </label>
          {target.findingId && (
            <span className="chip chip-accent">Selected warning: {a?.focus?.title ?? target.title}
              <button className="ml-1 underline" onClick={() => setTarget({ ...target, findingId: null })}>show overall</button></span>
          )}
        </div>
        <button className="btn btn-primary btn-sm" onClick={() => request(!!a && !!got?.current)} disabled={busy}>
          {busy && <Spinner />}{busy ? (aiOn ? "Writing assessment…" : "Building assessment…") : !a ? (aiOn ? "Get AI assessment" : "Get assessment") : got?.current ? "Refresh assessment" : "Assess current figures"}
        </button>
      </div>
      {busy && aiOn && <p className="text-[0.8rem] text-text-3" role="status">The AI is reading the Risk Radar findings; this can take up to a minute.</p>}
      {error && <ErrorBox message={error} />}
      {!a && !busy && (
        <p className="text-[0.9rem] text-text-2">
          {aiOn ? "Ask the AI to explain these warnings, suggest what to consider and what to avoid, and propose scenarios you can test." :
            "AI is not connected; an assessment can still be built from the Risk Radar rules."} Nothing is changed or simulated until you choose to.
        </p>
      )}
      {a && <AssessmentView a={a} current={!!got?.current} cached={!!got?.cached} cur={cur} businessId={businessId} scopeLevers={scopeLevers} horizon={horizon} />}
    </div>
  );
});

function AssessmentView({ a, current, cached, cur, businessId, scopeLevers, horizon }: {
  a: Assessment; current: boolean; cached: boolean; cur: string; businessId: number; scopeLevers: Levers; horizon: number;
}) {
  const titles = Object.fromEntries(a.detected.map((d) => [d.finding_id, d.title]));
  const rulesFilled = (k: string) => a.filled_from_rules.includes(k);
  const { now, later } = splitByTiming(a.level, a.recommended);
  return (
    <div className="grid gap-5">
      <div className="flex flex-wrap items-center gap-2 text-[0.8rem] text-text-3">
        <SeverityBadge s={a.level} suffix={a.focus ? "warning" : "risk"} />
        {a.focus && <span>Overall: {sevLabel(a.overall_level)}</span>}
        <KindTag kind={a.mode === "ai" ? "ai" : "rules"} title={a.mode === "ai" ? `Written by ${a.model}` : "Written from the Risk Radar rules"} />
        <span>{a.mode === "ai" ? `AI assessment (${a.model})` : "Rule-based assessment"} · {ago(a.created_at)}{cached ? " · saved copy, no new AI call" : ""}</span>
        <span className={current ? "" : "font-semibold text-[var(--sev-moderate)]"}>{current ? "· Matches the current figures" : "· Outdated"}</span>
      </div>
      {!current && (
        <Notice tone="warn"><span>Your business figures, this scenario or the external data have changed since this assessment. It is kept for reference; use “Assess current figures” for a new one.</span></Notice>
      )}
      {a.notice && <Notice><span>{a.notice}</span></Notice>}

      <Block title={a.labels.overview} rules={rulesFilled("overview")}>
        <p>{a.overview}</p>
        {a.priority && <p><b className="text-text">Priority:</b> {a.priority}</p>}
        {a.relationships && <p><b className="text-text">How these warnings relate:</b> {a.relationships}</p>}
      </Block>

      <Block title="Why this risk was detected">
        {a.detected.length === 0 ? <p>No Risk Radar rule crosses its threshold for these figures.</p> : (
          <ul className="grid gap-2">
            {a.detected.slice(0, a.focus ? 1 : 6).map((d) => (
              <li key={d.finding_id} className="grid gap-0.5">
                <span className="flex flex-wrap items-center gap-2"><span className={`inline-flex items-center gap-1 sev-${d.severity} !bg-transparent`} style={{ border: 0 }}><SevShape s={d.severity} />{sevLabel(d.severity)}</span><b className="text-text">{d.title}</b>
                  <KindTag kind={d.data_kind === "actual" ? "actual" : d.data_kind === "forecast" ? "forecast" : d.data_kind === "historical" ? "historical" : "calculated"} /></span>
                <span className="num">{d.metric.label}: {withUnit(d.metric.value, d.metric.unit, cur)}{d.metric.threshold != null && <> · warning threshold {withUnit(d.metric.threshold, d.metric.unit, cur)}</>}</span>
                <span className="text-[0.8rem] text-text-3">Rule: {d.rule_thresholds}</span>
              </li>
            ))}
            {!a.focus && a.detected.length > 6 && <li className="text-[0.8rem] text-text-3">…and {a.detected.length - 6} more in the warning list below.</li>}
          </ul>
        )}
      </Block>

      <div className="grid gap-5 md:grid-cols-2">
        <Block title={a.labels.recommended} rules={rulesFilled("recommended")} tone="good">
          <Items items={now} titles={titles} prefix="Recommended" />
          {later.length > 0 && <><h4 className="mt-2 text-[0.8rem] font-semibold text-text-3">{a.labels.next}</h4><Items items={later} titles={titles} prefix="Next" /></>}
        </Block>
        <Block title={a.labels.avoid} rules={rulesFilled("not_recommended")} tone="bad">
          {a.not_recommended.length === 0 ? <p>{a.not_recommended_none ?? "No action is clearly inadvisable from the available figures."}</p> :
            <Items items={a.not_recommended} titles={titles} prefix="Not recommended" />}
        </Block>
      </div>

      <div className="grid gap-5 md:grid-cols-2">
        <Block title={a.labels.impact}>
          <p><b className="text-text">If you test or follow the suggestions:</b> {a.expected_impact.if_followed}</p>
          <p><b className="text-text">If nothing changes:</b> {a.expected_impact.if_ignored}</p>
        </Block>
        <Block title={a.labels.monitor} rules={rulesFilled("monitor")}>
          <ul className="grid gap-1.5">{a.monitor.map((m, i) => <li key={i}><b className="text-text">{m.indicator}</b> <span>— {m.why}</span></li>)}</ul>
        </Block>
      </div>

      <Block title="Test this scenario" rules={rulesFilled("scenarios")}>
        <p className="text-[0.8rem] text-text-3">Proposed values only. Nothing runs or changes until you choose; your business figures stay as they are.</p>
        <div className="grid gap-3 lg:grid-cols-2">
          {a.scenarios.map((s, i) => <ScenarioTest key={`${a.created_at}-${i}`} s={s} titles={titles} cur={cur} businessId={businessId} scopeLevers={scopeLevers} horizon={horizon} scopeName={a.scope.name} isScenario={a.scope.kind === "scenario"} />)}
        </div>
      </Block>

      {(a.verify.length > 0 || a.limitations.length > 0) && (
        <div className="grid gap-5 md:grid-cols-2">
          {a.verify.length > 0 && <Block title={a.labels.verify}><ul className="grid gap-1 pl-4 [list-style:disc]">{a.verify.map((v, i) => <li key={i}>{v}</li>)}</ul></Block>}
          {a.limitations.length > 0 && <Block title="Limitations"><ul className="grid gap-1 pl-4 [list-style:disc]">{a.limitations.map((v, i) => <li key={i}>{v}</li>)}</ul></Block>}
        </div>
      )}
      <p className="text-[0.78rem] text-text-3">{a.disclaimer}</p>
    </div>
  );
}

function Block({ title, children, rules = false, tone }: { title: string; children: React.ReactNode; rules?: boolean; tone?: "good" | "bad" }) {
  return (
    <section className="grid content-start gap-2 text-[0.88rem] text-text-2">
      <h3 className="flex items-center gap-2 text-[0.82rem] font-semibold uppercase tracking-[0.06em] text-text-3">
        {tone && <span aria-hidden="true" className={tone === "good" ? "text-[var(--accent)]" : "text-[var(--sev-high)]"}>{tone === "good" ? "✓" : "✕"}</span>}
        {title}{rules && <KindTag kind="rules" title="This section was written from the Risk Radar rules" />}
      </h3>
      {children}
    </section>
  );
}

function Items({ items, titles, prefix }: { items: { action: string; reason: string; finding_ids: string[] }[]; titles: Record<string, string>; prefix: string }) {
  return (
    <ol className="grid gap-2.5">
      {items.map((r, i) => (
        <li key={i} className="grid gap-0.5">
          <span><span className="sr-only">{prefix}: </span><b className="text-text">{i + 1}. {r.action}</b></span>
          <span>Reason: {r.reason}</span>
          {r.finding_ids.length > 0 && <span className="text-[0.78rem] text-text-3">Related warning: {r.finding_ids.map((id) => titles[id] ?? id).join("; ")}</span>}
        </li>
      ))}
    </ol>
  );
}

interface SimOut { result: SimResult; risks: { scenario: RiskReport; baseline: RiskReport } }

/** One proposed scenario: editable values, an explicit run, and the calculated result beside the reference. */
function ScenarioTest({ s, titles, cur, businessId, scopeLevers, horizon, scopeName, isScenario }: {
  s: Assessment["scenarios"][number]; titles: Record<string, string>; cur: string; businessId: number; scopeLevers: Levers; horizon: number; scopeName: string; isScenario: boolean;
}) {
  const nav = useNavigate();
  const [change, setChange] = useState<Levers>(s.levers);
  const [res, setRes] = useState<{ ref: SimOut | null; out: SimOut; key: string } | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const merged = mergeProposal(scopeLevers, change, horizon);
  const key = JSON.stringify(change);
  const editable = EDITABLE.filter((k) => typeof change[k] === "number");
  const other = describeLevers(Object.fromEntries(Object.entries(change).filter(([k]) => !(EDITABLE as readonly string[]).includes(k))) as Levers, cur);

  const run = async () => {
    setRunning(true);
    setError(null);
    try {
      const sim = (lv: Levers) => api.post<SimOut>(`/api/whatif/businesses/${businessId}/simulate`, { levers: lv });
      // For a saved scenario, compare against that scenario too (not only the current course).
      const [out, ref] = await Promise.all([sim(merged), isScenario ? sim({ ...scopeLevers, start_month: null }) : Promise.resolve(null)]);
      setRes({ out, ref, key });
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setRunning(false); }
  };
  const stale = res != null && res.key !== key;
  const p = res?.out.result;
  const base = p?.baseline;
  const refP = res?.ref?.result.scenario ?? base;
  const refLevel: Severity | undefined = res?.ref ? res.ref.risks.scenario.level : undefined;
  const diff = p && refP ? p.scenario.totals.net_profit - refP.totals.net_profit : null;

  return (
    <div className="panel grid content-start gap-3 p-3.5" data-testid="scenario-test">
      <div className="grid gap-0.5">
        <b className="text-text">{s.title}</b>
        <span className="text-[0.84rem]">{s.rationale}</span>
        {s.finding_ids.length > 0 && <span className="text-[0.76rem] text-text-3">For: {s.finding_ids.map((id) => titles[id] ?? id).join("; ")}</span>}
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        {editable.map((k) => (
          <label key={k} className="field"><span>{LEVER_LABELS[k] ?? k}{k.endsWith("_pct") ? " (%)" : k.endsWith("_pts") ? " (pts)" : ""}</span>
            <input className="input input-num" type="number" step="any" value={change[k] as number}
              onChange={(e) => setChange({ ...change, [k]: e.target.value === "" ? 0 : Number(e.target.value) })} />
          </label>
        ))}
      </div>
      {other.length > 0 && <ul className="text-[0.82rem]">{other.map((o) => <li key={o}>{o}</li>)}</ul>}
      <div className="flex flex-wrap gap-2">
        <button className="btn btn-sm btn-primary" onClick={run} disabled={running}>{running && <Spinner />}{res && !stale ? "Run again" : "Run this simulation"}</button>
        <button className="btn btn-sm btn-outline" onClick={() => nav(`/app/simulate?levers=${encodeURIComponent(JSON.stringify(merged))}`)}>Review in simulator</button>
      </div>
      {error && <ErrorBox message={error} />}
      {!res && <p className="text-[0.78rem] text-text-3">Not simulated yet, so its effect is unknown.</p>}
      {p && base && refP && (
        <div className={`grid gap-1.5 ${stale ? "opacity-60" : ""}`} aria-live="polite">
          <div className="flex items-center gap-2"><KindTag kind="calculated" />{stale && <span className="text-[0.78rem] text-[var(--sev-moderate)]">Values changed since this run; run again.</span>}</div>
          <div className="table-wrap">
            <table className="data text-[0.82rem]">
              <thead><tr><th></th><th className="n">Current course</th>{isScenario && <th className="n">{scopeName.replace(/^the scenario /, "")}</th>}<th className="n">With this change</th></tr></thead>
              <tbody>
                <tr><td>Net profit ({p.scenario.horizon_months} mo)</td><td className="n">{money(base.totals.net_profit, cur)}</td>{isScenario && <td className="n">{money(refP.totals.net_profit, cur)}</td>}<td className="n">{money(p.scenario.totals.net_profit, cur)}</td></tr>
                <tr><td>Revenue</td><td className="n">{money(base.totals.revenue, cur)}</td>{isScenario && <td className="n">{money(refP.totals.revenue, cur)}</td>}<td className="n">{money(p.scenario.totals.revenue, cur)}</td></tr>
                <tr><td>Lowest cash</td><td className="n">{money(base.metrics.min_cash, cur)}</td>{isScenario && <td className="n">{money(refP.metrics.min_cash, cur)}</td>}<td className="n">{money(p.scenario.metrics.min_cash, cur)}</td></tr>
                <tr><td>Risk level</td><td className="n"><SeverityBadge s={res.out.risks.baseline.level} /></td>{isScenario && refLevel && <td className="n"><SeverityBadge s={refLevel} /></td>}<td className="n"><SeverityBadge s={res.out.risks.scenario.level} /></td></tr>
              </tbody>
            </table>
          </div>
          {diff != null && (
            <p className="text-[0.84rem]">
              Calculated: net profit is {money(Math.abs(diff), cur)} {diff >= 0 ? "higher" : "lower"} than {isScenario ? "the scenario as saved" : "the current course"} under the same assumptions. This is a simulation, not a guarantee.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
