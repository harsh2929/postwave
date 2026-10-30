/**
 * DmarcAlignmentSparkline — tiny inline chart of alignment % over
 * the period. Refined DMARC PR 3.
 *
 * Pure SVG, no chart library — the dataset is at most ~365 points
 * and we draw a polyline with one circle per day. The Y axis is
 * always [0, 1] so the eye can compare two domains' sparklines on
 * their own merits ("this one bottomed at 60%, that one at 90%"); a
 * normalised-to-actual-range chart would hide that.
 *
 * Calendar days without an observation remain explicit gaps. They are neither
 * compressed out of time nor invented as zero traffic/alignment.
 */

import type { ReactElement } from "react";

import type { DmarcDailyPoint } from "../../lib/api-client";
import { Sparkline } from "../charts/Sparkline";

interface Props {
  series: DmarcDailyPoint[];
  domain: string;
  generatedAt: string;
  periodDays: number;
  windowStart: string;
  windowEnd: string;
  /** Defaults are sized for the alignment card; the source slideover
   *  uses a wider variant. */
  width?: number;
  height?: number;
}

export function DmarcAlignmentSparkline({
  series,
  domain,
  generatedAt,
  periodDays,
  windowStart,
  windowEnd,
  width = 220,
  height = 36,
}: Props): ReactElement | null {
  const observed = series.filter((point) => point.messages > 0);
  if (observed.length < 2) return null;
  const byDay = new Map(observed.map((point) => [point.date, point]));
  const start = new Date(`${windowStart.slice(0, 10)}T00:00:00.000Z`);
  const end = new Date(`${windowEnd.slice(0, 10)}T00:00:00.000Z`);
  const calendar: Array<{ date: string; point?: DmarcDailyPoint }> = [];
  for (
    let cursor = start.getTime();
    cursor <= end.getTime() && calendar.length <= 366;
    cursor += 24 * 60 * 60 * 1_000
  ) {
    const date = new Date(cursor).toISOString().slice(0, 10);
    calendar.push({ date, point: byDay.get(date) });
  }
  const firstPct = observed[0]!.alignedPct;
  const lastPct = observed.at(-1)!.alignedPct;
  const stroke =
    lastPct >= 0.995
      ? "var(--pw-success)"
      : lastPct >= 0.9
        ? "var(--pw-warning, var(--pw-accent))"
        : "var(--pw-danger)";

  return (
    <Sparkline
      values={calendar.map(({ point }) =>
        point ? point.alignedPct * 100 : Number.NaN,
      )}
      labels={calendar.map(({ date, point }) =>
        point
          ? `${date} · ${point.messages.toLocaleString()} ${point.messages === 1 ? "message" : "messages"}`
          : `${date} · no aggregate observation`,
      )}
      width={width}
      height={height}
      domain={[0, 100]}
      fill={false}
      responsive
      showAllPoints
      color={stroke}
      className="dmarc-sparkline"
      trend={lastPct > firstPct ? "up" : lastPct < firstPct ? "down" : "flat"}
      valueLabel="aligned"
      formatValue={(value) => `${value.toFixed(1)}%`}
      ariaLabel={`Calendar-spaced alignment across ${calendar.length} UTC ${calendar.length === 1 ? "date" : "dates"} with ${observed.length} reporting ${observed.length === 1 ? "date" : "dates"} and ${calendar.length - observed.length} unobserved ${calendar.length - observed.length === 1 ? "date" : "dates"} shown as gaps; latest ${(lastPct * 100).toFixed(1)}%`}
      dataDisclosure={{
        title: "Daily DMARC alignment evidence",
        summary: `${observed.length} UTC ${observed.length === 1 ? "date contains" : "dates contain"} positive message observations in the selected ${periodDays}-day window; unavailable dates remain gaps.`,
        rowHeaderLabel: "UTC date",
        provenance: {
          source: "DMARC aggregate insights contract",
          asOf: generatedAt,
          scope: `${domain || "All available domains"} · ${windowStart} to ${windowEnd}`,
          note: "An unavailable date is not evidence of zero traffic or zero alignment.",
        },
        exportFileName: `dmarc-alignment-${domain || "all-domains"}-${periodDays}d.csv`,
        exportPrivacy: "confidential",
        allowExport: false,
      }}
    />
  );
}
