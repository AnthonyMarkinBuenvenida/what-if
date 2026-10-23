import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../../lib/api";
import { useAsync } from "../../lib/hooks";
import { useWorkspace } from "../../app/workspace";
import { ErrorBox, Skeleton, Spinner } from "../../components/ui";
import { IconPlay } from "../../components/icons";
import { ProjectionChart } from "../charts";
import { ago, compact, money, pct } from "../format";
import type { AIStatus, Finding, HistoryRow, IndustryInfo, Metrics, ScenarioSummary, Severity, Signal } from "../types";
import { SignalStatus } from "../ExternalData";
import { DemoButton, KindTag, Kpi, NeedsProfile, PageTitle, Section, SeverityBadge, useProfile } from "../ui";

interface Dash {
  business: { id: number; name: string; is_demo: boolean }; profile_version: number; profile_updated_at: string; industry: IndustryInfo;
  currency: string; unit_label: string; default_share: number; history: HistoryRow[];
  baseline: { months: { month: string; revenue: number; net_profit: number; cash: number; units: number }[]; totals: Record<string, number>; metrics: Metrics; monthly_avg: Record<string, number> };
  risk: { score: number; level: Severity; counts: Record<Severity, number>; findings: Finding[] };
  scenarios: ScenarioSummary[]; insights: { scenario_id: number; scenario: string; mode: string; summary: string; created_at: string }[];
  signals: Record<string, Signal>; relevant_signals: string[]; ai: AIStatus; validation: { issues: { severity: string; message: string }[] };
}

const SIGNAL_LABEL: Record<string, string> = { gdp: "GDP growth", weather: "Weather (current and forecast)", inflation: "Consumer price inflation", lending: "Lending interest rate", fx: "Exchange rate vs US dollar", market: "Stock price" };

export default function Dashboard() {
  const { current, businesses } = useWorkspace();
  const prof = useProfile(current?.id);
  const nav = useNavigate();
  const { data, error, loading, reload } = useAsync<Dash | null>(
    () => (current && prof.profile ? api.get<Dash>(`/api/whatif/businesses/${current.id}/dashboard`) : Promise.resolve(null)), [current?.id, prof.profile?.id]);
  const [refreshing, setRefreshing] = useState(false);

  if (!businesses.length) return <Onboarding />;
  if (!current || (!prof.loading && !prof.profile)) return <div className="grid gap-6"><PageTitle title="Dashboard" /><NeedsProfile state={prof} /></div>;
  if (error) return <ErrorBox message={error} onRetry={reload} />;
  if (loading || !data) return <div className="grid gap-4"><Skeleton h={60} w="50%" /><Skeleton h={300} /><Skeleton h={180} /></div>;

  const cur = data.currency;
  const m = data.baseline.metrics;
  const avg = data.baseline.monthly_avg;
  const refresh = async () => {
    setRefreshing(true);
    try { await api.post(`/api/whatif/businesses/${current.id}/signals/refresh`); await reload(); } finally { setRefreshing(false); }
  };
  return (
    <div className="grid gap-8">
      <PageTitle title={data.business.name}
        kicker={<div className="flex flex-wrap items-center gap-2 text-[0.82rem] text-text-3"><span>{data.industry.label}</span><span aria-hidden="true">/</span><span>profile v{data.profile_version}, updated {ago(data.profile_updated_at)}</span>{data.business.is_demo && <KindTag kind="demo" />}</div>}
        sub={data.business.is_demo ? "Every figure here is fictional demo data, calculated by the real engine." : data.default_share > 0 ? <>{Math.round(data.default_share * 100)}% of the core figures are still What-if estimates. <Link to="/app/setup" className="underline">Replace them with yours</Link> to make results meaningful.</> : "All core figures are yours."}
        actions={<button className="btn btn-signal btn-lg" onClick={() => nav("/app/simulate")}><IconPlay size={16} />New simulation</button>} />

      <section className="panel glass grid gap-6 p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-[1.02rem] font-semibold">Current course, next 12 months</h2>
          <div className="flex gap-2">{data.history.length > 0 && <KindTag kind="actual" />}<KindTag kind="calculated" /></div>
        </div>
        <div className="grid grid-cols-2 gap-x-6 gap-y-5 lg:grid-cols-4">
          <Kpi label="Revenue per month" value={compact(avg.revenue, cur)} sub={`${compact(data.baseline.totals.revenue, cur)} over 12 months`} big />
          <Kpi label="Net profit per month" value={compact(avg.net_profit, cur)} sub={`net margin ${pct(m.net_margin)}`} />
          <Kpi label={`Break-even ${data.unit_label}`} value={m.break_even_units == null ? "none" : Math.round(m.break_even_units).toLocaleString()} sub={`selling ${Math.round(avg.units).toLocaleString()} a month`} />
          <Kpi label="Lowest cash" value={compact(m.min_cash, cur)} sub={`ending ${compact(m.ending_cash, cur)}`} />
        </div>
        <ProjectionChart months={data.baseline.months.map((x) => x.month)} history={data.history.map((h) => ({ month: h.month, value: h.revenue }))}
          series={[{ key: "rev", label: "Revenue, current course", values: data.baseline.months.map((x) => x.revenue), color: "var(--series-baseline)", dash: "6 5", shape: "ring" }]}
          format={(v) => compact(v, cur)} ariaLabel="Monthly revenue: actual results and the current-course projection" height={240} />
      </section>

      <div className="grid gap-8 lg:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]">
        <Section title="Active risk alerts" aside={<Link to="/app/risk" className="text-[0.85rem] underline">Risk Radar · score {data.risk.score}</Link>}>
          {data.risk.findings.length === 0 ? <p className="panel p-4 text-text-2">No rule is triggered on the current course.</p> : (
            <ul className="grid gap-2">
              {data.risk.findings.map((f) => (
                <li key={f.id} className="panel flex flex-wrap items-start gap-3 p-3">
                  <SeverityBadge s={f.severity} />
                  <div className="grid min-w-0 flex-1 gap-0.5"><span className="font-semibold">{f.title}</span><span className="text-[0.85rem] text-text-2">{f.summary}</span></div>
                </li>
              ))}
            </ul>
          )}
        </Section>
        <Section title="Recent scenarios" aside={<Link to="/app/compare" className="text-[0.85rem] underline">Compare</Link>}>
          {data.scenarios.length === 0 ? <p className="panel p-4 text-text-2">No saved scenarios yet. <Link className="underline" to="/app/simulate">Run your first simulation</Link>.</p> : (
            <ul className="panel divide">
              {data.scenarios.map((s) => (
                <li key={s.id}>
                  <Link to={`/app/simulate?scenario=${s.id}`} className="interactive flex items-center justify-between gap-3 px-4 py-3 no-underline">
                    <span className="grid min-w-0"><span className="truncate font-medium">{s.name}</span><span className="text-[0.78rem] text-text-3">{ago(s.created_at)}</span></span>
                    <span className="grid justify-items-end">
                      <span className="num text-[0.9rem]">{money(s.summary.net_profit, cur)}</span>
                      {s.summary.risk_level && <span className="text-[0.75rem] text-text-3">risk {s.summary.risk_score}</span>}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>

      <div className="grid gap-8 lg:grid-cols-2">
        <Section title="Recent insights">
          {data.insights.length === 0 ? <p className="text-text-2">Explanations of saved scenarios appear here.</p> : (
            <ul className="grid gap-2">
              {data.insights.map((i) => (
                <li key={i.scenario_id} className="panel grid gap-1.5 p-3">
                  <div className="flex items-center justify-between gap-2"><span className="text-[0.85rem] font-semibold">{i.scenario}</span><KindTag kind={i.mode === "ai" ? "ai" : "rules"} /></div>
                  <p className="text-[0.86rem] text-text-2">{i.summary}</p>
                </li>
              ))}
            </ul>
          )}
        </Section>
        <Section title="Data connections" aside={<button className="btn btn-sm btn-outline" onClick={refresh} disabled={refreshing}>{refreshing && <Spinner />}Refresh signals</button>}>
          <ul className="panel divide text-[0.86rem]">
            <li className="flex items-center justify-between gap-3 px-4 py-2.5">
              <span>AI interpretation</span>
              <span className={data.ai.configured ? "chip chip-ai" : "chip"}>{data.ai.configured ? `${data.ai.provider} · ${data.ai.model}` : "not connected"}</span>
            </li>
            {data.relevant_signals.map((k) => {
              const s = data.signals[k];
              return (
                <li key={k} className="grid gap-0.5 px-4 py-2.5">
                  <div className="flex items-center justify-between gap-3">
                    <span>{s?.label ?? SIGNAL_LABEL[k] ?? k}</span>
                    <SignalStatus s={s} />
                  </div>
                  {s?.summary && <span className="text-[0.8rem] text-text-3">{s.summary} ({s.source}, {s.kind})</span>}
                  {s?.reason && <span className="text-[0.8rem] text-text-3">{s.reason}</span>}
                </li>
              );
            })}
          </ul>
          <p className="text-[0.78rem] text-text-3">Signals are retrieved when you refresh them. Nothing is monitored in the background.</p>
        </Section>
      </div>
    </div>
  );
}

function Onboarding() {
  return (
    <div className="grid min-h-[60vh] content-center gap-6">
      <div className="grid max-w-2xl gap-3">
        <h1 className="t-display text-[clamp(2.2rem,1.6rem+2.6vw,3.6rem)]">Start with a business</h1>
        <p className="text-[1.05rem] text-text-2">Set up your own business from an industry template, or open the demo milk tea shop. The demo uses fictional figures and is labelled as demo data everywhere.</p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Link to="/app/setup?new=1" className="btn btn-primary btn-lg">Set up my business</Link>
        <DemoButton className="btn btn-lg" />
      </div>
    </div>
  );
}
