import { useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { api } from "../../lib/api";
import { useAsync } from "../../lib/hooks";
import { useWorkspace } from "../../app/workspace";
import LegacySettings from "../../app/pages/Settings";
import { ErrorBox, Skeleton, Spinner, useToast } from "../../components/ui";
import { IconDownload, IconUpload } from "../../components/icons";
import { ago } from "../format";
import type { AIStatus, ScenarioSummary } from "../types";
import { KindTag, PageTitle, useProfile } from "../ui";

interface SourceInfo { id: string; name: string; docs_url: string; rate_note: string; requests_made: number; cache_hits: number; last_success_at: string | null; last_error: { message: string } | null; last_error_at: string | null; rate_limited_for_seconds: number }
interface Status {
  ai: AIStatus; sources: Record<string, SourceInfo>; monitoring: string;
  weather_provider: string; terms: Record<string, string>; data_rules: { id: string; label: string; rule: string }[];
}

export default function Settings() {
  const { current } = useWorkspace();
  const prof = useProfile(current?.id);
  const st = useAsync(() => api.get<Status>("/api/whatif/status"), []);
  const cat = useAsync(() => api.get<{ simplifications: string[]; disclaimer: string; engine: string }>("/api/whatif/industries"), []);
  return (
    <div className="grid gap-10">
      <PageTitle title="Settings & data" sub="Connections, data handling and the assumptions every simulation shares. Keys and private URLs stay on the server; this page only shows whether they are set." />
      {st.error ? <ErrorBox message={st.error} onRetry={st.reload} /> : !st.data ? <Skeleton h={300} /> : (
        <>
          <Row id="ai" title="AI provider">
            <div className="flex flex-wrap items-center gap-2">
              {st.data.ai.configured ? <span className="chip chip-ai">Connected: {st.data.ai.provider} · {st.data.ai.model}</span> : <span className="chip chip-warn">Not connected</span>}
              <span className="text-[0.82rem] text-text-3">timeout {st.data.ai.timeout_seconds}s · {st.data.ai.calls} calls this session · {st.data.ai.failures} failed</span>
            </div>
            {!st.data.ai.configured && <p className="text-text-2">{st.data.ai.setup_hint} Without AI, What-if still calculates everything; questions are read by a rule-based parser and explanations are written from the calculation, both labelled as such.</p>}
            {st.data.ai.last_error && <p className="text-[0.85rem] text-[var(--sev-moderate)]">Last error ({ago(st.data.ai.last_error_at)}): {st.data.ai.last_error}</p>}
            {st.data.ai.last_success_at && <p className="text-[0.85rem] text-text-3">Last successful AI response {ago(st.data.ai.last_success_at)}.</p>}
            <details className="text-[0.85rem] text-text-2"><summary className="cursor-pointer text-text-3">How to switch provider</summary>
              <pre className="mt-2 overflow-x-auto rounded-[var(--r-card)] border border-line bg-night p-3 text-[0.78rem]">{`# backend/.env (server-side only), then restart the backend
WHATIF_AI_PROVIDER=anthropic          # default
ANTHROPIC_API_KEY=...
WHATIF_AI_MODEL=claude-opus-5-5

# or any OpenAI-compatible endpoint (OpenAI, OpenRouter, Ollama, vLLM)
WHATIF_AI_PROVIDER=openai_compatible
WHATIF_AI_BASE_URL=https://.../v1
WHATIF_AI_MODEL=...
WHATIF_AI_API_KEY=...`}</pre>
            </details>
          </Row>

          <Row title="External data">
            <ul className="panel divide text-[0.86rem]">
              {Object.values(st.data.sources).map((s) => (
                <li key={s.id} className="grid gap-0.5 px-4 py-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <a href={s.docs_url} target="_blank" rel="noreferrer" className="font-medium underline">{s.name}</a>
                    <span className={`chip ${s.last_error && (!s.last_success_at || (s.last_error_at ?? "") > s.last_success_at) ? "chip-warn" : s.last_success_at ? "chip-good" : ""}`}>
                      {s.last_success_at ? `last answer ${ago(s.last_success_at)}` : s.requests_made ? "no successful answer yet" : "not used yet this session"}
                    </span>
                  </div>
                  <span className="text-text-3">{s.rate_note}. {s.requests_made} requests, {s.cache_hits} served from cache.</span>
                  {s.last_error && <span className="text-[var(--sev-moderate)]">Last error: {s.last_error.message}</span>}
                </li>
              ))}
            </ul>
            <p className="text-[0.82rem] text-text-3">{st.data.monitoring} Responses are cached (weather 3 h, World Bank 24 h, exchange rates 6 h); a failed refresh keeps the last good value, marked stale with its age. Prometheus live metrics are configured separately: <Link to="/app/live" className="underline">Live data</Link>.</p>
            <div className="grid gap-1.5 rounded-[var(--r-card)] border border-dashed border-line-strong p-3 text-[0.85rem]">
              <span><b>Weather provider:</b> {st.data.weather_provider === "none" ? "turned off" : "Open-Meteo (free API)"}</span>
              <span className="text-[var(--sev-moderate)]">{st.data.terms.weather}</span>
              <span className="text-text-3">For commercial use, switch to a paid Open-Meteo plan (WHATIF_OPEN_METEO_BASE_URL + WHATIF_OPEN_METEO_API_KEY) or turn weather off (WHATIF_WEATHER_PROVIDER=none).</span>
              <span className="text-text-3">{st.data.terms.inflation} {st.data.terms.fx}</span>
            </div>
            <details className="text-[0.85rem]"><summary className="cursor-pointer text-text-3">How external data can affect a scenario</summary>
              <ul className="mt-2 grid list-disc gap-1 pl-5 text-text-2">{st.data.data_rules.map((r) => <li key={r.id}><b className="text-text">{r.label}.</b> {r.rule}</li>)}</ul>
              <p className="mt-1 text-text-3">Nothing is applied automatically. Each applied data point is recorded on the scenario with its source, value, date and retrieval time.</p>
            </details>
          </Row>

        </>
      )}

      <Row title="Privacy & data handling">
        <ul className="grid list-disc gap-1.5 pl-5 text-[0.9rem] text-text-2">
          <li>Business figures, scenarios and reports are stored in this server's database, in a workspace tied to this browser by a signed cookie. There are no accounts.</li>
          <li>When AI is connected, What-if sends the industry, currency, country, product names and figures, cost totals, the scenario's changes and calculated results. It never sends the business name, description, location or monthly history rows.</li>
          <li>AI responses are validated against fixed formats, and any sentence citing a number that is not in the calculation is removed before you see it.</li>
          <li>External data requests (weather, inflation, lending rate, GDP growth, exchange rates) send only coordinates, a country code or currency codes.</li>
        </ul>
      </Row>

      {cat.data && (
        <Row title="Simulation assumptions">
          <p className="text-text-2">Engine: {cat.data.engine}. Per-business settings (elasticities, marketing response, seasonality, tax, uncertainty ranges) live in <Link to="/app/setup" className="underline">Business setup</Link>. These simplifications apply to every simulation:</p>
          <ul className="grid list-disc gap-1 pl-5 text-[0.88rem] text-text-2">{cat.data.simplifications.map((s) => <li key={s}>{s}</li>)}</ul>
          <p className="text-[0.85rem] text-text-3">{cat.data.disclaimer}</p>
        </Row>
      )}

      {current && prof.profile && <ImportExport businessId={current.id} name={current.name} />}

      <div className="grid gap-3">
        <h2 className="text-[1.02rem] font-semibold">Workspace & audit trail</h2>
        <LegacySettings embedded />
      </div>
    </div>
  );
}

function Row({ title, id, children }: { title: string; id?: string; children: ReactNode }) {
  return (
    <section id={id} className="grid gap-3 md:grid-cols-[15rem_minmax(0,1fr)]">
      <div className="grid content-start gap-2"><div className="hline" /><h2 className="text-[1rem] font-semibold">{title}</h2></div>
      <div className="grid content-start gap-3 md:pt-3">{children}</div>
    </section>
  );
}

function ImportExport({ businessId, name }: { businessId: number; name: string }) {
  const toast = useToast();
  const { refresh } = useWorkspace();
  const file = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const download = (data: unknown, fname: string) => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = fname;
    a.click();
    URL.revokeObjectURL(url);
  };
  const exportAll = async () => {
    setBusy(true);
    try {
      const p = await api.get<{ profile: unknown }>(`/api/whatif/businesses/${businessId}/profile`);
      const s = await api.get<ScenarioSummary[]>(`/api/whatif/businesses/${businessId}/scenarios`);
      download({ exported_at: new Date().toISOString(), format: "whatif-export-1", profile: p.profile, scenarios: s.map((x) => ({ name: x.name, question: x.question, levers: x.levers })) },
        `${name.replace(/[^\w-]+/g, "_")}-whatif.json`);
    } finally { setBusy(false); }
  };
  const importProfile = async (f: File) => {
    setBusy(true);
    setErr(null);
    try {
      const data = JSON.parse(await f.text());
      const spec = data?.profile?.spec ?? data?.spec ?? data;
      if (!spec?.industry || !spec?.products) throw new Error("This file has no What-if profile (expected an export from this page).");
      await api.put(`/api/whatif/businesses/${businessId}/profile`, { spec, note: `Imported from ${f.name}.` });
      let n = 0;
      for (const sc of data?.scenarios ?? []) {
        await api.post(`/api/whatif/businesses/${businessId}/scenarios`, { name: sc.name, question: sc.question ?? "", levers: sc.levers ?? {} });
        n++;
      }
      toast(`Imported the profile${n ? ` and ${n} scenarios` : ""}. They were recalculated on import.`);
      await refresh();
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); if (file.current) file.current.value = ""; }
  };
  return (
    <Row title="Import & export">
      <p className="text-text-2">Export {name}'s profile and saved scenarios as JSON, or import an export into this business (creates a new profile version and recalculates imported scenarios). Report numbers can be exported as CSV from each report.</p>
      <div className="flex flex-wrap gap-2">
        <button className="btn" onClick={exportAll} disabled={busy}>{busy ? <Spinner /> : <IconDownload size={15} />}Export JSON</button>
        <button className="btn" onClick={() => file.current?.click()} disabled={busy}><IconUpload size={15} />Import JSON</button>
        <input ref={file} type="file" accept="application/json,.json" className="hidden" onChange={(e) => e.target.files?.[0] && importProfile(e.target.files[0])} />
      </div>
      {err && <p className="error-text">{err}</p>}
      <p className="text-[0.8rem] text-text-3">Exports are generated in your browser; nothing is sent anywhere. <KindTag kind="calculated" /> values in exports are recalculated on import, never copied.</p>
    </Row>
  );
}
