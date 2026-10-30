/**
 * Sparkline — tiny inline SVG chart for StatCard.
 *
 * Pure presentation: takes a values array, renders a line + faint
 * area fill. No tooltips, no animation, no library dependency.
 * Tone shifts the stroke color (good = accent, bad = danger).
 */

import { type ReactElement } from "react";

import { Sparkline as AccessibleSparkline } from "../charts/Sparkline";

export type SparklineTone = "good" | "neutral" | "bad";

interface Props {
  values: readonly number[];
  tone?: SparklineTone;
  height?: number;
  /** Width is set by the parent's grid; SVG is 100% wide. */
  ariaLabel?: string;
}

function seriesEvidence(values: readonly number[]): {
  trend: "up" | "down" | "flat";
  summary: string;
} {
  const finite = values.filter((value) => Number.isFinite(value));
  if (finite.length === 0) {
    return { trend: "flat", summary: "no verified points" };
  }
  const first = finite[0]!;
  const last = finite.at(-1)!;
  const trend = last > first ? "up" : last < first ? "down" : "flat";
  const direction =
    trend === "up" ? "increasing" : trend === "down" ? "decreasing" : "flat";
  return {
    trend,
    summary: `${direction} across ${values.length} points; starts at ${first.toLocaleString()}, ends at ${last.toLocaleString()}, minimum ${Math.min(...finite).toLocaleString()}, maximum ${Math.max(...finite).toLocaleString()}${finite.length === values.length ? "" : `; ${values.length - finite.length} unavailable`}`,
  };
}

export function Sparkline({
  values,
  tone = "neutral",
  height = 28,
  ariaLabel,
}: Props): ReactElement {
  const evidence = seriesEvidence(values);
  const color =
    tone === "good"
      ? "var(--pw-accent)"
      : tone === "bad"
        ? "var(--pw-danger)"
        : "var(--pw-fg-subtle)";
  return (
    <AccessibleSparkline
      values={values}
      width={200}
      height={height}
      responsive
      className="dash-sparkline"
      color={color}
      trend={evidence.trend}
      ariaLabel={`${ariaLabel ?? "Metric trend"}: ${evidence.summary}.`}
    />
  );
}
