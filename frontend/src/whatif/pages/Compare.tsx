import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../../lib/api";
import { useAsync } from "../../lib/hooks";
import { useWorkspace } from "../../app/workspace";
import { useBackdropState } from "../../app/AppShell";
import { ErrorBox, Skeleton, Spinner, useToast } from "../../components/ui";
import { IconTrash } from "../../components/icons";
import { ProjectionChart, RankBars } from "../charts";
import { ago, compact, money, num, pct } from "../format";
import type { ScenarioSummary, Severity } from "../types";
import { KindTag, NeedsProfile, PageTitle, Section, SeverityBadge, useProfile } from "../ui";

interface Row {
  id: number | null; name: string; is_baseline: boolean; rank: number; values: Record<string, number | null>; best: number; worst: number;
  risk_score: number; risk_level: Severity; top_risks: { severity: Severity; title: string }[]; confidence: string;
  assumptions: { label: string; value: number | null; unit: string; source: string; note: string }[]; monthly_net_profit: number[]; months: string[];
}
interface Table {
  objective: string; objective_label: string; horizon_months: number; start_month: string; currency: string; ranking_note: string; robust: boolean | null; method: string;
  metrics: { key: string; label: string; format: "money" | "pct" | "num" }[]; rows: Row[];
  commentary: { mode: string; summary: string; trade_offs: string[]; caveats: string[]; notice: string | null; model?: string };
}
const OBJECTIVES: Record<string, string> = {
  max_profit: "Highest net profit", protect_cash: "Protect cash flow (highest lowest-cash point)", max_revenue: "Highest revenue", lowest_risk: "Lowest risk score", best_margin: "Highest net margin",
};
const SLOT = ["var(--series-1)", "var(--series-2)", "var(--series-3)"];
const SHAPE = ["circle", "square", "triangle"] as const;

export default function Compare() {
  const { current } = useWorkspace();
  const prof = useProfile(current?.id);
  const nav = useNavigate();
  const toast = useToast();
  const setBackdrop = useBackdropState();
  const list = useAsync<ScenarioSummary[]>(() => (current && prof.profile ? api.get(`/api/whatif/businesses/${current.id}/scenarios`) : Promise.resolve([])), [current?.id, prof.profile?.id]);
  const [sel, setSel] = useState<number[]>([]);
  const [baseline, setBaseline] = useState(true);
  const [objective, setObjective] = useState("max_profit");
  const [horizon, setHorizon] = useState(12);
  const [table, setTable] = useState<Table | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [lines, setLines] = useState<(number | null)[]>([]);

  const scenarios = (list.data ?? []).filter((s) => !s.summary.is_baseline);
  useEffect(() => { if (scenarios.length && !sel.length) setSel(scenarios.slice(0, 4).map((s) => s.id)); }, [list.data]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!current || (!prof.loading && !prof.profile)) return <div className="grid gap-6"><PageTitle title="Compare scenarios" /><NeedsProfile state={prof} /></div>;
  if (list.error) return <ErrorBox message={list.error} onRetry={list.reload} />;
  const cur = prof.profile?.spec.business.currency ?? "USD";

  const run = async () => {
    setBusy(true);
    setErr(null);
    setBackdrop({ active: true });
    try {
      const t = await api.post<Table>(`/api/whatif/businesses/${current.id}/compare`, { scenario_ids: sel, include_baseline: baseline, objective, horizon_months: horizon, explain: true });
      setTable(t);
      setLines(t.rows.filter((r) => !r.is_baseline).slice(0, 3).map((r) => r.id));
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); setBackdrop({ active: false }); }
  };
  const report = async () => {
    const ids = sel;
    if (!ids.length) return;
    setBusy(true);
    try {
      const r = await api.post<{ id: number }>(`/api/whatif/businesses/${current.id}/reports`, { scenario_ids: ids, objective });
      toast("Report created.");
      nav(`/app/reports/w/${r.id}`);
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };
  const fmt = (f: string, v: number | null) => (v == null ? "—" : f === "money" ? money(v, cur) : f === "pct" ? pct(v) : num(v));
  const objKey = { max_profit: "net_profit", protect_cash: "min_cash", max_revenue: "revenue", best_margin: "net_margin", lowest_risk: "risk" }[objective]!;
  const baseRow = table?.rows.find((r) => r.is_baseline);
  const lineRows = (table?.rows ?? []).filter((r) => lines.includes(r.id) && !r.is_baseline).slice(0, 3);

  return (
    <div className="grid gap-8">
      <PageTitle title="Compare scenarios" sub="All selected scenarios are recalculated on the current business figures, for the same period and start month, then ranked by the objective you choose." />

      <section className="panel glass grid gap-4 p-5">
        {list.loading ? <Skeleton h={120} /> : scenarios.length === 0 ? (
          <p className="text-text-2">Save at least one scenario in <Link to="/app/simulate" className="underline">Simulate</Link> to compare it with the current course.</p>
        ) : (
          <>
            <fieldset className="grid gap-2">
              <legend className="label mb-1">Scenarios</legend>
              <label className="flex items-center gap-2 text-[0.9rem]"><input type="checkbox" checked={baseline} onChange={(e) => setBaseline(e.target.checked)} />Current course (no changes)</label>
              <div className="grid gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
                {scenarios.map((s) => (
                  <label key={s.id} className="flex items-center justify-between gap-2 rounded-[var(--r-control)] border border-line px-3 py-2 text-[0.88rem]">
                    <span className="flex min-w-0 items-center gap-2"><input type="checkbox" checked={sel.includes(s.id)} onChange={(e) => setSel(e.target.checked ? [...sel, s.id] : sel.filter((x) => x !== s.id))} disabled={!sel.includes(s.id) && sel.length >= 8} /><span className="truncate">{s.name}</span></span>
                    <span className="flex items-center gap-1">
                      <span className="text-[0.74rem] text-text-3">{ago(s.created_at)}</span>
                      <button className="btn btn-quiet btn-sm !min-h-[1.6rem] !px-1.5" aria-label={`Delete ${s.name}`} onClick={async (e) => { e.preventDefault(); if (confirm(`Delete “${s.name}”?`)) { await api.del(`/api/whatif/scenarios/${s.id}`); setSel(sel.filter((x) => x !== s.id)); list.reload(); } }}><IconTrash size={14} /></button>
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>
            <div className="flex flex-wrap items-end gap-3">
              <label className="field"><span>Objective</span>
                <select className="select" value={objective} onChange={(e) => setObjective(e.target.value)}>{Object.entries(OBJECTIVES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
              </label>
              <label className="field"><span>Period</span>
                <select className="select" value={horizon} onChange={(e) => setHorizon(+e.target.value)}>{[6, 12, 18, 24, 36].map((m) => <option key={m} value={m}>{m} months</option>)}</select>
              </label>
              <button className="btn btn-signal" onClick={run} disabled={busy || sel.length + (baseline ? 1 : 0) < 2}>{busy && <Spinner />}Compare</button>
              <button className="btn btn-outline" onClick={report} disabled={busy || !sel.length}>Create report</button>
            </div>
          </>
        )}
        {err && <p className="error-text">{err}</p>}
      </section>

      {table && (
        <>
          <Section title={`Ranked by: ${table.objective_label.toLowerCase()}`} aside={<KindTag kind="calculated" />}>
            <div className="panel grid gap-4 p-5">
              <RankBars ariaLabel={`Scenarios ranked by ${table.objective_label}`} format={(v) => (objKey === "risk" ? `${num(v)}` : objKey === "net_margin" ? pct(v) : compact(v, cur))}
                rows={table.rows.map((r) => ({ key: r.id ?? "base", label: r.name, value: objKey === "risk" ? r.risk_score : (r.values[objKey] ?? 0), leader: r.rank === 1 }))} />
              <p className="text-[0.88rem]">{table.ranking_note}</p>
              <p className="text-[0.78rem] text-text-3">{table.method} Period: {table.horizon_months} months from {table.start_month}. ★ marks the leader for this objective only.</p>
            </div>
          </Section>

          <Section title="Side by side">
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr><th className="sticky left-0 z-10 bg-surface">Measure</th>{table.rows.map((r) => <th key={r.id ?? "b"} className="n min-w-[150px]">{r.rank === 1 && "★ "}{r.name}</th>)}</tr>
                </thead>
                <tbody>
                  {table.metrics.map((m) => (
                    <tr key={m.key}>
                      <td className="sticky left-0 bg-surface">{m.label}</td>
                      {table.rows.map((r) => {
                        const v = r.values[m.key], b = baseRow?.values[m.key];
                        return <td key={r.id ?? "b"} className="n">{fmt(m.format, v)}{!r.is_baseline && b != null && v != null && m.format === "money" && <div className="text-[0.74rem] text-text-3">{v - b >= 0 ? "+" : "−"}{compact(Math.abs(v - b), cur)}</div>}</td>;
                      })}
                    </tr>
                  ))}
                  <tr><td className="sticky left-0 bg-surface">Net profit, worst to best case</td>{table.rows.map((r) => <td key={r.id ?? "b"} className="n">{compact(r.worst, cur)} to {compact(r.best, cur)}</td>)}</tr>
                  <tr><td className="sticky left-0 bg-surface">Risk</td>{table.rows.map((r) => <td key={r.id ?? "b"} className="n"><div className="flex justify-end"><SeverityBadge s={r.risk_level} suffix={`· ${r.risk_score}`} /></div></td>)}</tr>
                  <tr><td className="sticky left-0 bg-surface">Main risk</td>{table.rows.map((r) => <td key={r.id ?? "b"} className="text-[0.8rem] text-text-2">{r.top_risks[0]?.title ?? "none triggered"}</td>)}</tr>
                  <tr><td className="sticky left-0 bg-surface">Confidence</td>{table.rows.map((r) => <td key={r.id ?? "b"} className="n capitalize">{r.confidence}</td>)}</tr>
                  <tr><td className="sticky left-0 bg-surface">Key assumptions</td>{table.rows.map((r) => <td key={r.id ?? "b"} className="text-[0.78rem] text-text-2">{r.assumptions.length ? r.assumptions.map((a) => `${a.label}${a.value != null ? ` ${a.value}${a.unit === "%" ? "%" : a.unit ? ` ${a.unit}` : ""}` : ""}`).join("; ") : "none (current figures)"}</td>)}</tr>
                </tbody>
              </table>
            </div>
          </Section>

          <Section title="Monthly net profit" aside={<span className="text-[0.78rem] text-text-3">Up to three scenarios at a time</span>}>
            <div className="panel grid gap-3 p-5">
              <div className="flex flex-wrap gap-1.5" role="group" aria-label="Scenarios shown in the chart">
                {table.rows.filter((r) => !r.is_baseline).map((r) => {
                  const on = lines.includes(r.id);
                  return <button key={r.id} className={`chip cursor-pointer ${on ? "chip-calc" : ""}`} aria-pressed={on} disabled={!on && lineRows.length >= 3}
                    onClick={() => setLines(on ? lines.filter((x) => x !== r.id) : [...lines, r.id])}>{r.name}</button>;
                })}
              </div>
              <ProjectionChart months={table.rows[0].months} format={(v) => compact(v, cur)} ariaLabel="Monthly net profit by scenario"
                series={[
                  ...(baseRow ? [{ key: "base", label: "Current course", values: baseRow.monthly_net_profit, color: "var(--series-baseline)", dash: "6 5", shape: "ring" as const }] : []),
                  ...lineRows.map((r, i) => ({ key: String(r.id), label: r.name, values: r.monthly_net_profit, color: SLOT[i], dash: i === 1 ? "7 4" : i === 2 ? "2 4" : undefined, shape: SHAPE[i] })),
                ]} />
            </div>
          </Section>

          <Section title="Trade-offs" aside={<KindTag kind={table.commentary.mode === "ai" ? "ai" : "rules"} />}>
            <div className="panel grid gap-2 p-4 text-[0.9rem]">
              <p>{table.commentary.summary}</p>
              {table.commentary.trade_offs.length > 0 && <ul className="list-disc pl-5 text-text-2">{table.commentary.trade_offs.map((t, i) => <li key={i}>{t}</li>)}</ul>}
              {table.commentary.caveats.length > 0 && <p className="text-[0.8rem] text-text-3">{table.commentary.caveats.join(" ")}</p>}
              {table.commentary.notice && <p className="text-[0.78rem] text-text-3">{table.commentary.notice}</p>}
            </div>
          </Section>
        </>
      )}
    </div>
  );
}
