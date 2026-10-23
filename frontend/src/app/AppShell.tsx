import { createContext, useCallback, useContext, useEffect, useState, type ComponentType, type ReactNode } from "react";
import { Link, NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { AnimatePresence, motion } from "motion/react";
import { ForkMark, Wordmark } from "../components/Logo";
import {
  IconBolt, IconFork, IconGlobe, IconLoop, IconMenu, IconMuseum, IconOverview, IconPlay, IconPlus, IconReport,
  IconSettings, IconSidebar, IconStore, IconTwin, IconX, IconAlert,
} from "../components/icons";
import { ErrorBox, Spinner } from "../components/ui";
import { useLocalState, useReduced } from "../lib/hooks";
import { Backdrop, type BackdropContext } from "../whatif/backdrop/Backdrop";
import { KindTag } from "../whatif/ui";
import type { Levers } from "../whatif/types";
import { WorkspaceProvider, useWorkspace } from "./workspace";

type Item = { to: string; label: string; icon: ComponentType<{ size?: number }>; end?: boolean };
const PRIMARY: Item[] = [
  { to: "/app", label: "Dashboard", icon: IconOverview, end: true },
  { to: "/app/simulate", label: "Simulate", icon: IconPlay },
  { to: "/app/risk", label: "Risk Radar", icon: IconAlert },
  { to: "/app/compare", label: "Compare", icon: IconFork },
  { to: "/app/reports", label: "Reports", icon: IconReport },
];
const BUSINESS: Item[] = [
  { to: "/app/setup", label: "Business setup", icon: IconStore },
  { to: "/app/settings", label: "Settings & data", icon: IconSettings },
];
const LAB: Item[] = [
  { to: "/app/overview", label: "Lab overview", icon: IconOverview, end: true },
  { to: "/app/twin", label: "Digital twins", icon: IconTwin },
  { to: "/app/worlds", label: "Parallel worlds", icon: IconFork },
  { to: "/app/simulations", label: "Monte Carlo runs", icon: IconPlay },
  { to: "/app/lab", label: "Decision lab", icon: IconReport },
  { to: "/app/reports/legacy", label: "Lab reports", icon: IconReport },
  { to: "/app/failures", label: "Failure museum", icon: IconMuseum },
  { to: "/app/feedback", label: "Reality feedback", icon: IconLoop },
  { to: "/app/research", label: "Market research", icon: IconGlobe },
  { to: "/app/live", label: "Live data", icon: IconBolt },
];

// Pages tell the backdrop what is going on (a calculation running, the scenario's levers).
interface BackdropState { active: boolean; levers: Levers | null }
const BackdropCtx = createContext<(s: Partial<BackdropState>) => void>(() => {});
export const useBackdropState = () => useContext(BackdropCtx);

function contextFor(path: string): BackdropContext {
  if (path.startsWith("/app/simulate") || path.startsWith("/app/compare")) return "simulation";
  if (path.startsWith("/app/risk")) return "risk";
  if (path.startsWith("/app/reports/")) return "report";
  return "app";
}

function NavGroup({ title, items, collapsed, onNavigate, defaultOpen = true }: { title?: string; items: Item[]; collapsed: boolean; onNavigate?: () => void; defaultOpen?: boolean }) {
  const [open, setOpen] = useLocalState(`whatif-nav-${title ?? "main"}`, defaultOpen);
  const loc = useLocation();
  const containsActive = items.some((i) => (i.end ? loc.pathname === i.to : loc.pathname.startsWith(i.to)));
  const show = collapsed || open || containsActive;
  return (
    <div className="grid gap-0.5">
      {title && !collapsed && (
        <button className="flex items-center justify-between px-2.5 pb-1 pt-3 text-left text-[0.74rem] font-medium text-text-3 hover:text-text-2" onClick={() => setOpen(!open)} aria-expanded={show}>
          {title}<span aria-hidden="true">{show ? "−" : "+"}</span>
        </button>
      )}
      {title && collapsed && <div className="hline mx-2 my-2" />}
      {show && items.map(({ to, label, icon: Icon, end }) => (
        <NavLink key={to} to={to} end={end} onClick={onNavigate} title={collapsed ? label : undefined}
          className={({ isActive }) => `relative flex items-center gap-3 rounded-[var(--r-control)] px-2.5 py-[7px] text-[0.88rem] no-underline transition-colors ${collapsed ? "justify-center" : ""} ${isActive ? "bg-surface-2 font-semibold text-text" : "text-text-2 hover:bg-surface-2 hover:text-text"}`}>
          {({ isActive }) => (
            <>
              {isActive && <span className="absolute inset-y-1.5 left-0 w-[2px] rounded-full bg-signal" aria-hidden="true" />}
              <Icon size={18} />{!collapsed && label}
            </>
          )}
        </NavLink>
      ))}
    </div>
  );
}

function Sidebar({ collapsed, onNavigate }: { collapsed: boolean; onNavigate?: () => void }) {
  const { businesses, current, setCurrentId, workspace } = useWorkspace();
  const nav = useNavigate();
  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto p-3">
      <div className={`flex h-10 items-center ${collapsed ? "justify-center" : "px-1.5"}`}>
        {collapsed ? <Link to="/" aria-label="What-if home"><ForkMark size={28} /></Link> : <Wordmark size={26} />}
      </div>
      {!collapsed && (
        <div className="grid gap-1.5 px-1">
          <label className="label" htmlFor="biz-switch">Business</label>
          {businesses.length ? (
            <select id="biz-switch" className="select" value={current?.id ?? ""} onChange={(e) => { setCurrentId(+e.target.value); onNavigate?.(); }}>
              {businesses.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          ) : <p className="text-[0.82rem] text-text-3">No business yet.</p>}
          {current?.is_demo && <div><KindTag kind="demo" /></div>}
        </div>
      )}
      <button className={`btn btn-signal ${collapsed ? "!px-0" : ""}`} onClick={() => { nav("/app/simulate"); onNavigate?.(); }} title="New simulation">
        <IconPlus size={16} />{!collapsed && "New simulation"}
      </button>
      <nav aria-label="Workspace" className="grid gap-1">
        <NavGroup items={PRIMARY} collapsed={collapsed} onNavigate={onNavigate} />
        <NavGroup title="Business" items={BUSINESS} collapsed={collapsed} onNavigate={onNavigate} />
        <NavGroup title="Retail lab (advanced)" items={LAB} collapsed={collapsed} onNavigate={onNavigate} defaultOpen={false} />
      </nav>
      <div className="mt-auto grid gap-2 px-1.5 pt-3">
        <div className="hline" />
        {!collapsed && workspace && <p className="text-[0.72rem] leading-snug text-text-3">Workspace {workspace.id}, kept in this browser. No account needed.</p>}
      </div>
    </div>
  );
}

function ShellInner() {
  const [collapsed, setCollapsed] = useLocalState("whatif-sidebar-collapsed", false);
  const [mobile, setMobile] = useState(false);
  const [bd, setBd] = useState<BackdropState>({ active: false, levers: null });
  const loc = useLocation();
  const reduced = useReduced();
  const { current, workspace, error, loading } = useWorkspace();
  useEffect(() => setMobile(false), [loc.pathname]);
  useEffect(() => setBd({ active: false, levers: null }), [loc.pathname]);
  // Stable setter: pages call it from effects, so it must not change between renders.
  const update = useCallback((s: Partial<BackdropState>) => setBd((p) => ({ ...p, ...s })), []);

  if (!workspace && error) {
    return (
      <div className="mx-auto grid min-h-screen max-w-lg content-center gap-4 p-6">
        <Backdrop context="app" />
        <Wordmark />
        <ErrorBox message={`The workspace could not be opened. ${error}`} onRetry={() => window.location.reload()} />
        <p className="text-[0.9rem] text-text-2">The <Link to="/">home page preview</Link> needs the server too; start the backend and try again.</p>
      </div>
    );
  }
  if (!workspace && loading) return <div className="grid min-h-screen place-items-center text-text-3"><Backdrop context="app" /><Spinner size={22} /></div>;

  return (
    <BackdropCtx.Provider value={update}>
      <div className="min-h-screen">
        <Backdrop context={contextFor(loc.pathname)} industry={current?.industry} levers={bd.levers} active={bd.active} />
        <aside className={`no-print glass fixed inset-y-0 left-0 z-30 hidden border-r border-line transition-[width] duration-300 lg:block ${collapsed ? "w-[68px]" : "w-[260px]"}`} aria-label="Sidebar">
          <Sidebar collapsed={collapsed} />
        </aside>
        <AnimatePresence>
          {mobile && (
            <motion.div className="fixed inset-0 z-40 lg:hidden" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
              <div className="absolute inset-0 bg-[rgb(0_0_0/55%)]" onClick={() => setMobile(false)} />
              <motion.aside className="absolute inset-y-0 left-0 w-[290px] border-r border-line bg-surface" initial={{ x: -290 }} animate={{ x: 0 }} exit={{ x: -290 }} transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}>
                <button className="btn btn-quiet btn-sm absolute right-2 top-3" onClick={() => setMobile(false)} aria-label="Close menu"><IconX /></button>
                <Sidebar collapsed={false} onNavigate={() => setMobile(false)} />
              </motion.aside>
            </motion.div>
          )}
        </AnimatePresence>
        <div className={`transition-[padding] duration-300 print:!pl-0 ${collapsed ? "lg:pl-[68px]" : "lg:pl-[260px]"}`}>
          <div className="no-print glass sticky top-0 z-20 flex h-14 items-center gap-2 border-b border-line px-3 sm:px-5">
            <button className="btn btn-quiet btn-sm lg:hidden" onClick={() => setMobile(true)} aria-label="Open menu"><IconMenu /></button>
            <button className="btn btn-quiet btn-sm hidden lg:inline-flex" onClick={() => setCollapsed(!collapsed)} aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}><IconSidebar size={18} /></button>
            <span className="truncate text-[0.9rem] text-text-2">{current ? current.name : "No business selected"}</span>
            {current?.is_demo && <span className="hidden sm:inline-flex"><KindTag kind="demo" /></span>}
            <div className="ml-auto flex items-center gap-3">
              {bd.active && <span className="chip chip-calc" role="status"><span className="pulse-dot" style={{ width: 6, height: 6 }} />Calculating</span>}
              <Link to="/" className="hidden text-[0.85rem] text-text-2 hover:text-text md:inline">Home</Link>
            </div>
          </div>
          <AnimatePresence mode="wait">
            <motion.main key={loc.pathname} className="mx-auto max-w-[1320px] px-4 pb-24 pt-6 sm:px-6 lg:px-10 lg:pt-9"
              initial={reduced ? false : { opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={reduced ? undefined : { opacity: 0 }} transition={{ duration: 0.28, ease: [0.16, 1, 0.3, 1] }}>
              <Outlet />
            </motion.main>
          </AnimatePresence>
        </div>
      </div>
    </BackdropCtx.Provider>
  );
}

export default function AppShell({ children }: { children?: ReactNode }) {
  return (
    <WorkspaceProvider>
      <ShellInner />
      {children}
    </WorkspaceProvider>
  );
}
