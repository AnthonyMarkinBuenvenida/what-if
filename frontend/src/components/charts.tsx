/* Monochrome SVG charts. Series are told apart by gray value, dash pattern
   and point-marker shape, and every series is named in a legend or label, so
   charts stay readable without color (and in print). One y-axis per chart,
   2px lines, bands for uncertainty, crosshair + tooltip on hover. */
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { motion } from "motion/react";
import { compactMoney } from "../lib/format";
import { useReduced } from "../lib/hooks";

type Shape = "circle" | "square" | "triangle" | "diamond" | "ring" | "cross";
export const SERIES_STYLE: { color: string; dash?: string; shape: Shape }[] = [
  { color: "var(--series-1)", shape: "circle" },
  { color: "var(--series-2)", dash: "7 4", shape: "square" },
  { color: "var(--series-3)", dash: "1.5 3.5", shape: "triangle" },
  { color: "var(--series-4)", shape: "diamond" },
  { color: "var(--series-5)", dash: "10 4 2 4", shape: "ring" },
  { color: "var(--series-6)", dash: "4 3", shape: "cross" },
];
export const seriesStyle = (i: number) => SERIES_STYLE[((i % SERIES_STYLE.length) + SERIES_STYLE.length) % SERIES_STYLE.length];

export function Marker({ shape, x, y, size = 4, color, bg = "var(--surface)" }: { shape: Shape; x: number; y: number; size?: number; color: string; bg?: string }) {
  const s = size;
  switch (shape) {
    case "square": return <rect x={x - s} y={y - s} width={s * 2} height={s * 2} fill={color} stroke={bg} strokeWidth={1.5} />;
    case "triangle": return <path d={`M${x},${y - s * 1.2} L${x + s * 1.15},${y + s * 0.9} L${x - s * 1.15},${y + s * 0.9}Z`} fill={color} stroke={bg} strokeWidth={1.5} />;
    case "diamond": return <path d={`M${x},${y - s * 1.3} L${x + s * 1.3},${y} L${x},${y + s * 1.3} L${x - s * 1.3},${y}Z`} fill={color} stroke={bg} strokeWidth={1.5} />;
    case "ring": return <circle cx={x} cy={y} r={s} fill={bg} stroke={color} strokeWidth={2} />;
    case "cross": return <path d={`M${x - s},${y - s} L${x + s},${y + s} M${x + s},${y - s} L${x - s},${y + s}`} stroke={color} strokeWidth={2} strokeLinecap="round" />;
    default: return <circle cx={x} cy={y} r={s} fill={color} stroke={bg} strokeWidth={1.5} />;
  }
}

/** Legend key for a series: its line style plus its marker. Use wherever a color swatch used to be. */
export function SeriesMark({ index, width = 22 }: { index: number; width?: number }) {
  const st = seriesStyle(index);
  return (
    <svg width={width} height={10} aria-hidden="true" className="inline-block flex-none align-middle">
      <line x1={1} y1={5} x2={width - 1} y2={5} stroke={st.color} strokeWidth={2} strokeDasharray={st.dash} strokeLinecap={st.dash === "1.5 3.5" ? "round" : "butt"} />
      <Marker shape={st.shape} x={width / 2} y={5} size={3.2} color={st.color} />
    </svg>
  );
}

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [w, setW] = useState(600);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(240, Math.floor(e.contentRect.width))));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

function niceTicks(min: number, max: number, count = 4) {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [0, 1];
  if (min === max) {
    min -= 1;
    max += 1;
  }
  const span = max - min;
  const step0 = span / count;
  const mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => span / s <= count + 0.5) ?? step0;
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const out: number[] = [];
  for (let v = lo; v <= hi + step / 2; v += step) out.push(Math.round(v * 1e6) / 1e6);
  return out;
}

export interface LineSeries {
  id: string | number;
  label: string;
  colorIndex: number;
  values: (number | null)[];
  low?: number[];
  high?: number[];
  dashed?: boolean;
}

export function Legend({ items }: { items: { label: string; colorIndex: number }[] }) {
  if (items.length < 2) return null;
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-[0.8rem] text-text-2" aria-label="Legend">
      {items.map((s) => (
        <li key={s.label} className="inline-flex items-center gap-1.5"><SeriesMark index={s.colorIndex} />{s.label}</li>
      ))}
    </ul>
  );
}

/** Thin x labels so they stay about 56 px apart, whatever the chart width. */
function showXLabel(i: number, n: number, plotWidth: number) {
  const fit = Math.max(2, Math.min(8, Math.floor(plotWidth / 56)));
  if (n <= 14 && plotWidth / n >= 40) return true;
  const every = Math.ceil(n / fit);
  return i % every === 0 || (i === n - 1 && (n - 1) % every >= every / 2);
}

export function LineChart({
  series, xLabels, height = 240, format = compactMoney, refLine, xTitle = "Week", ariaLabel, showBands = true, animate = true,
}: {
  series: LineSeries[]; xLabels: (string | number)[]; height?: number; format?: (v: number) => string;
  refLine?: { value: number; label: string }; xTitle?: string; ariaLabel: string; showBands?: boolean; animate?: boolean;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const reduced = useReduced();
  const clip = useId();
  const [hover, setHover] = useState<number | null>(null);
  const pad = { l: 56, r: 14, t: 12, b: 28 };
  const n = xLabels.length;
  const { ticks, y, x } = useMemo(() => {
    const vals: number[] = [];
    series.forEach((s) => {
      s.values.forEach((v) => v != null && vals.push(v));
      if (showBands && s.low) vals.push(...s.low);
      if (showBands && s.high) vals.push(...s.high);
    });
    if (refLine) vals.push(refLine.value);
    const t = niceTicks(Math.min(...vals), Math.max(...vals));
    const y0 = t[0], y1 = t[t.length - 1];
    const yf = (v: number) => pad.t + (1 - (v - y0) / (y1 - y0 || 1)) * (height - pad.t - pad.b);
    const xf = (i: number) => pad.l + (n <= 1 ? 0 : (i / (n - 1)) * (width - pad.l - pad.r));
    return { ticks: t, y: yf, x: xf };
  }, [series, width, height, refLine, n, showBands, pad.t, pad.b, pad.l, pad.r]);

  // Gaps (null values) break the line instead of being invented.
  const path = (vals: (number | null)[]) => {
    let d = "", pen = false;
    vals.forEach((v, i) => {
      if (v == null) { pen = false; return; }
      d += `${pen ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
      pen = true;
    });
    return d;
  };
  const band = (lo: number[], hi: number[]) => `${path(hi)}L${lo.map((v, i) => [i, v] as const).reverse().map(([i, v]) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join("L")}Z`;
  const markEvery = Math.max(1, Math.ceil(n / 14));

  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
    const i = Math.round(((e.clientX - r.left - pad.l) / (width - pad.l - pad.r)) * (n - 1));
    setHover(Math.max(0, Math.min(n - 1, i)));
  };
  const draw = animate && !reduced;

  return (
    <div className="grid gap-2">
      <Legend items={series.map((s) => ({ label: s.label, colorIndex: s.colorIndex }))} />
      <div ref={ref} className="relative" style={{ height }}>
        <svg width={width} height={height} role="img" aria-label={ariaLabel} onPointerMove={onMove} onPointerLeave={() => setHover(null)} style={{ touchAction: "pan-y" }}>
          <defs><clipPath id={clip}><rect x={pad.l} y={0} width={width - pad.l - pad.r} height={height} /></clipPath></defs>
          {ticks.map((t) => (
            <g key={t}>
              <line className="chart-grid" x1={pad.l} x2={width - pad.r} y1={y(t)} y2={y(t)} />
              <text className="chart-axis" x={pad.l - 8} y={y(t) + 4} textAnchor="end">{format(t)}</text>
            </g>
          ))}
          {xLabels.map((l, i) => showXLabel(i, n, width - pad.l - pad.r) ? (
            <text key={i} className="chart-axis" x={x(i)} y={height - 8} textAnchor="middle">{l}</text>
          ) : null)}
          {refLine && (
            <g>
              <line x1={pad.l} x2={width - pad.r} y1={y(refLine.value)} y2={y(refLine.value)} stroke="var(--text-3)" strokeDasharray="2 3" strokeWidth={1.2} />
              <text className="chart-axis" x={width - pad.r} y={y(refLine.value) - 5} textAnchor="end">{refLine.label}</text>
            </g>
          )}
          <g clipPath={`url(#${clip})`}>
            {showBands && series.map((s) => s.low && s.high ? (
              <motion.path key={`b${s.id}`} d={band(s.low, s.high)} fill={seriesStyle(s.colorIndex).color} fillOpacity={0.08}
                initial={draw ? { opacity: 0 } : false} animate={{ opacity: 1 }} transition={{ duration: 0.6, delay: 0.25 }} />
            ) : null)}
            {series.map((s, si) => {
              const st = seriesStyle(s.colorIndex);
              return (
                <motion.path key={`l${s.id}`} d={path(s.values)} fill="none" stroke={st.color} strokeWidth={2} strokeLinejoin="round"
                  strokeLinecap={st.dash === "1.5 3.5" ? "round" : "butt"} strokeDasharray={st.dash}
                  initial={draw ? { opacity: 0 } : false} animate={{ opacity: 1 }} transition={{ duration: 0.5, delay: si * 0.06, ease: [0.16, 1, 0.3, 1] }} />
              );
            })}
            {series.map((s) => {
              const st = seriesStyle(s.colorIndex);
              return <g key={`m${s.id}`}>{s.values.map((v, i) => v != null && (i % markEvery === 0 || i === n - 1) ? <Marker key={i} shape={st.shape} x={x(i)} y={y(v)} size={3.2} color={st.color} /> : null)}</g>;
            })}
          </g>
          {hover != null && (
            <g>
              <line x1={x(hover)} x2={x(hover)} y1={pad.t} y2={height - pad.b} stroke="var(--text)" strokeWidth={1} />
              {series.map((s) => s.values[hover] != null && <Marker key={s.id} shape={seriesStyle(s.colorIndex).shape} x={x(hover)} y={y(s.values[hover]!)} size={4.5} color={seriesStyle(s.colorIndex).color} />)}
            </g>
          )}
        </svg>
        {hover != null && (
          <div className="chart-tip" style={{ left: Math.min(x(hover) + 12, width - 200), top: 8 }}>
            <div className="mb-1 font-semibold">{xTitle} {xLabels[hover]}</div>
            {series.map((s) => (
              <div key={s.id} className="flex items-center justify-between gap-3">
                <span className="inline-flex items-center gap-1.5 text-text-2"><SeriesMark index={s.colorIndex} width={18} />{s.label}</span>
                <span className="num font-medium">{s.values[hover] == null ? "no data" : format(s.values[hover]!)}</span>
              </div>
            ))}
            {series.some((s) => s.low) && showBands && <div className="mt-1 text-[0.72rem] text-text-3">Line: median. Shaded: 10th–90th percentile of runs.</div>}
          </div>
        )}
      </div>
    </div>
  );
}

/** Diverging horizontal bars. Solid black raises the value; light gray lowers it; the sign is always printed. */
export function DivergingBars({ rows, format = compactMoney, ariaLabel }: {
  rows: { label: string; low?: number; value: number; note?: ReactNode }[]; format?: (v: number) => string; ariaLabel: string;
}) {
  const max = Math.max(1, ...rows.flatMap((r) => [Math.abs(r.value), Math.abs(r.low ?? 0)]));
  const reduced = useReduced();
  const [tip, setTip] = useState<number | null>(null);
  const signed = (v: number) => `${v > 0 ? "+" : v < 0 ? "−" : ""}${format(Math.abs(v))}`;
  return (
    <div role="img" aria-label={ariaLabel} className="grid gap-1.5">
      {rows.map((r, i) => {
        const vals = r.low != null ? [r.low, r.value] : [r.value];
        return (
          <div key={r.label} className="grid grid-cols-[minmax(7rem,38%)_1fr] items-center gap-3 text-[0.85rem]"
            onPointerEnter={() => setTip(i)} onPointerLeave={() => setTip(null)}>
            <span className="truncate text-text-2" title={r.label}>{r.label}</span>
            <div className="relative h-6">
              <div className="absolute inset-y-0 left-1/2 w-px bg-text" />
              {vals.map((v, k) => {
                const w = (Math.abs(v) / max) * 50;
                return (
                  <motion.div key={k} className="absolute top-1.5 h-3"
                    style={{ left: v >= 0 ? "50%" : `${50 - w}%`, background: v >= 0 ? "var(--text)" : "var(--gray-300)", border: v >= 0 ? undefined : "1px solid var(--gray-500)" }}
                    initial={reduced ? false : { width: 0 }} animate={{ width: `${w}%` }} transition={{ duration: 0.6, delay: i * 0.04, ease: [0.16, 1, 0.3, 1] }} />
                );
              })}
              <span className="num absolute top-0.5 text-[0.75rem] text-text-2" style={r.value >= 0 && (r.low == null || r.low >= 0) ? { right: 0 } : { left: 0 }}>
                {r.low != null ? `${signed(r.low)} / ${signed(r.value)}` : signed(r.value)}
              </span>
              {tip === i && r.note && <div className="chart-tip" style={{ left: "50%", top: 26 }}>{r.note}</div>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function Sparkline({ values, colorIndex = 0, width = 120, height = 34, baseline }: { values: number[]; colorIndex?: number; width?: number; height?: number; baseline?: number }) {
  if (!values.length) return null;
  const st = seriesStyle(colorIndex);
  const vals = baseline != null ? [...values, baseline] : values;
  const min = Math.min(...vals), max = Math.max(...vals);
  const y = (v: number) => 4 + (1 - (v - min) / (max - min || 1)) * (height - 8);
  const x = (i: number) => 3 + (i / Math.max(1, values.length - 1)) * (width - 6);
  const d = values.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join("");
  return (
    <svg width={width} height={height} aria-hidden="true">
      {baseline != null && <line x1={0} x2={width} y1={y(baseline)} y2={y(baseline)} stroke="var(--text-3)" strokeDasharray="2 3" strokeWidth={1} />}
      <path d={d} fill="none" stroke={st.color} strokeWidth={1.75} strokeDasharray={st.dash} strokeLinecap="round" strokeLinejoin="round" />
      <Marker shape={st.shape} x={x(values.length - 1)} y={y(values[values.length - 1])} size={3} color={st.color} />
    </svg>
  );
}

/** Range rows: p10–p90 as an outlined bar, the median as the series marker, on one shared scale. */
export function RangeRows({ rows, format = compactMoney, refValue, refLabel, ariaLabel }: {
  rows: { label: string; colorIndex: number; p10: number; p50: number; p90: number }[]; format?: (v: number) => string;
  refValue?: number | null; refLabel?: string; ariaLabel: string;
}) {
  const all = rows.flatMap((r) => [r.p10, r.p90]).concat(refValue != null ? [refValue] : []);
  const t = niceTicks(Math.min(...all), Math.max(...all), 4);
  const lo = t[0], hi = t[t.length - 1];
  const pct = (v: number) => ((v - lo) / (hi - lo || 1)) * 100;
  const reduced = useReduced();
  return (
    <div role="img" aria-label={ariaLabel} className="grid gap-2">
      <div className="relative ml-[38%] h-4 text-[0.7rem] text-text-3">
        {t.map((v) => <span key={v} className="num absolute -translate-x-1/2" style={{ left: `${pct(v)}%` }}>{format(v)}</span>)}
      </div>
      {rows.map((r, i) => {
        const st = seriesStyle(r.colorIndex);
        return (
          <div key={r.label} className="grid grid-cols-[38%_1fr] items-center text-[0.85rem]">
            <span className="flex min-w-0 items-center gap-1.5 pr-3 text-text-2" title={r.label}><SeriesMark index={r.colorIndex} width={18} /><span className="truncate">{r.label}</span></span>
            <div className="relative h-7">
              {t.map((v) => <div key={v} className="absolute inset-y-0 w-px bg-[var(--grid)]" style={{ left: `${pct(v)}%` }} />)}
              {refValue != null && <div className="absolute inset-y-[-4px] w-0 border-l border-dashed border-text" style={{ left: `${pct(refValue)}%` }} title={refLabel} />}
              <motion.div className="absolute top-[11px] h-[6px] rounded-full border border-text bg-surface-3" style={{ left: `${pct(r.p10)}%`, width: `${Math.max(0.5, pct(r.p90) - pct(r.p10))}%`, transformOrigin: "left" }}
                initial={reduced ? false : { scaleX: 0 }} animate={{ scaleX: 1 }} transition={{ duration: 0.6, delay: i * 0.05, ease: [0.16, 1, 0.3, 1] }} />
              <div className="absolute top-0 h-7 w-0" style={{ left: `${pct(r.p50)}%` }} title={`Median ${format(r.p50)}`}>
                <svg width={14} height={28} className="-translate-x-1/2 overflow-visible" aria-hidden="true"><Marker shape={st.shape} x={7} y={14} size={5} color="var(--text)" /></svg>
              </div>
            </div>
          </div>
        );
      })}
      <p className="text-[0.75rem] text-text-3">Bar: 10th–90th percentile of runs · marker: median{refValue != null ? ` · dashed line: ${refLabel}` : ""}.</p>
    </div>
  );
}
