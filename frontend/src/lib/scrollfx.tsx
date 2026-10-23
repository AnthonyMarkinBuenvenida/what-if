// Ascend motion: Lenis smooth scroll and the staggered [data-reveal] fade-up, set up once for the app.
// Both are skipped under prefers-reduced-motion (reveal targets are shown immediately).
import { useEffect } from "react";
import { useLocation } from "react-router-dom";
import Lenis from "lenis";

let lenis: Lenis | null = null;

const reducedMotion = () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export function getLenis() {
  return lenis;
}

/** Scroll to the top (or any y) through Lenis when it is running, natively otherwise. */
export function scrollToY(y: number) {
  if (lenis) lenis.scrollTo(y, { immediate: true, force: true });
  else window.scrollTo(0, y);
}

export function SmoothScroll() {
  useEffect(() => {
    if (reducedMotion()) return;
    const l = new Lenis({ duration: 1.15, smoothWheel: true, touchMultiplier: 1.5, anchors: true, allowNestedScroll: true });
    lenis = l;
    let raf = 0;
    const loop = (t: number) => { l.raf(t); raf = requestAnimationFrame(loop); };
    raf = requestAnimationFrame(loop);
    return () => { cancelAnimationFrame(raf); l.destroy(); lenis = null; };
  }, []);
  return null;
}

/** Adds .in to every [data-reveal] once it enters the viewport; new elements are picked up as pages render. */
export function RevealObserver() {
  const { pathname } = useLocation();
  useEffect(() => {
    const reveal = (el: Element) => el.classList.add("in");
    if (reducedMotion() || !("IntersectionObserver" in window)) {
      const all = () => document.querySelectorAll("[data-reveal]:not(.in)").forEach(reveal);
      all();
      const mo = new MutationObserver(all);
      mo.observe(document.body, { childList: true, subtree: true });
      return () => mo.disconnect();
    }
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (e.isIntersecting) { reveal(e.target); io.unobserve(e.target); }
      }
    }, { threshold: 0.18, rootMargin: "0px 0px -8% 0px" });
    const seen = new WeakSet<Element>();
    const scan = () => document.querySelectorAll("[data-reveal]:not(.in)").forEach((el) => {
      if (!seen.has(el)) { seen.add(el); io.observe(el); }
    });
    scan();
    const mo = new MutationObserver(scan);
    mo.observe(document.body, { childList: true, subtree: true });
    return () => { io.disconnect(); mo.disconnect(); };
  }, [pathname]);
  return null;
}

/** Inline style for a reveal delay, e.g. <div data-reveal style={rd(180)}>. */
export const rd = (ms: number) => ({ ["--rd" as string]: `${ms}ms` });
