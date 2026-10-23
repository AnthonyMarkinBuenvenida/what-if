import { useState } from "react";
import { Link } from "react-router-dom";
import { CalibrationChip, ErrorBox, Modal, PageHeader, Skeleton, useToast } from "../../components/ui";
import { api } from "../../lib/api";
import { when } from "../../lib/format";
import { useAsync } from "../../lib/hooks";
import { useWorkspace } from "../workspace";

interface Status { engine: string; ai: { mode: "connected" | "deterministic"; model: string | null; explanation: string }; live_data: { configured: boolean; name: string }; database: string; parallel_workers: number }
interface Event { id: number; actor: string; action: string; summary: string; created_at: string }

export default function Settings({ embedded = false }: { embedded?: boolean }) {
  const ws = useWorkspace();
  const toast = useToast();
  const status = useAsync(() => api.get<Status>("/api/system/status"), []);
  const audit = useAsync(async () => (ws.current ? api.get<Event[]>(`/api/businesses/${ws.current.id}/audit?limit=60`) : []), [ws.current?.id]);
  const [confirm, setConfirm] = useState(false);
  const [typed, setTyped] = useState("");

  async function clearAll() {
    try {
      await api.post("/api/workspace/clear", { confirm: typed });
      toast("All businesses in this workspace were deleted.");
      setConfirm(false);
      setTyped("");
      ws.refresh();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "bad");
    }
  }

  return (
    <div className="grid gap-8">
      {!embedded && <PageHeader title="Settings" />}
      <section className="grid gap-3 border-t border-line pt-5 md:grid-cols-[16rem_1fr]">
        <h2 className="t-h3">Workspace</h2>
        <div className="grid gap-2 text-[0.92rem]">
          {ws.workspace && <p>Workspace <b className="num">{ws.workspace.id}</b>, opened {when(ws.workspace.created_at)}, {ws.workspace.businesses} business{ws.workspace.businesses === 1 ? "" : "es"}.</p>}
          <p className="text-text-2">What-if has no accounts. This workspace is linked to this browser by a cookie, and only this browser can see its data. Clearing this site's data in the browser, or using another browser, opens a new, empty workspace.</p>
          <div><button className="btn btn-sm" onClick={() => setConfirm(true)}>Delete all businesses in this workspace</button></div>
        </div>
      </section>
      <section className="grid gap-3 border-t border-line pt-5 md:grid-cols-[16rem_1fr]">
        <h2 className="t-h3">Retail lab engine</h2>
        {status.error ? <ErrorBox message={status.error} /> : !status.data ? <Skeleton h={60} /> : (
          <div className="grid gap-2 text-[0.92rem]">
            <p><b>Agents: </b>{status.data.ai.mode === "connected" ? <span className="chip chip-good">Connected: {status.data.ai.model}</span> : <span className="chip chip-warn">Deterministic rules (no AI model connected)</span>}</p>
            <p className="text-text-2">{status.data.ai.explanation}</p>
            <p className="text-text-2"><b className="text-text">Simulation engine:</b> {status.data.engine}, {status.data.parallel_workers} parallel workers, {status.data.database} database.</p>
            <p className="text-text-2"><b className="text-text">Live data:</b> {status.data.live_data.configured ? `${status.data.live_data.name} configured` : "not configured"}. <Link to="/app/live">Open Live Data</Link></p>
          </div>
        )}
      </section>
      {ws.current && (
        <section className="grid gap-3 border-t border-line pt-5">
          <div className="flex flex-wrap items-center gap-2"><h2 className="t-h3">Audit trail: {ws.current.name}</h2>{ws.current.active_model && <CalibrationChip status={ws.current.active_model.calibration} />}</div>
          <p className="text-[0.85rem] text-text-3">Every model change, agent step, run and report is recorded with what performed it: you, an agent, or the engine.</p>
          {audit.loading && !audit.data ? <Skeleton h={120} /> : (
            <div className="table-wrap"><table className="data">
              <thead><tr><th>When</th><th>Actor</th><th>Event</th></tr></thead>
              <tbody>{(audit.data ?? []).map((e) => <tr key={e.id}><td className="whitespace-nowrap text-text-3">{when(e.created_at)}</td><td className="whitespace-nowrap">{e.actor === "user" ? "you" : e.actor}</td><td>{e.summary}</td></tr>)}</tbody>
            </table></div>
          )}
        </section>
      )}
      <Modal open={confirm} onClose={() => setConfirm(false)} title="Delete all businesses?">
        <div className="grid gap-4">
          <p className="text-text-2">This permanently deletes every business in this workspace, with its model versions, scenarios, runs, reports and feedback. Type <b className="text-text">DELETE</b> to confirm.</p>
          <input className="input" value={typed} onChange={(e) => setTyped(e.target.value)} aria-label="Type DELETE to confirm" />
          <div className="flex justify-end gap-2"><button className="btn" onClick={() => setConfirm(false)}>Keep everything</button><button className="btn btn-primary" disabled={typed !== "DELETE"} onClick={clearAll}>Delete all businesses</button></div>
        </div>
      </Modal>
    </div>
  );
}
