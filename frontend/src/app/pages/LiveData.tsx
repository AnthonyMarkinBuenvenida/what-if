/* Live data from the configured Prometheus server. Shows only values that the
   server actually returned, each with its timestamp; nothing is filled in when
   the source is missing, unreachable or empty. */
import { useEffect, useRef, useState } from "react";
import { LineChart, Sparkline } from "../../components/charts";
import { IconAlert, IconCheck, IconRetry } from "../../components/icons";
import { DataTag, ErrorBox, Notice, PageHeader, Skeleton, Spinner, useToast } from "../../components/ui";
import { api } from "../../lib/api";
import { usePolling } from "../../lib/hooks";
import { useWorkspace } from "../workspace";

interface Status {
  configured: boolean; name: string; reachable: boolean; version: string | null; checked_at: number; latency_ms: number | null;
  error: string | null; error_kind: string | null; metric_names_available: number | null; business_metrics_configured: number; business_config_error: string | null;
  startup_telemetry: { found: boolean; reason?: string; job?: string; last_scrape_at?: number | null; age_seconds?: number | null; target_up?: boolean | null; stale?: boolean };
}
interface OpValue { value: number | null; evaluated_at?: number; unit: string; query: string; error?: string }
interface Operational { available: boolean; reason?: string; kind?: string; values?: Record<string, OpValue>; series?: Record<string, [number, number | null][] | { error: string }>; fetched_at?: number }
interface BizMetric { key: string; label: string; unit: string; use: string; query: string; description: string; value: number | null; evaluated_at: number | null; sample_at: number | null; age_seconds: number | null; stale: boolean | null; series: [number, number | null][]; error: string | null }
interface Business { metrics: BizMetric[]; error: string | null; kind?: string; note?: string; fetched_at?: number }
interface Compare { metric: { label: string; unit: string }; observed: number; evaluated_at: number; expected: number; expected_basis: string; model_version: number; ratio: number | null; suggestion: string }

const REFRESH_MS = 15000;
const LABELS: Record<string, string> = {
  requests_per_second: "API requests per second (5-minute rate)", error_ratio: "Share of API requests that failed (5 min)",
  runs_active: "Simulations running now", runs_finished_1h: "Simulations finished in the last hour", runs_failed_1h: "Simulations failed in the last hour",
  demo_runs_1h: "Demo simulations in the last hour", run_duration_p95_seconds: "Slowest 5% of simulations took at least", api_latency_p95_seconds: "Slowest 5% of API requests took at least",
};

const clock = (t?: number | null) => (t ? new Date(t * 1000).toLocaleTimeString() : "—");
const ago = (s?: number | null) => (s == null ? "unknown" : s < 90 ? `${Math.round(s)} s ago` : s < 5400 ? `${Math.round(s / 60)} min ago` : `${(s / 3600).toFixed(1)} h ago`);
function fmt(v: number | null, unit: string) {
  if (v == null) return "No data yet";
  if (unit === "share") return `${(v * 100).toFixed(1)}%`;
  if (unit === "seconds") return v < 1 ? `${Math.round(v * 1000)} ms` : `${v.toFixed(2)} s`;
  if (unit === "requests/s") return `${v.toFixed(2)}/s`;
  // increase() over a window is extrapolated by Prometheus, so counts can be fractional.
  if (unit === "runs" && !Number.isInteger(v)) return `≈${v.toFixed(1)}`;
  return Number.isInteger(v) ? v.toLocaleString() : v.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

/** Highlights a value briefly when a refresh returns a different number. */
function Changing({ value, children }: { value: unknown; children: React.ReactNode }) {
  const prev = useRef(value);
  const [flash, setFlash] = useState(0);
  useEffect(() => {
    if (prev.current !== undefined && prev.current !== value) setFlash((f) => f + 1);
    prev.current = value;
  }, [value]);
  return <span key={flash} className={flash ? "value-changed rounded px-1" : "px-1"}>{children}</span>;
}

export default function LiveData() {
  const ws = useWorkspace();
  const toast = useToast();
  const [status, setStatus] = useState<Status | null>(null);
  const [op, setOp] = useState<Operational | null>(null);
  const [biz, setBiz] = useState<Business | { forbidden: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastLoad, setLastLoad] = useState<number | null>(null);
  const [visible, setVisible] = useState(!document.hidden);
  const [cmp, setCmp] = useState<{ key: string; data: Compare } | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    try {
      const [s, o] = await Promise.all([api.get<Status>("/api/live/status"), api.get<Operational>("/api/live/operational")]);
      setStatus(s);
      setOp(o);
      try { setBiz(await api.get<Business>("/api/live/business")); }
      catch (e) { setBiz({ forbidden: e instanceof Error ? e.message : String(e) }); }
      setError(null);
      setLastLoad(Date.now());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { load(); }, []);
  useEffect(() => {
    const on = () => setVisible(!document.hidden);
    document.addEventListener("visibilitychange", on);
    return () => document.removeEventListener("visibilitychange", on);
  }, []);
  // Refresh only while the page is visible and a source is configured.
  usePolling(load, visible && !!status?.configured, REFRESH_MS);

  async function compare(key: string) {
    if (!ws.current) return;
    setBusy(true);
    try { setCmp({ key, data: await api.post<Compare>(`/api/businesses/${ws.current.id}/live/compare`, { key }) }); }
    catch (e) { toast(e instanceof Error ? e.message : String(e), "bad"); }
    finally { setBusy(false); }
  }
  async function apply(key: string) {
    if (!ws.current) return;
    setBusy(true);
    try {
      const r = await api.post<{ new_version: { version: number } }>(`/api/businesses/${ws.current.id}/live/apply`, { key });
      toast(`Model v${r.new_version.version} created from the live measurement. Earlier versions and results are unchanged.`);
      setCmp(null);
      ws.refresh();
    } catch (e) { toast(e instanceof Error ? e.message : String(e), "bad"); }
    finally { setBusy(false); }
  }

  if (loading) return <div className="grid gap-3"><Skeleton h={40} w={300} /><Skeleton h={220} /></div>;
  if (error && !status) return <ErrorBox message={error} onRetry={load} />;
  const st = status!;
  const tel = st.startup_telemetry;

  return (
    <div className="grid gap-8">
      <PageHeader title="Live data" sub="Measurements read from your monitoring server, kept separate from simulation results and example data."
        actions={<button className="btn" onClick={load}><IconRetry size={15} />Refresh now</button>} />

      <section className="grid gap-4 border-t border-text pt-5 md:grid-cols-[16rem_1fr]">
        <h2 className="t-h3">Connection</h2>
        <div className="grid gap-2 text-[0.92rem]">
          {!st.configured ? (
            <>
              <p className="flex items-center gap-2"><IconAlert size={16} /><b>Not configured.</b> No live data source is connected, so What-if shows no live measurements.</p>
              <p className="text-text-2">To connect a Prometheus server, set <code>PROMETHEUS_URL</code> (and, if needed, <code>PROMETHEUS_BEARER_TOKEN</code> or <code>PROMETHEUS_USERNAME</code>/<code>PROMETHEUS_PASSWORD</code>) on the What-if server and restart it. See the README section "Live data".</p>
            </>
          ) : !st.reachable ? (
            <>
              <p className="flex items-center gap-2"><IconAlert size={16} /><b>{st.name} could not be reached.</b></p>
              <p className="text-text-2">{st.error} No values are shown until the connection works again; What-if does not substitute estimates.</p>
            </>
          ) : (
            <>
              <p className="flex flex-wrap items-center gap-2"><IconCheck size={16} /><b>Connected to {st.name}</b><span className="text-text-2">version {st.version} · answered in {st.latency_ms} ms · {st.metric_names_available} metric names available</span></p>
              <p className="text-text-2">Checked at {clock(st.checked_at)}. {visible ? `Refreshes every ${REFRESH_MS / 1000} s while this page is open.` : "Paused while this tab is hidden."}{lastLoad && ` Last refresh ${new Date(lastLoad).toLocaleTimeString()}.`}</p>
            </>
          )}
          {error && <Notice tone="warn">The last refresh failed: {error}. Showing the values from {lastLoad ? new Date(lastLoad).toLocaleTimeString() : "the previous refresh"}.</Notice>}
        </div>
      </section>

      {st.configured && st.reachable && (
        <section className="grid gap-4 border-t border-text pt-5">
          <div className="flex flex-wrap items-center gap-3">
            <h2 className="t-h3">What-if operations</h2><DataTag kind="live" />
            <span className="text-[0.85rem] text-text-3">How this What-if server is running, as recorded by {st.name}. These are application metrics, not business results.</span>
          </div>
          {!tel.found ? (
            <Notice>{tel.reason}</Notice>
          ) : (
            <>
              <p className="text-[0.88rem] text-text-2">
                Scrape job <code>{tel.job}</code>: target {tel.target_up ? "up" : "down"}, last scraped {ago(tel.age_seconds)} ({clock(tel.last_scrape_at)}).
                {tel.stale && <b className="ml-1"><IconAlert size={14} className="mr-1 inline" />Stale: no fresh samples recently, so these values may be out of date.</b>}
              </p>
              {op?.available && op.values ? (
                <>
                  <dl className="grid grid-cols-1 border-l border-t border-line sm:grid-cols-2 lg:grid-cols-4">
                    {Object.entries(op.values).map(([k, v]) => (
                      <div key={k} className="grid gap-1 border-b border-r border-line p-4">
                        <dt className="text-[0.8rem] text-text-2">{LABELS[k] ?? k}</dt>
                        <dd className="num text-[1.4rem] font-semibold" style={{ fontFamily: "var(--font-display)" }}><Changing value={v.value}>{v.error ? "Query failed" : fmt(v.value, v.unit)}</Changing></dd>
                        <span className="text-[0.72rem] text-text-3" title={v.query}>{v.error ?? (v.evaluated_at ? `evaluated ${clock(v.evaluated_at)}` : "")}{v.unit === "runs" && v.value != null && !Number.isInteger(v.value) ? " · estimated by Prometheus from counter samples" : ""}</span>
                      </div>
                    ))}
                  </dl>
                  <div className="grid gap-4 lg:grid-cols-2">
                    {(["requests_per_second", "runs_finished_per_minute"] as const).map((k) => {
                      const s = op.series?.[k];
                      return (
                        <div key={k} className="card card-pad">
                          <h3 className="mb-2 text-[0.95rem]">{k === "requests_per_second" ? "API requests per second, last hour" : "Simulations finished per minute, last hour"}</h3>
                          {!s || "error" in s ? <p className="text-[0.85rem] text-text-3">{s && "error" in s ? s.error : "No data."}</p>
                            : s.length < 2 ? <p className="text-[0.85rem] text-text-3">Not enough samples yet. Values appear after a few scrapes.</p>
                            : <LineChart ariaLabel={k} height={180} xTitle="Time" format={(v) => v.toFixed(2)} animate={false}
                                xLabels={s.map(([t]) => new Date(t * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }))}
                                series={[{ id: k, label: k, colorIndex: 0, values: s.map(([, v]) => v) }]} />}
                        </div>
                      );
                    })}
                  </div>
                </>
              ) : <Notice>{op?.reason ?? "No operational data."}</Notice>}
            </>
          )}
        </section>
      )}

      <section className="grid gap-4 border-t border-text pt-5">
        <div className="flex flex-wrap items-center gap-3"><h2 className="t-h3">Business measurements</h2>{biz && "metrics" in biz && biz.metrics.length > 0 && <DataTag kind="live" />}</div>
        {!biz ? null : "forbidden" in biz ? <Notice>{biz.forbidden}</Notice>
          : biz.kind === "not_configured" ? <p className="text-[0.9rem] text-text-2">No live data source is configured, so no business measurements are available. Simulations use the inputs in each business's digital twin.</p>
          : biz.error ? <Notice tone="warn">{biz.error}</Notice>
          : biz.kind === "no_mapping" ? (
            <div className="grid gap-2 text-[0.9rem] text-text-2">
              <p>{biz.note}</p>
              <p>{st.reachable && st.metric_names_available != null ? `${st.name} currently holds ${st.metric_names_available} metric names; none are mapped as business data, so none are shown as sales, demand or revenue.` : ""}</p>
              <p>To use a real business metric (for example daily units sold), map it on the server:</p>
              <pre className="overflow-x-auto rounded-[var(--r-card)] bg-surface-2 p-3 text-[0.78rem] text-text">{`STARTUP_BUSINESS_METRICS='[{"key":"units_sold_daily","label":"Units sold per day",
  "query":"sum(increase(your_units_sold_total[1d]))","unit":"units/day",
  "use":"demand","freshness_selector":"your_units_sold_total"}]'`}</pre>
            </div>
          ) : (
            <div className="table-wrap"><table className="data">
              <thead><tr><th>Measurement</th><th className="n">Latest value</th><th>Sampled</th><th>Last 24 h</th><th /></tr></thead>
              <tbody>{biz.metrics.map((m) => (
                <tr key={m.key}>
                  <td><b>{m.label}</b><div className="text-[0.72rem] text-text-3" title={m.query}>{m.description || m.query}</div></td>
                  <td className="n"><Changing value={m.value}>{m.value == null ? "No data" : `${fmt(m.value, m.unit)} ${m.unit}`}</Changing></td>
                  <td className="text-[0.8rem]">{m.error ? <span>{m.error}</span> : <>evaluated {clock(m.evaluated_at)}{m.age_seconds != null && <div className="text-text-3">newest sample {ago(m.age_seconds)}</div>}{m.stale && <div className="font-semibold">Stale</div>}{m.age_seconds == null && <div className="text-text-3">sample age not configured</div>}</>}</td>
                  <td>{m.series.filter(([, v]) => v != null).length > 1 ? <Sparkline values={m.series.filter(([, v]) => v != null).map(([, v]) => v as number)} width={140} /> : <span className="text-[0.75rem] text-text-3">—</span>}</td>
                  <td className="whitespace-nowrap">{(m.use === "demand" || m.use === "revenue") && ws.current && m.value != null &&
                    <button className="btn btn-sm" disabled={busy} onClick={() => compare(m.key)}>{busy && cmp?.key !== m.key ? <Spinner /> : null}Compare with {ws.current.name}</button>}</td>
                </tr>
              ))}</tbody>
            </table></div>
          )}
        {cmp && (
          <div className="panel grid gap-3 p-5">
            <h3 className="t-h3">{cmp.data.metric.label} vs. model v{cmp.data.model_version}</h3>
            <div className="grid gap-4 sm:grid-cols-3 text-[0.9rem]">
              <div><div className="text-text-3">Live measurement</div><b className="num">{cmp.data.observed.toLocaleString(undefined, { maximumFractionDigits: 2 })} {cmp.data.metric.unit}</b><div className="text-[0.75rem] text-text-3">at {clock(cmp.data.evaluated_at)}</div></div>
              <div><div className="text-text-3">Model expectation</div><b className="num">{cmp.data.expected.toLocaleString(undefined, { maximumFractionDigits: 2 })}</b><div className="text-[0.75rem] text-text-3">{cmp.data.expected_basis}</div></div>
              <div><div className="text-text-3">Ratio</div><b className="num">{cmp.data.ratio?.toFixed(3) ?? "—"}</b></div>
            </div>
            <p className="text-text-2">{cmp.data.suggestion} Simulation results are still calculated by the engine; the measurement only changes the model's demand input, and only if you approve.</p>
            <div className="flex gap-2">
              {cmp.data.ratio != null && Math.abs(cmp.data.ratio - 1) > 0.05 && <button className="btn btn-primary" disabled={busy} onClick={() => apply(cmp.key)}>Approve and create a new model version</button>}
              <button className="btn" onClick={() => setCmp(null)}>Close</button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
