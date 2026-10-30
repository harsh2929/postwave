/**
 * Skeleton — animated placeholder for content that's loading.
 *
 * Three variants cover the loading shapes used across the app:
 *   - "row"    — a thin horizontal bar (default). Stand-in for a
 *                line of text or a single cell value.
 *   - "card"   — a taller rectangle. Stand-in for a card body or a
 *                small chart tile.
 *   - "circle" — a perfect circle. Stand-in for an avatar / status
 *                dot.
 *
 * The animation reuses the existing `.skel` CSS class. The component picks
 * tokenized radii and sensible dimensions; `styles/design-system.css` makes
 * the placeholder static under reduced motion and visible in forced colors.
 *
 * Why both `width` and a `lines` shortcut:
 *   - Most loading placeholders render n copies of the same row skel
 *     (think table loading: 8 rows × 4 cells). The `lines` shortcut
 *     emits a vertical stack with a stable gap, avoiding the usual
 *     `Array.from({length:8}).map(...)` boilerplate.
 */
import { type ReactElement } from "react";

import type { PrimitiveLayoutStyle } from "./primitive-style-contract";

export type SkeletonVariant = "row" | "card" | "circle";

export interface SkeletonProps {
  variant?: SkeletonVariant;
  /** Width override. Strings (e.g. "60%") and numbers (treated as px)
   *  both supported. */
  width?: string | number;
  /** Height override. */
  height?: string | number;
  /** When > 1, emits a vertical stack of N rows. Implicitly forces
   *  variant="row". */
  lines?: number;
  /** Gap between stacked rows when `lines` > 1. Defaults to `--pw-sp-2`. */
  gap?: string | number;
  className?: string;
  style?: PrimitiveLayoutStyle;
  "data-testid"?: string;
  /**
   * Optional loading announcement. Visual skeletons are hidden from AT by
   * default so a grid of placeholders does not repeat “Loading…” per cell.
   * Prefer one labelled Skeleton or an owning `role="status"` container.
   */
  "aria-label"?: string;
}

function defaultsFor(variant: SkeletonVariant): {
  width: string | number;
  height: string | number;
  borderRadius: string | number;
} {
  switch (variant) {
    case "card":
      return {
        width: "100%",
        height: 96,
        borderRadius: "var(--pw-radius-sm)",
      };
    case "circle":
      return {
        width: 24,
        height: 24,
        borderRadius: "var(--pw-radius-pill)",
      };
    case "row":
    default:
      return {
        width: "100%",
        height: 12,
        borderRadius: "var(--pw-radius-xs)",
      };
  }
}

export function Skeleton({
  variant = "row",
  width,
  height,
  lines,
  gap = "var(--pw-sp-2)",
  className,
  style,
  "data-testid": testId,
  "aria-label": ariaLabel,
}: SkeletonProps): ReactElement {
  if (lines && lines > 1) {
    const d = defaultsFor("row");
    return (
      <div
        role={ariaLabel ? "status" : undefined}
        aria-label={ariaLabel}
        aria-hidden={ariaLabel ? undefined : true}
        data-testid={testId}
        style={{ display: "grid", gap, ...style }}
      >
        {Array.from({ length: lines }).map((_, i) => (
          <span
            key={i}
            className={["skel", className].filter(Boolean).join(" ")}
            style={{
              display: "block",
              width: width ?? (i === lines - 1 ? "60%" : d.width),
              height: height ?? d.height,
              borderRadius: d.borderRadius,
            }}
            aria-hidden="true"
          />
        ))}
      </div>
    );
  }

  const d = defaultsFor(variant);
  return (
    <span
      role={ariaLabel ? "status" : undefined}
      aria-label={ariaLabel}
      aria-hidden={ariaLabel ? undefined : true}
      data-testid={testId}
      className={["skel", className].filter(Boolean).join(" ")}
      style={{
        display: "inline-block",
        width: width ?? d.width,
        height: height ?? d.height,
        borderRadius: d.borderRadius,
        ...style,
      }}
    />
  );
}
