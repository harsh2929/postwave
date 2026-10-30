/**
 * ForecastStrip — small ambient line below the StatGrid that does a
 * linear extrapolation on the subscriber sparkline: "At this rate
 * you'll cross 1,000 subscribers on Aug 15."
 *
 * Only renders when:
 *   • the sparkline has >= 7 points (enough signal for a trend)
 *   • the slope is positive (we don't predict shrinkage)
 *   • the predicted "next round number" is reachable inside the
 *     reasonable forecast horizon (180 days)
 *
 * Linear regression — simplest defensible choice. No external lib.
 */

import { type ReactElement } from "react";

import { forecastNextMilestone } from "../../lib/dashboard-helpers";
import { Icon } from "../Icon";
import { InlineHelp } from "../InlineHelp";

import "./dashboard-secondary-cards.css";

interface Props {
  /** Daily-bucketed subscriber adds. */
  sparkline?: number[];
  /** Current subscriber total — used as the regression intercept. */
  currentTotal: number;
}

export function ForecastStrip({
  sparkline,
  currentTotal,
}: Props): ReactElement | null {
  if (!sparkline || sparkline.length < 7) return null;
  const fc = forecastNextMilestone(sparkline, currentTotal);
  if (!fc) return null;
  const fmt = fc.crossesAt.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  return (
    <aside
      className="pw-dash-secondary-forecast"
      role="note"
      aria-label="Subscriber forecast"
    >
      <span className="pw-dash-secondary-forecast-icon" aria-hidden="true">
        <Icon name="arrow-up-right" size={16} />
      </span>
      <p className="pw-dash-secondary-forecast-copy">
        <span className="pw-dash-secondary-eyebrow">Growth trajectory</span>
        <span>
          At this rate, you&apos;ll cross{" "}
          <strong className="tabular">{fc.target.toLocaleString()}</strong>{" "}
          subscribers around <strong>{fmt}</strong>.
        </span>
      </p>
      <span className="pw-dash-secondary-provenance">
        <span className="pw-dash-secondary-badge">Projection</span>
        <InlineHelp
          ariaLabel="How this subscriber projection is calculated"
          text="A linear projection from the recent subscriber trend. It is directional, not a guarantee, and only appears when at least seven daily data points show positive growth."
        />
      </span>
    </aside>
  );
}
