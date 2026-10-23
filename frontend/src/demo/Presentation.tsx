/* Presentation Mode: five slides, presenter in control. Optional auto-advance
   pauses while the engine works and never skips the simulation; nothing on
   the results slides exists until the simulation has actually run. */
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { AnimatePresence, motion } from "motion/react";
import { ForkMark } from "../components/Logo";
import { IconArrowLeft, IconChevron, IconPause, IconPlay, IconRetry, IconX } from "../components/icons";
import { DataTag, Spinner } from "../components/ui";
import { money } from "../lib/format";
import { useReduced } from "../lib/hooks";
import { useDemo } from "./DemoContext";
import { mainRisk } from "./explain";
import { EngineNotice, ForkFigure, GoalPicker, ResultsSummary, RunButton, RunProgress, StoreFacts } from "./parts";

const SLIDES = ["The business and its goal", "The alternative strategies", "Running the simulation", "Comparing the outcomes", "Risks and recommendation"] as const;
const SECONDS = 12;

function SlideBody({ i }: { i: number }) {
  const d = useDemo();
  const notRun = <p className="text-[1.3rem] text-text-2">The simulation hasn't run yet. Go to step 3 and start it.</p>;
  switch (i) {
    case 0:
      return (
        <div className="grid gap-8">
          <p className="max-w-[60ch] text-[1.3rem] text-text-2">
            {d.session?.business.name} is a fictional neighborhood store with {d.session?.business.products.length} product lines, {d.session?.business.staff.reduce((a, s) => a + s.count, 0)} staff
            and {money(d.session?.business.starting_cash)} in the bank. Choose what the owner wants to achieve.</p>
          <StoreFacts big />
          <div className="max-w-3xl"><GoalPicker big /></div>
        </div>
      );
    case 1:
      return <div className="grid gap-6"><p className="text-[1.3rem] text-text-2">Each strategy is a copy of the same model with one decision changed, so differences come from the decision itself.</p><ForkFigure big /></div>;
    case 2:
      return (
        <div className="grid max-w-3xl gap-6">
          <p className="text-[1.3rem] text-text-2">Each scenario is simulated day by day for 90 days{d.client?.kind === "server" && d.mode === "monte_carlo" ? ", 300 times with different demand and supplier prices" : ""}. Statuses come from the engine as it works.</p>
          <div className="max-w-sm"><RunButton big /></div>
          <RunProgress big />
        </div>
      );
    case 3:
      return d.comparison ? <ResultsSummary big /> : notRun;
    default: {
      if (!d.comparison || !d.analysis) return notRun;
      const a = d.analysis.output;
      const rec = d.comparison.rows.find((r) => r.run_id === a.recommended_run_id);
      return (
        <div className="grid gap-8">
          <p className="max-w-[40ch] text-[clamp(1.6rem,1.2rem+1.4vw,2.6rem)] leading-tight" style={{ fontFamily: "var(--font-display)" }}>{a.recommendation}</p>
          <div className="grid gap-6 lg:grid-cols-2">
            <div className="grid content-start gap-2">
              <h3 className="text-[1.3rem]">Main risks</h3>
              <ul className="grid gap-2 text-[1.1rem] text-text-2">{d.comparison.rows.map((r) => <li key={r.run_id}><b className="text-text">{r.scenario_name.replace(" World", "")}:</b> {mainRisk(r)}</li>)}</ul>
            </div>
            <div className="grid content-start gap-2">
              <h3 className="text-[1.3rem]">Next experiment</h3>
              <p className="text-[1.1rem] text-text-2">{a.next_steps[0]}</p>
              {rec && <p className="text-[0.9rem] text-text-3">Recommended: {rec.scenario_name}. Ranking rule: scenarios that break a limit rank below those that don't; then lower cash risk; then higher profit.</p>}
            </div>
          </div>
          <div className="flex flex-wrap gap-2"><DataTag kind="calculated" /><DataTag kind="sample" /></div>
        </div>
      );
    }
  }
}

export default function Presentation() {
  const d = useDemo();
  const nav = useNavigate();
  const reduced = useReduced();
  const [started, setStarted] = useState(false);
  const [i, setI] = useState(0);
  const [dir, setDir] = useState(1);
  const [auto, setAuto] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const root = useRef<HTMLDivElement>(null);

  const go = useCallback((n: number) => {
    const next = Math.max(0, Math.min(SLIDES.length - 1, n));
    setDir(next >= i ? 1 : -1);
    setI(next);
    setElapsed(0);
  }, [i]);
  const exit = useCallback(() => {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    nav("/demo");
  }, [nav]);
  const restart = useCallback(async () => {
    setAuto(false);
    setStarted(false);
    setI(0);
    setElapsed(0);
    await d.reset();
  }, [d]);

  // Auto-advance waits on real work: it starts the run on slide 3 and holds until results exist.
  const waiting = d.running || (i === 2 && (!d.comparison || d.outdated));
  useEffect(() => {
    if (auto && i === 2 && !d.running && (!d.runs.length || d.outdated)) d.run();
  }, [auto, i, d]);
  useEffect(() => {
    if (!auto || waiting || i === SLIDES.length - 1) return;
    const t = setInterval(() => setElapsed((e) => e + 0.1), 100);
    return () => clearInterval(t);
  }, [auto, waiting, i]);
  useEffect(() => { if (elapsed >= SECONDS) go(i + 1); }, [elapsed, i, go]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA" || !started) return;
      if (e.key === "ArrowRight" || e.key === "PageDown") { e.preventDefault(); go(i + 1); }
      else if (e.key === "ArrowLeft" || e.key === "PageUp") { e.preventDefault(); go(i - 1); }
      else if (e.key === " ") { e.preventDefault(); setAuto((a) => !a); }
      else if (e.key === "Escape" && !document.fullscreenElement) exit();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [i, go, exit, started]);

  const begin = () => {
    setStarted(true);
    root.current?.requestFullscreen?.().catch(() => {});
  };

  return (
    <div ref={root} className="fixed inset-0 z-50 flex flex-col overflow-hidden bg-bg" role="region" aria-label="What-if presentation mode">
      {!started ? (
        <div className="m-auto grid max-w-2xl gap-6 px-6 text-center">
          <div className="mx-auto"><ForkMark size={56} /></div>
          <h1 className="t-display text-[clamp(2.6rem,1.6rem+3.6vw,5rem)]">Explore different futures before deciding.</h1>
          <p className="text-[1.2rem] text-text-2">A five-step walkthrough of What-if on a fictional store. Results are calculated live during the presentation.</p>
          {d.boot !== "ready" ? <div className="mx-auto"><Spinner size={24} /></div> : (
            <div className="flex flex-wrap justify-center gap-2">
              <button className="btn btn-primary btn-lg" onClick={begin}><IconPlay size={16} />Start</button>
              <button className="btn btn-lg" onClick={exit}>Back to the demo</button>
            </div>
          )}
          <EngineNotice big />
        </div>
      ) : (
        <>
          <div className="flex items-center gap-4 border-b border-line px-5 py-3 sm:px-8">
            <ForkMark size={28} />
            <ol className="flex flex-1 gap-1.5" aria-label="Presentation progress">
              {SLIDES.map((s, k) => (
                <li key={s} className="flex-1">
                  <button onClick={() => go(k)} className="group grid w-full gap-1.5 text-left" aria-current={k === i ? "step" : undefined} aria-label={`Step ${k + 1}: ${s}`}>
                    <span className="relative h-[3px] overflow-hidden bg-surface-3">
                      <span className="absolute inset-y-0 left-0 bg-text transition-[width] duration-200"
                        style={{ width: k < i ? "100%" : k === i ? (auto && !waiting ? `${(elapsed / SECONDS) * 100}%` : "100%") : "0%" }} />
                    </span>
                    <span className={`hidden truncate text-[0.75rem] lg:block ${k === i ? "font-semibold text-text" : "text-text-3 group-hover:text-text-2"}`}>{k + 1}. {s}</span>
                  </button>
                </li>
              ))}
            </ol>
            <span className="num text-[0.95rem] text-text-2">{i + 1} / {SLIDES.length}</span>
          </div>
          <div className="relative flex-1 overflow-y-auto px-5 py-8 sm:px-10 lg:px-16">
            <AnimatePresence mode="wait" custom={dir}>
              <motion.div key={i} custom={dir} className="mx-auto grid max-w-[1400px] gap-8"
                initial={reduced ? { opacity: 0 } : { opacity: 0, x: dir * 40 }} animate={{ opacity: 1, x: 0 }} exit={reduced ? { opacity: 0 } : { opacity: 0, x: dir * -24 }}
                transition={{ duration: 0.45, ease: [0.16, 1, 0.3, 1] }}>
                <div className="grid gap-2">
                  <span className="t-index text-[1rem]">0{i + 1}</span>
                  <h1 className="t-display text-[clamp(2.6rem,1.4rem+4vw,5.2rem)]">{SLIDES[i]}</h1>
                </div>
                <EngineNotice big />
                <SlideBody i={i} />
              </motion.div>
            </AnimatePresence>
          </div>
          <div className="flex flex-wrap items-center gap-2 border-t border-line px-5 py-3 sm:px-8">
            <button className="btn" onClick={() => go(i - 1)} disabled={i === 0}><IconArrowLeft size={16} />Previous</button>
            <button className="btn btn-primary" onClick={() => go(i + 1)} disabled={i === SLIDES.length - 1}>Next<IconChevron size={16} /></button>
            <button className="btn" onClick={() => setAuto((a) => !a)} aria-pressed={auto} title="Space">{auto ? <IconPause size={16} /> : <IconPlay size={16} />}{auto ? "Pause" : "Auto-advance"}</button>
            {auto && waiting && <span className="ml-1 inline-flex items-center gap-2 text-[0.85rem] text-text-2"><span className="pulse-dot" />{d.running ? "Waiting for the engine" : "Will run the simulation, then continue"}</span>}
            <span className="ml-auto hidden text-[0.78rem] text-text-3 md:inline">← → to move · Space for auto-advance · Fictional example data</span>
            <button className="btn btn-quiet" onClick={restart}><IconRetry size={16} />Restart</button>
            <button className="btn btn-quiet" onClick={exit}><IconX size={16} />Exit presentation</button>
          </div>
        </>
      )}
    </div>
  );
}
