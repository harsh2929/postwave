/**
 * RateBar — tiny inline progress bar showing a 0..1 rate normalised
 * against `max`. Refined Dashboard PR 4 — used in per-row mini-stats
 * on the Campaigns / Sequences pages so each row's open rate (or
 * similar) is comparable at a glance without a sparkline-class
 * implementation.
 *
 * Every live caller renders the exact value or count immediately beside this
 * bar. It is therefore deliberately supplemental and hidden from AT instead
 * of announcing a duplicate, context-free percentage.
 */

import { type ReactElement } from "react";

interface Props {
  value: number | null | undefined;
  /** Max value to normalise against; defaults to 1 (assume 0..1 rate). */
  max?: number;
  tone?: "good" | "bad";
  /** Optional title for the tooltip. */
  title?: string;
}

export function RateBar({
  value,
  max = 1,
  tone = "good",
  title,
}: Props): ReactElement | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
    return null;
  const pct = Math.max(0, Math.min(1, value / Math.max(max, 1e-9)));
  const cls = ["dash-rate-bar"];
  if (tone === "bad") cls.push("is-bad");
  return (
    <div
      className={cls.join(" ")}
      title={title}
      aria-hidden="true"
      data-dux025-supplemental="rate-bar"
    >
      <span
        style={{
          width: `${pct * 100}%`,
          backgroundImage:
            "repeating-linear-gradient(135deg, transparent 0 3px, color-mix(in srgb, var(--pw-bg) 45%, transparent) 3px 4px)",
        }}
      />
    </div>
  );
}
