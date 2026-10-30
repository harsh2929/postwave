/**
 * ClippingMeter — live byte-size meter + Gmail-clipping warning.
 *
 * Renders inside the Archive issue Preview pane. Continuously
 * computes the rendered HTML's byte size and compares against
 * Gmail's 102 KB clipping threshold. Three states:
 *
 *   ok       → green meter, "well under" copy
 *   warn     → amber meter at ≥80% of threshold
 *   critical → red meter at ≥100% — copy explains what gets hidden
 *
 * The meter is *advisory*: it never disables Save / Publish. The goal
 * is to give the operator enough information to fix the body before
 * subscribers see "[Message clipped]" in Gmail.
 *
 * Inspired by 2026 SOTA from Ghost (their composer toolbar shows the
 * same byte meter inline as you type).
 *
 * Pure computation lives in lib/email-byte-size.ts; this file is the
 * presentation layer only.
 */

import { type ReactElement, useMemo } from "react";

import {
  GMAIL_CLIP_THRESHOLD_BYTES,
  formatBytes,
  measureEmailByteSize,
  verdictMessage,
} from "../../lib/email-byte-size";

interface Props {
  /** Rendered HTML to measure. Pass "" while loading. */
  html: string;
  /** Compact one-line variant (used in tight toolbars). Defaults to full. */
  compact?: boolean;
}

function verdictColor(v: "ok" | "warn" | "critical"): string {
  switch (v) {
    case "critical":
      return "var(--pw-danger)";
    case "warn":
      return "var(--pw-warning)";
    default:
      return "var(--pw-success)";
  }
}

function verdictLabel(v: "ok" | "warn" | "critical"): string {
  switch (v) {
    case "critical":
      return "Will be clipped in Gmail";
    case "warn":
      return "Approaching Gmail clip limit";
    default:
      return "Under Gmail clip limit";
  }
}

export function ClippingMeter({ html, compact = false }: Props): ReactElement {
  // Memoise on html so we don't re-run the byte count on every parent
  // re-render. Cost is O(n) over the HTML string; cheap for moderate
  // bodies but worth caching when the parent re-renders unrelated bits.
  const m = useMemo(() => measureEmailByteSize(html ?? ""), [html]);
  const color = verdictColor(m.verdict);
  // Cap the visual fill at 110% so a 5x-over body doesn't render an
  // overflowing bar; the textual copy already conveys the magnitude.
  const fillPct = Math.min(110, m.ratio * 100);

  if (compact) {
    return (
      <span
        data-testid="clipping-meter-compact"
        data-verdict={m.verdict}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          fontSize: 12,
          color,
        }}
        title={verdictMessage(m)}
      >
        <span
          aria-hidden="true"
          style={{
            display: "inline-block",
            width: 60,
            height: 6,
            borderRadius: 3,
            background: "var(--pw-bg-elev-2)",
            position: "relative",
            overflow: "hidden",
          }}
        >
          <span
            style={{
              position: "absolute",
              left: 0,
              top: 0,
              bottom: 0,
              width: `${Math.min(100, fillPct)}%`,
              background: color,
            }}
          />
        </span>
        <span className="tabular">
          {formatBytes(m.bytes)} / {formatBytes(GMAIL_CLIP_THRESHOLD_BYTES)}
        </span>
      </span>
    );
  }

  return (
    <div
      data-testid="clipping-meter"
      data-verdict={m.verdict}
      role="status"
      aria-live="polite"
      style={{
        border: `1px solid ${color}`,
        borderRadius: 6,
        padding: "8px 10px",
        marginBottom: 8,
        fontSize: 12,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
          marginBottom: 6,
        }}
      >
        <strong style={{ color }}>{verdictLabel(m.verdict)}</strong>
        <span className="tabular muted">
          {formatBytes(m.bytes)} / {formatBytes(GMAIL_CLIP_THRESHOLD_BYTES)} (
          {Math.round(m.ratio * 100)}%)
        </span>
      </div>
      <div
        aria-hidden="true"
        style={{
          height: 6,
          borderRadius: 3,
          background: "var(--pw-bg-elev-2)",
          position: "relative",
          overflow: "hidden",
          marginBottom: 6,
        }}
      >
        <span
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            bottom: 0,
            width: `${Math.min(100, fillPct)}%`,
            background: color,
            transition: "width 200ms ease-out",
          }}
        />
        {/* 80%-soft-warn tick mark so the operator sees how much
            runway is left before the amber zone. */}
        <span
          aria-hidden="true"
          style={{
            position: "absolute",
            top: 0,
            bottom: 0,
            left: "80%",
            width: 1,
            background: "var(--pw-border)",
          }}
        />
      </div>
      <div className="muted" style={{ lineHeight: 1.4 }}>
        {verdictMessage(m)}
      </div>
    </div>
  );
}
