/* Result charts: current course vs scenario. Two series only — the current course is drawn outlined (or a ring)
   in the neutral reference colour, the scenario solid in series 1 — so identity never relies on colour alone
   (validated on #0b1022: the pair sits at the CVD floor, hence the fill/outline + direct labels + legend). */
import { useState } from "react";
import { motion } from "motion/react";
import { useReduced } from "../lib/hooks";
import { useWidth } from "./charts";

export function PairLegend({ scenarioLabel = "This scenario" }: { scenarioLabel?: string }) {
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-[0.8rem] text-text-2" aria-label="Legend">
      <li className="inline-flex items-center gap-1.5"><span className="inline-block h-2.5 w-5 rounded-[3px] border-2" style={{ borderColor: "var(--series-baseline)" }} />Current course</li>
      <li className="inline-flex items-center gap-1.5"><span className="inline-block h-2.5 w-5 rounded-[3px]" style={{ background: "var(--series-1)" }} />{scenarioLabel}</li>
    </ul>
  );
}

export interface PairRow { key: string; label: string; base: number | null; scen: number | null; note?: string }

/** Two thin bars per row on one shared scale, each value labelled. Hover a row for both values and the change;
    "Show data table" gives the exact figures. */
export function PairBars({ rows, format, ariaLabel, showScenario = true, changeFormat }: {
  rows: PairRow[]; format: (v: number) => string; ariaLabel: string; showScenario?: boolean; changeFormat?: (v: number) => string;
}) {
  const [ref, width] = useWidth<HTMLDivElement>(260);
  const reduced = useReduced();
  const [hover, setHover] = useState<number | null>(null);
  const [table, setTable] = useState(false);
  const vals = rows.flatMap((r) => [r.base ?? 0, showScenario ? r.scen ?? 0 : 0]);
  const lo = Math.min(0, ...vals), hi = Math.max(0, ...vals);
  const labelW = Math.min(190, Math.max(104, width * 0.3)), valW = 86;
  const plot = Math.max(70, width - labelW - valW - 24);
  const sx = (v: number) => ((v - lo) / (hi - lo || 1)) * plot;
  const t = reduced ? { duration: 0 } : { duration: 0.6, ease: [0.16, 1, 0.3, 1] as const };
  const chg = changeFormat ?? ((v: number) => `${v >= 0 ? "+" : "−"}${format(Math.abs(v))}`);
  const rowH = showScenario ? 40 : 26;
  const bar = (v: number | null, solid: boolean) => {
    if (v == null) return null;
    const a = sx(Math.min(0, v)), b = sx(Math.max(0, v));
    return <motion.div className="absolute inset-y-0 rounded-[4px]" style={solid ? { background: "var(--series-1)" } : { border: "2px solid var(--series-baseline)" }}
      initial={false} animate={{ left: a, width: Math.max(2, b - a) }} transition={t} />;
  };
  return (
    <div className="grid gap-2">
      {showScenario && <PairLegend />}
      <div ref={ref} className="relative grid min-w-0" style={{ contain: "inline-size" }} role="table" aria-label={ariaLabel} onPointerLeave={() => setHover(null)}>
        {width > 0 && rows.map((r, i) => (
          <div key={r.key} role="row" className="grid items-center gap-3" style={{ gridTemplateColumns: `${labelW}px ${plot}px ${valW}px`, height: rowH }} onPointerEnter={() => setHover(i)}>
            <span role="cell" className="truncate text-[0.84rem] text-text-2">{r.label}</span>
            <div role="cell" className="relative" style={{ height: showScenario ? 30 : 14 }}>
              <div className="absolute inset-y-0" style={{ left: sx(0), width: 1, background: "var(--line-strong)" }} />
              <div className="absolute inset-x-0" style={{ top: 1, height: 12 }}>{bar(r.base, false)}</div>
              {showScenario && <div className="absolute inset-x-0" style={{ top: 17, height: 12 }}>{bar(r.scen, true)}</div>}
            </div>
            <span role="cell" className="num grid text-right text-[0.8rem] leading-tight">
              <span className="text-text-3">{r.base == null ? "—" : format(r.base)}</span>
              {showScenario && <span className="text-text">{r.scen == null ? "—" : format(r.scen)}</span>}
            </span>
          </div>
        ))}
        {hover != null && rows[hover] && (
          <div className="chart-tip" style={{ left: Math.min(labelW + 8, Math.max(0, width - 230)), top: hover * rowH + rowH, pointerEvents: "none" }}>
            <div className="mb-1 font-semibold">{rows[hover].label}</div>
            <div className="flex justify-between gap-4"><span className="text-text-2">Current course</span><span className="num">{rows[hover].base == null ? "—" : format(rows[hover].base!)}</span></div>
            {showScenario && <div className="flex justify-between gap-4"><span className="text-text-2">This scenario</span><span className="num font-medium">{rows[hover].scen == null ? "—" : format(rows[hover].scen!)}</span></div>}
            {showScenario && rows[hover].base != null && rows[hover].scen != null && <div className="flex justify-between gap-4 text-[0.75rem] text-text-3"><span>Change</span><span className="num">{chg(rows[hover].scen! - rows[hover].base!)}</span></div>}
            {rows[hover].note && <div className="mt-1 max-w-[16rem] text-[0.75rem] text-text-3">{rows[hover].note}</div>}
          </div>
        )}
      </div>
      <button className="justify-self-start text-[0.78rem] text-text-3 underline" onClick={() => setTable(!table)} aria-expanded={table}>{table ? "Hide" : "Show"} data table</button>
      {table && (
        <div className="table-wrap"><table className="data">
          <thead><tr><th></th><th className="n">Current course</th>{showScenario && <><th className="n">This scenario</th><th className="n">Change</th></>}</tr></thead>
          <tbody>{rows.map((r) => <tr key={r.key}><td>{r.label}</td><td className="n">{r.base == null ? "—" : format(r.base)}</td>{showScenario && <><td className="n">{r.scen == null ? "—" : format(r.scen)}</td><td className="n">{r.base == null || r.scen == null ? "—" : chg(r.scen - r.base)}</td></>}</tr>)}</tbody>
        </table></div>
      )}
    </div>
  );
}

/** Units sold per month against the break-even volume (a marker on each bar). */
export function BreakEvenChart({ rows, unit, ariaLabel }: { rows: { key: string; label: string; sold: number; breakEven: number | null; solid: boolean }[]; unit: string; ariaLabel: string }) {
  const [ref, width] = useWidth<HTMLDivElement>(260);
  const reduced = useReduced();
  const hi = Math.max(1, ...rows.flatMap((r) => [r.sold, r.breakEven ?? 0])) * 1.12;
  const labelW = Math.min(150, Math.max(96, width * 0.25)), valW = 124;
  const plot = Math.max(70, width - labelW - valW - 24);
  const sx = (v: number) => (v / hi) * plot;
  const fmt = (v: number) => Math.round(v).toLocaleString();
  return (
    <div ref={ref} className="grid min-w-0 gap-3" style={{ contain: "inline-size" }} role="table" aria-label={ariaLabel}>
      {width > 0 && rows.map((r) => (
        <div key={r.key} role="row" className="grid items-center gap-3" style={{ gridTemplateColumns: `${labelW}px ${plot}px ${valW}px` }}
          title={r.breakEven == null ? `${r.label}: no break-even point` : `${r.label}: ${fmt(r.sold)} ${unit} sold a month vs break-even ${fmt(r.breakEven)}`}>
          <span role="cell" className="truncate text-[0.84rem] text-text-2">{r.label}</span>
          <div role="cell" className="relative h-[22px]">
            <div className="absolute inset-x-0 inset-y-[5px] rounded-[4px]" style={{ background: "var(--surface-3)" }} />
            <motion.div className="absolute inset-y-[5px] left-0 rounded-[4px]" style={r.solid ? { background: "var(--series-1)" } : { border: "2px solid var(--series-baseline)" }}
              initial={false} animate={{ width: Math.max(2, sx(r.sold)) }} transition={reduced ? { duration: 0 } : { duration: 0.6, ease: [0.16, 1, 0.3, 1] }} />
            {r.breakEven != null && <div className="absolute inset-y-0" style={{ left: sx(r.breakEven) - 1, width: 3, background: "var(--moon)" }} aria-hidden="true" />}
          </div>
          <span role="cell" className="num grid text-right text-[0.8rem] leading-tight">
            <span>{fmt(r.sold)} sold</span>
            <span className="text-text-3">{r.breakEven == null ? "no break-even" : `${fmt(r.breakEven)} to break even`}</span>
          </span>
        </div>
      ))}
      <p className="text-[0.76rem] text-text-3">Bars: average {unit} sold per month. White line: the break-even volume; below it each month loses money before tax.</p>
    </div>
  );
}

/** Worst, expected and best net profit across the uncertainty ranges: a range per row with the expected value marked. */
export function RangeChart({ rows, format, ariaLabel }: { rows: { key: string; label: string; worst: number; expected: number; best: number; solid: boolean }[]; format: (v: number) => string; ariaLabel: string }) {
  const [ref, width] = useWidth<HTMLDivElement>(260);
  const vals = rows.flatMap((r) => [r.worst, r.best, 0]);
  const lo = Math.min(...vals), hi = Math.max(...vals);
  const labelW = Math.min(150, Math.max(96, width * 0.25)), padX = 34;
  const plot = Math.max(80, width - labelW - 12 - padX * 2);
  const sx = (v: number) => padX + ((v - lo) / (hi - lo || 1)) * plot;
  return (
    <div className="grid gap-2">
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-[0.8rem] text-text-2" aria-label="Legend">
        <li className="inline-flex items-center gap-1.5"><svg width="12" height="12" aria-hidden="true"><circle cx="6" cy="6" r="4" fill="var(--surface)" stroke="var(--series-baseline)" strokeWidth="2" /></svg>Current course, expected</li>
        <li className="inline-flex items-center gap-1.5"><svg width="12" height="12" aria-hidden="true"><circle cx="6" cy="6" r="4.5" fill="var(--series-1)" /></svg>This scenario, expected</li>
        <li className="inline-flex items-center gap-1.5"><span className="inline-block h-[3px] w-5 rounded" style={{ background: "var(--text-3)" }} />Worst to best case</li>
      </ul>
      <div ref={ref} className="grid min-w-0 gap-3" style={{ contain: "inline-size" }} role="table" aria-label={ariaLabel}>
        {width > 0 && rows.map((r) => (
          <div key={r.key} role="row" className="grid items-center gap-3" style={{ gridTemplateColumns: `${labelW}px 1fr` }}
            title={`${r.label}: worst ${format(r.worst)}, expected ${format(r.expected)}, best ${format(r.best)}`}>
            <span role="cell" className="truncate text-[0.84rem] text-text-2">{r.label}</span>
            <div role="cell" className="relative h-[40px]">
              <div className="absolute top-[3px] bottom-[16px]" style={{ left: sx(0), width: 1, background: "var(--line-strong)" }} />
              <div className="absolute top-[10px] h-[3px] rounded" style={{ left: sx(r.worst), width: Math.max(2, sx(r.best) - sx(r.worst)), background: "var(--text-3)" }} />
              <svg className="absolute left-0 top-0 overflow-visible" width={1} height={1} aria-hidden="true">
                {r.solid ? <circle cx={sx(r.expected)} cy={11.5} r={6} fill="var(--series-1)" stroke="var(--surface)" strokeWidth={2} />
                  : <circle cx={sx(r.expected)} cy={11.5} r={5} fill="var(--surface)" stroke="var(--series-baseline)" strokeWidth={2} />}
              </svg>
              <span className="num absolute top-[22px] -translate-x-1/2 whitespace-nowrap text-[0.7rem] text-text-3" style={{ left: sx(r.worst) }}>{format(r.worst)}</span>
              <span className="num absolute top-[22px] -translate-x-1/2 whitespace-nowrap text-[0.7rem] text-text-3" style={{ left: sx(r.best) }}>{format(r.best)}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
