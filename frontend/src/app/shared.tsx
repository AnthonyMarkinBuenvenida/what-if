import { useRef, useState } from "react";
import { IconAlert, IconCheck, IconUpload } from "../components/icons";
import { Notice, Spinner, useToast } from "../components/ui";
import { api } from "../lib/api";
import type { Plan } from "../lib/types";

export interface Step { agent: string; mode: "ai" | "deterministic"; notes: string[]; summary: string }

export function AgentSteps({ steps, working, workingLabel }: { steps: Step[]; working?: boolean; workingLabel?: string }) {
  return (
    <ol className="grid gap-2" aria-live="polite">
      {steps.map((s, i) => (
        <li key={i} className="card flex gap-3 px-4 py-3">
          <span className="mt-0.5 text-[var(--text)]"><IconCheck size={16} /></span>
          <div className="grid gap-0.5">
            <span className="font-semibold">{s.agent} <span className="chip ml-1" style={{ height: "1.2rem" }}>{s.mode === "ai" ? "AI model" : "Deterministic rules"}</span></span>
            <span className="text-[0.88rem] text-text-2">{s.summary}</span>
            {s.notes.map((n, k) => <span key={k} className="text-[0.78rem] text-text-3">{n}</span>)}
          </div>
        </li>
      ))}
      {working && (
        <li className="card flex items-center gap-3 px-4 py-3 text-text-2"><span className="pulse-dot" />{workingLabel ?? "Working…"}</li>
      )}
    </ol>
  );
}

export function PlanReview({ businessId, plan, onApproved }: { businessId: number; plan: Plan; onApproved: () => void }) {
  const [keep, setKeep] = useState<number[]>(plan.proposed_scenarios.map((_, i) => i));
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  async function approve() {
    setBusy(true);
    try {
      await api.post(`/api/businesses/${businessId}/plan/approve`, { scenario_indexes: keep });
      toast(`Plan approved. ${keep.length} scenarios created.`);
      onApproved();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "bad");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="grid gap-5">
      <Notice>Plan mode: nothing has been simulated yet. Review the assumptions and choose the scenarios; they are created only when you approve.</Notice>
      <section className="grid gap-2">
        <h3 className="t-h3">What the Data Analyst found</h3>
        <ul className="grid gap-1.5 text-[0.9rem] text-text-2">{plan.business_summary.map((x, i) => <li key={i}>• {x}</li>)}</ul>
      </section>
      <section className="grid gap-2">
        <h3 className="t-h3">Assumptions to verify</h3>
        <ul className="grid gap-1.5">
          {plan.assumptions_to_verify.map((a, i) => (
            <li key={i} className="flex gap-2 text-[0.88rem]"><span className="mt-0.5 text-[var(--text)]"><IconAlert size={15} /></span><span>{a.message}{a.fix && <span className="text-text-3"> {a.fix}</span>}</span></li>
          ))}
        </ul>
      </section>
      <section className="grid gap-2">
        <h3 className="t-h3">Proposed scenarios</h3>
        <ul className="grid gap-2">
          {plan.proposed_scenarios.map((p, i) => (
            <li key={i} className="card px-4 py-3">
              <label className="flex cursor-pointer gap-3">
                <input type="checkbox" className="mt-1 h-4 w-4 accent-[var(--text)]" checked={keep.includes(i)} onChange={(e) => setKeep(e.target.checked ? [...keep, i] : keep.filter((x) => x !== i))} />
                <span className="grid gap-0.5">
                  <span className="font-semibold">{p.name}</span>
                  <span className="text-[0.86rem] text-text-2">{p.description}</span>
                  {p.rationale && <span className="text-[0.8rem] text-text-3">Why: {p.rationale}</span>}
                  {p.assumptions.length > 0 && <span className="text-[0.8rem] text-text-3">Assumes: {p.assumptions.join(" ")}</span>}
                </span>
              </label>
            </li>
          ))}
        </ul>
      </section>
      <section className="grid gap-2">
        <h3 className="t-h3">Questions before you run</h3>
        <ul className="grid gap-1 text-[0.88rem] text-text-2">{plan.questions.map((q, i) => <li key={i}>• {q}</li>)}</ul>
      </section>
      <div className="flex flex-wrap items-center gap-3">
        <button className="btn btn-primary" onClick={approve} disabled={busy || !keep.length}>{busy && <Spinner />}Approve plan and create {keep.length} scenarios</button>
        <span className="text-[0.82rem] text-text-3">Settings: {plan.proposed_config.runs} Monte Carlo runs over {plan.proposed_config.horizon_days} days. You can change them per scenario later.</span>
      </div>
    </div>
  );
}

interface ImportResult {
  id: number; kind: string; filename: string; rows: number; status: string;
  report: { total_rows: number; accepted_rows: number; rejected_rows?: number; missing_columns: string[]; ignored_columns: string[]; column_mapping: Record<string, string>; errors: { row: number | null; message: string }[]; warnings: { row: number | null; message: string }[] };
}

export function ImportPanel({ businessId, onApplied }: { businessId: number; onApplied: () => void }) {
  const [kind, setKind] = useState("products");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [applied, setApplied] = useState<string[] | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const toast = useToast();

  async function upload(f: File) {
    setBusy(true);
    setError(null);
    setResult(null);
    setApplied(null);
    const form = new FormData();
    form.append("kind", kind);
    form.append("file", f);
    try {
      setResult(await api.upload<ImportResult>(`/api/businesses/${businessId}/imports`, form));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  }
  async function apply() {
    if (!result) return;
    setBusy(true);
    try {
      const res = await api.post<{ version: { version: number }; changes: string[] }>(`/api/imports/${result.id}/apply`);
      setApplied(res.changes);
      toast(`Saved as model version ${res.version.version}.`);
      onApplied();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  const r = result?.report;
  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-end gap-3">
        <label className="field"><span>What's in the file?</span>
          <select className="select" value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="products">Products (name, price, cost, stock…)</option>
            <option value="sales">Sales history (date, product, units)</option>
            <option value="expenses">Expenses (name, amount, frequency)</option>
          </select></label>
        <input ref={input} type="file" accept=".csv,.xlsx,.xlsm,.txt" className="sr-only" id="import-file" onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
        <label htmlFor="import-file" className="btn cursor-pointer">{busy ? <Spinner /> : <IconUpload size={16} />}Choose CSV or Excel file</label>
      </div>
      <p className="hint">Required columns: products need name, price and cost; sales need date, product and units; expenses need name and amount. Files are checked before anything changes, and nothing is applied until you confirm.</p>
      {error && <p className="error-text" role="alert">{error}</p>}
      {result && r && (
        <div className="card card-pad grid gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <b>{result.filename}</b>
            <span className={`chip ${r.missing_columns.length ? "chip-bad" : "chip-good"}`}>{r.accepted_rows} of {r.total_rows} rows accepted</span>
            {!!r.rejected_rows && <span className="chip chip-bad">{r.rejected_rows} rejected</span>}
            {r.warnings.length > 0 && <span className="chip chip-warn">{r.warnings.length} warnings</span>}
          </div>
          {Object.keys(r.column_mapping).length > 0 && <p className="text-[0.82rem] text-text-3">Columns read: {Object.entries(r.column_mapping).map(([k, v]) => `${v} → ${k}`).join(", ")}{r.ignored_columns.length ? `. Ignored: ${r.ignored_columns.join(", ")}` : ""}</p>}
          {r.errors.length > 0 && <ul className="grid max-h-48 gap-1 overflow-y-auto text-[0.84rem]">{r.errors.map((e, i) => <li key={i} className="text-[var(--text)]">{e.row ? `Row ${e.row}: ` : ""}{e.message}</li>)}</ul>}
          {r.warnings.length > 0 && <ul className="grid max-h-48 gap-1 overflow-y-auto text-[0.84rem]">{r.warnings.map((e, i) => <li key={i} className="text-[var(--text)]">{e.row ? `Row ${e.row}: ` : ""}{e.message}</li>)}</ul>}
          {result.status === "reviewed" && !applied && (
            <div className="flex flex-wrap gap-2">
              <button className="btn btn-primary" onClick={apply} disabled={busy}>Apply {r.accepted_rows} rows as a new model version</button>
              <button className="btn btn-quiet" onClick={() => setResult(null)}>Discard</button>
            </div>
          )}
          {applied && <div className="grid gap-1"><b className="text-[0.9rem]">Applied changes</b><ul className="max-h-48 overflow-y-auto text-[0.82rem] text-text-2">{applied.map((c, i) => <li key={i}>• {c}</li>)}</ul></div>}
        </div>
      )}
    </div>
  );
}
