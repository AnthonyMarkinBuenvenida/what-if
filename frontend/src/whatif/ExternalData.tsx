// External data in the simulator: retrieved signals, the documented rules that can apply them to
// this scenario, and the data links already applied. Nothing changes a scenario unless the user applies it.
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { api } from "../lib/api";
import { Spinner } from "../components/ui";
import { IconTrash } from "../components/icons";
import { ago } from "./format";
import type { DataLink, Levers, ProfileSpec, Signal } from "./types";
import { KindTag } from "./ui";

interface SignalsResp { relevant: string[]; signals: Record<string, Signal & { data?: Record<string, unknown> }>; note: string }

export const KIND_TAG = (k: string) => (k === "forecast" ? "forecast" : k === "historical" ? "historical" : k === "user" ? "estimate" : "observed") as "forecast" | "historical" | "observed" | "estimate";

export function SignalStatus({ s }: { s?: Signal }) {
  if (!s) return <span className="chip">not retrieved yet</span>;
  if (s.status === "ok") return <span className="chip chip-good">retrieved {ago(s.retrieved_at)}</span>;
  if (s.status === "stale") return <span className="chip chip-warn" title={s.refresh_error?.message}>stale: last good {ago(s.retrieved_at)}</span>;
  return <span className="chip chip-warn">{s.status}</span>;
}

export function ExternalData({ businessId, spec, levers, setLevers }: { businessId: number; spec: ProfileSpec; levers: Levers; setLevers: (l: Levers) => void }) {
  const [data, setData] = useState<SignalsResp | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(async () => { setData(await api.get<SignalsResp>(`/api/whatif/businesses/${businessId}/signals`)); }, [businessId]);
  useEffect(() => { load().catch((e) => setErr(e instanceof Error ? e.message : String(e))); }, [load]);

  const refresh = async () => {
    setBusy("refresh"); setErr(null);
    try { await api.post(`/api/whatif/businesses/${businessId}/signals/refresh`); await load(); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); } finally { setBusy(null); }
  };
  const apply = async (rule: string, params: Record<string, unknown>) => {
    setBusy(rule); setErr(null);
    try { const r = await api.post<{ levers: Levers }>(`/api/whatif/businesses/${businessId}/signals/apply`, { levers, rule, params }); setLevers({ ...r.levers, start_month: levers.start_month ?? null }); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); } finally { setBusy(null); }
  };
  const remove = async (link: DataLink) => {
    setBusy(link.id); setErr(null);
    try { const r = await api.post<{ levers: Levers }>(`/api/whatif/businesses/${businessId}/signals/unapply`, { levers, link_id: link.id }); setLevers({ horizon_months: levers.horizon_months, ...r.levers, start_month: levers.start_month ?? null }); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); } finally { setBusy(null); }
  };

  const sg = data?.signals ?? {};
  const has = (k: string) => data?.relevant.includes(k);
  const usable = (k: string) => sg[k]?.status === "ok" || sg[k]?.status === "stale";
  return (
    <div className="grid gap-3 text-[0.84rem]">
      <div className="flex items-center justify-between gap-2">
        <span className="text-text-3">Retrieved on request; nothing is applied unless you choose to.</span>
        <button className="btn btn-sm btn-outline" onClick={refresh} disabled={!!busy}>{busy === "refresh" && <Spinner />}Refresh</button>
      </div>
      {err && <p className="error-text">{err}</p>}
      {!data ? <span className="think-text">Loading…</span> : (
        <>
          {has("fx") && <FxRule s={sg.fx} spec={spec} busy={busy} onApply={apply} disabled={!usable("fx")} />}
          {has("inflation") && <InflationRule s={sg.inflation} busy={busy} onApply={apply} disabled={!usable("inflation")} horizon={levers.horizon_months ?? 12} />}
          {has("lending") && <LendingRule s={sg.lending} cur={spec.business.currency} busy={busy} onApply={apply} disabled={!usable("lending")} />}
          {has("weather") && <WeatherRule s={sg.weather} busy={busy} onApply={apply} disabled={!usable("weather")} start={levers.start_month} />}
          {has("market") && <MarketRule s={sg.market} busy={busy} onApply={apply} disabled={!usable("market")} />}
          {has("gdp") && sg.gdp && <div className="grid gap-1 rounded-[var(--r-card)] border border-line p-2.5"><Head s={sg.gdp} /><span className="text-text-3">Context only; no rule applies GDP growth to a single business.</span></div>}
          {!has("fx") && <p className="text-text-3">Exchange rates appear here once you set the share of costs priced in a foreign currency (Business setup → External exposure).</p>}
        </>
      )}
      {!!levers.data_links?.length && (
        <div className="grid gap-1.5 border-t border-line pt-2">
          <span className="font-semibold">Applied to this scenario</span>
          {levers.data_links.map((l) => (
            <div key={l.id} className="flex items-start justify-between gap-2">
              <span className="text-text-2"><KindTag kind={KIND_TAG(l.kind)} /> {l.indicator}: {l.value}{l.unit.startsWith("%") ? "" : " "}{l.unit} ({l.observed_at})</span>
              <button className="btn btn-quiet btn-sm !px-1.5" aria-label="Remove this data point" onClick={() => remove(l)} disabled={!!busy}><IconTrash size={14} /></button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Head({ s }: { s?: Signal }) {
  return (
    <div className="grid gap-0.5">
      <div className="flex flex-wrap items-center justify-between gap-1.5"><span className="font-semibold">{s?.label}</span><span className="flex gap-1">{s && <KindTag kind={KIND_TAG(s.kind)} />}<SignalStatus s={s} /></span></div>
      {s?.summary && <span className="text-text-2">{s.summary}</span>}
      {s?.reason && <span className="text-text-3">{s.reason}</span>}
      {s?.status === "failed" && <span className="text-[var(--sev-moderate)]">{(s as { error?: { message: string } }).error?.message}</span>}
    </div>
  );
}

function Box({ s, children }: { s?: Signal; children: ReactNode }) {
  return <div className="grid gap-2 rounded-[var(--r-card)] border border-line p-2.5"><Head s={s} />{children}</div>;
}

function Apply({ onClick, busy, disabled }: { onClick: () => void; busy: boolean; disabled: boolean }) {
  return <button className="btn btn-sm justify-self-start" onClick={onClick} disabled={disabled || busy}>{busy && <Spinner />}Apply to this scenario</button>;
}

function FxRule({ s, spec, busy, onApply, disabled }: { s?: Signal; spec: ProfileSpec; busy: string | null; onApply: (r: string, p: Record<string, unknown>) => void; disabled: boolean }) {
  const [share, setShare] = useState(spec.external.imported_cost_share_pct ?? 0);
  const [mode, setMode] = useState("observed_90d");
  const [rate, setRate] = useState<number | "">("");
  return (
    <Box s={s}>
      <span className="text-text-3">Variable cost change = imported share × exchange-rate change.</span>
      <div className="grid grid-cols-2 gap-2">
        <label className="field"><span>Imported share %</span><input className="input input-num" type="number" min={0} max={100} value={share} onChange={(e) => setShare(+e.target.value)} /></label>
        <label className="field"><span>Exchange-rate change</span>
          <select className="select" value={mode} onChange={(e) => setMode(e.target.value)}><option value="observed_90d">Observed 90-day move</option><option value="hypothetical">Test a rate</option></select>
        </label>
        {mode === "hypothetical" && <label className="field col-span-2"><span>Rate to test ({spec.business.currency} per {spec.external.foreign_currency})</span><input className="input input-num" type="number" step={0.01} value={rate} onChange={(e) => setRate(e.target.value === "" ? "" : +e.target.value)} /></label>}
      </div>
      <Apply busy={busy === "fx_imported_costs"} disabled={disabled} onClick={() => onApply("fx_imported_costs", { imported_share_pct: share, mode, ...(mode === "hypothetical" ? { new_rate: rate } : {}) })} />
    </Box>
  );
}

function InflationRule({ s, busy, onApply, disabled, horizon }: { s?: Signal; busy: string | null; onApply: (r: string, p: Record<string, unknown>) => void; disabled: boolean; horizon: number }) {
  const [t, setT] = useState<string[]>(["unit_cost_change_pct"]);
  const opts: [string, string][] = [["unit_cost_change_pct", "Variable costs"], ["wage_change_pct", "Wages"], ["fixed_cost_change_pct", "Other fixed costs"]];
  return (
    <Box s={s}>
      <span className="text-text-3">Average cost level over {horizon} months if costs rise steadily at the published annual rate: rate × ({horizon} ÷ 12) ÷ 2.</span>
      <div className="flex flex-wrap gap-3">{opts.map(([k, l]) => <label key={k} className="flex items-center gap-1.5"><input type="checkbox" checked={t.includes(k)} onChange={(e) => setT(e.target.checked ? [...t, k] : t.filter((x) => x !== k))} />{l}</label>)}</div>
      <Apply busy={busy === "inflation_costs"} disabled={disabled || !t.length} onClick={() => onApply("inflation_costs", { targets: t })} />
    </Box>
  );
}

function LendingRule({ s, cur, busy, onApply, disabled }: { s?: Signal; cur: string; busy: string | null; onApply: (r: string, p: Record<string, unknown>) => void; disabled: boolean }) {
  const [amount, setAmount] = useState<number | "">("");
  return (
    <Box s={s}>
      <span className="text-text-3">Interest per month = loan × published annual rate ÷ 12, added to operating costs.</span>
      <label className="field"><span>Loan amount ({cur})</span><input className="input input-num" type="number" min={0} step={1000} value={amount} onChange={(e) => setAmount(e.target.value === "" ? "" : +e.target.value)} /></label>
      <Apply busy={busy === "lending_interest"} disabled={disabled || !amount} onClick={() => onApply("lending_interest", { loan_amount: amount })} />
    </Box>
  );
}

function WeatherRule({ s, busy, onApply, disabled, start }: { s?: Signal & { data?: Record<string, unknown> }; busy: string | null; onApply: (r: string, p: Record<string, unknown>) => void; disabled: boolean; start?: string | null }) {
  const [cond, setCond] = useState("rain_probability");
  const [th, setTh] = useState(70);
  const [pct, setPct] = useState<number | "">("");
  const wsError = (s?.data?.reported_now_error as { message?: string } | undefined)?.message;
  return (
    <Box s={s}>
      {wsError && <span className="text-[var(--sev-moderate)]">Weatherstack reading unavailable: {wsError}</span>}
      <span className="text-text-3">Your demand adjustment, applied only to the share of each month covered by matching forecast days. The forecast covers the next 16 days{start ? "" : "; set “Starting” to the current month to use days in this month"}.</span>
      <div className="grid grid-cols-3 gap-2">
        <label className="field"><span>Condition</span><select className="select" value={cond} onChange={(e) => { setCond(e.target.value); setTh(e.target.value === "heat" ? 34 : e.target.value === "rain_mm" ? 20 : 70); }}>
          <option value="rain_probability">Rain chance ≥ %</option><option value="rain_mm">Rain ≥ mm</option><option value="heat">Max temp ≥ °C</option></select></label>
        <label className="field"><span>Threshold</span><input className="input input-num" type="number" value={th} onChange={(e) => setTh(+e.target.value)} /></label>
        <label className="field"><span>Demand those days %</span><input className="input input-num" type="number" value={pct} placeholder="e.g. -20" onChange={(e) => setPct(e.target.value === "" ? "" : +e.target.value)} /></label>
      </div>
      <Apply busy={busy === "weather_demand"} disabled={disabled || pct === ""} onClick={() => onApply("weather_demand", { condition: cond, threshold: th, demand_change_pct: pct })} />
    </Box>
  );
}

function MarketRule({ s, busy, onApply, disabled }: { s?: Signal; busy: string | null; onApply: (r: string, p: Record<string, unknown>) => void; disabled: boolean }) {
  const [target, setTarget] = useState("unit_cost_change_pct");
  const [sens, setSens] = useState<number | "">("");
  return (
    <Box s={s}>
      <span className="text-text-3">Change = your sensitivity × the stock's observed price move over about 90 days. 0.5 passes on half the move; −1 moves the opposite way.</span>
      <div className="grid grid-cols-2 gap-2">
        <label className="field"><span>Apply to</span><select className="select" value={target} onChange={(e) => setTarget(e.target.value)}><option value="unit_cost_change_pct">Variable costs</option><option value="demand_change_pct">Demand</option></select></label>
        <label className="field"><span>Sensitivity</span><input className="input input-num" type="number" min={-5} max={5} step={0.1} value={sens} placeholder="e.g. 0.5" onChange={(e) => setSens(e.target.value === "" ? "" : +e.target.value)} /></label>
      </div>
      <Apply busy={busy === "market_move"} disabled={disabled || sens === ""} onClick={() => onApply("market_move", { target, sensitivity: sens })} />
    </Box>
  );
}

/** Read-only record for results and reports. */
export function DataLinks({ links }: { links: DataLink[] }) {
  return (
    <div className="table-wrap">
      <table className="data min-w-[640px]">
        <thead><tr><th>Data</th><th className="n">Value</th><th>Observed / forecast</th><th>Retrieved</th><th>Kind</th><th>Rule used</th></tr></thead>
        <tbody>{links.map((l) => (
          <tr key={l.id}>
            <td>{l.source_url ? <a href={l.source_url} target="_blank" rel="noreferrer" className="underline">{l.indicator}</a> : l.indicator}<div className="text-[0.75rem] text-text-3">{l.source}</div></td>
            <td className="n">{l.value} {l.unit}</td><td>{l.observed_at}</td><td className="whitespace-nowrap">{l.retrieved_at ? new Date(l.retrieved_at).toLocaleString() : "—"}</td>
            <td><KindTag kind={KIND_TAG(l.kind)} /></td><td className="text-[0.8rem] text-text-2">{l.rule_text}</td>
          </tr>
        ))}</tbody>
      </table>
    </div>
  );
}
