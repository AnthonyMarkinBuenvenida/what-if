import { useState } from "react";
import { Link } from "react-router-dom";
import { AnimatePresence, motion } from "motion/react";
import { Wordmark } from "../components/Logo";
import { IconArrowLeft, IconChevron, IconPresent, IconRetry } from "../components/icons";
import { DataTag, ErrorBox, Spinner } from "../components/ui";
import { useReduced } from "../lib/hooks";
import { useDemo } from "./DemoContext";
import { AssumptionControls, DetailedAnalysis, EngineNotice, ForkFigure, GoalPicker, ResultsSummary, RunButton, RunProgress, StoreFacts } from "./parts";

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <section className="grid gap-4 border-t border-text pt-4" aria-labelledby={`step-${n}`}>
      <h2 id={`step-${n}`} className="flex items-baseline gap-3 text-[1.15rem]"><span className="t-index">0{n}</span>{title}</h2>
      {children}
    </section>
  );
}

export default function Demo() {
  const d = useDemo();
  const reduced = useReduced();
  const [details, setDetails] = useState(false);

  return (
    <div className="min-h-screen bg-bg">
      <header className="sticky top-0 z-30 border-b border-line bg-[color-mix(in_srgb,var(--bg)_94%,transparent)] backdrop-blur-md">
        <div className="mx-auto flex h-14 max-w-[1320px] items-center gap-3 px-4 sm:px-6">
          <Wordmark size={24} />
          <span className="hidden text-text-3 sm:inline">/</span>
          <span className="hidden font-semibold sm:inline">Live demo</span>
          <div className="ml-auto flex items-center gap-1.5">
            <Link to="/demo/present" className="btn btn-sm no-underline" aria-label="Presentation mode"><IconPresent size={16} /><span className="hidden md:inline">Presentation mode</span></Link>
            <button className="btn btn-sm" onClick={() => { setDetails(false); d.reset(); }} aria-label="Reset demo"><IconRetry size={16} /><span className="hidden md:inline">Reset demo</span></button>
            <Link to="/" className="btn btn-quiet btn-sm no-underline" aria-label="Back to homepage"><IconArrowLeft size={16} /><span className="hidden lg:inline">Homepage</span></Link>
            <Link to="/app" className="btn btn-primary btn-sm hidden no-underline sm:inline-flex">Open workspace</Link>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-[1320px] px-4 pb-24 pt-10 sm:px-6">
        <div className="mb-8 grid gap-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
          <div className="grid gap-3">
            <div className="flex flex-wrap gap-2"><DataTag kind="sample" /></div>
            <h1 className="t-display text-[clamp(2.4rem,1.6rem+3vw,4.4rem)]">Try a decision on a sample store.</h1>
            <p className="t-lead">Choose a business goal, change a few assumptions, and compare what happens in different scenarios. Maple Street Grocer is a fictional neighborhood store; its numbers are example data, not a real business.</p>
          </div>
        </div>

        {d.boot === "starting" && <div className="grid place-items-center gap-3 py-24 text-text-2"><Spinner size={22} />Preparing the sample store…</div>}
        {d.boot === "error" && <ErrorBox message={d.bootError ?? "The demo could not start."} onRetry={d.reset} />}
        {d.boot === "ready" && (
          <div className="grid gap-8">
            <StoreFacts />
            <EngineNotice />
            <div className="grid gap-10 lg:grid-cols-[minmax(0,23rem)_minmax(0,1fr)] lg:gap-14">
              <div className="grid content-start gap-8 lg:sticky lg:top-20 lg:self-start">
                <Step n={1} title="Choose a business goal"><GoalPicker /></Step>
                <Step n={2} title="Change a few assumptions"><AssumptionControls /></Step>
                <Step n={3} title="Run and compare">
                  <RunButton />
                  {d.client?.kind === "server" && (
                    <label className="flex items-center gap-2 text-[0.82rem] text-text-2">
                      <input type="checkbox" className="h-4 w-4" checked={d.mode === "monte_carlo"} onChange={(e) => d.setMode(e.target.checked ? "monte_carlo" : "deterministic")} disabled={d.running} />
                      Include uncertainty (300 simulated quarters per scenario)
                    </label>
                  )}
                  {d.runError && <p className="error-text" role="alert">{d.runError}</p>}
                  <RunProgress />
                </Step>
              </div>

              <div className="grid content-start gap-8">
                {!d.comparison ? (
                  <section className="grid gap-5" aria-label="Scenarios to compare">
                    <p className="text-text-2">Your goal tests these scenarios against today's operations. Press <b className="text-text">Run simulation</b> to calculate them.</p>
                    <ForkFigure />
                  </section>
                ) : (
                  <AnimatePresence mode="wait">
                    <motion.section key={d.runs.map((r) => r.id).join(",")} className="grid gap-8" aria-label="Results"
                      initial={reduced ? false : { opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.45, ease: [0.16, 1, 0.3, 1] }}>
                      <ResultsSummary />
                      <div className="border-t border-text pt-4">
                        <button className="flex w-full items-center justify-between gap-3 text-left text-[1.05rem] font-semibold" aria-expanded={details} onClick={() => setDetails((v) => !v)}>
                          View detailed analysis
                          <IconChevron size={18} className={`transition-transform ${details ? "rotate-90" : ""}`} />
                        </button>
                        <p className="mt-1 text-[0.85rem] text-text-3">Full comparison table, charts, profit breakdown, stress tests, sensitivity and model details.</p>
                        {details && <div className="mt-6"><DetailedAnalysis /></div>}
                      </div>
                    </motion.section>
                  </AnimatePresence>
                )}
              </div>
            </div>
            <section className="flex flex-wrap items-center justify-between gap-4 border-t border-text pt-6">
              <p className="max-w-[56ch] text-text-2">Ready to model your own business? The workspace opens straight away; no account needed.</p>
              <div className="flex flex-wrap gap-2">
                <Link to="/app/new" className="btn btn-primary btn-lg no-underline">Start your own simulation</Link>
                <Link to="/demo/present" className="btn btn-lg no-underline">Present this demo</Link>
              </div>
            </section>
          </div>
        )}
      </main>
    </div>
  );
}
