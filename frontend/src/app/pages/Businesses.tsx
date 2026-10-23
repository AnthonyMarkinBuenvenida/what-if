import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { IconPlus, IconTrash } from "../../components/icons";
import { CalibrationChip, DemoBadge, Empty, Modal, PageHeader, Skeleton, useToast } from "../../components/ui";
import { api } from "../../lib/api";
import { when } from "../../lib/format";
import type { Business } from "../../lib/types";
import { useWorkspace } from "../workspace";

export default function Businesses() {
  const ws = useWorkspace();
  const nav = useNavigate();
  const toast = useToast();
  const [confirm, setConfirm] = useState<Business | null>(null);

  async function remove(b: Business) {
    try {
      await api.del(`/api/businesses/${b.id}`);
      toast(`Deleted ${b.name}.`);
      setConfirm(null);
      await ws.refresh();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "bad");
    }
  }

  return (
    <div>
      <PageHeader title="My Businesses" sub="Each business has its own digital twin, model history, scenarios and results."
        actions={<button className="btn btn-primary" onClick={() => nav("/app/new")}><IconPlus size={16} />New business model</button>} />
      {ws.loading ? <div className="grid gap-3">{[0, 1].map((i) => <Skeleton key={i} h={90} />)}</div>
        : !ws.businesses.length ? <Empty title="No businesses yet" action={<button className="btn btn-primary" onClick={() => nav("/app/new")}>Create business model</button>}>Describe your business and the decision you want to test.</Empty>
        : (
          <ul className="grid gap-3 md:grid-cols-2">
            {ws.businesses.map((b) => (
              <li key={b.id} className={`card card-pad grid gap-3 ${ws.current?.id === b.id ? "border-[color-mix(in_srgb,var(--text)_55%,var(--line))]" : ""}`}>
                <div className="flex flex-wrap items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <h2 className="t-h3">{b.name}</h2>
                    <p className="text-[0.82rem] text-text-3">{b.business_type} · {b.industry} · created {when(b.created_at)}</p>
                  </div>
                  {b.is_demo && <DemoBadge />}
                  {b.active_model && <CalibrationChip status={b.active_model.calibration} />}
                </div>
                {b.decision && <p className="line-clamp-2 text-[0.9rem] text-text-2">Decision: {b.decision}</p>}
                <div className="flex flex-wrap gap-x-5 gap-y-1 text-[0.82rem] text-text-2">
                  <span>Model v{b.active_model?.version ?? "—"}</span><span>{b.scenario_count} scenarios</span>
                  <span>{Object.entries(b.run_counts).filter(([s]) => s.startsWith("completed")).reduce((a, [, n]) => a + n, 0)} completed runs</span>
                  {b.creation_mode === "plan" && <span>Plan: {b.plan_status}</span>}
                </div>
                <div className="flex flex-wrap gap-2">
                  <button className="btn btn-sm" onClick={() => { ws.setCurrentId(b.id); nav("/app/twin"); }}>Open twin</button>
                  <button className="btn btn-sm" onClick={() => { ws.setCurrentId(b.id); nav("/app/worlds"); }}>Parallel worlds</button>
                  <button className="btn btn-quiet btn-sm btn-danger ml-auto" onClick={() => setConfirm(b)}><IconTrash size={15} />Delete</button>
                </div>
              </li>
            ))}
          </ul>
        )}
      <Modal open={!!confirm} onClose={() => setConfirm(null)} title="Delete business?">
        <p className="mb-5 text-text-2">This permanently deletes <b className="text-text">{confirm?.name}</b> with all its model versions, scenarios, runs, reports and feedback. It cannot be undone.</p>
        <div className="flex justify-end gap-2"><button className="btn" onClick={() => setConfirm(null)}>Keep it</button><button className="btn btn-danger" onClick={() => confirm && remove(confirm)}>Delete business</button></div>
      </Modal>
    </div>
  );
}
