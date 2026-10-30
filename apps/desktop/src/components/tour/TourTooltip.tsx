/**
 * TourTooltip — the animated card that pins next to the spotlit target.
 *
 * Placement strategy:
 *   - Explicit `placement` is honoured when there's room.
 *   - `auto` (or any side that would push off-screen) re-evaluates and
 *     picks the side with the most viewport space.
 *   - Centered-modal mode (rect == null) renders mid-screen with a
 *     gentle scale-in.
 *
 * Accessibility:
 *   - Centered steps are isolated modal dialogs; anchored steps remain
 *     non-modal so the highlighted target stays operable.
 *   - Focus is scoped across the dialog actions and highlighted target,
 *     with the primary action focused whenever the step changes.
 *   - Reduced-motion path drops scale + transform animations.
 *
 * Confetti (final step): 24 small CSS-animated particles scatter outward
 * unless reduced motion is requested. Completion is always explicit so a
 * timed animation can never dismiss content before it is read.
 */

import {
  type CSSProperties,
  type ReactElement,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { useDialogStack } from "../../hooks/useDialogStack";
import { usePrefersReducedMotion } from "../../hooks/usePrefersReducedMotion";
import {
  isolateDialogBackground,
  lockDocumentBodyScroll,
} from "../../lib/dialog-accessibility";
import { popDialog, pushDialog } from "../../lib/dialogStack";
import { motion } from "./motion-tokens";
import type { TooltipPlacement, TourStep } from "./types";

interface TooltipProps {
  step: TourStep;
  stepIndex: number;
  totalSteps: number;
  rect: DOMRect | null;
  target: HTMLElement | null;
  targetUnavailable: boolean;
  ownerId: string;
  onNext: () => void;
  onBack: () => void;
  onSkip: () => void;
  onComplete: () => void;
}

const FALLBACK_TOOLTIP_W = 320;
const FALLBACK_TOOLTIP_H = 180;
const TOOLTIP_GAP = 14; // distance from spotlight edge

interface ViewportBounds {
  height: number;
  left: number;
  top: number;
  width: number;
}

interface TooltipSize {
  height: number;
  width: number;
}

interface MeasuredPosition {
  key: string;
  left: number;
  top: number;
}

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

function viewportBounds(): ViewportBounds {
  const visual = window.visualViewport;
  return {
    height: Math.max(0, visual?.height ?? window.innerHeight),
    left: Math.max(0, visual?.offsetLeft ?? 0),
    top: Math.max(0, visual?.offsetTop ?? 0),
    width: Math.max(0, visual?.width ?? window.innerWidth),
  };
}

/** Pick the side with the most viewport space when `auto` is requested
 *  or the explicit side wouldn't fit. */
function pickPlacement(
  rect: DOMRect,
  preferred: TooltipPlacement,
  viewport: ViewportBounds,
  size: TooltipSize,
): Exclude<TooltipPlacement, "auto"> {
  const space = {
    top: rect.top - viewport.top,
    bottom: viewport.top + viewport.height - rect.bottom,
    left: rect.left - viewport.left,
    right: viewport.left + viewport.width - rect.right,
  };

  const fits = (side: keyof typeof space): boolean => {
    if (side === "top") return space.top >= size.height + TOOLTIP_GAP;
    if (side === "bottom") return space.bottom >= size.height + TOOLTIP_GAP;
    if (side === "left") return space.left >= size.width + TOOLTIP_GAP;
    return space.right >= size.width + TOOLTIP_GAP;
  };

  if (preferred !== "auto" && fits(preferred)) return preferred;

  // Fallback: pick the side with the most absolute room.
  const order: Array<keyof typeof space> = ["bottom", "right", "top", "left"];
  let best: keyof typeof space = order[0]!;
  let bestSpace = -1;
  for (const side of order) {
    if (space[side] > bestSpace) {
      bestSpace = space[side];
      best = side;
    }
  }
  return best;
}

/** Compute fixed-position coordinates for the tooltip given a side. */
function placeTooltip(
  rect: DOMRect,
  side: Exclude<TooltipPlacement, "auto">,
  viewport: ViewportBounds,
  size: TooltipSize,
): { left: number; top: number } {
  let left = 0;
  let top = 0;
  if (side === "top") {
    top = rect.top - size.height - TOOLTIP_GAP;
    left = rect.left + rect.width / 2 - size.width / 2;
  } else if (side === "bottom") {
    top = rect.bottom + TOOLTIP_GAP;
    left = rect.left + rect.width / 2 - size.width / 2;
  } else if (side === "left") {
    left = rect.left - size.width - TOOLTIP_GAP;
    top = rect.top + rect.height / 2 - size.height / 2;
  } else {
    left = rect.right + TOOLTIP_GAP;
    top = rect.top + rect.height / 2 - size.height / 2;
  }
  // Clamp to viewport with an 8px margin so the tooltip doesn't kiss
  // the edge.
  const margin = 8;
  const minimumLeft = viewport.left + margin;
  const minimumTop = viewport.top + margin;
  const maximumLeft = Math.max(
    minimumLeft,
    viewport.left + viewport.width - size.width - margin,
  );
  const maximumTop = Math.max(
    minimumTop,
    viewport.top + viewport.height - size.height - margin,
  );
  left = Math.max(minimumLeft, Math.min(left, maximumLeft));
  top = Math.max(minimumTop, Math.min(top, maximumTop));
  return { left, top };
}

function focusableElements(root: HTMLElement): HTMLElement[] {
  const candidates = [
    ...(root.matches(FOCUSABLE_SELECTOR) ? [root] : []),
    ...root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
  ];
  return candidates.filter(
    (element) =>
      !element.hidden &&
      !element.closest('[aria-hidden="true"], [inert]') &&
      element.getAttribute("aria-disabled") !== "true",
  );
}

export function TourTooltip({
  step,
  stepIndex,
  totalSteps,
  rect,
  target,
  targetUnavailable,
  ownerId,
  onNext,
  onBack,
  onSkip,
  onComplete,
}: TooltipProps): ReactElement {
  const titleId = useId();
  const descId = useId();
  const availabilityId = useId();
  const cardRef = useRef<HTMLDivElement | null>(null);
  const primaryRef = useRef<HTMLButtonElement | null>(null);
  const [measuredPosition, setMeasuredPosition] =
    useState<MeasuredPosition | null>(null);
  const reducedMotion = usePrefersReducedMotion();
  const { isTop } = useDialogStack(ownerId);
  const isCentered = !rect;
  const positionKey = rect
    ? [
        step.id,
        rect.left,
        rect.top,
        rect.right,
        rect.bottom,
        rect.width,
        rect.height,
      ].join(":")
    : "center";

  useLayoutEffect(() => {
    if (!rect || !cardRef.current) {
      setMeasuredPosition(null);
      return;
    }
    const card = cardRef.current;
    let frame = 0;
    let scheduled = false;
    const measure = (): void => {
      const viewport = viewportBounds();
      const bounds = card.getBoundingClientRect();
      const size = {
        width:
          card.offsetWidth ||
          bounds.width ||
          Math.min(FALLBACK_TOOLTIP_W, Math.max(0, viewport.width - 16)),
        height:
          card.offsetHeight ||
          bounds.height ||
          Math.min(FALLBACK_TOOLTIP_H, Math.max(0, viewport.height - 16)),
      };
      const side = pickPlacement(
        rect,
        step.placement ?? "auto",
        viewport,
        size,
      );
      const next = placeTooltip(rect, side, viewport, size);
      setMeasuredPosition((current) =>
        current?.key === positionKey &&
        current.left === next.left &&
        current.top === next.top
          ? current
          : { key: positionKey, ...next },
      );
    };
    const schedule = (): void => {
      if (scheduled) return;
      scheduled = true;
      frame = window.requestAnimationFrame(() => {
        scheduled = false;
        measure();
      });
    };
    measure();
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(schedule);
    observer?.observe(card);
    window.addEventListener("resize", schedule);
    window.visualViewport?.addEventListener("resize", schedule);
    window.visualViewport?.addEventListener("scroll", schedule);
    return () => {
      observer?.disconnect();
      if (frame) window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", schedule);
      window.visualViewport?.removeEventListener("resize", schedule);
      window.visualViewport?.removeEventListener("scroll", schedule);
    };
  }, [positionKey, rect, step.placement]);

  const positionStyle: CSSProperties = rect
    ? measuredPosition?.key === positionKey
      ? {
          left: measuredPosition.left,
          top: measuredPosition.top,
          position: "fixed",
        }
      : { position: "fixed", visibility: "hidden" }
    : {};

  useEffect(() => {
    pushDialog(ownerId);
    return () => popDialog(ownerId);
  }, [ownerId]);

  useEffect(() => {
    if (!isCentered || !cardRef.current) return;
    const restoreBackground = isolateDialogBackground(cardRef.current);
    const restoreScroll = lockDocumentBodyScroll();
    return () => {
      restoreScroll();
      restoreBackground();
    };
  }, [isCentered]);

  /* Move keyboard focus to the primary action when the step changes
   * so Enter / Tab work without a manual click. We focus the card
   * itself first (so screen readers announce the dialog) then tab
   * lands on Next / Done. */
  useEffect(() => {
    const frame = window.requestAnimationFrame(() =>
      primaryRef.current?.focus(),
    );
    return () => window.cancelAnimationFrame(frame);
  }, [step.id, stepIndex]);

  useEffect(() => {
    const card = cardRef.current;
    if (!card || !isTop) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.isComposing || event.keyCode === 229) return;
      if (event.key === "Escape") {
        event.preventDefault();
        onSkip();
        return;
      }
      if (event.key !== "Tab") return;
      const scoped = [
        ...focusableElements(card),
        ...(target?.isConnected ? focusableElements(target) : []),
      ];
      const focusable = Array.from(new Set(scoped));
      if (focusable.length === 0) {
        event.preventDefault();
        card.focus();
        return;
      }
      const current = focusable.indexOf(document.activeElement as HTMLElement);
      const next =
        current < 0
          ? event.shiftKey
            ? focusable.at(-1)
            : focusable[0]
          : focusable[
              (current + (event.shiftKey ? -1 : 1) + focusable.length) %
                focusable.length
            ];
      if (!next) return;
      event.preventDefault();
      next.focus();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isTop, onSkip, target]);

  const isFirst = stepIndex === 0;
  const showBack = !step.hideBack && !isFirst;

  return (
    <div
      ref={cardRef}
      className={`tour-tooltip${isCentered ? " is-centered" : ""}${
        step.isFinal ? " is-final" : ""
      }`}
      style={positionStyle}
      role="dialog"
      aria-modal={isCentered ? "true" : "false"}
      aria-labelledby={titleId}
      aria-describedby={
        targetUnavailable ? `${descId} ${availabilityId}` : descId
      }
      tabIndex={-1}
    >
      <span className="sr-only" role="status" aria-live="polite">
        Tour step {stepIndex + 1} of {totalSteps}
      </span>
      <h2 id={titleId} className="tour-tooltip-title">
        {step.title}
      </h2>
      <p id={descId} className="tour-tooltip-body">
        {step.body}
      </p>
      {targetUnavailable ? (
        <p
          id={availabilityId}
          className="tour-tooltip-availability"
          role="status"
        >
          The highlighted area is not available in this workspace view. You can
          still review this step and continue safely.
        </p>
      ) : null}

      <div className="tour-tooltip-foot">
        {totalSteps <= 12 ? (
          <div className="tour-tooltip-dots" aria-hidden="true">
            {Array.from({ length: totalSteps }).map((_, i) => (
              <span
                key={i}
                className={`tour-tooltip-dot${
                  i === stepIndex
                    ? " is-active"
                    : i < stepIndex
                      ? " is-done"
                      : ""
                }`}
              />
            ))}
          </div>
        ) : (
          <div className="tour-tooltip-progress" aria-hidden="true">
            <span>
              {stepIndex + 1} of {totalSteps}
            </span>
            <span className="tour-tooltip-progress-track">
              <span
                className="tour-tooltip-progress-value"
                style={{ width: `${((stepIndex + 1) / totalSteps) * 100}%` }}
              />
            </span>
          </div>
        )}
        <div className="tour-tooltip-actions">
          <button
            type="button"
            className="btn btn-sm btn-ghost tour-tooltip-skip"
            onClick={onSkip}
          >
            Skip
          </button>
          {showBack ? (
            <button
              type="button"
              className="btn btn-sm tour-tooltip-back"
              onClick={onBack}
            >
              Back
            </button>
          ) : null}
          <button
            ref={primaryRef}
            type="button"
            className="btn btn-sm btn-primary tour-tooltip-next"
            onClick={step.isFinal ? onComplete : onNext}
          >
            {step.isFinal ? "Done" : isFirst ? "Show me around" : "Next"}
          </button>
        </div>
      </div>

      {step.isFinal && !reducedMotion ? <Confetti /> : null}
    </div>
  );
}

/* ---------- confetti ------------------------------------------------- */

/**
 * CSS particles fanning out from the centre of the tooltip. Count, spray
 * spread, flight time, stagger, and the brand palette are all token-sourced
 * from the canonical motion mirror (motion-tokens.ts) so the celebration feel
 * matches web/mobile. Rendered inside the tooltip card so they inherit its
 * transform-origin.
 */
function Confetti(): ReactElement {
  const { count, spreadDeg, flightMs, staggerMs } = motion.confetti;
  // Dark is the default theme (data-theme is set ONLY for light); pick the
  // matching palette so the burst stays on-brand in both themes.
  const palette =
    typeof document !== "undefined" &&
    document.documentElement.getAttribute("data-theme") === "light"
      ? motion.confetti.paletteLight
      : motion.confetti.paletteDark;
  const particles = useMemo(() => {
    const out: { angle: number; dist: number; color: string; delay: number }[] =
      [];
    for (let i = 0; i < count; i++) {
      out.push({
        angle: (i / count) * spreadDeg + Math.random() * 12,
        dist: 80 + Math.random() * 60,
        // Cycle the brand spark palette (ember + gold + lifted ember).
        color: palette[i % palette.length] ?? palette[0]!,
        // Token stagger gives an organic burst; jitter keeps it lively.
        delay: (i % count) * staggerMs + Math.random() * 60,
      });
    }
    return out;
  }, [count, spreadDeg, staggerMs, palette]);
  return (
    <div className="tour-confetti" aria-hidden="true">
      {particles.map((p, i) => {
        const dx = Math.cos((p.angle * Math.PI) / 180) * p.dist;
        const dy = Math.sin((p.angle * Math.PI) / 180) * p.dist;
        const style: CSSProperties = {
          // Custom-property-based animation targets — defined in CSS.
          ["--tx" as string]: `${dx.toFixed(1)}px`,
          ["--ty" as string]: `${dy.toFixed(1)}px`,
          // Token palette wins over the CSS hsl() fallback via inline style.
          background: p.color,
          animationDuration: `${flightMs}ms`,
          animationDelay: `${p.delay.toFixed(0)}ms`,
        };
        return (
          <span key={i} className="tour-confetti-particle" style={style} />
        );
      })}
    </div>
  );
}
