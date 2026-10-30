// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { motion } from "@postwave/design-tokens";

import styles from "./overlay.module.css";
import { TourTooltip } from "./TourTooltip";
import { useTour } from "./TourProvider";
import type { TourStep } from "./types";

interface TargetRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

const TARGET_PAD = 8;
const TARGET_RETRY_MS = 100;
const TARGET_POLL_MS = 250;
const TARGET_MISSING_GRACE_MS = 1_200;

function isUsableTarget(element: HTMLElement): boolean {
  if (
    !element.isConnected ||
    element.closest("[hidden], [inert], [aria-hidden='true']")
  ) {
    return false;
  }
  const style = window.getComputedStyle(element);
  if (style.display === "none" || style.visibility === "hidden") return false;
  const rect = element.getBoundingClientRect();
  return rect.width > 0 || rect.height > 0;
}

function resolveTarget(target: string | undefined): HTMLElement | null {
  if (!target) return null;
  if (typeof document === "undefined") return null;
  const byData = Array.from(
    document.querySelectorAll<HTMLElement>(
      `[data-tour="${CSS.escape(target)}"]`,
    ),
  ).find(isUsableTarget);
  if (byData) return byData;
  // Fallback: treat as raw selector (allows e.g. "#hero" or "h1").
  try {
    return (
      Array.from(document.querySelectorAll<HTMLElement>(target)).find(
        isUsableTarget,
      ) ?? null
    );
  } catch {
    return null;
  }
}

function measure(el: HTMLElement): TargetRect {
  const rect = el.getBoundingClientRect();
  return {
    top: rect.top - TARGET_PAD,
    left: rect.left - TARGET_PAD,
    width: rect.width + TARGET_PAD * 2,
    height: rect.height + TARGET_PAD * 2,
  };
}

function sameRect(left: TargetRect | null, right: TargetRect): boolean {
  return (
    left !== null &&
    left.top === right.top &&
    left.left === right.left &&
    left.width === right.width &&
    left.height === right.height
  );
}

// An even-odd clip removes the rounded target from BOTH the tint and blur.
// Drawing just a ring above a full-screen backdrop still obscures the target.
function spotlightClip(
  rect: TargetRect,
  viewport: { width: number; height: number },
): string {
  const { left: x, top: y, width, height } = rect;
  const right = x + width;
  const bottom = y + height;
  const radius = Math.min(motion.spotlight.radius, width / 2, height / 2);
  const outer = `M 0 0 H ${viewport.width} V ${viewport.height} H 0 Z`;
  const cutout = `M ${x + radius} ${y} H ${right - radius} A ${radius} ${radius} 0 0 1 ${right} ${y + radius} V ${bottom - radius} A ${radius} ${radius} 0 0 1 ${right - radius} ${bottom} H ${x + radius} A ${radius} ${radius} 0 0 1 ${x} ${bottom - radius} V ${y + radius} A ${radius} ${radius} 0 0 1 ${x + radius} ${y} Z`;
  return `path(evenodd, "${outer} ${cutout}")`;
}

function prefersReducedMotion(): boolean {
  return (
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

function logMissing(target: string): void {
  if (typeof window === "undefined") return;
  if (process.env.NODE_ENV === "production") return;
  console.warn(`[tour] target "${target}" not found, advancing.`);
}

/** Convert a `#rgb`/`#rrggbb` hex to an `rgba(r, g, b, a)` string. */
function hexToRgba(hex: string, alpha: number): string {
  const h = hex.replace("#", "");
  const full =
    h.length === 3
      ? h
          .split("")
          .map((c) => c + c)
          .join("")
      : h;
  const int = parseInt(full, 16);
  if (Number.isNaN(int)) return `rgba(200, 16, 46, ${alpha})`;
  const r = (int >> 16) & 255;
  const g = (int >> 8) & 255;
  const b = int & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/**
 * Build the CSS custom properties consumed by overlay.module.css from the
 * shared `motion` design tokens. Dark-aware: matches the tooltip's
 * `html.dark` behavior by picking the dark accent when the app theme class is
 * present (next-themes drives `html.dark` on the dashboard).
 */
function buildTokenVars(): React.CSSProperties {
  const isDark =
    typeof document !== "undefined" &&
    document.documentElement.classList.contains("dark");
  const accent = isDark
    ? motion.spotlight.accentDark
    : motion.spotlight.accentLight;
  return {
    ["--pw-spot-accent" as string]: accent,
    ["--pw-spot-accent-glow" as string]: hexToRgba(accent, 0.18),
    ["--pw-spot-accent-glow-soft" as string]: hexToRgba(accent, 0.08),
    ["--pw-spot-ring-width" as string]: `${motion.spotlight.ringWidth}px`,
    ["--pw-spot-ring-blur" as string]: `${motion.spotlight.ringBlur}px`,
    ["--pw-spot-ring-glow" as string]: `${motion.spotlight.ringGlow}px`,
    ["--pw-spot-radius" as string]: `${motion.spotlight.radius}px`,
    ["--pw-backdrop-tint-light" as string]: hexToRgba(
      motion.backdrop.frosted.colorLight,
      motion.backdrop.frosted.opacity,
    ),
    ["--pw-backdrop-tint-dark" as string]: hexToRgba(
      motion.backdrop.frosted.colorDark,
      motion.backdrop.frosted.opacity,
    ),
    ["--pw-backdrop-blur" as string]: `${motion.backdrop.frosted.blur}px`,
    ["--pw-backdrop-saturation" as string]: String(
      motion.backdrop.frosted.saturation,
    ),
    ["--pw-travel-ms" as string]: `${motion.durations.spotlightTravelMs}ms`,
    ["--pw-tooltip-ms" as string]: `${motion.durations.tooltipEnterMs}ms`,
    ["--pw-pulse-ms" as string]: `${motion.durations.pulseMs}ms`,
    ["--pw-exit-ms" as string]: `${motion.durations.exitMs}ms`,
    ["--pw-ring-fill-ms" as string]: `${motion.durations.ringFillMs}ms`,
    ["--pw-ease-standard" as string]: motion.easing.standard.css,
    ["--pw-ease-decelerate" as string]: motion.easing.decelerate.css,
    ["--pw-ease-accelerate" as string]: motion.easing.accelerate.css,
    ["--pw-ease-spring" as string]: motion.easing.spring.css,
  } as React.CSSProperties;
}

export function TourOverlay(): JSX.Element | null {
  const { state, steps, next, skipStep, back, skip, complete } = useTour();
  const [rect, setRect] = useState<TargetRect | null>(null);
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const [resolved, setResolved] = useState(false);
  const [showConfetti, setShowConfetti] = useState(false);
  const [mounted, setMounted] = useState(false);
  const resolvedRef = useRef(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  const step: TourStep | undefined = steps[state.stepIndex];

  // Resolve the current target and keep following it for the whole step.
  //
  // A one-shot query + resize listener is not enough in a routed React app:
  // the old route can unmount after the target was measured, responsive
  // disclosures can swap a hidden desktop anchor for a visible mobile one,
  // and async cards can replace their skeleton without a window resize. Keep a
  // small poll plus DOM/size observers while the tour is open, with a grace
  // window so transient route layouts do not auto-skip a step. Once a tooltip
  // has been shown, keep it centred while its anchor is changing instead of
  // unmounting the focused dialog and leaving a bare modal scrim.
  useEffect(() => {
    if (!step) return;
    const currentStep = step;
    let cancelled = false;
    let timer: number | null = null;
    let refreshFrame: number | null = null;
    let missingSince: number | null = null;
    let targetElement: HTMLElement | null = null;
    let scrolledElement: HTMLElement | null = null;
    let didLogMissing = false;
    let didSkip = false;
    const readyAt = performance.now() + (currentStep.navigateDelayMs ?? 60);
    const resizeObserver =
      typeof ResizeObserver === "function"
        ? new ResizeObserver(() => scheduleRefresh())
        : null;

    function revealTooltip(): void {
      resolvedRef.current = true;
      setResolved(true);
    }

    function schedule(delay: number): void {
      if (cancelled) return;
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(resolveNow, delay);
    }

    function detachTarget(): void {
      if (targetElement) resizeObserver?.unobserve(targetElement);
      targetElement = null;
    }

    function resolveNow(): void {
      if (cancelled || didSkip) return;
      setViewport((previous) =>
        previous.width === window.innerWidth &&
        previous.height === window.innerHeight
          ? previous
          : { width: window.innerWidth, height: window.innerHeight },
      );
      if (timer !== null) {
        window.clearTimeout(timer);
        timer = null;
      }
      const untilReady = readyAt - performance.now();
      if (untilReady > 0) {
        schedule(untilReady);
        return;
      }

      // A cold Next.js route can take longer than the missing-target grace
      // period. Keep the dialog available while navigation loads; never skip
      // a destination's explanation just because its page has not mounted.
      if (currentStep.route && window.location.pathname !== currentStep.route) {
        detachTarget();
        setRect(null);
        missingSince = null;
        revealTooltip();
        schedule(TARGET_RETRY_MS);
        return;
      }

      const element = resolveTarget(currentStep.target);
      if (element) {
        missingSince = null;
        didLogMissing = false;
        if (targetElement !== element) {
          detachTarget();
          targetElement = element;
          resizeObserver?.observe(element);
        }
        const nextRect = measure(element);
        setRect((previous) =>
          sameRect(previous, nextRect) ? previous : nextRect,
        );
        revealTooltip();
        if (scrolledElement !== element) {
          scrolledElement = element;
          element.scrollIntoView({
            behavior: prefersReducedMotion() ? "auto" : "smooth",
            block:
              nextRect.height > window.innerHeight * 0.75 ? "start" : "center",
          });
        }
        schedule(TARGET_POLL_MS);
        return;
      }

      const targetWasPresent = targetElement !== null;
      detachTarget();
      setRect(null);
      if (!currentStep.target) {
        revealTooltip();
        return;
      }
      // Preserve an already-open dialog while a route or responsive layout is
      // replacing its anchor. Required steps are also useful without a
      // spotlight, so show them centred from the start.
      if (resolvedRef.current || !currentStep.skipIfMissing) revealTooltip();
      if (missingSince === null || targetWasPresent) {
        missingSince = performance.now();
      }
      const missingFor = performance.now() - missingSince;
      if (missingFor >= TARGET_MISSING_GRACE_MS) {
        if (!didLogMissing) {
          didLogMissing = true;
          logMissing(currentStep.target);
        }
        if (currentStep.skipIfMissing) {
          didSkip = true;
          skipStep();
        }
        // Required steps remain usable in the centre. A later DOM mutation can
        // still attach the spotlight, but there is no reason to poll forever.
        return;
      }
      schedule(Math.min(TARGET_RETRY_MS, TARGET_MISSING_GRACE_MS - missingFor));
    }

    setRect(null);
    if (!currentStep.target || !currentStep.skipIfMissing) revealTooltip();
    schedule(Math.max(0, readyAt - performance.now()));

    function scheduleRefresh(): void {
      if (cancelled || refreshFrame !== null) return;
      refreshFrame = window.requestAnimationFrame(() => {
        refreshFrame = null;
        resolveNow();
      });
    }

    const mutationObserver = new MutationObserver(scheduleRefresh);
    mutationObserver.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["aria-hidden", "class", "data-tour", "hidden", "style"],
    });
    window.addEventListener("resize", scheduleRefresh);
    window.addEventListener("scroll", scheduleRefresh, true);

    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
      if (refreshFrame !== null) window.cancelAnimationFrame(refreshFrame);
      detachTarget();
      resizeObserver?.disconnect();
      mutationObserver.disconnect();
      window.removeEventListener("resize", scheduleRefresh);
      window.removeEventListener("scroll", scheduleRefresh, true);
    };
  }, [step, skipStep]);

  // Trigger confetti on celebrate steps.
  useEffect(() => {
    if (!step?.celebrate) return;
    setShowConfetti(true);
    const t = window.setTimeout(() => setShowConfetti(false), 1400);
    return () => window.clearTimeout(t);
  }, [step]);

  // Keyboard handling.
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (!state.isOpen || e.defaultPrevented || e.repeat) return;
      if (e.key === "Escape") {
        e.preventDefault();
        skip();
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        if (state.stepIndex >= steps.length - 1) {
          complete();
        } else {
          next();
        }
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        back();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [state.isOpen, state.stepIndex, steps.length, next, back, skip, complete]);

  if (!mounted || !step || typeof document === "undefined") return null;

  const isLast = state.stepIndex >= steps.length - 1;

  const overlay = (
    <div
      className={styles.root}
      style={buildTokenVars()}
      aria-hidden={false}
      data-testid="tour-overlay"
    >
      <div
        className={styles.dismissLayer}
        onClick={() => skip()}
        role="presentation"
      />
      <div
        className={styles.backdrop}
        data-testid="tour-backdrop"
        style={rect ? { clipPath: spotlightClip(rect, viewport) } : undefined}
        aria-hidden="true"
      />
      {rect ? (
        <div
          className={styles.spotlightOutline}
          data-testid="tour-spotlight"
          style={{
            top: rect.top,
            left: rect.left,
            width: rect.width,
            height: rect.height,
          }}
          aria-hidden="true"
        />
      ) : null}
      {resolved ? (
        <TourTooltip
          step={step}
          stepIndex={state.stepIndex}
          totalSteps={steps.length}
          rect={rect}
          isLast={isLast}
          onNext={() => (isLast ? complete() : next())}
          onBack={back}
          onSkip={skip}
        />
      ) : null}
      {showConfetti ? <ConfettiBurst /> : null}
    </div>
  );

  return createPortal(overlay, document.body);
}

function ConfettiBurst(): JSX.Element {
  const pieces = Array.from({ length: motion.confetti.count }, (_, i) => i);
  const isDark =
    typeof document !== "undefined" &&
    document.documentElement.classList.contains("dark");
  const colors = isDark
    ? motion.confetti.paletteDark
    : motion.confetti.paletteLight;
  return (
    <div className={styles.confettiLayer} aria-hidden="true">
      {pieces.map((i) => {
        const angle = (i / pieces.length) * Math.PI * 2;
        const distance = 140 + Math.random() * 120;
        const x = Math.cos(angle) * distance;
        const y = Math.sin(angle) * distance;
        const rot = (Math.random() * 720 - 360).toFixed(0);
        const color = colors[i % colors.length];
        const delay = (Math.random() * 80).toFixed(0);
        const duration = 900 + Math.random() * 400;
        return (
          <span
            key={i}
            className={styles.confetti}
            style={
              {
                background: color,
                animation: `tour-confetti-fly ${duration}ms cubic-bezier(0.22, 1, 0.36, 1) ${delay}ms forwards`,
                ["--pw-confetti-x" as string]: `${x}px`,
                ["--pw-confetti-y" as string]: `${y}px`,
                ["--pw-confetti-r" as string]: `${rot}deg`,
              } as React.CSSProperties
            }
          />
        );
      })}
    </div>
  );
}
