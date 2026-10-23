import { Link, useNavigate } from "react-router-dom";
import { IconReport } from "../../components/icons";
import { DemoBadge, Empty, ErrorBox, PageHeader, Skeleton } from "../../components/ui";
import { api } from "../../lib/api";
import { when } from "../../lib/format";
import { useAsync } from "../../lib/hooks";
import { useWorkspace } from "../workspace";

interface ReportRow { id: number; title: string; run_ids: number[]; model_version_ids: number[]; created_at: string; recommendation: string | null; is_demo: boolean }

export default function Reports() {
  const ws = useWorkspace();
  const b = ws.current;
  const nav = useNavigate();
  const reports = useAsync(async () => (b ? api.get<ReportRow[]>(`/api/businesses/${b.id}/reports`) : []), [b?.id]);
  if (!b) return <Empty title="No business selected" action={<button className="btn btn-primary" onClick={() => nav("/app/new")}>Create business model</button>} />;
  if (reports.error) return <ErrorBox message={reports.error} onRetry={reports.reload} />;
  return (
    <div>
      <PageHeader title="Results and reports" sub="Reports are snapshots: they keep the exact runs and model versions they were written from."
        actions={<Link to="/app/lab" className="btn btn-primary no-underline"><IconReport size={16} />New report from the Lab</Link>} />
      {reports.loading && !reports.data ? <Skeleton h={200} /> : !(reports.data ?? []).length ? (
        <Empty title="No reports yet" action={<Link to="/app/lab" className="btn btn-primary no-underline">Open the Decision Lab</Link>}>Compare completed runs in the Decision Lab and create a report from them.</Empty>
      ) : (
        <ul className="grid gap-3">
          {reports.data!.map((r) => (
            <li key={r.id}>
              <Link to={`/app/reports/${r.id}`} className="card interactive grid gap-1 px-5 py-4 no-underline">
                <div className="flex flex-wrap items-center gap-2"><span className="font-semibold">{r.title}</span>{r.is_demo && <DemoBadge />}</div>
                {r.recommendation && <p className="line-clamp-2 text-[0.88rem] text-text-2">{r.recommendation}</p>}
                <p className="text-[0.78rem] text-text-3">Report #{r.id} · runs {r.run_ids.join(", ")} · model version id {r.model_version_ids.join(", ")} · {when(r.created_at)}</p>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
