"use client";

// SPDX-License-Identifier: AGPL-3.0-only
//
// CountUp — animates a whole number up to its value on hydration. The server
// renders the real value as the initial state, so with JS off (or before
// hydration, or for a crawler) the true number is always shown — the count-up
// is pure enhancement, never load-bearing. Honours prefers-reduced-motion.

import { useEffect, useRef, useState } from "react";

const DURATION = 460;

export default function CountUp({
  value,
  className,
}: {
  value: number;
  className?: string;
}) {
  // Initial = value so SSR and the first client render agree (no hydration
  // mismatch) and no-JS shows the truth.
  const [display, setDisplay] = useState(value);
  const done = useRef(false);

  useEffect(() => {
    if (done.current) {
      setDisplay(value);
      return;
    }
    done.current = true;

    const reduce =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reduce || value <= 0) {
      setDisplay(value);
      return;
    }

    let raf = 0;
    let start = 0;
    const from = 0;
    const step = (t: number) => {
      if (!start) start = t;
      const p = Math.min(1, (t - start) / DURATION);
      // easeOutCubic
      const eased = 1 - Math.pow(1 - p, 3);
      setDisplay(Math.round(from + (value - from) * eased));
      if (p < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [value]);

  return (
    <span className={className} aria-label={String(value)}>
      {display}
    </span>
  );
}
