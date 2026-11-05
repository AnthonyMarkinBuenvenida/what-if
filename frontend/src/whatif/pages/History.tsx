// Simulation history: every saved run in this workspace, from the database. Open restores the stored result
// (no recalculation); rename, duplicate, compare and delete act on the saved records.
import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../../lib/api";
import { useAsync } from "../../lib/hooks";
import { useWorkspace } from "../../app/workspace";
import { Empty, ErrorBox, Modal, Skeleton, Spinner, useToast } from "../../components/ui";
import { IconTrash } from "../../components/icons";
import { ago, money, signedMoney } from "../format";
import type { ScenarioSummary } from "../types";
import { PageTitle, SeverityBadge, Spark } from "../ui";

interface HistoryResponse {
  scenarios: ScenarioSummary[]; businesses: { id: number; name: string }[];
  storage: { ok: boolean; kind: string; durable: boolean; location: string; note: string };
}
type Sort = "created:desc" | "created:asc" | "name:asc" | "business:asc" | "profit:desc";

export default function History() {
  const { setCurrentId } = useWorkspace();
  const nav = useNavigate();
  const toast = useToast();
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  const [biz, setBiz] = useState<string>("");
  const [origin, setOrigin] = useState<string>("");
  const [sort, setSort] = useState<Sort>("created:desc");
  const [sel, setSel] = useState<number[]>([]);
  const [renaming, setRenaming] = useState<ScenarioSummary | null>(null);
  const [deleting, setDeleting] = useState<ScenarioSummary | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { const t = setTimeout(() => setQuery(q), 250); return () => clearTimeout(t); }, [q]);
  const [s, o] = sort.split(":");
  const data = useAsync<HistoryResponse>(() => api.get(`/api/whatif/history?q=${encodeURIComponent(query)}&sort=${s}&order=${o}${biz ? `&business_id=${biz}` : ""}${origin ? `&origin=${origin}` : ""}`),
    [query, s, o, biz, origin]);
  const rows = data.data?.scenarios ?? [];
  const selRows = rows.filter((r) => sel.includes(r.id));
  const sameBusiness = selRows.length > 0 && selRows.every((r) => r.business_id === selRows[0].business_id);

  const open = (r: ScenarioSummary) => { setCurrentId(r.business_id); nav(`/app/simulate?scenario=${r.id}`); };
  const duplicate = async (r: ScenarioSummary) => {
    await api.post(`/api/whatif/scenarios/${r.id}/duplicate`, {});
    toast(`Copied “${r.name}”.`);
    data.reload();
  };
  const compare = () => { setCurrentId(selRows[0].business_id); nav(`/app/compare?ids=${sel.join(",")}`); };

  return (
    <div className="grid gap-6">
      <PageTitle title="Simulation history" sub={<>Every simulation you run is saved here automatically, with its inputs, results, risks and explanation. Opening one shows it exactly as it was saved.</>}
        actions={<Link to="/app/simulate" className="btn btn-signal btn-sm">New simulation</Link>} />

      {data.data?.storage && (
        <p className={`text-[0.8rem] ${data.data.storage.durable ? "text-text-3" : "text-[var(--sev-moderate)]"}`} data-testid="storage-line">
          Stored in: {data.data.storage.location}{data.data.storage.durable ? " · kept across restarts" : ` · ${data.data.storage.note}`}
        </p>
      )}

      <div className="flex flex-wrap items-end gap-2" role="group" aria-label="Search and filters">
        <label className="field min-w-[220px] flex-1"><span>Search</span><input className="input" placeholder="Scenario name or question" value={q} onChange={(e) => setQ(e.target.value)} /></label>
        <label className="field"><span>Business</span>
          <select className="select" value={biz} onChange={(e) => setBiz(e.target.value)}>
            <option value="">All businesses</option>{data.data?.businesses.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
        </label>
        <label className="field"><span>Kind</span>
          <select className="select" value={origin} onChange={(e) => setOrigin(e.target.value)}>
            <option value="">All</option><option value="user">Named</option><option value="auto">Automatic</option><option value="demo">Demo</option>
          </select>
        </label>
        <label className="field"><span>Sort by</span>
          <select className="select" value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
            <option value="created:desc">Newest first</option><option value="created:asc">Oldest first</option><option value="name:asc">Name</option>
            <option value="business:asc">Business</option><option value="profit:desc">Net profit (highest)</option>
          </select>
        </label>
        <button className="btn btn-outline" disabled={sel.length < 1 || !sameBusiness} onClick={compare} title={sel.length && !sameBusiness ? "Choose scenarios of one business to compare" : undefined}>
          Compare selected{sel.length ? ` (${sel.length})` : ""}
        </button>
      </div>

      {data.error && <ErrorBox message={data.error} onRetry={data.reload} />}
      {data.loading && !data.data ? <div className="grid gap-2"><Skeleton h={56} /><Skeleton h={56} /><Skeleton h={56} /></div>
        : rows.length === 0 ? (
          <Empty title={query || biz || origin ? "No saved simulations match" : "No saved simulations yet"} action={<Link to="/app/simulate" className="btn btn-signal">Run a simulation</Link>}>
            {query || biz || origin ? "Change the search or filters." : "Run a simulation and it will be saved here automatically."}
          </Empty>
        ) : (
          <div className="table-wrap" data-testid="history-table">
            <table className="data min-w-[760px]">
              <thead><tr><th className="w-8"><span className="sr-only">Select</span></th><th>Scenario</th><th>Business</th><th>Saved</th><th className="n">Net profit</th><th className="n">vs current course</th><th>Risk (as saved)</th><th></th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} data-testid="history-row">
                    <td><input type="checkbox" aria-label={`Select ${r.name}`} checked={sel.includes(r.id)} onChange={(e) => setSel(e.target.checked ? [...sel, r.id] : sel.filter((x) => x !== r.id))} /></td>
                    <td>
                      <button className="text-left font-medium underline-offset-2 hover:underline" onClick={() => open(r)}>{r.name}</button>
                      <div className="flex flex-wrap items-center gap-1.5 text-[0.74rem] text-text-3">
                        {r.origin === "auto" ? <span>automatic</span> : r.origin === "demo" ? <span>demo</span> : <span>named</span>}
                        {r.source_scenario_id && <span>· copy</span>}
                        {r.explanation_mode === "ai" && <span className="chip chip-ai !py-0"><Spark size={9} />AI explained</span>}
                        {r.question && <span className="max-w-[28ch] truncate">· “{r.question}”</span>}
                      </div>
                    </td>
                    <td className="text-text-2">{r.business_name}</td>
                    <td className="text-text-2" title={new Date(r.created_at).toLocaleString()}>{ago(r.created_at)}</td>
                    <td className="n">{r.summary.net_profit == null ? "—" : money(r.summary.net_profit, r.summary.currency ?? "USD")}</td>
                    <td className="n">{r.summary.is_baseline ? <span className="text-text-3">current course</span> : r.summary.change == null ? "—" : signedMoney(r.summary.change, r.summary.currency ?? "USD")}</td>
                    <td>{r.summary.risk_level && <SeverityBadge s={r.summary.risk_level} />}</td>
                    <td>
                      <div className="flex justify-end gap-1">
                        <button className="btn btn-sm btn-outline" onClick={() => open(r)}>Open</button>
                        <button className="btn btn-sm btn-quiet" onClick={() => setRenaming(r)}>Rename</button>
                        <button className="btn btn-sm btn-quiet" onClick={() => duplicate(r)}>Duplicate</button>
                        <button className="btn btn-sm btn-quiet" aria-label={`Delete ${r.name}`} onClick={() => setDeleting(r)}><IconTrash size={14} /></button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

      <Modal open={!!renaming} onClose={() => setRenaming(null)} title="Rename scenario">
        {renaming && <RenameForm initial={renaming.name} onSave={async (name) => {
          await api.patch(`/api/whatif/scenarios/${renaming.id}`, { name });
          setRenaming(null);
          data.reload();
        }} />}
      </Modal>
      <Modal open={!!deleting} onClose={() => setDeleting(null)} title="Delete this simulation?">
        {deleting && (
          <div className="grid gap-4">
            <p className="text-text-2">“{deleting.name}” ({deleting.business_name}, saved {new Date(deleting.created_at).toLocaleString()}) and its saved Risk Radar assessments will be deleted permanently. Other simulations are not affected.</p>
            <div className="flex justify-end gap-2">
              <button className="btn btn-quiet" onClick={() => setDeleting(null)}>Cancel</button>
              <button className="btn btn-primary" disabled={busy} onClick={async () => {
                setBusy(true);
                try { await api.del(`/api/whatif/scenarios/${deleting.id}`); setSel(sel.filter((x) => x !== deleting.id)); toast("Deleted."); setDeleting(null); data.reload(); } finally { setBusy(false); }
              }}>{busy && <Spinner />}Delete</button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}

function RenameForm({ initial, onSave }: { initial: string; onSave: (name: string) => Promise<void> }) {
  const [name, setName] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return (
    <form className="grid gap-3" onSubmit={async (e) => { e.preventDefault(); setBusy(true); try { await onSave(name.trim() || initial); } catch (x) { setErr(x instanceof Error ? x.message : String(x)); } finally { setBusy(false); } }}>
      <label className="field"><span>Name</span><input className="input" value={name} maxLength={160} onChange={(e) => setName(e.target.value)} /></label>
      {err && <p className="error-text">{err}</p>}
      <div className="flex justify-end"><button className="btn btn-primary" disabled={busy}>{busy && <Spinner />}Save name</button></div>
    </form>
  );
}
