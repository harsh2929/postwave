// SPDX-License-Identifier: AGPL-3.0-only
"use client";

//
// CountUp — animates a number toward its target on first paint and whenever the
// value changes (e.g. the 60s stats refresh / SSE update), instead of a hard
// snap (ANL-037). Uses requestAnimationFrame with an ease-out curve. Respects
// `prefers-reduced-motion` (jumps straight to the value) and is SSR-safe (emits
// the final value on the server + first client render, animating only after
// mount, so there's no hydration mismatch).

import { useEffect, useRef, useState } from "react";

/** Ease-out cubic — fast start, gentle settle. Clamps t to [0,1]. */
export function easeOutCubic(t: number): number {
  const c = Math.min(1, Math.max(0, t));
  return 1 - (1 - c) ** 3;
}

/** Interpolate an integer between from→to at eased progress t∈[0,1]. */
export function interpolateCount(from: number, to: number, t: number): number {
  return Math.round(from + (to - from) * easeOutCubic(t));
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

export function CountUp({
  value,
  durationMs = 650,
  className,
  format = (n) => n.toLocaleString(),
}: {
  value: number;
  durationMs?: number;
  className?: string;
  format?: (n: number) => string;
}) {
  // Start displaying the true value so SSR and the first client render agree;
  // the animation kicks in only after mount / on subsequent value changes.
  const [display, setDisplay] = useState(value);
  const fromRef = useRef(value);
  const rafRef = useRef<number | null>(null);
  const mountedRef = useRef(false);

  useEffect(() => {
    const target = Number.isFinite(value) ? value : 0;

    // First mount: animate up from zero for the entrance count-up; later
    // changes tween from the previously displayed value.
    const from = mountedRef.current ? fromRef.current : 0;
    mountedRef.current = true;

    if (prefersReducedMotion() || from === target || durationMs <= 0) {
      fromRef.current = target;
      setDisplay(target);
      return;
    }

    const start = performance.now();
    const tick = (now: number) => {
      const t = (now - start) / durationMs;
      if (t >= 1) {
        fromRef.current = target;
        setDisplay(target);
        rafRef.current = null;
        return;
      }
      setDisplay(interpolateCount(from, target, t));
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);

    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [value, durationMs]);

  return (
    <span className={className} data-testid="count-up">
      {format(display)}
    </span>
  );
}
