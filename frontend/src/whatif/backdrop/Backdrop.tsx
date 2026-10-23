// Reusable background system (Ascend deep-space theme). Pick a context (what the page is for) and,
// optionally, the business industry and the scenario being simulated; the layers follow from those.
//
//   landing     the WebGL planet with Ascend's scroll choreography (zoom out, swing, turn) + float-up entrance
//   app         the planet held low as a horizon behind work pages (dashboards, setup, settings)
//   simulation  planet horizon + analytical grid; a scan line runs only while a calculation is running
//   risk        planet horizon + grid with a warmer glow
//   report      plain (printing removes all backdrop layers)
//
// Industry scenes are faint line art along the bottom edge (Scenes.tsx). A scenario that commits money
// (investment, new location) switches the scene to "finance". To use your own photography, add files to
// public/backgrounds/ and list them in PHOTOS; they are shown under a dark overlay.
// Without WebGL (or if the planet assets cannot be loaded) the deep-space gradient remains.

import { useEffect, useRef, useState } from "react";
import { useReduced } from "../../lib/hooks";
import { Scene } from "./Scenes";
import type { PlanetMode, PlanetScene } from "./planet";
import type { Industry, Levers } from "../types";

export type BackdropContext = "landing" | "app" | "simulation" | "risk" | "report";

/** Optional photos per scene key, e.g. { food_beverage: "/backgrounds/food_beverage.jpg" }. Empty by default. */
export const PHOTOS: Partial<Record<string, string>> = {};

export function sceneFor(industry?: Industry | string | null, levers?: Levers | null): string | null {
  if (levers && (levers.one_time_investment || levers.new_branch)) return "finance";
  return industry ?? null;
}

export function Backdrop({ context, industry, levers, active = false }: {
  context: BackdropContext; industry?: Industry | string | null; levers?: Levers | null; active?: boolean;
}) {
  const scene = context === "report" ? null : sceneFor(industry, levers);
  const photo = scene ? PHOTOS[scene] : undefined;
  const planetMode: PlanetMode | null = context === "report" ? null : context === "landing" ? "landing" : "app";
  return (
    <div className="backdrop pointer-events-none fixed inset-0 -z-10 overflow-hidden" aria-hidden="true" data-context={context} data-scene={scene ?? "none"}>
      <div className="absolute inset-0" style={{ background: BASE[context] }} />
      {planetMode && <Planet mode={planetMode} />}
      {photo && (
        <div className="absolute inset-0" style={{ backgroundImage: `url(${photo})`, backgroundSize: "cover", backgroundPosition: "center bottom", opacity: 0.16, filter: "grayscale(0.6)" }} />
      )}
      {(context === "simulation" || context === "risk") && <Grid active={active} warm={context === "risk"} />}
      {scene && context !== "landing" && (
        <div className="absolute inset-x-0 bottom-0 h-[34vh] max-h-[360px] min-h-[180px]"
          style={{ opacity: 0.18, maskImage: "linear-gradient(to top, transparent 0%, #000 35%, #000 70%, transparent 100%)", WebkitMaskImage: "linear-gradient(to top, transparent 0%, #000 35%, #000 70%, transparent 100%)" }}>
          <Scene name={scene} key={scene} />
        </div>
      )}
      {/* Ascend top scrim: nav and titles stay legible while the planet reads through below */}
      <div className="absolute inset-0" style={{ background: context === "landing"
        ? "radial-gradient(125% 62% at 50% -10%, rgba(4,6,15,.82) 0%, rgba(4,6,15,.28) 44%, transparent 68%)"
        : "linear-gradient(to bottom, rgba(4,6,15,.78) 0%, rgba(4,6,15,.55) 45%, rgba(4,6,15,.15) 100%)" }} />
    </div>
  );
}

const BASE: Record<BackdropContext, string> = {
  landing: "radial-gradient(90% 60% at 50% 110%, rgba(58,108,255,.22) 0%, transparent 60%), #04060f",
  app: "radial-gradient(90% 55% at 60% 115%, rgba(58,108,255,.16) 0%, transparent 60%), #04060f",
  simulation: "radial-gradient(90% 55% at 60% 115%, rgba(58,108,255,.16) 0%, transparent 60%), #04060f",
  risk: "radial-gradient(90% 55% at 60% 115%, rgba(210,115,58,.12) 0%, transparent 60%), #04060f",
  report: "#04060f",
};

/** The fixed WebGL planet. One renderer per mounted backdrop; the GLTF assets are shared. */
function Planet({ mode }: { mode: PlanetMode }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const sceneRef = useRef<PlanetScene | null>(null);
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const reduced = useReduced();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    let s: PlanetScene | null = null;
    let cancelled = false;
    // three.js loads in its own chunk after first paint, so page content never waits for it.
    import("./planet").then(({ PlanetScene, webglAvailable }) => {
      if (cancelled) return;
      if (!webglAvailable()) { setFailed(true); return; }
      try {
        // Work pages run at a lower pixel ratio so charts and tables stay responsive.
        s = new PlanetScene(c, modeRef.current, reduced, modeRef.current === "landing" ? 2 : 1.25);
        s.start();
        sceneRef.current = s;
      } catch (e) {
        console.warn("WebGL planet unavailable", e);
        setFailed(true);
      }
    }).catch(() => setFailed(true));
    return () => { cancelled = true; s?.dispose(); sceneRef.current = null; };
    // Mode changes are applied without rebuilding the scene (below).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reduced]);
  useEffect(() => { sceneRef.current?.setMode(mode); }, [mode]);
  if (failed) return null;
  // Work pages dim the planet so figures and headings stay easy to read; the landing shows it in full.
  return <canvas ref={ref} className="planet-canvas absolute inset-0 block h-full w-full" style={{ opacity: mode === "landing" ? 1 : 0.5 }} />;
}

function Grid({ active, warm }: { active: boolean; warm: boolean }) {
  const reduced = useReduced();
  return (
    <div className="absolute inset-0">
      <svg className="absolute inset-0 h-full w-full" aria-hidden="true">
        <defs>
          <pattern id="wi-grid" width="64" height="64" patternUnits="userSpaceOnUse">
            <path d="M64 0H0V64" fill="none" stroke="rgba(150,175,230,.05)" strokeDasharray="2 4" />
          </pattern>
        </defs>
        <rect width="100%" height="100%" fill="url(#wi-grid)" />
      </svg>
      {active && !reduced && (
        <div className="absolute inset-y-0 w-[30vw]" style={{ background: `linear-gradient(90deg, transparent, ${warm ? "rgba(240,138,93,.06)" : "rgba(93,240,168,.06)"}, transparent)`, animation: "scan 1.6s linear infinite" }} />
      )}
      <style>{"@keyframes scan { from { transform: translateX(-30vw) } to { transform: translateX(100vw) } }"}</style>
    </div>
  );
}
