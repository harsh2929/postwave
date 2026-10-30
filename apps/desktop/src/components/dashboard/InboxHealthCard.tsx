/** InboxHealthCard — surfaces the latest verified deliverability snapshot. */

import { type ReactElement } from "react";

import { type DashboardStatsResponse } from "../../lib/api-client";
import { setSection } from "../../lib/store";

interface Props {
  stats: DashboardStatsResponse | null;
  loading?: boolean;
}

export function InboxHealthCard({
  stats,
  loading = stats === null,
}: Props): ReactElement {
  const ih = stats?.inbox_health;
  const rawScore = ih?.score;
  const hasReport =
    typeof rawScore === "number" &&
    Number.isFinite(rawScore) &&
    rawScore >= 0 &&
    rawScore <= 100;
  const invalidReport = ih != null && !hasReport;
  const score = hasReport ? rawScore : null;
  const state = ih?.state?.trim() || "Not classified";

  return (
    <section
      className="card pw-dash-secondary-card pw-dash-secondary-health"
      aria-labelledby="dashboard-inbox-health-title"
      aria-busy={loading || undefined}
    >
      <div className="pw-dash-secondary-health-copy">
        <span className="pw-dash-secondary-eyebrow">Deliverability</span>
        <h3 id="dashboard-inbox-health-title">Inbox health</h3>
        {loading ? (
          <p role="status">Checking your sender-domain health…</p>
        ) : stats === null ? (
          <p role="alert">
            Inbox health is unavailable because workspace metrics could not be
            loaded. Retry metrics above or review deliverability.
          </p>
        ) : hasReport && score !== null ? (
          <>
            <p>
              <strong className="tabular">{score}/100</strong>
              <span aria-hidden="true"> · </span>
              <span>{state}</span>
            </p>
            <meter
              className={`pw-dash-secondary-health-meter ${healthTone(score)}`}
              aria-label={`Inbox health: ${score} out of 100, ${state}`}
              min={0}
              max={100}
              low={75}
              high={90}
              optimum={100}
              value={score}
            />
          </>
        ) : invalidReport ? (
          <p role="alert">
            The latest inbox-health snapshot could not be verified. Review the
            detailed deliverability report before acting on it.
          </p>
        ) : (
          <p>
            No recent inbox-health snapshot is available. Review sender
            authentication and reputation details in Deliverability.
          </p>
        )}
      </div>
      <button
        type="button"
        className="btn pw-dash-secondary-action"
        onClick={() => setSection("deliverabilityHub")}
      >
        {loading
          ? "Review deliverability"
          : hasReport
            ? "Open report"
            : "Review deliverability"}
      </button>
    </section>
  );
}

function healthTone(score: number): string {
  if (score >= 90) return "is-healthy";
  if (score >= 75) return "is-watch";
  return "is-risk";
}
