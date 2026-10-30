/**
 * lib/forecast.ts — linear projection of the next subscriber milestone.
 *
 * Ported from the desktop's `forecastNextMilestone`/`nextRoundMilestone`
 * (apps/desktop/src/lib/dashboard-helpers.ts) so the two clients cannot drift
 * into predicting different dates from the same series.
 *
 * BOTH OF THE DESKTOP'S GATES ARE KEPT, because they are what stops this being
 * a horoscope:
 *
 *  - AT LEAST SEVEN DAILY POINTS. A three-day series through a launch spike
 *    extrapolates to a million subscribers by Christmas.
 *  - POSITIVE PROJECTED GROWTH. We do not forecast shrinkage; a workspace that
 *    is losing subscribers gets NO strip rather than a date it will "cross"
 *    a milestone it is moving away from.
 *
 * And one gate the copy must keep: the result is DIRECTIONAL. The renderer is
 * required to label it a projection — a bare date reads as a commitment.
 *
 * Pure and import-free so it can be unit-tested in the node environment (house
 * rule 5): nothing here may reach for react-native, SecureStore or netinfo.
 */

export interface MilestoneForecast {
  /** The round number the workspace is heading for. */
  target: number;
  /** Projected crossing date. */
  crossesAt: Date;
  /** Whole days from `today` to `crossesAt`. */
  daysAway: number;
  /** Projected net adds per day used to get there — the strip's provenance. */
  perDay: number;
}

/** Minimum daily points before a trend is a trend rather than a coincidence. */
export const MIN_FORECAST_POINTS = 7;
/** Beyond this a projection is arithmetic, not information. */
export const DEFAULT_FORECAST_HORIZON_DAYS = 180;
/**
 * Below half a subscriber a day the projection is dominated by rounding, and
 * the milestone date swings by weeks between two consecutive polls.
 */
const MIN_PROJECTED_DAILY_ADDS = 0.5;

/**
 * Next round subscriber milestone strictly above `current`. Sequence:
 *   100, 250, 500, 1k, 2.5k, 5k, 10k, 25k, 50k, 100k, 250k, 500k, 1M, …
 */
export function nextRoundMilestone(current: number): number | null {
  if (!Number.isFinite(current)) return null;
  const ladder = [
    100, 250, 500, 1_000, 2_500, 5_000, 10_000, 25_000, 50_000, 100_000,
    250_000, 500_000, 1_000_000, 5_000_000, 10_000_000,
  ];
  for (const milestone of ladder) {
    if (milestone > current) return milestone;
  }
  return null;
}

/**
 * Project when `currentTotal` crosses the next round milestone, from a series
 * of daily NET ADDS. Returns null whenever any gate fails — the caller renders
 * nothing rather than a hedged sentence.
 */
export function forecastNextMilestone(
  dailyAdds: readonly number[],
  currentTotal: number,
  today: Date = new Date(),
  horizonDays: number = DEFAULT_FORECAST_HORIZON_DAYS,
): MilestoneForecast | null {
  const n = dailyAdds.length;
  if (n < MIN_FORECAST_POINTS) return null;
  if (!Number.isFinite(currentTotal) || currentTotal < 0) return null;

  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumXX = 0;
  for (let i = 0; i < n; i += 1) {
    const y = dailyAdds[i];
    if (typeof y !== "number" || !Number.isFinite(y)) return null;
    sumX += i;
    sumY += y;
    sumXY += i * y;
    sumXX += i * i;
  }
  const denom = n * sumXX - sumX * sumX;
  if (denom === 0) return null;

  const slope = (n * sumXY - sumX * sumY) / denom;
  const intercept = (sumY - slope * sumX) / n;
  // The regression is evaluated 15 days ahead of the last observation — the
  // midpoint of the next 30 days — so a single recent uptick tilts the
  // forecast instead of defining it.
  const projectedDailyAdds = Math.max(0, slope * (n + 15) + intercept);
  if (projectedDailyAdds < MIN_PROJECTED_DAILY_ADDS) return null;

  const target = nextRoundMilestone(currentTotal);
  if (target === null) return null;
  const gap = target - currentTotal;
  if (gap <= 0) return null;

  const days = Math.ceil(gap / projectedDailyAdds);
  if (!Number.isFinite(days) || days > horizonDays) return null;

  const crossesAt = new Date(today.getTime());
  crossesAt.setDate(crossesAt.getDate() + days);
  return { target, crossesAt, daysAway: days, perDay: projectedDailyAdds };
}
