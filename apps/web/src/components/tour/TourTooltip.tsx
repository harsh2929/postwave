// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";

import styles from "./overlay.module.css";
import type { TourPlacement, TourStep } from "./types";

interface TourTooltipProps {
  step: TourStep;
  stepIndex: number;
  totalSteps: number;
  rect: { top: number; left: number; width: number; height: number } | null;
  isLast: boolean;
  onNext: () => void;
  onBack: () => void;
  onSkip: () => void;
}

const TOOLTIP_W = 320;
const TOOLTIP_GAP = 14;
const VIEWPORT_PAD = 12;
// Conservative tooltip height estimate for placement math; final visual height
// adapts via CSS. Used only to keep us in-viewport.
const TOOLTIP_H_GUESS = 180;

interface Position {
  top: number;
  left: number;
  placement: Exclude<TourPlacement, "auto">;
}

function pickPlacement(
  preferred: TourPlacement | undefined,
  rect: TourTooltipProps["rect"],
): Exclude<TourPlacement, "auto"> {
  if (!rect) return "center";
  if (preferred && preferred !== "auto") return preferred;
  if (typeof window === "undefined") return "bottom";
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const space = {
    top: rect.top,
    bottom: vh - (rect.top + rect.height),
    left: rect.left,
    right: vw - (rect.left + rect.width),
  };
  // Pick the side with the most space, preferring vertical for natural reading.
  if (space.bottom >= TOOLTIP_H_GUESS) return "bottom";
  if (space.top >= TOOLTIP_H_GUESS) return "top";
  if (space.right >= TOOLTIP_W) return "right";
  if (space.left >= TOOLTIP_W) return "left";
  return "bottom";
}

function positionFor(
  placement: Exclude<TourPlacement, "auto">,
  rect: TourTooltipProps["rect"],
  // The tooltip's real rendered height once it has been measured. The estimate
  // is only the pre-measurement seed — everything that keeps the card on
  // screen has to use the height it actually has, or the clamp below lets the
  // footer (Skip / Back / Next) hang off the bottom edge.
  height: number = TOOLTIP_H_GUESS,
): Position {
  if (!rect || placement === "center") {
    if (typeof window === "undefined") {
      return { top: 100, left: 100, placement: "center" };
    }
    return {
      top: Math.max(VIEWPORT_PAD, window.innerHeight / 2 - height / 2),
      left: Math.max(VIEWPORT_PAD, window.innerWidth / 2 - TOOLTIP_W / 2),
      placement: "center",
    };
  }
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  let top = 0;
  let left = 0;

  if (placement === "bottom") {
    top = rect.top + rect.height + TOOLTIP_GAP;
    left = cx - TOOLTIP_W / 2;
  } else if (placement === "top") {
    top = rect.top - TOOLTIP_GAP - height;
    left = cx - TOOLTIP_W / 2;
  } else if (placement === "right") {
    top = cy - height / 2;
    left = rect.left + rect.width + TOOLTIP_GAP;
  } else if (placement === "left") {
    top = cy - height / 2;
    left = rect.left - TOOLTIP_GAP - TOOLTIP_W;
  }

  // Clamp into viewport.
  //
  // The vertical clamp used to reserve a flat 80px, so a tooltip below a
  // low-on-screen target was pinned at `vh - 92` while standing ~187px tall:
  // the whole action row rendered past the bottom edge. The card is
  // `position: absolute` inside a `position: fixed` overlay, so nothing the
  // reader can scroll brings it back — the tour became unadvanceable and
  // undismissable (caught at 1280x720 on the "Your first three moves" step).
  // Clamp against the card's own height, exactly as the horizontal axis
  // already does with TOOLTIP_W.
  if (typeof window !== "undefined") {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    left = Math.max(
      VIEWPORT_PAD,
      Math.min(left, vw - TOOLTIP_W - VIEWPORT_PAD),
    );
    top = Math.max(VIEWPORT_PAD, Math.min(top, vh - height - VIEWPORT_PAD));
  }

  return { top, left, placement };
}

export function TourTooltip({
  step,
  stepIndex,
  totalSteps,
  rect,
  isLast,
  onNext,
  onBack,
  onSkip,
}: TourTooltipProps): JSX.Element {
  const titleId = useId();
  const bodyId = useId();
  const containerRef = useRef<HTMLDivElement>(null);
  const primaryBtnRef = useRef<HTMLButtonElement>(null);

  const [pos, setPos] = useState<Position>(() =>
    positionFor(pickPlacement(step.placement, rect), rect),
  );

  // Re-compute position when rect or step changes.
  //
  // Measured before paint, from the node that already holds THIS step's copy,
  // so the clamp works off the height the card really has rather than the
  // 180px estimate. Step bodies differ by ~50px, which is the difference
  // between an action row on screen and one below the fold.
  useLayoutEffect(() => {
    const measured = containerRef.current?.offsetHeight ?? 0;
    setPos(
      positionFor(
        pickPlacement(step.placement, rect),
        rect,
        measured > 0 ? measured : TOOLTIP_H_GUESS,
      ),
    );
  }, [rect, step]);

  // Focus the primary button on mount / step change.
  useEffect(() => {
    primaryBtnRef.current?.focus();
  }, [stepIndex]);

  // Focus trap inside tooltip — only on Tab cycling.
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key !== "Tab") return;
      const root = containerRef.current;
      if (!root) return;
      const focusables = root.querySelectorAll<HTMLElement>(
        "button:not([disabled])",
      );
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement;
      if (e.shiftKey) {
        if (active === first || !root.contains(active)) {
          e.preventDefault();
          last.focus();
        }
      } else {
        if (active === last) {
          e.preventDefault();
          first.focus();
        }
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const arrowClass =
    pos.placement === "top"
      ? styles.arrowTop
      : pos.placement === "bottom"
        ? styles.arrowBottom
        : pos.placement === "left"
          ? styles.arrowLeft
          : pos.placement === "right"
            ? styles.arrowRight
            : null;

  const showBack = stepIndex > 0;
  const primaryLabel = step.primaryLabel ?? (isLast ? "Got it" : "Next");

  return (
    <div
      ref={containerRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={bodyId}
      className={styles.tooltip}
      style={{ top: pos.top, left: pos.left }}
    >
      {arrowClass ? (
        <span className={`${styles.arrow} ${arrowClass}`} aria-hidden />
      ) : null}
      <div className={styles.tooltipScroller}>
        <div className={styles.tooltipHeader}>
          <span className={styles.tooltipBadge} aria-hidden>
            {stepIndex + 1}
          </span>
          <h2 id={titleId} className={styles.tooltipTitle}>
            {step.title}
          </h2>
        </div>
        <p id={bodyId} className={styles.tooltipBody}>
          {step.body}
        </p>
      </div>
      <div className={styles.tooltipFooter}>
        <div className={styles.dots} aria-hidden>
          {Array.from({ length: totalSteps }, (_, i) => (
            <span
              key={i}
              className={`${styles.dot} ${
                i === stepIndex
                  ? styles.dotActive
                  : i < stepIndex
                    ? styles.dotPast
                    : ""
              }`}
            />
          ))}
        </div>
        <div className={styles.actions}>
          {!isLast ? (
            <button
              type="button"
              className={styles.skip}
              onClick={onSkip}
              aria-label="Skip tour"
            >
              Skip
            </button>
          ) : null}
          {showBack ? (
            <button type="button" className={styles.btn} onClick={onBack}>
              Back
            </button>
          ) : null}
          <button
            ref={primaryBtnRef}
            type="button"
            className={`${styles.btn} ${styles.btnPrimary}`}
            onClick={onNext}
          >
            {primaryLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
