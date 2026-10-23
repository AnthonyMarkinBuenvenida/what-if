import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { api } from "../lib/api";
import { useWorkspace } from "../app/workspace";
import { Spinner } from "../components/ui";
import { rd } from "../lib/scrollfx";
import type { IndustryInfo, ProfileRow, Severity, Source } from "./types";

// ------------------------------------------------------------- severity

const SEV_LABEL: Record<Severity, string> = { low: "Low", moderate: "Moderate", high: "High", critical: "Critical" };

/** Distinct shape per level so severity never depends on color: circle, triangle, diamond, octagon. */
export function SevShape({ s, size = 11 }: { s: Severity; size?: number }) {
  const p = { width: size, height: size, viewBox: "0 0 12 12", "aria-hidden": true as const };
  if (s === "low") return <svg {...p}><circle cx="6" cy="6" r="4.5" fill="currentColor" /></svg>;
  if (s === "moderate") return <svg {...p}><path d="M6 1.2 11 10.5H1z" fill="currentColor" /></svg>;
  if (s === "high") return <svg {...p}><path d="M6 .8 11.2 6 6 11.2.8 6z" fill="currentColor" /></svg>;
  return <svg {...p}><path d="M4 .8h4L11.2 4v4L8 11.2H4L.8 8V4z" fill="currentColor" /><path d="M6 3.4v3.2M6 8.2v.3" stroke="var(--night)" strokeWidth="1.4" strokeLinecap="round" /></svg>;
}

export function SeverityBadge({ s, suffix }: { s: Severity; suffix?: string }) {
  return <span className={`sev sev-${s}`}><SevShape s={s} />{SEV_LABEL[s]}{suffix ? ` ${suffix}` : ""}</span>;
}

export const sevLabel = (s: Severity) => SEV_LABEL[s];

// ------------------------------------------------------------- kinds of numbers

export type Kind = "actual" | "calculated" | "ai" | "demo" | "forecast" | "historical" | "observed" | "estimate" | "rules";

const KIND: Record<Kind, { cls: string; text: string; title: string }> = {
  actual: { cls: "chip-actual", text: "Actual", title: "Past results you entered for this business." },
  calculated: { cls: "chip-calc", text: "Calculated", title: "Calculated by the What-if engine from the inputs and assumptions shown." },
  ai: { cls: "chip-ai", text: "AI-written", title: "Written by an AI model from the calculated figures. Numbers it cites were checked against the calculation." },
  demo: { cls: "chip-sample", text: "Demo data", title: "Fictional business used to demonstrate What-if. Not real activity." },
  forecast: { cls: "chip-forecast", text: "Forecast", title: "A third party's model forecast for future days (e.g. Open-Meteo weather)." },
  historical: { cls: "chip-accent", text: "Historical", title: "Official statistics for past periods, as published (e.g. World Bank)." },
  observed: { cls: "chip-live", text: "Observed", title: "Published values recorded at a point in time (e.g. a reference exchange rate)." },
  estimate: { cls: "chip-warn", text: "Estimate", title: "A What-if default estimate. Replace it with your own figure." },
  rules: { cls: "chip", text: "From the calculation", title: "Written by fixed rules from the calculated figures. No AI was used." },
};

export function KindTag({ kind, title }: { kind: Kind; title?: string }) {
  const k = KIND[kind];
  return <span className={`chip ${k.cls}`} title={title ?? k.title}>{kind === "ai" && <Spark />}{k.text}</span>;
}

export function Spark({ size = 11 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 12 12" aria-hidden="true"><path d="M6 0c.5 3.2 2.8 5.5 6 6-3.2.5-5.5 2.8-6 6-.5-3.2-2.8-5.5-6-6 3.2-.5 5.5-2.8 6-6z" fill="currentColor" /></svg>;
}

const SRC: Record<Source | string, { text: string; cls: string; title: string }> = {
  user: { text: "Yours", cls: "chip-good", title: "Entered by you" },
  imported: { text: "Imported", cls: "chip-good", title: "Imported from your data" },
  default: { text: "Estimate", cls: "chip-warn", title: "What-if default estimate; replace with your own figure" },
  demo: { text: "Demo", cls: "chip-sample", title: "Fictional demo value" },
  observed: { text: "Observed", cls: "chip-live", title: "From an external data source" },
  stated: { text: "Stated", cls: "chip-good", title: "Stated in your question" },
  assumed: { text: "Assumed", cls: "chip-warn", title: "Assumed because the question did not give it; check it" },
  scenario: { text: "Scenario", cls: "chip-calc", title: "Set for this scenario" },
  ai: { text: "AI assumed", cls: "chip-ai", title: "Assumed by the AI because your question did not give it; check it" },
};

export function SourceBadge({ s }: { s: string | undefined }) {
  const v = SRC[s ?? "user"] ?? SRC.user;
  return <span className={`chip ${v.cls}`} title={v.title} style={{ height: "1.2rem", fontSize: "0.68rem", padding: "0 0.38rem" }}>{v.text}</span>;
}

// ------------------------------------------------------------- figures

export function Delta({ v, fmt, invert = false }: { v: number | null | undefined; fmt: (n: number) => string; invert?: boolean }) {
  if (v == null || Math.abs(v) < 1e-9) return <span className="text-text-3">no change</span>;
  const good = invert ? v < 0 : v > 0;
  return (
    <span className="num inline-flex items-center gap-1" style={{ color: good ? "var(--sev-low)" : "var(--sev-high)" }}>
      <svg width="9" height="9" viewBox="0 0 10 10" aria-hidden="true" style={{ transform: v > 0 ? "none" : "rotate(180deg)" }}><path d="M5 1 9 8H1z" fill="currentColor" /></svg>
      {fmt(v)}
    </span>
  );
}

export function Kpi({ label, value, sub, kind, big = false }: { label: string; value: ReactNode; sub?: ReactNode; kind?: Kind; big?: boolean }) {
  return (
    <div className="grid content-start gap-1.5">
      <div className="flex flex-wrap items-center gap-2"><span className="label-soft">{label}</span>{kind && <KindTag kind={kind} />}</div>
      <span className={`kpi ${big ? "text-[clamp(1.7rem,1.2rem+1.3vw,2.3rem)]" : "text-[1.55rem]"}`}>{value}</span>
      {sub && <span className="text-[0.8rem] text-text-2">{sub}</span>}
    </div>
  );
}

export function ConfidenceMeter({ level, score, reasons }: { level: "high" | "medium" | "low"; score: number; reasons?: { impact: number; text: string }[] }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="grid gap-2">
      <button className="flex items-center gap-3 text-left" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="flex gap-[3px]" aria-hidden="true">
          {[0, 1, 2, 3, 4].map((i) => <i key={i} className="block h-3 w-1.5 rounded-sm" style={{ background: i < Math.round(score / 20) ? "var(--moon)" : "var(--line-strong)" }} />)}
        </span>
        <span className="text-[0.85rem]"><b className="font-semibold capitalize">{level}</b> confidence <span className="text-text-3">({score}/100)</span></span>
        {reasons && reasons.length > 0 && <span className="text-[0.78rem] text-text-3 underline">{open ? "hide why" : "why?"}</span>}
      </button>
      {open && reasons && (
        <ul className="grid gap-1 pl-1 text-[0.82rem] text-text-2">
          {reasons.map((r, i) => <li key={i} className="flex gap-2"><span className="num w-8 shrink-0 text-text-3">{r.impact}</span>{r.text}</li>)}
        </ul>
      )}
    </div>
  );
}

export function Section({ title, aside, children, className = "" }: { title: ReactNode; aside?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`grid gap-3 ${className}`} data-reveal>
      <div className="flex flex-wrap items-end justify-between gap-2">
        <h2 className="text-[1.02rem] font-bold tracking-[-0.01em]" style={{ textShadow: "0 1px 18px rgba(0,0,0,.75)" }}>{title}</h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

export function PageTitle({ title, sub, actions, kicker }: { title: string; sub?: ReactNode; actions?: ReactNode; kicker?: ReactNode }) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-4 pb-2">
      <div className="grid max-w-[68ch] gap-2">
        {kicker && <div data-reveal>{kicker}</div>}
        <h1 className="t-display-tight text-[clamp(1.9rem,1.4rem+1.8vw,2.7rem)]" data-reveal style={rd(60)}>{title}</h1>
        {sub && <p className="text-text-2" data-reveal style={rd(180)}>{sub}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2" data-reveal style={rd(300)}>{actions}</div>}
    </header>
  );
}

// ------------------------------------------------------------- profile hook

export interface ProfileState {
  loading: boolean; error: string | null; profile: ProfileRow | null; canImportTwin: boolean; industry: IndustryInfo | null;
  reload: () => Promise<void>;
}

export function useProfile(businessId: number | undefined | null): ProfileState {
  const [s, set] = useState<Omit<ProfileState, "reload">>({ loading: true, error: null, profile: null, canImportTwin: false, industry: null });
  const reload = useCallback(async () => {
    if (!businessId) {
      set({ loading: false, error: null, profile: null, canImportTwin: false, industry: null });
      return;
    }
    set((p) => ({ ...p, loading: true }));
    try {
      const r = await api.get<{ profile: ProfileRow | null; can_import_twin?: boolean; industry?: IndustryInfo }>(`/api/whatif/businesses/${businessId}/profile`);
      set({ loading: false, error: null, profile: r.profile, canImportTwin: !!r.can_import_twin, industry: r.industry ?? null });
    } catch (e) {
      set({ loading: false, error: e instanceof Error ? e.message : String(e), profile: null, canImportTwin: false, industry: null });
    }
  }, [businessId]);
  useEffect(() => { reload(); }, [reload]);
  return { ...s, reload };
}

/** Shown when the selected business has no What-if profile yet. */
export function NeedsProfile({ state }: { state: ProfileState }) {
  const { current } = useWorkspace();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  if (state.loading) return <div className="grid min-h-[30vh] place-items-center text-text-3"><Spinner size={20} /></div>;
  return (
    <div className="panel glass grid max-w-2xl gap-4 p-6">
      <h2 className="t-h2">{current ? `${current.name} has no What-if profile yet` : "Set up a business to start"}</h2>
      <p className="text-text-2">What-if needs the business's prices, costs, sales and cash to calculate anything. Start from an industry template (every value is marked as an estimate until you change it), or open the demo milk tea shop.</p>
      {err && <p className="error-text">{err}</p>}
      <div className="flex flex-wrap gap-2">
        <Link to="/app/setup?new=1" className="btn btn-primary">Set up a business</Link>
        {state.canImportTwin && current && (
          <button className="btn" disabled={busy} onClick={async () => {
            setBusy(true);
            try { await api.post(`/api/whatif/businesses/${current.id}/profile/from-twin`); await state.reload(); } catch (e) { setErr(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
          }}>{busy && <Spinner />}Import from this business's digital twin</button>
        )}
        <DemoButton />
      </div>
    </div>
  );
}

export function DemoButton({ className = "btn" }: { className?: string }) {
  const { refresh, setCurrentId } = useWorkspace();
  const [busy, setBusy] = useState(false);
  return (
    <button className={className} disabled={busy} onClick={async () => {
      setBusy(true);
      try {
        const r = await api.post<{ business: { id: number } }>("/api/whatif/demo");
        await refresh();
        setCurrentId(r.business.id);
      } finally { setBusy(false); }
    }}>{busy && <Spinner />}Open the demo milk tea shop</button>
  );
}
