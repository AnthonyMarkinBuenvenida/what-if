import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { motion } from "motion/react";
import { rd } from "../lib/scrollfx";
import { Wordmark } from "../components/Logo";
import { api } from "../lib/api";
import { useReduced } from "../lib/hooks";
import { Backdrop } from "../whatif/backdrop/Backdrop";
import { Scene } from "../whatif/backdrop/Scenes";
import { useWidth } from "../whatif/charts";
import { compact, monthLabel, signedMoney, signedPct } from "../whatif/format";
import { KindTag, SevShape } from "../whatif/ui";
import type { Severity } from "../whatif/types";

interface Preview {
  demo: boolean; label: string; currency: string;
  baseline: { month: string; net_profit: number; revenue: number }[]; scenario: { month: string; net_profit: number; revenue: number }[];
  best: number[]; worst: number[];
  delta: Record<string, { baseline: number | null; scenario: number | null; change: number | null; change_pct?: number | null }>;
  risk: { score: number; level: Severity; top: { severity: Severity; title: string }[] }; assessment: { key: string; text: string };
  computed_at: string; engine: string;
}

function usePreview(price: number, cost: number) {
  const [data, setData] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [offline, setOffline] = useState(false);
  const seq = useRef(0);
  useEffect(() => {
    const id = ++seq.current;
    const t = setTimeout(async () => {
      setBusy(true);
      try {
        const r = await api.post<Preview>("/api/whatif/public/preview", { price_change_pct: price, unit_cost_change_pct: cost });
        if (id === seq.current) { setData(r); setOffline(false); }
      } catch {
        if (id === seq.current) setOffline(true);
      } finally {
        if (id === seq.current) setBusy(false);
      }
    }, 220);
    return () => clearTimeout(t);
  }, [price, cost]);
  return { data, busy, offline };
}

/** The signature element: today's line meets the horizon and the futures fan out above it. */
function Horizon({ p, busy }: { p: Preview; busy: boolean }) {
  const [ref, w] = useWidth<HTMLDivElement>(280);
  const reduced = useReduced();
  const h = 300, padL = 8, padR = 8, top = 26, bottom = 46;
  const n = p.scenario.length;
  const all = [...p.baseline.map((x) => x.net_profit), ...p.best, ...p.worst, 0];
  const lo = Math.min(...all), hi = Math.max(...all);
  const x = (i: number) => padL + (i / (n - 1)) * (w - padL - padR);
  const y = (v: number) => top + (1 - (v - lo) / (hi - lo || 1)) * (h - top - bottom);
  const line = (vs: number[]) => vs.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join("");
  const band = `${line(p.best)}L${p.worst.map((v, i) => `${x(i).toFixed(1)} ${y(v).toFixed(1)}`).reverse().join("L")}Z`;
  const t = reduced ? { duration: 0 } : { duration: 0.75, ease: [0.16, 1, 0.3, 1] as const };
  return (
    <div ref={ref} className="relative min-w-0" style={{ contain: "inline-size", height: h }}>
      {w > 0 && <svg width={w} height={h} role="img" aria-label={`Monthly net profit of the demo shop: current course versus the scenario, with worst-to-best range. ${p.assessment.text}`}>
        <line x1={0} x2={w} y1={y(0)} y2={y(0)} stroke="var(--moon)" strokeOpacity="0.55" />
        <text x={w - 4} y={y(0) - 6} textAnchor="end" className="chart-axis">break-even (zero profit)</text>
        <motion.path initial={false} animate={{ d: band }} transition={t} fill="var(--series-1)" fillOpacity={busy ? 0.08 : 0.16} />
        <motion.path initial={false} animate={{ d: line(p.baseline.map((m) => m.net_profit)) }} transition={t} fill="none" stroke="var(--series-baseline)" strokeWidth="2" strokeDasharray="6 5" />
        <motion.path initial={false} animate={{ d: line(p.scenario.map((m) => m.net_profit)) }} transition={t} fill="none" stroke="var(--signal)" strokeWidth="2.4" />
        {p.scenario.map((m, i) => (i % 3 === 0 || i === n - 1) && <text key={m.month} x={x(i)} y={h - 22} textAnchor={i === 0 ? "start" : i === n - 1 ? "end" : "middle"} className="chart-axis">{monthLabel(m.month)}</text>)}
      </svg>}
      <div className="pointer-events-none absolute left-2 top-0 flex flex-wrap gap-x-4 gap-y-1 text-[0.76rem] text-text-2">
        <span className="inline-flex items-center gap-1.5"><i className="block h-0 w-5 border-t-2 border-dashed" style={{ borderColor: "var(--series-baseline)" }} />Current course</span>
        <span className="inline-flex items-center gap-1.5"><i className="block h-[2px] w-5" style={{ background: "var(--signal)" }} />Your decision</span>
        <span className="inline-flex items-center gap-1.5"><i className="block h-2.5 w-5 rounded-sm" style={{ background: "var(--series-1)", opacity: 0.35 }} />Worst to best case</span>
      </div>
    </div>
  );
}

function HeroPreview() {
  const [price, setPrice] = useState(-10);
  const [cost, setCost] = useState(0);
  const { data, busy, offline } = usePreview(price, cost);
  const sev = data?.risk.level;
  return (
    <div className="panel glass glow-border grid gap-4 p-5 sm:p-6" style={{ borderRadius: "var(--radius-lg)", borderColor: "var(--line-strong)", boxShadow: "var(--shadow)" }}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2"><KindTag kind="demo" /><span className="text-[0.82rem] font-semibold">Sunny Cup Milk Tea · next 12 months</span></div>
        <span className="inline-flex items-center gap-1.5 text-[0.78rem] font-semibold text-[var(--accent)]" role="status">
          {offline ? <span className="text-text-3">Preview offline</span> : busy ? <span className="think-text">Calculating…</span> : data ? <><i className="inline-block h-1.5 w-1.5 rounded-full bg-[var(--accent)]" />Calculated by the What-if engine</> : ""}
        </span>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Ctl label="What if I change my price by" value={price} set={setPrice} min={-25} max={25} />
        <Ctl label="…and ingredient costs change by" value={cost} set={setCost} min={-20} max={30} />
      </div>
      {offline && !data ? (
        <div className="grid h-[300px] place-items-center rounded-[14px] border border-line bg-[rgba(0,0,0,.25)] text-center text-text-2"><p className="max-w-[40ch]">The live preview needs the What-if server. Start the backend, or open the workspace once it is running.</p></div>
      ) : !data ? <div className="h-[300px]" /> : (
        <>
          <div className={`rounded-[14px] border border-line bg-[rgba(0,0,0,.25)] p-2 ${busy ? "stale" : ""}`}><Horizon p={data} busy={busy} /></div>
          <div className="grid grid-cols-2 gap-4 border-t border-line pt-3 sm:grid-cols-4">
            <Fig k="Net profit, 12 months" v={compact(data.delta.net_profit.scenario, data.currency)} sub={signedMoney(data.delta.net_profit.change, data.currency) + " vs now"} />
            <Fig k="Revenue" v={compact(data.delta.revenue.scenario, data.currency)} sub={signedPct(data.delta.revenue.change_pct ?? null)} />
            <Fig k="Cups sold" v={compact(data.delta.units.scenario)} sub={signedPct(data.delta.units.change_pct ?? null)} />
            <div className="grid content-start gap-1"><span className="label-soft">Risk level</span>{sev && <span className={`inline-flex items-center gap-1.5 text-[1.05rem] font-semibold sev-${sev} !bg-transparent`} style={{ border: 0 }}><SevShape s={sev} size={13} />{sev[0].toUpperCase() + sev.slice(1)}</span>}<span className="text-[0.76rem] text-text-3">{data.risk.top[0]?.title ?? "no rule triggered"}</span></div>
          </div>
          <p className="text-[0.84rem] text-text-2">{data.assessment.text}</p>
        </>
      )}
    </div>
  );
}

function Ctl({ label, value, set, min, max }: { label: string; value: number; set: (v: number) => void; min: number; max: number }) {
  return (
    <label className="grid gap-1.5">
      <span className="flex items-baseline justify-between gap-2 text-[0.84rem] text-text-2">{label}<b className="kpi text-[1.25rem] text-text">{value > 0 ? "+" : value < 0 ? "−" : ""}{Math.abs(value)}%</b></span>
      <input type="range" className="range" min={min} max={max} step={1} value={value} onChange={(e) => set(+e.target.value)} />
    </label>
  );
}

function Fig({ k, v, sub }: { k: string; v: string; sub?: string }) {
  return <div className="grid content-start gap-1"><span className="label-soft">{k}</span><span className="kpi text-[1.3rem]">{v}</span>{sub && <span className="text-[0.76rem] text-text-3">{sub}</span>}</div>;
}

// Ascend icon set: 24x24, stroke 1.6 (arrow 2), round caps and joins.
const Icon = ({ children, sw = 1.6 }: { children: ReactNode; sw?: number }) => (
  <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>
);
const ICONS = {
  workflow: <Icon><rect x="3" y="3" width="6" height="6" rx="1.5" /><rect x="15" y="15" width="6" height="6" rx="1.5" /><path d="M6 9v3a3 3 0 0 0 3 3h3" /></Icon>,
  analytics: <Icon><path d="M4 19V5" /><path d="M4 19h16" /><path d="M8 16v-4" /><path d="M13 16V8" /><path d="M18 16v-7" /></Icon>,
  leads: <Icon><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M22 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" /></Icon>,
  shield: <Icon><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" /><path d="m9 12 2 2 4-4" /></Icon>,
  bolt: <Icon><path d="M13 2 3 14h9l-1 8 10-12h-9l1-8Z" /></Icon>,
  globe: <Icon><circle cx="12" cy="12" r="10" /><path d="M2 12h20" /><path d="M12 2a15 15 0 0 1 0 20 15 15 0 0 1 0-20Z" /></Icon>,
};
const Arrow = () => <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12h14" /><path d="m12 5 7 7-7 7" /></svg>;

const FEATURES: { icon: keyof typeof ICONS; title: string; text: string }[] = [
  { icon: "leads", title: "Describe the business", text: "Prices, costs, staff, sales and cash. Start from an industry template; every figure you have not replaced stays marked as an estimate." },
  { icon: "bolt", title: "Ask what if", text: "“What if ingredient costs rise 15%?” What-if turns the question into changes you can see and adjust, and asks for anything it had to assume." },
  { icon: "analytics", title: "Read the calculation", text: "Month-by-month revenue, profit, cash, break-even and capacity, next to the current course, with a best and worst case and the reason for every change." },
  { icon: "shield", title: "Check the risks, then decide", text: "Risk Radar applies written thresholds to the result and suggests actions you can simulate next." },
  { icon: "workflow", title: "Compare and report", text: "Rank saved scenarios by the objective you choose on the same figures and period, then export a report as PDF or CSV." },
  { icon: "globe", title: "External data, labelled", text: "Exchange rates, inflation, lending rates and weather inform a scenario only when you apply them, with source and date recorded." },
];

const INDUSTRIES = [
  ["food_beverage", "Food & beverage", "What if ingredient costs increase by 15%?"],
  ["retail", "Retail", "What if demand rises 30% over the holidays?"],
  ["manufacturing", "Manufacturing", "What if I add a second shift?"],
  ["technology", "Technology", "What if monthly churn rises by 2 points?"],
  ["agriculture", "Agriculture", "What if a dry season cuts the harvest by 30%?"],
  ["services", "Services", "What if I hire another stylist?"],
] as const;

// Product facts, not marketing claims: each is a property of the engine as built.
const FACTS = [
  ["6", "industries with their own inputs"],
  ["19", "written Risk Radar rules"],
  ["36", "months you can simulate ahead"],
  ["0", "calculated results changed by AI"],
] as const;

export default function Landing() {
  const [rules, setRules] = useState<{ id: string; metric: string; thresholds: string; why?: string }[]>([]);
  useEffect(() => { api.get<{ risk_rules: { id: string; metric: string; thresholds: string; why: string }[] }>("/api/whatif/industries").then((r) => setRules(r.risk_rules)).catch(() => setRules([])); }, []);
  const shownRules = useMemo(() => rules.filter((r) => ["net_margin", "cash_shortfall", "marketing", "capacity"].includes(r.id)), [rules]);
  const year = new Date().getFullYear();
  return (
    <div className="relative min-h-screen">
      <Backdrop context="landing" />

      {/* SECTION 1 · HERO */}
      <header className="flex min-h-screen flex-col">
        {/* relative z-10: the hero block below is lifted by translateY(-10vh) and would otherwise cover the nav */}
        <nav className="relative z-10 mx-auto flex w-full max-w-[var(--maxw)] items-center justify-between gap-4 px-5 py-[18px] md:px-6 md:py-[22px]" aria-label="Main">
          <Wordmark size={24} />
          <div className="hidden items-center gap-[30px] text-[14.5px] text-text-2 md:flex">
            <a href="#how" className="no-underline transition-colors hover:text-text">How it works</a>
            <a href="#preview" className="no-underline transition-colors hover:text-text">Live preview</a>
            <a href="#risk" className="no-underline transition-colors hover:text-text">Risk Radar</a>
            <a href="#industries" className="no-underline transition-colors hover:text-text">Industries</a>
          </div>
          <Link to="/app" className="btn btn-ghost">Open the workspace</Link>
        </nav>
        <div className="flex flex-1 flex-col items-center justify-center px-6 text-center" style={{ transform: "translateY(-10vh)" }}>
          <h1 className="t-display max-w-[15ch] text-[clamp(34px,5.2vw,62px)]" data-reveal style={rd(60)}>Make the decision.<br />Before the <em>risk.</em></h1>
          <p className="mt-6 max-w-[560px] text-[clamp(16px,2vw,19px)] leading-[1.6] text-text-2" data-reveal style={rd(180)}>Simulate business decisions, explore possible outcomes, and uncover financial risks before they affect your business.</p>
          <div className="mt-[38px] flex flex-wrap items-center justify-center gap-[14px] max-[560px]:w-full max-[560px]:[&>a]:flex-1" data-reveal style={rd(300)}>
            <Link to="/app/simulate" className="btn btn-primary btn-lg">Start a simulation <Arrow /></Link>
            <Link to="/app/setup?new=1" className="btn btn-outline btn-lg">Set up my business</Link>
          </div>
        </div>
        <div className="px-6 pb-[clamp(36px,6vw,64px)] text-center [text-shadow:0_1px_14px_rgba(0,0,0,.85)]" data-reveal style={rd(420)}>
          <p className="mb-4 text-[12px] uppercase tracking-[0.16em] text-text-3">Built for six kinds of business</p>
          <ul className="flex flex-wrap justify-center gap-x-[clamp(24px,5vw,56px)] gap-y-3" aria-label="Supported industries">
            {INDUSTRIES.map(([id, label]) => <li key={id} className="text-[17px] font-bold text-[var(--muted-2)] opacity-80 transition hover:text-text hover:opacity-100 max-[380px]:text-[15px]">{label}</li>)}
          </ul>
        </div>
      </header>

      {/* SECTION 2 · FEATURES */}
      <section id="how" className="mx-auto max-w-[var(--maxw)] px-5 py-[clamp(64px,16vw,110px)] md:px-6 md:py-[clamp(80px,12vw,160px)]">
        <div className="mx-auto mb-[clamp(48px,6vw,80px)] max-w-[680px] text-center">
          <span className="eyebrow mb-[18px]" data-reveal>How it works</span>
          <h2 className="t-display-tight text-[clamp(30px,4.4vw,50px)]" data-reveal style={rd(80)}>From a question to a calculated answer</h2>
          <p className="mt-[18px] text-[18px] leading-[1.65] text-text-2" style={{ ...rd(160), textShadow: "0 1px 24px rgba(0,0,0,.55)" }} data-reveal>The arithmetic is done by a deterministic engine you can trace line by line. AI, when connected, reads your question and explains the result; it never changes a number.</p>
        </div>
        <ul className="grid gap-[18px] min-[561px]:grid-cols-2 min-[981px]:grid-cols-3">
          {FEATURES.map((f, i) => (
            <li key={f.title} className="card interactive grid content-start gap-3 p-[30px]" style={{ borderRadius: "var(--radius)", ...rd(i * 90) }} data-reveal>
              <span className="grid h-[46px] w-[46px] place-items-center rounded-[12px] border border-[rgba(93,240,168,.18)] bg-[rgba(93,240,168,.1)] text-[var(--accent)]">{ICONS[f.icon]}</span>
              <h3 className="text-[19px] font-bold">{f.title}</h3>
              <p className="text-[15px] leading-[1.6] text-text-2">{f.text}</p>
            </li>
          ))}
        </ul>
      </section>

      {/* SECTION 3 · SHOWCASE + FACTS */}
      <section id="preview" className="mx-auto max-w-[var(--maxw)] px-5 py-[clamp(64px,16vw,110px)] md:px-6 md:py-[clamp(80px,12vw,160px)]">
        <div className="grid items-center gap-[clamp(36px,6vw,72px)] min-[981px]:grid-cols-[1fr_1.05fr]">
          <div className="grid content-start gap-5 text-center min-[981px]:text-left">
            <span className="eyebrow" data-reveal>Live preview</span>
            <h2 className="t-display-tight text-[clamp(30px,4.4vw,50px)]" data-reveal style={rd(90)}>See a decision move the numbers</h2>
            <p className="text-[17px] leading-[1.65] text-text-2" data-reveal style={rd(180)}>Drag the sliders: the real What-if engine recalculates a fictional milk tea shop for the next 12 months, with the current course, a worst-to-best band and the risk level it triggers.</p>
            <div data-reveal style={rd(270)}><Link to="/app" className="btn btn-primary btn-lg">Open the workspace <Arrow /></Link></div>
          </div>
          <div data-reveal style={rd(160)}><HeroPreview /></div>
        </div>
        <ul className="mt-[clamp(56px,8vw,96px)] grid gap-[18px] min-[381px]:grid-cols-2 min-[981px]:grid-cols-4">
          {FACTS.map(([v, l], i) => (
            <li key={l} className="card grid justify-items-center px-[18px] py-[30px] text-center" style={{ borderRadius: "var(--radius)", ...rd(i * 80) }} data-reveal>
              <span className="kpi kpi-grad text-[clamp(30px,4vw,44px)]">{v}</span>
              <span className="mt-2 text-[14px] text-text-2">{l}</span>
            </li>
          ))}
        </ul>
      </section>

      {/* RISK RADAR */}
      <section id="risk" className="mx-auto max-w-[var(--maxw)] px-5 py-[clamp(64px,16vw,110px)] md:px-6 md:py-[clamp(80px,12vw,160px)]">
        <div className="mx-auto mb-[clamp(48px,6vw,80px)] max-w-[680px] text-center">
          <span className="eyebrow mb-[18px]" data-reveal>Risk Radar</span>
          <h2 className="t-display-tight text-[clamp(30px,4.4vw,50px)]" data-reveal style={rd(80)}>Every result is read for warning signs</h2>
          <p className="mt-[18px] text-[18px] leading-[1.65] text-text-2" data-reveal style={rd(160)}>Each warning comes from a written rule with a threshold: thin margins, cash running out, costs outpacing revenue, demand above capacity, advertising that does not pay for itself, dependence on one supplier. It shows the evidence, the estimated impact, and actions you can test.</p>
          <ul className="mt-6 flex flex-wrap justify-center gap-2" aria-label="Severity levels" data-reveal style={rd(240)}>
            {(["low", "moderate", "high", "critical"] as Severity[]).map((s) => <li key={s} className={`sev sev-${s}`}><SevShape s={s} />{s[0].toUpperCase() + s.slice(1)}</li>)}
          </ul>
        </div>
        <ul className="grid gap-[18px] min-[561px]:grid-cols-2">
          {shownRules.length ? shownRules.map((r, i) => (
            <li key={r.id} className="card grid gap-1.5 p-[26px]" style={{ borderRadius: "var(--radius)", ...rd(i * 90) }} data-reveal>
              <span className="text-[17px] font-bold">{r.metric}</span>
              <span className="text-[14.5px] text-text-2">{r.thresholds}</span>
            </li>
          )) : <li className="card p-[26px] text-text-3" style={{ borderRadius: "var(--radius)" }}>The rule list loads from the What-if server.</li>}
        </ul>
      </section>

      {/* INDUSTRIES */}
      <section id="industries" className="mx-auto max-w-[var(--maxw)] px-5 py-[clamp(64px,16vw,110px)] md:px-6 md:py-[clamp(80px,12vw,160px)]">
        <div className="mx-auto mb-[clamp(48px,6vw,80px)] max-w-[680px] text-center">
          <span className="eyebrow mb-[18px]" data-reveal>Industries</span>
          <h2 className="t-display-tight text-[clamp(30px,4.4vw,50px)]" data-reveal style={rd(80)}>Shaped to the business you run</h2>
          <p className="mt-[18px] text-[18px] leading-[1.65] text-text-2" data-reveal style={rd(160)}>A café counts cups and ingredient costs; a SaaS counts subscribers and churn; a farm plans around harvest months. Each industry gets its own inputs, units and starting estimates.</p>
        </div>
        <ul className="grid gap-[18px] min-[561px]:grid-cols-2 min-[981px]:grid-cols-3">
          {INDUSTRIES.map(([id, label, q], i) => (
            <li key={id} className="card interactive grid overflow-hidden" style={{ borderRadius: "var(--radius)", ...rd(i * 90) }} data-reveal>
              <div className="h-28 opacity-80" style={{ background: "linear-gradient(to bottom, transparent, rgba(93,240,168,.05))" }}><Scene name={id} /></div>
              <div className="grid gap-1 p-5"><span className="text-[17px] font-bold">{label}</span><span className="text-[14.5px] text-text-2">“{q}”</span></div>
            </li>
          ))}
        </ul>
      </section>

      {/* NUMBER KINDS */}
      <section className="mx-auto max-w-[var(--maxw)] px-5 py-[clamp(64px,16vw,110px)] md:px-6 md:py-[clamp(80px,12vw,160px)]">
        <div className="mx-auto mb-[clamp(40px,5vw,64px)] max-w-[680px] text-center">
          <span className="eyebrow mb-[18px]" data-reveal>Honest numbers</span>
          <h2 className="t-display-tight text-[clamp(30px,4.4vw,50px)]" data-reveal style={rd(80)}>Every number says what it is</h2>
          <p className="mt-[18px] text-[18px] leading-[1.65] text-text-2" data-reveal style={rd(160)}>Simulations support decisions; they are not guarantees. What-if keeps the kinds of numbers apart and labels them on every screen.</p>
        </div>
        <dl className="grid gap-[18px] min-[561px]:grid-cols-2 min-[981px]:grid-cols-3">
          {([["actual", "Results you entered for past months."], ["calculated", "Engine output for the inputs shown, with its assumptions."], ["ai", "Wording by an AI model, checked against the calculation."], ["forecast", "Third-party forecasts, such as the weather, with retrieval time."], ["estimate", "A default you have not replaced yet."], ["demo", "The fictional demo shop, never your data."]] as const).map(([k, d], i) => (
            <div key={k} className="card grid content-start gap-2 p-[24px]" style={{ borderRadius: "var(--radius)", ...rd(i * 80) }} data-reveal><dt><KindTag kind={k} /></dt><dd className="text-[14.5px] text-text-2">{d}</dd></div>
          ))}
        </dl>
      </section>

      {/* SECTION 4 · CTA + FOOTER */}
      <section className="mx-auto max-w-[var(--maxw)] px-5 py-[clamp(64px,16vw,110px)] md:px-6 md:py-[clamp(80px,12vw,160px)]" id="cta">
        <div className="relative mx-auto grid max-w-[760px] justify-items-center gap-5 border px-[clamp(22px,5vw,64px)] py-[clamp(40px,7vw,80px)] text-center max-[560px]:px-[22px] max-[560px]:py-10"
          style={{ borderRadius: "var(--radius-lg)", borderColor: "var(--line-strong)", boxShadow: "var(--shadow)", background: "radial-gradient(120% 140% at 50% 0%, rgba(93,240,168,.12), transparent 55%), var(--glass-2)", backdropFilter: "blur(18px)", WebkitBackdropFilter: "blur(18px)" }}>
          <span className="eyebrow" data-reveal style={rd(60)}>Ready when you are</span>
          <h2 className="t-display-tight text-[clamp(30px,4.4vw,50px)]" data-reveal style={rd(140)}>Test it before it costs you</h2>
          <p className="max-w-[52ch] text-[17px] leading-[1.65] text-text-2" data-reveal style={rd(220)}>No account and no card. Start from an industry template or the demo shop, and replace the estimates with your own figures when you are ready.</p>
          <div className="flex flex-wrap items-center justify-center gap-[14px] max-[560px]:w-full max-[560px]:[&>a]:flex-1" data-reveal style={rd(300)}>
            <Link to="/app/simulate" className="btn btn-primary btn-lg">Start a simulation <Arrow /></Link>
            <Link to="/app" className="btn btn-outline btn-lg">Open the workspace</Link>
          </div>
        </div>

        <footer className="mt-[clamp(64px,9vw,110px)] flex flex-wrap justify-between gap-12 border-t border-line pt-12 max-[560px]:flex-col">
          <div className="grid max-w-[34ch] content-start gap-3">
            <Wordmark size={22} />
            <p className="text-[14px] text-text-2">Business decision simulation. Results are calculated from the inputs and assumptions you give; they are not forecasts or financial advice.</p>
          </div>
          <nav className="flex flex-wrap gap-x-16 gap-y-8" aria-label="Footer">
            {([
              ["Workspace", [["Dashboard", "/app"], ["Simulate", "/app/simulate"], ["Risk Radar", "/app/risk"]]],
              ["Plan", [["Compare", "/app/compare"], ["Reports", "/app/reports"], ["Business setup", "/app/setup"]]],
              ["More", [["Settings & data", "/app/settings"], ["Retail lab demo", "/demo"]]],
            ] as const).map(([h, links]) => (
              <div key={h} className="grid content-start gap-2.5">
                <span className="text-[12px] uppercase tracking-[0.14em] text-text-3">{h}</span>
                {links.map(([l, to]) => <Link key={to} to={to} className="text-[14.5px] text-text-2 no-underline transition-colors hover:text-text">{l}</Link>)}
              </div>
            ))}
          </nav>
        </footer>
        <p className="mt-14 text-center text-[13px] text-text-3">© {year} What-if. Simulations under stated assumptions, not guarantees.</p>
      </section>
    </div>
  );
}
