// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { motion, useInView, useReducedMotion, useSpring } from "motion/react";
import { useEffect, useRef, useState, type ReactNode } from "react";

export function TerminalTypeOn({
  lines,
  charDelayMs = 18,
  lineDelayMs = 320,
  className,
  label,
}: {
  lines: string[];
  charDelayMs?: number;
  lineDelayMs?: number;
  className?: string;
  /**
   * Accessible name for the transcript. Callers scroll this element
   * horizontally, and it holds nothing focusable, so it has to take focus
   * itself or a keyboard user cannot scroll it (WCAG 2.1.1). The a11y
   * attributes live here rather than on the call site because the scrolling
   * element is this div — passing tabIndex to the component did not compile,
   * which is how the mismatch surfaced.
   */
  label?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { once: true, amount: 0.4 });
  return (
    <div
      ref={ref}
      tabIndex={0}
      role="group"
      aria-label={label ?? "Terminal transcript"}
      className={`${className ?? ""} focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pw-ember-500`}
    >
      {lines.map((line, i) => (
        <TypeLine
          key={i}
          line={line}
          delayMs={i * lineDelayMs}
          charDelayMs={charDelayMs}
          active={inView}
        />
      ))}
    </div>
  );
}

function TypeLine({
  line,
  delayMs,
  charDelayMs,
  active,
}: {
  line: string;
  delayMs: number;
  charDelayMs: number;
  active: boolean;
}) {
  const [shown, setShown] = useState(0);
  const reduceMotion = useReducedMotion();
  useEffect(() => {
    if (!active) return;
    if (reduceMotion) {
      setShown(line.length);
      return;
    }
    setShown(0);
    let id: ReturnType<typeof setInterval> | null = null;
    const t = setTimeout(() => {
      let i = 0;
      id = setInterval(() => {
        i += 1;
        setShown(i);
        if (i >= line.length && id !== null) clearInterval(id);
      }, charDelayMs);
    }, delayMs);
    return () => {
      clearTimeout(t);
      if (id !== null) clearInterval(id);
    };
  }, [active, charDelayMs, delayMs, line.length, reduceMotion]);
  return (
    <div className="whitespace-pre">{line.slice(0, shown) || "\u00A0"}</div>
  );
}

export function StaggerGrid({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <motion.div
      initial="hidden"
      whileInView="show"
      viewport={{ once: true, amount: 0.15 }}
      variants={{
        hidden: {},
        show: { transition: { staggerChildren: 0.07, delayChildren: 0.05 } },
      }}
      className={className}
    >
      {children}
    </motion.div>
  );
}

export function StaggerItem({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <motion.div
      variants={{
        hidden: { opacity: 0, y: 14 },
        show: { opacity: 1, y: 0 },
      }}
      transition={{ duration: 0.45, ease: [0.16, 1, 0.3, 1] }}
      className={`motion-reduce:!translate-y-0 motion-reduce:!opacity-100 ${className ?? ""}`}
    >
      {children}
    </motion.div>
  );
}

export function CountUp({
  value,
  className,
}: {
  value: number;
  className?: string;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const inView = useInView(ref, { once: true, amount: 0.6 });
  const [n, setN] = useState(0);
  const reduceMotion = useReducedMotion();
  const spring = useSpring(0, { stiffness: 60, damping: 15 });
  useEffect(() => {
    if (!inView) return;
    if (reduceMotion) {
      setN(value);
      return;
    }
    spring.set(value);
    const unsub = spring.on("change", (v) => setN(Math.round(v)));
    return () => unsub();
  }, [inView, reduceMotion, value, spring]);
  return (
    <span ref={ref} className={`tabular-nums ${className ?? ""}`}>
      {n}
    </span>
  );
}
