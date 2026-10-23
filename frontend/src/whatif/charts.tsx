/* What-if charts. One y-axis per chart; the baseline is a dashed neutral reference line, the
   scenario uses Signal (slot 1), extra series use slots 2-3 (validated on the dark surface).
   Every series is named in a legend, carries a marker shape, and has a table view. Lines morph
   to new values only when a new calculation has arrived (animations follow real state). */
import { useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { motion } from "motion/react";
import { useReduced } from "../lib/hooks";
import { compact, monthLabel } from "./format";
import { SevShape } from "./ui";
import type { Severity } from "./types";

/** Container width, measured before first paint. 0 until measured: charts render nothing
    until then, so lines never animate from a placeholder width to the real one. */
export function useWidth<T extends HTMLElement>(min = 240) {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    if (!ref.current) return;
    setW(Math.max(min, Math.floor(ref.current.getBoundingClientRect().width)));
    const ro = new ResizeObserver(([e]) => setW(Math.max(min, Math.floor(e.contentRect.width))));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, [min]);
  return [ref, w] as const;
}

function ticksFor(min: number, max: number, count = 4) {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [0, 1];
  if (min === max) { min -= Math.abs(min) * 0.1 || 1; max += Math.abs(max) * 0.1 || 1; }
  const span = max - min;
  const mag = 10 ** Math.floor(Math.log10(span / count));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => span / s <= count + 0.5) ?? span / count;
  const out: number[] = [];
  for (let v = Math.floor(min / step) * step; v <= Math.ceil(max / step) * step + step / 2; v += step) out.push(Math.round(v * 1e6) / 1e6);
  return out;
}

type Mark = "circle" | "ring" | "square" | "diamond" | "triangle";
function Dot({ shape, x, y, s = 3.6, color }: { shape: Mark; x: number; y: number; s?: number; color: string }) {
  const bg = "var(--surface)";
  if (shape === "ring") return <circle cx={x} cy={y} r={s} fill={bg} stroke={color} strokeWidth={2} />;
  if (shape === "square") return <rect x={x - s} y={y - s} width={s * 2} height={s * 2} fill={color} stroke={bg} strokeWidth={1.5} />;
  if (shape === "diamond") return <path d={`M${x} ${y - s * 1.3}L${x + s * 1.3} ${y}L${x} ${y + s * 1.3}L${x - s * 1.3} ${y}Z`} fill={color} stroke={bg} strokeWidth={1.5} />;
  if (shape === "triangle") return <path d={`M${x} ${y - s * 1.2}L${x + s * 1.15} ${y + s * 0.9}L${x - s * 1.15} ${y + s * 0.9}Z`} fill={color} stroke={bg} strokeWidth={1.5} />;
  return <circle cx={x} cy={y} r={s} fill={color} stroke={bg} strokeWidth={1.5} />;
}

export function LegendMark({ color, dash, shape }: { color: string; dash?: string; shape: Mark }) {
  return (
    <svg width="22" height="10" aria-hidden="true" className="inline-block flex-none">
      <line x1="1" y1="5" x2="21" y2="5" stroke={color} strokeWidth="2" strokeDasharray={dash} />
      <Dot shape={shape} x={11} y={5} s={3} color={color} />
    </svg>
  );
}

export interface ProjSeries { key: string; label: string; values: (number | null)[]; color: string; dash?: string; shape: Mark; kind?: "actual" | "baseline" | "scenario" }

/** Months on x. Optional history (actual) before a "Today" divider; projections after it. */
export function ProjectionChart({ months, history = [], series, band, height = 280, format, ariaLabel, zero = true }: {
  months: string[]; history?: { month: string; value: number | null }[]; series: ProjSeries[];
  band?: { low: number[]; high: number[]; label: string }; height?: number; format: (v: number) => string; ariaLabel: string; zero?: boolean;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const reduced = useReduced();
  const clip = useId();
  const [hover, setHover] = useState<number | null>(null);
  const [table, setTable] = useState(false);
  const pad = { l: 64, r: 16, t: 14, b: 30 };
  const H = history.length;
  const labels = [...history.map((h) => h.month), ...months];
  const n = labels.length;
  const { ticks, x, y } = useMemo(() => {
    const vals: number[] = [];
    history.forEach((h) => h.value != null && vals.push(h.value));
    series.forEach((s) => s.values.forEach((v) => v != null && vals.push(v)));
    if (band) vals.push(...band.low, ...band.high);
    if (zero) vals.push(0);
    const t = ticksFor(Math.min(...vals), Math.max(...vals));
    const y0 = t[0], y1 = t[t.length - 1];
    return {
      ticks: t,
      y: (v: number) => pad.t + (1 - (v - y0) / (y1 - y0 || 1)) * (height - pad.t - pad.b),
      x: (i: number) => pad.l + (n <= 1 ? 0 : (i / (n - 1)) * (width - pad.l - pad.r)),
    };
  }, [history, series, band, zero, height, width, n, pad.t, pad.b, pad.l, pad.r]);

  const line = (vals: (number | null)[], offset: number) => {
    let d = "", pen = false;
    vals.forEach((v, i) => {
      if (v == null) { pen = false; return; }
      d += `${pen ? "L" : "M"}${x(i + offset).toFixed(1)} ${y(v).toFixed(1)}`;
      pen = true;
    });
    return d || "M0 0";
  };
  const area = band ? `${line(band.high, H)}L${band.low.map((v, i) => `${x(i + H).toFixed(1)} ${y(v).toFixed(1)}`).reverse().join("L")}Z` : "";
  const histLine = line(history.map((h) => h.value), 0);
  const every = Math.max(1, Math.ceil(n / Math.max(3, Math.floor((width - pad.l - pad.r) / 58))));
  const t = reduced ? { duration: 0 } : { duration: 0.7, ease: [0.16, 1, 0.3, 1] as const };
  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    setHover(Math.max(0, Math.min(n - 1, Math.round(((e.clientX - r.left - pad.l) / (width - pad.l - pad.r)) * (n - 1)))));
  };
  const legend: { label: string; node: ReactNode }[] = [
    ...(H ? [{ label: "Actual (entered)", node: <LegendMark color="var(--moon)" shape="square" /> }] : []),
    ...series.map((s) => ({ label: s.label, node: <LegendMark color={s.color} dash={s.dash} shape={s.shape} /> })),
    ...(band ? [{ label: band.label, node: <span className="inline-block h-2.5 w-5 rounded-sm" style={{ background: "var(--series-1)", opacity: 0.25 }} /> }] : []),
  ];

  return (
    <div className="grid gap-2">
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-[0.8rem] text-text-2" aria-label="Legend">
        {legend.map((l) => <li key={l.label} className="inline-flex items-center gap-1.5">{l.node}{l.label}</li>)}
      </ul>
      <div ref={ref} className="relative min-w-0" style={{ contain: "inline-size", height }}>
        {width > 0 && <svg width={width} height={height} role="img" aria-label={ariaLabel} onPointerMove={onMove} onPointerLeave={() => setHover(null)} style={{ touchAction: "pan-y" }}>
          <defs><clipPath id={clip}><rect x={pad.l - 6} y={0} width={width - pad.l - pad.r + 12} height={height} /></clipPath></defs>
          {ticks.map((tk) => (
            <g key={tk}>
              <line className="chart-grid" x1={pad.l} x2={width - pad.r} y1={y(tk)} y2={y(tk)} stroke={tk === 0 ? "var(--line-strong)" : undefined} />
              <text className="chart-axis" x={pad.l - 8} y={y(tk) + 4} textAnchor="end">{format(tk)}</text>
            </g>
          ))}
          {labels.map((m, i) => (i % every === 0 || i === n - 1) && (n - 1 - i > every / 2 || i === n - 1) ? (
            <text key={m + i} className="chart-axis" x={x(i)} y={height - 9} textAnchor="middle">{monthLabel(m)}</text>
          ) : null)}
          {H > 0 && (
            <g>
              <line x1={(x(H - 1) + x(H)) / 2} x2={(x(H - 1) + x(H)) / 2} y1={pad.t} y2={height - pad.b} stroke="var(--hairline)" strokeDasharray="3 4" />
              <text className="chart-axis" x={(x(H - 1) + x(H)) / 2 + 6} y={pad.t + 10}>Projection →</text>
              <text className="chart-axis" x={(x(H - 1) + x(H)) / 2 - 6} y={pad.t + 10} textAnchor="end">← Actual</text>
            </g>
          )}
          <g clipPath={`url(#${clip})`}>
            {band && <motion.path initial={false} animate={{ d: area }} transition={t} fill="var(--series-1)" fillOpacity={0.12} />}
            {H > 0 && <path d={histLine} fill="none" stroke="var(--moon)" strokeWidth={2} />}
            {series.map((s) => (
              <motion.path key={s.key} initial={false} animate={{ d: line(s.values, H) }} transition={t} fill="none" stroke={s.color} strokeWidth={2} strokeDasharray={s.dash} strokeLinejoin="round" />
            ))}
            {history.map((h, i) => h.value != null && <Dot key={`h${i}`} shape="square" x={x(i)} y={y(h.value)} s={3} color="var(--moon)" />)}
            {series.map((s) => s.values.map((v, i) => v != null && (i % every === 0 || i === s.values.length - 1) ? (
              <motion.g key={`${s.key}${i}`} initial={false} animate={{ x: x(i + H), y: y(v) }} transition={t}><Dot shape={s.shape} x={0} y={0} s={3.2} color={s.color} /></motion.g>
            ) : null))}
          </g>
          {hover != null && (
            <g pointerEvents="none">
              <line x1={x(hover)} x2={x(hover)} y1={pad.t} y2={height - pad.b} stroke="var(--text-2)" strokeWidth={1} />
              {hover < H ? (history[hover].value != null && <Dot shape="square" x={x(hover)} y={y(history[hover].value!)} s={4.5} color="var(--moon)" />)
                : series.map((s) => s.values[hover - H] != null && <Dot key={s.key} shape={s.shape} x={x(hover)} y={y(s.values[hover - H]!)} s={4.5} color={s.color} />)}
            </g>
          )}
        </svg>}
        {hover != null && (
          <div className="chart-tip" style={{ left: Math.min(Math.max(0, x(hover) + 12), width - 210), top: 6 }}>
            <div className="mb-1 font-semibold">{monthLabel(labels[hover], true)}</div>
            {hover < H ? (
              <div className="flex justify-between gap-4"><span className="text-text-2">Actual</span><span className="num">{history[hover].value == null ? "not entered" : format(history[hover].value!)}</span></div>
            ) : (
              <>
                {series.map((s) => (
                  <div key={s.key} className="flex items-center justify-between gap-4">
                    <span className="inline-flex items-center gap-1.5 text-text-2"><LegendMark color={s.color} dash={s.dash} shape={s.shape} />{s.label}</span>
                    <span className="num font-medium">{s.values[hover - H] == null ? "—" : format(s.values[hover - H]!)}</span>
                  </div>
                ))}
                {band && <div className="mt-1 flex justify-between gap-4 text-[0.75rem] text-text-3"><span>{band.label}</span><span className="num">{format(band.low[hover - H])} to {format(band.high[hover - H])}</span></div>}
              </>
            )}
          </div>
        )}
      </div>
      <button className="justify-self-start text-[0.78rem] text-text-3 underline" onClick={() => setTable(!table)} aria-expanded={table}>{table ? "Hide" : "Show"} data table</button>
      {table && (
        <div className="table-wrap max-h-72 overflow-auto">
          <table className="data">
            <thead><tr><th>Month</th>{H > 0 && <th className="n">Actual</th>}{series.map((s) => <th key={s.key} className="n">{s.label}</th>)}{band && <th className="n">{band.label}</th>}</tr></thead>
            <tbody>
              {labels.map((m, i) => (
                <tr key={m + i}>
                  <td>{monthLabel(m, true)}</td>
                  {H > 0 && <td className="n">{i < H && history[i].value != null ? format(history[i].value!) : ""}</td>}
                  {series.map((s) => <td key={s.key} className="n">{i >= H && s.values[i - H] != null ? format(s.values[i - H]!) : ""}</td>)}
                  {band && <td className="n">{i >= H ? `${format(band.low[i - H])} – ${format(band.high[i - H])}` : ""}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/** Waterfall from the current course to the scenario: every driver of the change in net profit. */
export function BridgeChart({ start, end, items, cur }: { start: number; end: number; items: { key: string; label: string; value: number; note?: string }[]; cur: string }) {
  const [ref, width] = useWidth<HTMLDivElement>(260);
  const reduced = useReduced();
  const rows: { label: string; from: number; to: number; kind: "total" | "up" | "down"; note?: string; value: number }[] = [];
  rows.push({ label: "Current course", from: 0, to: start, kind: "total", value: start });
  let run = start;
  for (const it of items) {
    rows.push({ label: it.label, from: run, to: run + it.value, kind: it.value >= 0 ? "up" : "down", note: it.note, value: it.value });
    run += it.value;
  }
  rows.push({ label: "This scenario", from: 0, to: end, kind: "total", value: end });
  const lo = Math.min(0, ...rows.map((r) => Math.min(r.from, r.to)));
  const hi = Math.max(0, ...rows.map((r) => Math.max(r.from, r.to)));
  const labelW = Math.min(200, Math.max(120, width * 0.34));
  const valW = 92;
  const plot = Math.max(80, width - labelW - valW - 12);
  const sx = (v: number) => ((v - lo) / (hi - lo || 1)) * plot;
  return (
    <div ref={ref} className="grid gap-1.5 min-w-0" style={{ contain: "inline-size" }} role="table" aria-label="Profit bridge: what changes net profit">
      {width > 0 && rows.map((r, i) => {
        const a = sx(Math.min(r.from, r.to)), b = sx(Math.max(r.from, r.to));
        const color = r.kind === "total" ? (i === 0 ? "var(--series-baseline)" : "var(--series-1)") : r.kind === "up" ? "var(--series-1)" : "var(--ember)";
        return (
          <div key={r.label + i} role="row" className="group grid items-center gap-3" style={{ gridTemplateColumns: `${labelW}px ${plot}px ${valW}px` }} title={r.note || undefined}>
            <span role="cell" className={`truncate text-[0.84rem] ${r.kind === "total" ? "font-semibold" : "text-text-2"}`}>{r.label}</span>
            <div role="cell" className="relative h-[18px]">
              <div className="absolute inset-y-0" style={{ left: sx(0), width: 1, background: "var(--line-strong)" }} />
              <motion.div className="absolute inset-y-[3px] rounded-[4px]" style={{ background: color, opacity: r.kind === "total" ? 0.9 : 1 }}
                initial={false} animate={{ left: a, width: Math.max(2, b - a) }} transition={reduced ? { duration: 0 } : { duration: 0.6, ease: [0.16, 1, 0.3, 1] }} />
            </div>
            <span role="cell" className="num text-right text-[0.84rem]">{r.kind === "total" ? "" : r.value >= 0 ? "+" : "−"}{compact(Math.abs(r.value), cur).replace(/^-/, "")}</span>
          </div>
        );
      })}
    </div>
  );
}

const SEV_COLOR: Record<Severity, string> = { low: "var(--sev-low)", moderate: "var(--sev-moderate)", high: "var(--sev-high)", critical: "var(--sev-critical)" };

/** 0-100 risk score on a half dial; the level is printed with its shape. */
export function RiskDial({ score, level, size = 220 }: { score: number; level: Severity; size?: number }) {
  const reduced = useReduced();
  const r = size / 2 - 14, cx = size / 2, cy = size / 2 + 4;
  const pt = (v: number, rr = r) => { const a = Math.PI * (1 - v / 100); return [cx + rr * Math.cos(a), cy - rr * Math.sin(a)] as const; };
  const arc = (a: number, b: number) => { const [x1, y1] = pt(a), [x2, y2] = pt(b); return `M${x1} ${y1}A${r} ${r} 0 0 1 ${x2} ${y2}`; };
  const [nx, ny] = pt(score, r - 18);
  return (
    <div className="grid justify-items-center">
      <svg width={size} height={size / 2 + 30} role="img" aria-label={`Risk score ${score} of 100, ${level}`}>
        {[[0, 25, "low"], [25, 50, "moderate"], [50, 75, "high"], [75, 100, "critical"]].map(([a, b, s]) => (
          <path key={s as string} d={arc((a as number) + 0.8, (b as number) - 0.8)} stroke={SEV_COLOR[s as Severity]} strokeOpacity={0.35} strokeWidth="10" fill="none" />
        ))}
        <motion.path d={arc(0.8, Math.max(1, score))} stroke={SEV_COLOR[level]} strokeWidth="10" fill="none" strokeLinecap="round"
          initial={reduced ? false : { pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ duration: 0.9, ease: [0.16, 1, 0.3, 1] }} />
        <motion.line x1={cx} y1={cy} initial={false} animate={{ x2: nx, y2: ny }} transition={reduced ? { duration: 0 } : { duration: 0.9, ease: [0.16, 1, 0.3, 1] }} stroke="var(--moon)" strokeWidth="2" strokeLinecap="round" />
        <circle cx={cx} cy={cy} r="5" fill="var(--moon)" />
        <text x={14} y={cy + 20} className="chart-axis">0</text>
        <text x={size - 14} y={cy + 20} className="chart-axis" textAnchor="end">100</text>
      </svg>
      <div className="-mt-3 grid justify-items-center gap-1">
        <span className="kpi text-[2.4rem]">{score}</span>
        <span className="inline-flex items-center gap-1.5 text-[0.85rem] font-semibold" style={{ color: SEV_COLOR[level] }}><SevShape s={level} />{level[0].toUpperCase() + level.slice(1)} overall</span>
      </div>
    </div>
  );
}

/** Horizontal bars in one hue; the leader for the chosen objective is highlighted and labelled. */
export function RankBars({ rows, format, ariaLabel }: { rows: { key: string | number; label: string; value: number; leader?: boolean }[]; format: (v: number) => string; ariaLabel: string }) {
  const [ref, width] = useWidth<HTMLDivElement>(240);
  const reduced = useReduced();
  const lo = Math.min(0, ...rows.map((r) => r.value));
  const hi = Math.max(0, ...rows.map((r) => r.value));
  const labelW = Math.min(220, width * 0.38), valW = 96, plot = Math.max(60, width - labelW - valW - 12);
  const sx = (v: number) => ((v - lo) / (hi - lo || 1)) * plot;
  return (
    <div ref={ref} className="grid gap-1.5 min-w-0" style={{ contain: "inline-size" }} role="table" aria-label={ariaLabel}>
      {width > 0 && rows.map((r) => {
        const a = sx(Math.min(0, r.value)), b = sx(Math.max(0, r.value));
        return (
          <div key={r.key} role="row" className="grid items-center gap-3" style={{ gridTemplateColumns: `${labelW}px ${plot}px ${valW}px` }}>
            <span role="cell" className={`truncate text-[0.84rem] ${r.leader ? "font-semibold" : "text-text-2"}`}>{r.leader && <span className="sr-only">Leader: </span>}{r.label}</span>
            <div role="cell" className="relative h-[18px]">
              <div className="absolute inset-y-0" style={{ left: sx(0), width: 1, background: "var(--line-strong)" }} />
              <motion.div className="absolute inset-y-[3px] rounded-[4px]" style={{ background: r.leader ? "var(--series-1)" : "var(--series-baseline)", opacity: r.leader ? 1 : 0.55 }}
                initial={reduced ? false : { width: 0, left: sx(0) }} animate={{ left: a, width: Math.max(2, b - a) }} transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }} />
            </div>
            <span role="cell" className="num text-right text-[0.84rem]">{format(r.value)}{r.leader ? " ★" : ""}</span>
          </div>
        );
      })}
    </div>
  );
}
