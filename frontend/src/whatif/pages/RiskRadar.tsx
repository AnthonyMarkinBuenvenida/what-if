import { useMemo, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { AnimatePresence, motion } from "motion/react";
import { api } from "../../lib/api";
import { useAsync, useReduced } from "../../lib/hooks";
import { useWorkspace } from "../../app/workspace";
import { ErrorBox, Skeleton, Spinner } from "../../components/ui";
import { RiskCompare, type Financials, type RadarScenario } from "../RiskCompare";
import { ago, withUnit } from "../format";
import type { Finding, RiskReport, Severity, Signal } from "../types";
import { KindTag, NeedsProfile, PageTitle, Section, SeverityBadge, SevShape, sevLabel, useProfile } from "../ui";
import { RiskAssessmentPanel, type AssessTarget } from "../RiskAssessment";
import { scrollToY } from "../../lib/scrollfx";

interface Radar {
  computed_at: string; profile_version: number; horizon_months: number; currency: string; unit_label?: string; baseline: RiskReport; baseline_financials?: Financials;
  scenarios: RadarScenario[];
  signals: Record<string, Signal>; rules: { id: string; category_label: string; metric: string; thresholds: string; why: string }[]; categories: Record<string, string>; older_automatic_runs?: number;
}

const SEVS: Severity[] = ["critical", "high", "moderate", "low"];

export default function RiskRadar() {
  const { current } = useWorkspace();
  const prof = useProfile(current?.id);
  const nav = useNavigate();
  const reduced = useReduced();
  const { data, error, loading, reload } = useAsync<Radar | null>(
    () => (current && prof.profile ? api.get<Radar>(`/api/whatif/businesses/${current.id}/risk`) : Promise.resolve(null)), [current?.id, prof.profile?.id]);
  const [params] = useSearchParams();
  const linked = params.get("scenario");  // from the simulator: compare and assess that scenario
  // The compared scenario: the one linked from the simulator, otherwise the last one chosen for this business.
  const pickKey = `whatif-risk-compare-${current?.id ?? 0}`;
  const [compareId, setCompareIdState] = useState<number | null>(() => {
    if (linked) return +linked;
    try { const v = localStorage.getItem(pickKey); return v ? +v : null; } catch { return null; }
  });
  const setCompareId = (id: number) => { setCompareIdState(id); try { localStorage.setItem(pickKey, String(id)); } catch { /* storage unavailable */ } };
  const [scope, setScope] = useState<string>("all");
  const [sevs, setSevs] = useState<Severity[]>([]);
  const [cat, setCat] = useState("");
  const [metric, setMetric] = useState("");
  const [since, setSince] = useState(0);
  const [open, setOpen] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [target, setTarget] = useState<AssessTarget>({ scope: linked ?? "baseline", findingId: null });
  const assessRef = useRef<HTMLDivElement>(null);

  const all = useMemo(() => data ? [...data.baseline.findings, ...data.scenarios.flatMap((s) => s.findings)] : [], [data]);
  const inScope = (f: Finding) => scope === "all" || (scope === "baseline" ? f.scenario_id == null : String(f.scenario_id) === scope);
  const shown = all.filter((f) =>
    inScope(f)
    && (!sevs.length || sevs.includes(f.severity)) && (!cat || f.category === cat) && (!metric || f.metric.label === metric)
    && (!since || (f.created_at && Date.now() - new Date(f.created_at).getTime() <= since * 86400000)));
  const metrics = [...new Set(all.map((f) => f.metric.label))].sort();
  const cats = [...new Set(all.map((f) => f.category))];

  if (!current || (!prof.loading && !prof.profile)) return <div className="grid gap-6"><PageTitle title="Risk Radar" /><NeedsProfile state={prof} /></div>;
  if (error) return <ErrorBox message={error} onRetry={reload} />;
  if (loading || !data) return <div className="grid gap-4"><Skeleton h={60} w="40%" /><Skeleton h={260} /></div>;
  const cur = data.currency;

  const simulate = (f: Finding, levers: object) => {
    // A scenario's warning is tested on top of that scenario; the current course's on its own.
    const base = f.scenario_id != null ? data.scenarios.find((s) => s.id === f.scenario_id)?.levers ?? {} : {};
    nav(`/app/simulate?levers=${encodeURIComponent(JSON.stringify({ ...base, ...levers, start_month: null }))}`);
  };
  const assessWarning = (f: Finding) => {
    setTarget({ scope: f.scenario_id != null ? String(f.scenario_id) : "baseline", findingId: f.id, title: f.title });
    const el = assessRef.current;
    if (el) scrollToY(window.scrollY + el.getBoundingClientRect().top - 90);
  };
  const scopes = [{ value: "baseline", label: "Current business", levers: {} },
    ...data.scenarios.map((s) => ({ value: String(s.id), label: `Scenario: ${s.name}`, levers: s.levers }))];
  const refresh = async () => {
    setRefreshing(true);
    try { await api.post(`/api/whatif/businesses/${current.id}/signals/refresh`); await reload(); } finally { setRefreshing(false); }
  };

  return (
    <div className="grid gap-8">
      <PageTitle title="Risk Radar"
        sub={<>Every warning comes from a written rule with a threshold, checked against calculated results, your entered history and retrieved external data. Recalculated {ago(data.computed_at)} on profile v{data.profile_version}, {data.horizon_months}-month period.</>}
        actions={<button className="btn btn-outline" onClick={reload}>Recalculate</button>} />

      <Section title="Current business vs scenario">
        <RiskCompare baseline={data.baseline} baselineFinancials={data.baseline_financials} profileVersion={data.profile_version} scenarios={data.scenarios} cur={cur} unit={data.unit_label ?? "units"}
          selected={data.scenarios.find((x) => x.id === compareId) ?? data.scenarios[0] ?? null} onSelect={setCompareId} />
      </Section>

      <div className="grid gap-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <span className="text-[0.82rem] text-text-3" data-testid="tiles-scope">Warnings in: {scope === "all" ? `the current business and ${data.scenarios.length} scenario${data.scenarios.length === 1 ? "" : "s"}` : scope === "baseline" ? "the current business" : `scenario “${data.scenarios.find((x) => String(x.id) === scope)?.name ?? ""}”`} (change with Scope below)</span>
        </div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {SEVS.map((sv) => (
            <button key={sv} className={`panel interactive grid gap-1 p-3 text-left ${sevs.includes(sv) ? "!border-[var(--signal)]" : ""}`} aria-pressed={sevs.includes(sv)}
              onClick={() => setSevs(sevs.includes(sv) ? sevs.filter((x) => x !== sv) : [...sevs, sv])}>
              <span className={`inline-flex items-center gap-1.5 text-[0.82rem] font-semibold sev-${sv} !bg-transparent`} style={{ border: 0 }}><SevShape s={sv} />{sevLabel(sv)}</span>
              <span className="kpi text-[1.8rem]">{all.filter((f) => inScope(f) && f.severity === sv).length}</span>
            </button>
          ))}
        </div>
        {!!data.older_automatic_runs && <p className="text-[0.78rem] text-text-3">Showing named scenarios and the 5 latest automatic runs; {data.older_automatic_runs} older automatic run{data.older_automatic_runs > 1 ? "s are" : " is"} in <Link to="/app/history" className="underline">History</Link>.</p>}
        {data.scenarios.length > 0 && (
          <div className="table-wrap" data-testid="radar-table">
            <table className="data min-w-[640px]">
              <thead><tr><th>Scenario</th><th className="n">Risk score</th><th>Level today</th><th className="n">Warnings</th><th>As saved</th></tr></thead>
              <tbody>
                <tr><td>Current business</td><td className="n">{data.baseline.score}</td><td><SeverityBadge s={data.baseline.level} /></td><td className="n">{data.baseline.findings.length}</td><td className="text-text-3">—</td></tr>
                {data.scenarios.map((sc) => (
                  <tr key={sc.id}>
                    <td><Link to={`/app/simulate?scenario=${sc.id}`} className="underline">{sc.name}</Link></td>
                    <td className="n">{sc.score}</td><td><SeverityBadge s={sc.level} /></td><td className="n">{sc.findings.length}</td>
                    <td>{sc.inputs_changed && sc.saved?.level
                      ? <span className="inline-flex items-center gap-1.5 text-[0.8rem]"><SeverityBadge s={sc.saved.level} suffix={`· ${sc.saved.score}`} /><span className="text-text-3">profile v{sc.saved.profile_version}</span></span>
                      : <span className="text-[0.8rem] text-text-3">same as today</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="text-[0.78rem] text-text-3">“Level today” applies each scenario's changes to your current business figures. “As saved” is the assessment stored with the scenario, shown when your figures have changed since; opening a saved simulation always shows its saved assessment.</p>
      </div>

      <Section title="Assessment and recommendations">
        <RiskAssessmentPanel ref={assessRef} businessId={current.id} cur={cur} horizon={data.horizon_months} computedAt={data.computed_at}
          scopes={scopes} target={target} setTarget={setTarget} />
      </Section>

      <Section title={`Warnings (${shown.length})`}>
        <div className="flex flex-wrap items-end gap-2" role="group" aria-label="Filters">
          <label className="field"><span>Scope</span>
            <select className="select" value={scope} onChange={(e) => setScope(e.target.value)}>
              <option value="all">Everything</option><option value="baseline">Current business</option>
              {data.scenarios.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </label>
          <label className="field"><span>Category</span>
            <select className="select" value={cat} onChange={(e) => setCat(e.target.value)}>
              <option value="">All categories</option>{cats.map((c) => <option key={c} value={c}>{data.categories[c]}</option>)}
            </select>
          </label>
          <label className="field"><span>Affected metric</span>
            <select className="select" value={metric} onChange={(e) => setMetric(e.target.value)}>
              <option value="">All metrics</option>{metrics.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          </label>
          <label className="field"><span>Created</span>
            <select className="select" value={since} onChange={(e) => setSince(+e.target.value)}>
              <option value={0}>Any time</option><option value={1}>Last 24 hours</option><option value={7}>Last 7 days</option><option value={30}>Last 30 days</option>
            </select>
          </label>
          {(sevs.length || cat || metric || since || scope !== "all") ? <button className="btn btn-quiet btn-sm" onClick={() => { setSevs([]); setCat(""); setMetric(""); setSince(0); setScope("all"); }}>Clear filters</button> : null}
        </div>
        {shown.length === 0 ? <p className="panel p-4 text-text-2">No warnings match these filters.</p> : (
          <ul className="grid gap-2">
            {shown.map((f) => {
              const isOpen = open === f.id + (f.scenario_id ?? "");
              return (
                <motion.li key={f.id + (f.scenario_id ?? "")} className="panel overflow-hidden">
                  <button className="interactive flex w-full flex-wrap items-start gap-3 p-4 text-left" onClick={() => setOpen(isOpen ? null : f.id + (f.scenario_id ?? ""))} aria-expanded={isOpen}>
                    <SeverityBadge s={f.severity} />
                    <span className="grid min-w-0 flex-1 gap-1">
                      <span className="font-semibold">{sevLabel(f.severity)} risk: {f.title}</span>
                      <span className="text-[0.87rem] text-text-2">{f.summary}</span>
                      <span className="flex flex-wrap gap-x-3 gap-y-1 text-[0.78rem] text-text-3">
                        <span>{f.category_label}</span><span>{f.scenario_name}</span>
                        <span>{f.metric.label}: {withUnit(f.metric.value, f.metric.unit, cur)}{f.metric.threshold != null && <> (threshold {withUnit(f.metric.threshold, f.metric.unit, cur)})</>}</span>
                      </span>
                    </span>
                    <KindTag kind={f.data_kind === "actual" ? "actual" : f.data_kind === "forecast" ? "forecast" : f.data_kind === "historical" ? "historical" : "calculated"} />
                  </button>
                  <AnimatePresence initial={false}>
                    {isOpen && (
                      <motion.div initial={reduced ? false : { height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={reduced ? undefined : { height: 0, opacity: 0 }} transition={{ duration: 0.25 }}>
                        <div className="grid gap-5 border-t border-line p-4 md:grid-cols-2">
                          <div className="grid content-start gap-3">
                            <Detail title="Why this appeared">
                              <p>Rule: {f.threshold}.</p>
                              <p className="text-text-3">{f.why}</p>
                              {f.triggered_by.length > 0 && <p>Triggered by: {f.triggered_by.join(", ")}.</p>}
                            </Detail>
                            {f.evidence.length > 0 && (
                              <Detail title="Evidence">
                                <dl className="grid gap-1">
                                  {f.evidence.map((e, i) => <div key={i} className="flex justify-between gap-3"><dt className="text-text-2">{e.label}</dt><dd className="num">{withUnit(e.value, e.unit, cur)}</dd></div>)}
                                </dl>
                              </Detail>
                            )}
                          </div>
                          <div className="grid content-start gap-3">
                            {f.impact && <Detail title="Estimated impact"><p className="num">{f.impact.label}: <b>{withUnit(f.impact.value, f.impact.unit, cur)}</b> ({f.impact.period})</p></Detail>}
                            {f.if_no_action && <Detail title="If nothing changes"><p>{f.if_no_action}</p></Detail>}
                            {f.actions.length > 0 && (
                              <Detail title="Recommended actions">
                                <ol className="grid gap-1.5">
                                  {f.actions.map((a, i) => (
                                    <li key={i} className="flex flex-wrap items-center justify-between gap-2">
                                      <span>{i + 1}. {a.label}</span>
                                      {a.levers && Object.keys(a.levers).length > 0 && <button className="btn btn-sm btn-outline" onClick={() => simulate(f, a.levers)}>Simulate this</button>}
                                    </li>
                                  ))}
                                </ol>
                              </Detail>
                            )}
                            <button className="btn btn-sm btn-outline justify-self-start" onClick={() => assessWarning(f)}>Assess this warning</button>
                            {f.scenario_id != null && <Link to={`/app/simulate?scenario=${f.scenario_id}`} className="text-[0.85rem] underline">Open the scenario “{f.scenario_name}”</Link>}
                          </div>
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </motion.li>
              );
            })}
          </ul>
        )}
      </Section>

      <div className="grid gap-8 lg:grid-cols-2">
        <Section title="External conditions" aside={<button className="btn btn-sm btn-outline" onClick={refresh} disabled={refreshing}>{refreshing && <Spinner />}Refresh</button>}>
          {Object.keys(data.signals).length === 0 ? <p className="text-text-2">No external data retrieved yet for this business. Refresh to fetch what is relevant to its industry.</p> : (
            <ul className="panel divide text-[0.86rem]">
              {Object.entries(data.signals).map(([k, s]) => (
                <li key={k} className="grid gap-0.5 px-4 py-2.5">
                  <div className="flex items-center justify-between gap-2"><span className="font-medium">{s.label}</span><KindTag kind={s.kind === "forecast" ? "forecast" : s.kind === "historical" ? "historical" : "observed"} /></div>
                  <span className="text-text-2">{s.status === "ok" || s.status === "stale" ? s.summary : s.reason ?? `Retrieval failed (${s.status}).`}</span>
                  {s.status === "stale" && <span className="text-[0.76rem] text-[var(--sev-moderate)]">Last refresh failed; showing the last good value from {ago(s.retrieved_at)}.</span>}
                  <span className="text-[0.76rem] text-text-3">{s.source} · {s.retrieved_at ? `retrieved ${ago(s.retrieved_at)}` : "not retrieved"}</span>
                </li>
              ))}
            </ul>
          )}
          <p className="text-[0.78rem] text-text-3">Retrieved on request only; What-if does not monitor these sources in the background.</p>
        </Section>
        <Section title="How risk levels are decided">
          <details className="panel p-4 text-[0.85rem]">
            <summary className="cursor-pointer">{data.rules.length} rules, written thresholds</summary>
            <p className="mt-2 text-text-2">{data.baseline.method}</p>
            <ul className="mt-3 grid gap-2">
              {data.rules.map((r) => <li key={r.id}><b>{r.metric}</b> <span className="text-text-3">({r.category_label})</span><br /><span className="text-text-2">{r.thresholds}</span></li>)}
            </ul>
          </details>
        </Section>
      </div>
    </div>
  );
}

function Detail({ title, children }: { title: string; children: React.ReactNode }) {
  return <div className="grid gap-1.5 text-[0.86rem]"><h3 className="text-[0.8rem] font-semibold text-text-3">{title}</h3><div className="grid gap-1">{children}</div></div>;
}
