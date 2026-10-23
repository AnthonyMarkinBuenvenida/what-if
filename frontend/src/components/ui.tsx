import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { IconAlert, IconCheck, IconInfo, IconX } from "./icons";
import { STATUS_LABEL, isActive } from "../lib/format";
import type { Provenance, RunStatus } from "../lib/types";

export function Spinner({ size = 14 }: { size?: number }) {
  return (
    <svg className="spin animate-spin" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

export function RunStatusChip({ status, progress }: { status: RunStatus | string; progress?: number }) {
  const cls = status === "completed" ? "chip-good" : status === "completed_with_warnings" ? "chip-warn" : status === "failed" ? "chip-bad" : isActive(status) ? "chip-accent" : "";
  return (
    <span className={`chip ${cls}`} role="status">
      {isActive(status) ? <span className="pulse-dot" style={{ width: 6, height: 6 }} /> : status === "completed" ? <IconCheck size={13} /> : status === "failed" ? <IconX size={13} /> : status === "completed_with_warnings" ? <IconAlert size={13} /> : null}
      {STATUS_LABEL[status] ?? status}
      {status === "running" && progress != null ? <span className="num">{Math.round(progress * 100)}%</span> : null}
    </span>
  );
}

export function OutcomeChip({ outcome }: { outcome: string | null | undefined }) {
  if (!outcome) return null;
  return outcome === "passed" ? (
    <span className="chip chip-good"><IconCheck size={13} />Within limits</span>
  ) : (
    <span className="chip chip-bad"><IconAlert size={13} />Breaks a limit</span>
  );
}

const PROV: Record<Provenance, { label: string; title: string; cls: string }> = {
  confirmed: { label: "Your data", title: "Imported from your business data", cls: "chip-good" },
  user: { label: "You stated", title: "Entered or stated by you", cls: "chip-good" },
  inferred: { label: "Inferred", title: "Derived from your data (e.g. average demand from sales history)", cls: "" },
  calibrated: { label: "Calibrated", title: "Adjusted from actual results you approved", cls: "chip-accent" },
  default: { label: "Default", title: "A What-if default. Replace it with your own figure.", cls: "chip-warn" },
};

export function ProvenanceBadge({ p }: { p: Provenance | undefined }) {
  const v = PROV[p ?? "default"];
  return <span className={`chip ${v.cls}`} title={v.title} style={{ height: "1.25rem", fontSize: "0.68rem", padding: "0 0.4rem" }}>{v.label}</span>;
}

export function CalibrationChip({ status }: { status: "invalid" | "exploratory" | "calibrated" | string }) {
  if (status === "calibrated") return <span className="chip chip-good" title="All values come from your data and no warnings remain"><IconCheck size={13} />Calibrated</span>;
  if (status === "invalid") return <span className="chip chip-bad" title="The model has errors and cannot be simulated"><IconX size={13} />Has errors</span>;
  return <span className="chip chip-warn" title="Runs are allowed, with warnings, until defaults and issues are resolved"><IconAlert size={13} />Exploratory</span>;
}

export function DemoBadge() {
  return <DataTag kind="sample" />;
}

export type DataKind = "live" | "calculated" | "sample" | "observed" | "historical" | "ai_generated";

/** The kinds of numbers What-if shows, labelled the same way everywhere. */
export function DataTag({ kind, detail }: { kind: DataKind; detail?: string }) {
  const m = {
    live: { cls: "chip-live", text: "Live measurement", title: "Read from the connected live data source, with its timestamp." },
    calculated: { cls: "chip", text: "Calculated", title: "Calculated by What-if from the inputs shown." },
    sample: { cls: "chip-sample", text: "Fictional example data", title: "Made-up sample business used to demonstrate What-if. Not real activity." },
    observed: { cls: "chip-live", text: "Observed", title: "Recorded by a public source at a point in time (a shelf price, a published exchange rate, a news article), shown as retrieved." },
    historical: { cls: "chip-accent", text: "Historical", title: "Official statistics for past periods, shown as published." },
    ai_generated: { cls: "chip-ai", text: "AI-generated", title: "Written by an AI model. Check it against the data it cites." },
  }[kind];
  return (
    <span className={`chip ${m.cls}`} title={detail ?? m.title}>
      {kind === "live" && <span className="pulse-dot" style={{ width: 6, height: 6 }} />}
      {m.text}
    </span>
  );
}

export function ErrorBox({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div role="alert" className="card card-pad flex items-start gap-3" style={{ borderColor: "var(--text)" }}>
      <span className="mt-0.5"><IconAlert /></span>
      <div className="grid flex-1 gap-2">
        <p>{message}</p>
        {onRetry && <div><button className="btn btn-sm" onClick={onRetry}>Try again</button></div>}
      </div>
    </div>
  );
}

export function Notice({ tone = "info", children }: { tone?: "info" | "warn" | "good"; children: ReactNode }) {
  return (
    <div className="flex items-start gap-2.5 rounded-[var(--r-card)] border px-3 py-2.5 text-[0.875rem]"
      style={{ borderColor: tone === "warn" ? "var(--text)" : "var(--line)", background: tone === "warn" ? "var(--surface-2)" : "var(--surface)" }}>
      <span className="mt-0.5 shrink-0">{tone === "good" ? <IconCheck size={16} /> : tone === "warn" ? <IconAlert size={16} /> : <IconInfo size={16} />}</span>
      <div className="grid gap-1 text-text-2">{children}</div>
    </div>
  );
}

export function Empty({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="panel grid place-items-center gap-3 px-6 py-12 text-center">
      <svg width="64" height="40" viewBox="0 0 64 40" aria-hidden="true">
        <path d="M4 20h18c8 0 10-12 18-12h20M22 20c8 0 10 12 18 12h20M22 20h38" fill="none" stroke="var(--line-strong)" strokeWidth="2" strokeLinecap="round" strokeDasharray="2 6" />
        <circle cx="8" cy="20" r="4" fill="var(--text)" />
      </svg>
      <h3 className="t-h3">{title}</h3>
      {children && <div className="max-w-[46ch] text-text-2">{children}</div>}
      {action}
    </div>
  );
}

export function Skeleton({ h = 16, w = "100%", className = "" }: { h?: number; w?: number | string; className?: string }) {
  return <div className={`skeleton ${className}`} style={{ height: h, width: w }} />;
}

export function Stat({ label, value, sub, tone }: { label: string; value: ReactNode; sub?: ReactNode; tone?: "good" | "bad" }) {
  return (
    <div className="grid gap-0.5">
      <span className="text-[0.8rem] text-text-2">{label}</span>
      <span className="num text-[1.35rem] font-semibold tracking-tight" style={{ fontFamily: "var(--font-display)" }}>{tone === "bad" && <span aria-hidden="true">⚠ </span>}{value}</span>
      {sub && <span className="text-[0.78rem] text-text-3">{sub}</span>}
    </div>
  );
}

export function Modal({ open, onClose, title, children, wide = false }: { open: boolean; onClose: () => void; title: string; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    setTimeout(() => ref.current?.querySelector<HTMLElement>("input,textarea,select,button")?.focus(), 30);
    return () => {
      document.removeEventListener("keydown", onKey);
      prev?.focus();
    };
  }, [open, onClose]);
  return (
    <AnimatePresence>
      {open && (
        <motion.div className="fixed inset-0 z-50 grid place-items-center p-4" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.18 }}>
          <div className="absolute inset-0 bg-[rgb(0_0_0/45%)]" onClick={onClose} />
          <motion.div ref={ref} role="dialog" aria-modal="true" aria-label={title}
            className={`panel relative max-h-[88vh] w-full overflow-y-auto shadow-[var(--shadow-2)] ${wide ? "max-w-3xl" : "max-w-lg"}`}
            initial={{ y: 16, scale: 0.98 }} animate={{ y: 0, scale: 1 }} exit={{ y: 8, scale: 0.99 }} transition={{ duration: 0.32, ease: [0.16, 1, 0.3, 1] }}>
            <div className="sticky top-0 z-10 flex items-center justify-between border-b border-line bg-surface px-5 py-3.5">
              <h2 className="t-h3">{title}</h2>
              <button className="btn btn-quiet btn-sm" onClick={onClose} aria-label="Close"><IconX /></button>
            </div>
            <div className="p-5">{children}</div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

export function Drawer({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: ReactNode }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  return (
    <AnimatePresence>
      {open && (
        <motion.div className="fixed inset-0 z-50" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.18 }}>
          <div className="absolute inset-0 bg-[rgb(0_0_0/35%)]" onClick={onClose} />
          <motion.aside role="dialog" aria-modal="true" aria-label={title}
            className="absolute inset-y-0 right-0 flex w-full max-w-xl flex-col border-l border-line bg-surface shadow-[var(--shadow-2)]"
            initial={{ x: "100%" }} animate={{ x: 0 }} exit={{ x: "100%" }} transition={{ duration: 0.38, ease: [0.16, 1, 0.3, 1] }}>
            <div className="flex items-center justify-between border-b border-line px-5 py-3.5">
              <h2 className="t-h3">{title}</h2>
              <button className="btn btn-quiet btn-sm" onClick={onClose} aria-label="Close"><IconX /></button>
            </div>
            <div className="flex-1 overflow-y-auto p-5">{children}</div>
          </motion.aside>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

type Toast = { id: number; text: string; tone: "good" | "bad" | "info" };
const ToastCtx = createContext<(text: string, tone?: Toast["tone"]) => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  const push = useCallback((text: string, tone: Toast["tone"] = "good") => {
    const id = Date.now() + Math.random();
    setItems((x) => [...x, { id, text, tone }]);
    setTimeout(() => setItems((x) => x.filter((t) => t.id !== id)), 4200);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="pointer-events-none fixed bottom-4 right-4 z-[60] grid gap-2" aria-live="polite">
        <AnimatePresence>
          {items.map((t) => (
            <motion.div key={t.id} className="card pointer-events-auto flex max-w-sm items-start gap-2 px-3.5 py-2.5 text-[0.875rem] shadow-[var(--shadow-2)]"
              initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 6 }} transition={{ duration: 0.25 }}>
              <span>{t.tone === "bad" ? <IconAlert size={16} /> : <IconCheck size={16} />}</span>
              {t.text}
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </ToastCtx.Provider>
  );
}

export const useToast = () => useContext(ToastCtx);

export function PageHeader({ title, sub, actions }: { title: string; sub?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div className="grid gap-1.5">
        <h1 className="t-h1">{title}</h1>
        {sub && <div className="t-lead">{sub}</div>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </header>
  );
}
