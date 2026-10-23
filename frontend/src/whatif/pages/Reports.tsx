import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api } from "../../lib/api";
import { useAsync } from "../../lib/hooks";
import { useWorkspace } from "../../app/workspace";
import { ErrorBox, Skeleton, Spinner } from "../../components/ui";
import { IconDownload, IconPrint, IconTrash } from "../../components/icons";
import { BridgeChart, ProjectionChart } from "../charts";
import { ago, compact, money, num, pct, signedMoney, when } from "../format";
import type { Assumption, Explanation, Finding, ScenarioSummary, Severity } from "../types";
import { KindTag, NeedsProfile, PageTitle, Section, SeverityBadge, SourceBadge, useProfile } from "../ui";

export default function Reports() {
  const { current } = useWorkspace();
  const prof = useProfile(current?.id);
  const nav = useNavigate();
  const list = useAsync<{ id: number; title: string; created_at: string; ai: boolean }[]>(() => (current && prof.profile ? api.get(`/api/whatif/businesses/${current.id}/reports`) : Promise.resolve([])), [current?.id, prof.profile?.id]);
  const scen = useAsync<ScenarioSummary[]>(() => (current && prof.profile ? api.get(`/api/whatif/businesses/${current.id}/scenarios`) : Promise.resolve([])), [current?.id, prof.profile?.id]);
  const [sel, setSel] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  if (!current || (!prof.loading && !prof.profile)) return <div className="grid gap-6"><PageTitle title="Reports" /><NeedsProfile state={prof} /></div>;
  const create = async () => {
    setBusy(true);
    setErr(null);
    try { const r = await api.post<{ id: number }>(`/api/whatif/businesses/${current.id}/reports`, { scenario_ids: sel }); nav(`/app/reports/w/${r.id}`); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };
  return (
    <div className="grid gap-8">
      <PageTitle title="Reports" sub="A report freezes the scenarios, their assumptions, the calculated results, risks and explanations at the moment you create it. Export the numbers as CSV or print it to PDF."
        actions={<Link to="/app/reports/legacy" className="btn btn-outline btn-sm">Retail lab reports</Link>} />
      <Section title="New report">
        <div className="panel glass grid gap-3 p-5">
          {scen.loading ? <Skeleton h={60} /> : !scen.data?.length ? <p className="text-text-2">Save scenarios in <Link to="/app/simulate" className="underline">Simulate</Link> first.</p> : (
            <>
              <div className="grid gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
                {scen.data.map((s) => (
                  <label key={s.id} className="flex items-center gap-2 rounded-[var(--r-control)] border border-line px-3 py-2 text-[0.88rem]">
                    <input type="checkbox" checked={sel.includes(s.id)} disabled={!sel.includes(s.id) && sel.length >= 8} onChange={(e) => setSel(e.target.checked ? [...sel, s.id] : sel.filter((x) => x !== s.id))} />
                    <span className="truncate">{s.name}</span>
                  </label>
                ))}
              </div>
              <div className="flex items-center gap-2"><button className="btn btn-primary" onClick={create} disabled={busy || !sel.length}>{busy && <Spinner />}Create report</button>{err && <span className="error-text">{err}</span>}</div>
            </>
          )}
        </div>
      </Section>
      <Section title="Saved reports">
        {list.error ? <ErrorBox message={list.error} onRetry={list.reload} /> : !list.data?.length ? <p className="text-text-2">No reports yet.</p> : (
          <ul className="panel divide">
            {list.data.map((r) => (
              <li key={r.id} className="flex items-center justify-between gap-3 px-4 py-3">
                <Link to={`/app/reports/w/${r.id}`} className="grid min-w-0 no-underline"><span className="truncate font-medium underline-offset-2 hover:underline">{r.title}</span><span className="text-[0.78rem] text-text-3">{when(r.created_at)}{r.ai ? " · with AI narrative" : ""}</span></Link>
                <span className="flex gap-1">
                  <a className="btn btn-sm btn-outline" href={`/api/whatif/reports/${r.id}/csv`}><IconDownload size={14} />CSV</a>
                  <button className="btn btn-quiet btn-sm" aria-label="Delete report" onClick={async () => { if (confirm("Delete this report?")) { await api.del(`/api/whatif/reports/${r.id}`); list.reload(); } }}><IconTrash size={15} /></button>
                </span>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}

interface ReportScenario {
  id: number; name: string; question: string; levers: Record<string, unknown>; assumptions: Assumption[];
  delta: Record<string, { baseline: number | null; scenario: number | null; change: number | null }>;
  bridge: { key: string; label: string; value: number; note: string }[]; bands: { best: number; worst: number };
  months: { month: string; revenue: number; net_profit: number; cash: number }[]; baseline_months: { month: string; revenue: number; net_profit: number; cash: number }[];
  risks: { score: number; level: Severity; findings: Finding[] }; explanation: Explanation; saved_explanation: Explanation | null;
  confidence: { level: string; score: number; reasons: { impact: number; text: string }[] };
  metrics: Record<string, number | null>;
}
interface ReportDoc {
  id: number; title: string; created_at: string;
  content: {
    generated_at: string; engine: string; disclaimer: string; simplifications: string[];
    business: { name: string; industry_label: string; currency: string; unit_label: string; is_demo: boolean; profile_version: number; default_share: number };
    comparison: { objective_label: string; ranking_note: string; horizon_months: number; start_month: string; rows: { id: number | null; name: string; rank: number; values: Record<string, number | null>; risk_level: Severity; risk_score: number }[] } | null;
    scenarios: ReportScenario[];
    data_sources: { label: string; source: string; kind: string; status: string; retrieved_at: string | null; url: string | null; summary: string | null }[];
    narrative: { mode: string; available: boolean; executive_summary?: string; findings?: string[]; recommendations?: string[]; caveats?: string[]; notice?: string; model?: string };
  };
}

export function ReportView() {
  const { id } = useParams();
  const { data, error, loading, reload } = useAsync<ReportDoc>(() => api.get(`/api/whatif/reports/${id}`), [id]);
  if (error) return <ErrorBox message={error} onRetry={reload} />;
  if (loading || !data) return <Skeleton h={500} />;
  const c = data.content;
  const cur = c.business.currency;
  return (
    <article className="mx-auto grid max-w-[980px] gap-8">
      <div className="no-print flex flex-wrap items-center justify-between gap-2">
        <Link to="/app/reports" className="text-[0.85rem] underline">All reports</Link>
        <div className="flex gap-2">
          <a className="btn btn-outline btn-sm" href={`/api/whatif/reports/${data.id}/csv`}><IconDownload size={14} />Download CSV</a>
          <button className="btn btn-primary btn-sm" onClick={() => window.print()}><IconPrint size={14} />Print / save as PDF</button>
        </div>
      </div>
      <header className="grid gap-3">
        <div className="flex flex-wrap items-center gap-2 text-[0.82rem] text-text-3"><span>What-if simulation report</span>{c.business.is_demo && <KindTag kind="demo" />}</div>
        <h1 className="t-display-tight text-[clamp(1.8rem,1.3rem+1.8vw,2.6rem)]">{data.title}</h1>
        <p className="text-[0.86rem] text-text-2">{c.business.name} · {c.business.industry_label} · profile v{c.business.profile_version} · generated {when(c.generated_at)} · {c.engine}</p>
        <p className="text-[0.82rem] text-text-3">{c.disclaimer}{c.business.default_share > 0 ? ` ${Math.round(c.business.default_share * 100)}% of the core business figures were What-if estimates when this report was created.` : ""}</p>
      </header>

      {c.narrative.available ? (
        <Section title="Summary" aside={<KindTag kind="ai" title={`Written by ${c.narrative.model}; figures checked against the calculation`} />}>
          <div className="panel grid gap-3 p-5 text-[0.92rem]">
            <p>{c.narrative.executive_summary}</p>
            {!!c.narrative.findings?.length && <><h3 className="text-[0.82rem] font-semibold text-text-3">Findings</h3><ul className="list-disc pl-5">{c.narrative.findings.map((f, i) => <li key={i}>{f}</li>)}</ul></>}
            {!!c.narrative.recommendations?.length && <><h3 className="text-[0.82rem] font-semibold text-text-3">Recommendations</h3><ul className="list-disc pl-5">{c.narrative.recommendations.map((f, i) => <li key={i}>{f}</li>)}</ul></>}
            {!!c.narrative.caveats?.length && <p className="text-[0.82rem] text-text-3">{c.narrative.caveats.join(" ")}</p>}
          </div>
        </Section>
      ) : <p className="text-[0.84rem] text-text-3">{c.narrative.notice}</p>}

      {c.comparison && (
        <Section title={`Comparison: ${c.comparison.objective_label.toLowerCase()}`} aside={<KindTag kind="calculated" />}>
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Rank</th><th>Scenario</th><th className="n">Revenue</th><th className="n">Net profit</th><th className="n">Net margin</th><th className="n">Lowest cash</th><th>Risk</th></tr></thead>
              <tbody>{c.comparison.rows.map((r) => (
                <tr key={r.id ?? "b"}><td className="num">{r.rank}</td><td>{r.name}</td><td className="n">{money(r.values.revenue, cur)}</td><td className="n">{money(r.values.net_profit, cur)}</td><td className="n">{pct(r.values.net_margin)}</td><td className="n">{money(r.values.min_cash, cur)}</td><td><SeverityBadge s={r.risk_level} suffix={`· ${r.risk_score}`} /></td></tr>
              ))}</tbody>
            </table>
          </div>
          <p className="text-[0.86rem]">{c.comparison.ranking_note}</p>
        </Section>
      )}

      {c.scenarios.map((s, i) => (
        <section key={s.id} className={`grid gap-4 ${i > 0 ? "print-break" : ""}`}>
          <div className="hline" />
          <h2 className="t-h2">{s.name}</h2>
          {s.question && <p className="text-text-2">“{s.question}”</p>}
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <Fig k="Net profit" v={money(s.delta.net_profit.scenario, cur)} sub={`${signedMoney(s.delta.net_profit.change, cur)} vs current course`} />
            <Fig k="Revenue" v={money(s.delta.revenue.scenario, cur)} sub={`${signedMoney(s.delta.revenue.change, cur)}`} />
            <Fig k="Net margin" v={pct(s.delta.net_margin.scenario)} sub={`was ${pct(s.delta.net_margin.baseline)}`} />
            <Fig k="Worst to best case" v={`${compact(s.bands.worst, cur)} to ${compact(s.bands.best, cur)}`} sub={`confidence: ${s.confidence.level}`} />
          </div>
          <div className="panel p-4">
            <ProjectionChart months={s.months.map((m) => m.month)} format={(v) => compact(v, cur)} ariaLabel={`Monthly net profit, ${s.name}`} height={220}
              series={[{ key: "b", label: "Current course", values: s.baseline_months.map((m) => m.net_profit), color: "var(--series-baseline)", dash: "6 5", shape: "ring" },
                { key: "s", label: s.name, values: s.months.map((m) => m.net_profit), color: "var(--series-1)", shape: "circle" }]} />
          </div>
          {s.bridge.length > 0 && <div className="panel p-4"><h3 className="mb-2 text-[0.85rem] font-semibold">Why net profit changes</h3><BridgeChart start={s.delta.net_profit.baseline ?? 0} end={s.delta.net_profit.scenario ?? 0} items={s.bridge} cur={cur} /></div>}
          <div className="grid gap-4 md:grid-cols-2">
            <div className="grid content-start gap-2">
              <h3 className="text-[0.85rem] font-semibold">Explanation <KindTag kind={(s.saved_explanation?.mode ?? s.explanation.mode) === "ai" ? "ai" : "rules"} /></h3>
              <p className="text-[0.9rem]">{(s.saved_explanation ?? s.explanation).summary}</p>
              <ul className="list-disc pl-5 text-[0.86rem] text-text-2">{(s.saved_explanation ?? s.explanation).key_points.map((k, j) => <li key={j}>{k}</li>)}</ul>
            </div>
            <div className="grid content-start gap-2">
              <h3 className="text-[0.85rem] font-semibold">Risks (score {s.risks.score})</h3>
              {s.risks.findings.length === 0 ? <p className="text-[0.86rem] text-text-2">No rule triggered.</p> : (
                <ul className="grid gap-2">{s.risks.findings.slice(0, 6).map((f) => (
                  <li key={f.id} className="grid gap-0.5 text-[0.86rem]"><span className="flex items-center gap-2"><SeverityBadge s={f.severity} /><b>{f.title}</b></span><span className="text-text-2">{f.summary}</span>
                    {f.actions[0] && <span className="text-text-3">Recommended: {f.actions.map((a) => a.label).join("; ")}.</span>}</li>
                ))}</ul>
              )}
            </div>
          </div>
          <details open className="text-[0.84rem]"><summary className="cursor-pointer font-semibold">Input assumptions</summary>
            <table className="data mt-2"><tbody>{s.assumptions.map((a, j) => <tr key={j}><td>{a.label}</td><td className="n">{a.value == null ? "" : `${a.value}${a.unit === "%" ? "%" : a.unit ? ` ${a.unit}` : ""}`}</td><td><SourceBadge s={a.source} /></td><td className="text-text-2">{a.note}</td></tr>)}</tbody></table>
          </details>
        </section>
      ))}

      <section className="grid gap-3 print-break">
        <div className="hline" />
        <h2 className="t-h3">Data sources and method</h2>
        {c.data_sources.length === 0 ? <p className="text-[0.86rem] text-text-2">No external data was retrieved for this business; results use only the business figures shown.</p> : (
          <ul className="grid gap-1 text-[0.84rem]">{c.data_sources.map((d) => <li key={d.label}><b>{d.label}</b> ({d.source}, {d.kind}): {d.status === "ok" ? d.summary : d.status}{d.retrieved_at ? `, retrieved ${when(d.retrieved_at)}` : ""}{d.url ? <> · <a href={d.url} className="underline" target="_blank" rel="noreferrer">source</a></> : null}</li>)}</ul>
        )}
        <ul className="list-disc pl-5 text-[0.82rem] text-text-3">{c.simplifications.map((s) => <li key={s}>{s}</li>)}</ul>
        <p className="text-[0.78rem] text-text-3">Currency: {cur}. Units: {c.business.unit_label}. {num(c.scenarios.length)} scenario(s). Report created {ago(data.created_at)}.</p>
      </section>
    </article>
  );
}

function Fig({ k, v, sub }: { k: string; v: string; sub?: string }) {
  return <div className="grid gap-1"><span className="label-soft">{k}</span><span className="kpi text-[1.35rem]">{v}</span>{sub && <span className="text-[0.78rem] text-text-3">{sub}</span>}</div>;
}
