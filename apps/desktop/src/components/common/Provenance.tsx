/**
 * Provenance — tiny, honest provenance primitives for analytics UI.
 *
 * These are pure presentational chips/footnotes that make data honesty
 * VISIBLE: "this is an estimate", "computed from N of M", sample sizes,
 * and (only-when-real) confidence notes. They never fetch, never
 * compute a number, and — critically — never INVENT one. A caller must
 * pass real values; the components only render what's genuinely true.
 *
 * Design rules baked in:
 *   - Visually quiet: reuse the repo's `.badge` / `.muted` classNames
 *     and CSS vars (--pw-fg-muted / --pw-fg-subtle). Provenance should
 *     inform, not shout.
 *   - Honest by construction: ComputedFrom never implies a sample
 *     larger than reality (n is clamped to m); SampleSize renders an
 *     explicit "no data yet" rather than a misleading "based on 0";
 *     ConfidenceNote only shows a ± interval when the caller hands one
 *     over — it NEVER fabricates a confidence interval.
 *   - Defensive: `?? 0` on every numeric prop, no divide-by-zero.
 *
 * Styling matches the rest of the app: inline styles + CSS vars, native
 * `title` tooltips (same accessible pattern InlineHelp leans on), and
 * the shared `.badge`/`.muted` classes.
 */

import type { CSSProperties, ReactElement } from "react";

/** Shared muted-footnote style — small, quiet, CSS-var driven. */
const noteStyle: CSSProperties = {
  fontSize: 11,
  color: "var(--pw-fg-subtle)",
  lineHeight: 1.5,
};

/** Format a number honestly with grouping; treats nullish as 0. */
function fmt(n: number | undefined | null): string {
  return (n ?? 0).toLocaleString();
}

// ---------------------------------------------------------------------------
// EstimateBadge — for extrapolated / projected figures (forecasts, churn
// risk, predicted LTV, send-time recommendations). Says "this is a
// projection, not an exact figure" — and means it.
// ---------------------------------------------------------------------------

interface EstimateBadgeProps {
  /** Override the chip text (default "Estimate"). */
  label?: string;
  /** Override the tooltip; defaults to the honest projection wording. */
  title?: string;
}

export function EstimateBadge({
  label = "Estimate",
  title = "A projection from current data, not an exact figure.",
}: EstimateBadgeProps): ReactElement {
  return (
    <span
      className="badge"
      title={title}
      aria-label={`${label}: ${title}`}
      style={{ cursor: "help" }}
    >
      {label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// ComputedFrom — "computed from {n} of {m} {unit}". For metrics derived
// from a loaded slice / top-N rather than the whole population. Clamps n
// to m so it can NEVER imply a bigger sample than was actually used.
// ---------------------------------------------------------------------------

interface ComputedFromProps {
  /** Rows/records actually used in the computation. */
  n: number | undefined | null;
  /** Population total. When undefined, we can't claim a fraction. */
  m?: number | undefined | null;
  /** Unit noun, e.g. "subscribers", "campaigns". */
  unit?: string;
}

export function ComputedFrom({
  n,
  m,
  unit = "rows",
}: ComputedFromProps): ReactElement | null {
  const used = Math.max(0, n ?? 0);
  const u = unit.trim();
  const unitSuffix = u ? ` ${u}` : "";

  // No population to compare against → honestly report just the count
  // we used, never a fabricated fraction.
  if (m == null) {
    if (used === 0) return null;
    return (
      <span className="muted" style={noteStyle}>
        computed from {fmt(used)}
        {unitSuffix}
      </span>
    );
  }

  const total = Math.max(0, m);
  // Guard against the slice being reported larger than the population
  // (stale counts, races): clamp so we never overstate the sample.
  const shown = Math.min(used, total);

  if (total === 0) return null;

  // Whole population covered → say "all", never "N of N" which reads as
  // a partial sample.
  if (shown >= total) {
    return (
      <span className="muted" style={noteStyle}>
        computed from all {fmt(total)}
        {unitSuffix}
      </span>
    );
  }

  return (
    <span className="muted" style={noteStyle}>
      computed from {fmt(shown)} of {fmt(total)}
      {unitSuffix}
    </span>
  );
}

// ---------------------------------------------------------------------------
// SampleSize — "based on {n} {noun}". For figures derived from an
// explicit sample (a cohort of K, a model trained on K rows, K opens
// analysed). n === 0 renders an honest "no data yet" variant.
// ---------------------------------------------------------------------------

interface SampleSizeProps {
  /** Size of the sample the figure is based on. */
  n: number | undefined | null;
  /** What the sample is made of, e.g. "opens", "orders". */
  noun?: string;
}

export function SampleSize({
  n,
  noun = "records",
}: SampleSizeProps): ReactElement {
  const size = Math.max(0, n ?? 0);
  const word = noun.trim() || "records";

  if (size === 0) {
    return (
      <span className="muted" style={noteStyle}>
        no {word} yet — nothing to base this on
      </span>
    );
  }

  // Singularise the trailing noun when exactly one (best-effort, only
  // for the common plural-"s" case — keeps copy honest, not perfect).
  const label =
    size === 1 && word.endsWith("s") ? word.slice(0, -1) : word;

  return (
    <span className="muted" style={noteStyle}>
      based on {fmt(size)} {label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// ConfidenceNote — a muted footnote for low-confidence figures. Callers
// pass `level` ONLY when they actually know the sample is small. The
// optional `interval` renders a "±" range ONLY when supplied — we NEVER
// invent a confidence interval.
// ---------------------------------------------------------------------------

interface ConfidenceInterval {
  low: number;
  high: number;
}

interface ConfidenceNoteProps {
  /**
   * "low" surfaces the caution copy. "ok" / undefined renders nothing
   * unless a real interval is supplied — we don't reassure with a
   * confidence claim the caller didn't make.
   */
  level?: "low" | "ok";
  /**
   * A genuine interval, e.g. from the backend. ONLY rendered when
   * present; never derived here.
   */
  interval?: ConfidenceInterval;
  /** Unit for the interval bounds, e.g. "%", " orders". */
  unit?: string;
}

export function ConfidenceNote({
  level,
  interval,
  unit = "",
}: ConfidenceNoteProps): ReactElement | null {
  const hasInterval =
    interval != null &&
    Number.isFinite(interval.low) &&
    Number.isFinite(interval.high);

  // Nothing honest to say: no low-confidence flag and no real interval.
  if (level !== "low" && !hasInterval) return null;

  const parts: string[] = [];
  if (level === "low") {
    parts.push("low sample — interpret with caution");
  }
  if (hasInterval) {
    const lo = interval.low.toLocaleString();
    const hi = interval.high.toLocaleString();
    parts.push(`range ${lo}–${hi}${unit}`);
  }

  return (
    <span className="muted" role="note" style={noteStyle}>
      {parts.join(" · ")}
    </span>
  );
}
