// Line-art industry scenes drawn along a horizon (viewBox 1600 x 420, horizon at y = 300).
// They sit behind content at low opacity; strokes use Moon, a few accents use Signal.

import type { ReactNode } from "react";

const W = 1600;
const HZ = 300;
const range = (n: number) => Array.from({ length: n }, (_, i) => i);

function Ground() {
  return (
    <g>
      <path d={`M0 ${HZ}H${W}`} stroke="var(--moon)" strokeOpacity="0.5" />
      {range(9).map((i) => <path key={i} d={`M0 ${HZ + 14 + i * i * 2.4}H${W}`} stroke="var(--moon)" strokeOpacity={0.16 - i * 0.015} />)}
    </g>
  );
}

function FoodBeverage() {
  return (
    <g>
      {range(5).map((i) => {
        const x = 90 + i * 300, w = 230;
        return (
          <g key={i} opacity={i === 2 ? 1 : 0.7}>
            <rect x={x} y={150} width={w} height={150} fill="none" stroke="var(--moon)" strokeOpacity="0.5" />
            <path d={`M${x - 10} 150 ${range(8).map(() => `q${(w + 20) / 16} 22 ${(w + 20) / 8} 0`).join(" ")}`} fill="none" stroke="var(--moon)" strokeOpacity="0.55" />
            {range(8).map((k) => <path key={k} d={`M${x - 10 + k * (w + 20) / 8} 150v-18`} stroke="var(--moon)" strokeOpacity="0.3" />)}
            <path d={`M${x - 10} 132H${x + w + 10}`} stroke="var(--moon)" strokeOpacity="0.4" />
            <rect x={x + 24} y={200} width={w - 48} height={56} fill="none" stroke="var(--moon)" strokeOpacity="0.32" />
            <path d={`M${x + w / 2} 256V300`} stroke="var(--moon)" strokeOpacity="0.25" />
          </g>
        );
      })}
      {/* the cup on the counter of the middle shop */}
      <g transform="translate(760 196)">
        <path d="M0 0h52l-7 78H7z" fill="none" stroke="var(--signal)" strokeOpacity="0.8" />
        <path d="M-3 0h58" stroke="var(--signal)" strokeOpacity="0.8" />
        <path d="M30 0l14-34" stroke="var(--signal)" strokeOpacity="0.8" />
        {[[14, 66], [24, 70], [34, 64], [19, 58], [30, 56]].map(([x, y], i) => <circle key={i} cx={x} cy={y} r="3.4" fill="none" stroke="var(--signal)" strokeOpacity="0.7" />)}
      </g>
      {[0, 1, 2].map((i) => <path key={i} d={`M${776 + i * 12} 184c-8-12 8-18 0-30`} fill="none" stroke="var(--moon)" strokeOpacity="0.28" />)}
    </g>
  );
}

function Retail() {
  return (
    <g>
      <rect x="260" y="110" width="1080" height="190" fill="none" stroke="var(--moon)" strokeOpacity="0.5" />
      <path d="M240 110h1120M240 92h1120" stroke="var(--moon)" strokeOpacity="0.4" />
      {range(3).map((r) => <path key={r} d={`M300 ${160 + r * 44}H1300`} stroke="var(--moon)" strokeOpacity="0.32" />)}
      {range(3).flatMap((r) => range(22).map((c) => {
        const h = 12 + ((c * 7 + r * 5) % 4) * 5;
        return <rect key={`${r}-${c}`} x={310 + c * 44} y={160 + r * 44 - h} width="30" height={h} fill="none" stroke={c === 9 && r === 1 ? "var(--signal)" : "var(--moon)"} strokeOpacity={c === 9 && r === 1 ? 0.85 : 0.22} />;
      }))}
      <path d="M760 300V250h80v50" fill="none" stroke="var(--moon)" strokeOpacity="0.4" />
      {[120, 1430].map((x) => <g key={x}><path d={`M${x} 300v-90h70v90`} fill="none" stroke="var(--moon)" strokeOpacity="0.3" /><path d={`M${x + 18} 210c0-22 34-22 34 0`} fill="none" stroke="var(--moon)" strokeOpacity="0.3" /></g>)}
    </g>
  );
}

function Manufacturing() {
  const teeth = range(9).map(() => "l60 -46v46").join("");
  return (
    <g>
      <path d={`M220 300V180${teeth}H760V300`} fill="none" stroke="var(--moon)" strokeOpacity="0.5" />
      {range(9).map((i) => <path key={i} d={`M${232 + i * 60} 196h44`} stroke="var(--moon)" strokeOpacity="0.25" />)}
      {[860, 940].map((x, i) => (
        <g key={x}>
          <rect x={x} y={70 + i * 30} width="34" height={230 - i * 30} fill="none" stroke="var(--moon)" strokeOpacity="0.45" />
          <path d={`M${x + 17} ${66 + i * 30}c-30-20 10-40-14-62`} fill="none" stroke="var(--moon)" strokeOpacity="0.22" />
        </g>
      ))}
      <path d="M1000 270h460M1000 290h460" stroke="var(--moon)" strokeOpacity="0.45" />
      {range(10).map((i) => <circle key={i} cx={1010 + i * 50} cy="280" r="9" fill="none" stroke="var(--moon)" strokeOpacity="0.35" />)}
      {range(5).map((i) => <rect key={i} x={1040 + i * 90} y="232" width="44" height="38" fill="none" stroke={i === 2 ? "var(--signal)" : "var(--moon)"} strokeOpacity={i === 2 ? 0.85 : 0.4} />)}
      <g transform="translate(130 210)">
        <circle r="40" fill="none" stroke="var(--moon)" strokeOpacity="0.4" />
        <circle r="14" fill="none" stroke="var(--moon)" strokeOpacity="0.4" />
        {range(10).map((i) => <path key={i} d="M0 -40v-12" transform={`rotate(${i * 36})`} stroke="var(--moon)" strokeOpacity="0.4" strokeWidth="6" />)}
      </g>
    </g>
  );
}

function Technology() {
  const nodes = [[260, 90], [420, 60], [560, 120], [700, 70], [860, 110], [1010, 60], [1160, 100], [1320, 70], [480, 170], [780, 175], [1090, 170]];
  const edges = [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 6], [6, 7], [1, 8], [8, 2], [3, 9], [9, 4], [5, 10], [10, 6], [8, 9], [9, 10]];
  return (
    <g>
      {edges.map(([a, b], i) => <path key={i} d={`M${nodes[a][0]} ${nodes[a][1]}L${nodes[b][0]} ${nodes[b][1]}`} stroke={i === 11 ? "var(--signal)" : "var(--moon)"} strokeOpacity={i === 11 ? 0.8 : 0.22} />)}
      {nodes.map(([x, y], i) => <circle key={i} cx={x} cy={y} r={i === 5 ? 6 : 4} fill="var(--night)" stroke={i === 5 || i === 10 ? "var(--signal)" : "var(--moon)"} strokeOpacity="0.6" />)}
      {range(9).map((i) => {
        const x = 230 + i * 128;
        return (
          <g key={i}>
            <rect x={x} y={200} width="96" height="100" fill="none" stroke="var(--moon)" strokeOpacity="0.45" />
            {range(5).map((r) => (
              <g key={r}>
                <path d={`M${x + 10} ${214 + r * 18}h56`} stroke="var(--moon)" strokeOpacity="0.25" />
                <circle cx={x + 80} cy={214 + r * 18} r="2.4" fill={(i + r) % 4 === 0 ? "var(--signal)" : "var(--moon)"} fillOpacity={(i + r) % 4 === 0 ? 0.9 : 0.3} />
              </g>
            ))}
          </g>
        );
      })}
    </g>
  );
}

function Agriculture() {
  const vx = 800;
  return (
    <g>
      {range(15).map((i) => {
        const x = -400 + i * 172;
        return <path key={i} d={`M${vx + (x - vx) * 0.06} ${HZ}L${x} 420`} stroke="var(--moon)" strokeOpacity={i === 8 ? 0.5 : 0.22} />;
      })}
      <circle cx="1240" cy="150" r="54" fill="none" stroke="var(--moon)" strokeOpacity="0.45" />
      {range(12).map((i) => <path key={i} d="M0 -70v-14" transform={`translate(1240 150) rotate(${i * 30})`} stroke="var(--moon)" strokeOpacity="0.3" />)}
      <path d="M300 130c0-30 40-38 56-18 10-30 62-28 66 6 30-4 40 30 14 40H300c-22 0-24-28 0-28z" fill="none" stroke="var(--moon)" strokeOpacity="0.45" />
      {range(7).map((i) => <path key={i} d={`M${318 + i * 18} 176l-8 22`} stroke="var(--signal)" strokeOpacity="0.7" />)}
      <path d="M560 300v-74l46-34 46 34v74z" fill="none" stroke="var(--moon)" strokeOpacity="0.45" />
      <path d="M680 300V190c0-24 40-24 40 0v110" fill="none" stroke="var(--moon)" strokeOpacity="0.45" />
      {range(26).map((i) => <path key={i} d={`M${120 + i * 54} ${HZ}c-4-14 4-22 0-34M${120 + i * 54} ${HZ - 18}c6-4 10-4 14-12`} fill="none" stroke="var(--moon)" strokeOpacity="0.2" />)}
    </g>
  );
}

function Services() {
  return (
    <g>
      {range(7).map((i) => {
        const x = 120 + i * 205, h = 130 + ((i * 37) % 4) * 32;
        return (
          <g key={i}>
            <rect x={x} y={HZ - h} width="160" height={h} fill="none" stroke="var(--moon)" strokeOpacity="0.45" />
            {range(Math.floor(h / 34)).flatMap((r) => range(4).map((c) => (
              <rect key={`${r}-${c}`} x={x + 14 + c * 36} y={HZ - h + 14 + r * 34} width="22" height="18" fill="none"
                stroke={i === 3 && r === 1 && c === 2 ? "var(--signal)" : "var(--moon)"} strokeOpacity={i === 3 && r === 1 && c === 2 ? 0.9 : 0.2} />
            )))}
          </g>
        );
      })}
    </g>
  );
}

function Finance() {
  const pts = range(28).map((i) => 230 - Math.sin(i / 3) * 34 - i * 3 + ((i * 53) % 7) * 4);
  return (
    <g>
      {pts.map((y, i) => {
        const x = 110 + i * 52, up = i === 0 || y < pts[i - 1];
        return (
          <g key={i}>
            <path d={`M${x} ${y - 30}v80`} stroke="var(--moon)" strokeOpacity="0.3" />
            <rect x={x - 8} y={y - (up ? 18 : 6)} width="16" height="30" fill="none" stroke={up ? "var(--signal)" : "var(--moon)"} strokeOpacity={up ? 0.65 : 0.35} />
          </g>
        );
      })}
      <path d={`M110 ${pts[0]}${pts.map((y, i) => `L${110 + i * 52} ${y}`).join("")}`} fill="none" stroke="var(--moon)" strokeOpacity="0.3" strokeDasharray="4 6" />
    </g>
  );
}

export const SCENES: Record<string, () => ReactNode> = {
  food_beverage: FoodBeverage, retail: Retail, manufacturing: Manufacturing, technology: Technology,
  agriculture: Agriculture, services: Services, finance: Finance,
};

export function Scene({ name }: { name: string }) {
  const S = SCENES[name];
  if (!S) return null;
  return (
    <svg viewBox={`0 0 ${W} 420`} preserveAspectRatio="xMidYMax slice" className="h-full w-full" aria-hidden="true" fill="none" strokeWidth="1.2">
      <Ground />
      <S />
    </svg>
  );
}
