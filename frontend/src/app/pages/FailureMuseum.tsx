import { useState } from "react";
import { SeriesMark } from "../../components/charts";
import { Link, useNavigate } from "react-router-dom";
import { IconAlert, IconMuseum, IconTrash } from "../../components/icons";
import { Empty, ErrorBox, PageHeader, Skeleton, Spinner, useToast } from "../../components/ui";
import { api } from "../../lib/api";
import { money, when } from "../../lib/format";
import { useAsync } from "../../lib/hooks";
import type { Constraint } from "../../lib/types";
import { useWorkspace } from "../workspace";

interface Record_ {
  id: number; run_id: number; scenario_id: number | null; title: string; category: "failed" | "rejected"; tested: string; reasons: string[];
  limits_exceeded: Constraint[]; contributing_assumptions: string[]; lessons: string; next_changes: string; created_at: string;
  model_version_id: number | null; color_index: number; headline: { avg_monthly_operating_profit: { p50: number }; min_cash_p10: number } | null;
}
interface Museum { records: Record_[]; candidates: { run_id: number; scenario_name: string; color_index: number; violations: string[]; finished_at: string | null }[] }

function Exhibit({ r, onChanged }: { r: Record_; onChanged: () => void }) {
  const [lessons, setLessons] = useState(r.lessons);
  const [next, setNext] = useState(r.next_changes);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const nav = useNavigate();
  const dirty = lessons !== r.lessons || next !== r.next_changes;
  async function save() {
    setBusy(true);
    try { await api.patch(`/api/failures/${r.id}`, { lessons, next_changes: next }); toast("Notes saved."); onChanged(); }
    catch (e) { toast(e instanceof Error ? e.message : String(e), "bad"); } finally { setBusy(false); }
  }
  async function revise() {
    setBusy(true);
    try { await api.post(`/api/failures/${r.id}/revise`); toast("New experiment created from this failure. Edit it, then run it."); nav("/app/worlds"); }
    catch (e) { toast(e instanceof Error ? e.message : String(e), "bad"); setBusy(false); }
  }
  async function remove() {
    try { await api.del(`/api/failures/${r.id}`); toast("Removed from the museum. The run itself is kept."); onChanged(); }
    catch (e) { toast(e instanceof Error ? e.message : String(e), "bad"); }
  }
  return (
    <article className="panel grid gap-4 p-5">
      <header className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="t-h3">{r.title}</h2>
          <p className="text-[0.8rem] text-text-3">{r.category === "failed" ? "Broke a defined limit" : "Rejected by you"} · <Link to={`/app/runs/${r.run_id}`}>run #{r.run_id}</Link> · model version id {r.model_version_id} · {when(r.created_at)}</p>
        </div>
        {r.headline && <span className="num text-[0.88rem] text-text-2">{money(r.headline.avg_monthly_operating_profit.p50)}/mo · lowest cash {money(r.headline.min_cash_p10)}</span>}
      </header>
      <div className="grid gap-4 md:grid-cols-2">
        <div className="grid content-start gap-1"><h3 className="label">What was tested</h3><p className="text-[0.9rem]">{r.tested}</p></div>
        <div className="grid content-start gap-1"><h3 className="label">Why it failed</h3>
          <ul className="grid gap-1 text-[0.9rem]">{r.reasons.map((x, i) => <li key={i} className="flex gap-2"><span className="mt-1 text-[var(--text)]"><IconAlert size={14} /></span>{x}</li>)}</ul></div>
        {r.limits_exceeded.length > 0 && <div className="grid content-start gap-1"><h3 className="label">Limits exceeded</h3>
          <ul className="text-[0.86rem] text-text-2">{r.limits_exceeded.map((c) => <li key={c.key}>• {c.label}: {c.value} (limit {c.limit}). {c.basis}.</li>)}</ul></div>}
        <div className="grid content-start gap-1"><h3 className="label">Assumptions that contributed</h3>
          <ul className="text-[0.86rem] text-text-2">{r.contributing_assumptions.map((x, i) => <li key={i}>• {x}</li>)}</ul></div>
        <label className="field"><span>What we learned</span><textarea className="textarea" rows={3} value={lessons} onChange={(e) => setLessons(e.target.value)} /></label>
        <label className="field"><span>What to change next time</span><textarea className="textarea" rows={3} value={next} onChange={(e) => setNext(e.target.value)} /></label>
      </div>
      <div className="flex flex-wrap gap-2">
        <button className="btn btn-primary btn-sm" onClick={revise} disabled={busy}>{busy && <Spinner />}Revise and run again</button>
        {dirty && <button className="btn btn-sm" onClick={save} disabled={busy}>Save notes</button>}
        <button className="btn btn-quiet btn-sm btn-danger ml-auto" onClick={remove}><IconTrash size={14} />Remove</button>
      </div>
    </article>
  );
}

export default function FailureMuseum() {
  const ws = useWorkspace();
  const b = ws.current;
  const nav = useNavigate();
  const toast = useToast();
  const m = useAsync(async () => (b ? api.get<Museum>(`/api/businesses/${b.id}/failures`) : null), [b?.id]);
  if (!b) return <Empty title="No business selected" action={<button className="btn btn-primary" onClick={() => nav("/app/new")}>Create business model</button>} />;
  if (m.error) return <ErrorBox message={m.error} onRetry={m.reload} />;
  async function add(runId: number) {
    try { await api.post(`/api/businesses/${b!.id}/failures`, { run_id: runId }); toast("Added to the museum."); m.reload(); }
    catch (e) { toast(e instanceof Error ? e.message : String(e), "bad"); }
  }
  return (
    <div className="grid gap-6">
      <PageHeader title="Failure Museum" sub="Experiments that broke a limit, kept so a bad idea is only expensive once. A run counts as failed only when it breaks a limit you defined." />
      {m.loading && !m.data ? <Skeleton h={300} /> : <>
        {(m.data?.candidates ?? []).length > 0 && (
          <section className="panel grid gap-2 p-4">
            <h2 className="t-h3">Failed runs not yet in the museum</h2>
            <ul className="grid gap-1.5">{m.data!.candidates.map((c) => (
              <li key={c.run_id} className="flex flex-wrap items-center gap-3 text-[0.88rem]">
                <SeriesMark index={c.color_index} /><Link to={`/app/runs/${c.run_id}`}>{c.scenario_name} · run #{c.run_id}</Link>
                <span className="text-[var(--text)]">{c.violations.join("; ")}</span>
                <button className="btn btn-sm ml-auto" onClick={() => add(c.run_id)}><IconMuseum size={14} />Add to museum</button>
              </li>))}</ul>
          </section>
        )}
        {!(m.data?.records ?? []).length ? (
          <Empty title="The museum is empty">When a simulated strategy breaks one of your limits (cash floor, profit target, budget, waste or service level), add it here with what you learned.</Empty>
        ) : <div className="grid gap-4">{m.data!.records.map((r) => <Exhibit key={r.id} r={r} onChanged={m.reload} />)}</div>}
      </>}
    </div>
  );
}
