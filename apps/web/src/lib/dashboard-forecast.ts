// SPDX-License-Identifier: AGPL-3.0-only
//
// Subscriber growth projection for the home dashboard (parity with desktop
// lib/dashboard-helpers.ts forecastNextMilestone / nextRoundMilestone).
//
// Input is the `sparklines.subscribers` series GET /api/v1/dashboard/stats
// already returns: daily NEW-subscriber counts (analytics.go
// dashboardSubscriberSparklineSQL buckets `subscribers.created_at` by day).
// A least-squares line through that series gives the projected adds per day;
// the running total is then walked forward to the next round milestone.
//
// It declines to predict (returns null) when:
//   - there are fewer than 7 daily points — not enough signal for a trend
//   - the projected daily adds fall below half a subscriber — we never forecast
//     shrinkage, and a near-flat trend would yield a meaningless far date
//   - the milestone lies past the horizon (default 180 days) — that is noise
//   - the current total is not a finite nonnegative number
//
// Pure: `today` is injectable so tests are deterministic.

export const MILESTONE_LADDER = [
  100, 250, 500, 1_000, 2_500, 5_000, 10_000, 25_000, 50_000, 100_000,
  250_000, 500_000, 1_000_000, 5_000_000, 10_000_000,
] as const;

/** Next round subscriber milestone strictly above `current`, or null. */
export function nextRoundMilestone(current: number): number | null {
  for (const milestone of MILESTONE_LADDER) {
    if (milestone > current) return milestone;
  }
  return null;
}

export interface SubscriberForecast {
  target: number;
  crossesAt: Date;
  daysAway: number;
  /** Projected new subscribers per day used for the walk-forward. */
  projectedDailyAdds: number;
}

export function forecastNextMilestone(
  dailyAdds: readonly unknown[] | null | undefined,
  currentTotal: unknown,
  today: Date = new Date(),
  horizonDays = 180,
): SubscriberForecast | null {
  if (!Array.isArray(dailyAdds)) return null;
  if (
    typeof currentTotal !== "number" ||
    !Number.isFinite(currentTotal) ||
    currentTotal < 0
  ) {
    return null;
  }
  const series = dailyAdds.filter(
    (value): value is number =>
      typeof value === "number" && Number.isFinite(value),
  );
  // A mangled point would shift every index after it; refuse instead.
  if (series.length !== dailyAdds.length) return null;
  const n = series.length;
  if (n < 7) return null;

  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumXX = 0;
  for (let i = 0; i < n; i += 1) {
    const y = series[i] as number;
    sumX += i;
    sumY += y;
    sumXY += i * y;
    sumXX += i * i;
  }
  const denom = n * sumXX - sumX * sumX;
  if (denom === 0) return null;
  const slope = (n * sumXY - sumX * sumY) / denom;
  const intercept = (sumY - slope * sumX) / n;
  // Evaluate the fitted line mid-way through the next 30 days so a one-day
  // uptick at the tail does not dominate the projection.
  const projectedDailyAdds = Math.max(0, slope * (n + 15) + intercept);
  if (projectedDailyAdds < 0.5) return null;

  const target = nextRoundMilestone(currentTotal);
  if (target === null) return null;
  const gap = target - currentTotal;
  if (gap <= 0) return null;
  const daysAway = Math.ceil(gap / projectedDailyAdds);
  if (daysAway > horizonDays) return null;
  const crossesAt = new Date(today);
  crossesAt.setDate(crossesAt.getDate() + daysAway);
  return { target, crossesAt, daysAway, projectedDailyAdds };
}
