/**
 * AuditFeedCard — recent user-facing activity. Filters out noisy
 * audit entries via the existing isUserFacingActivity helper, same
 * as the original page.
 */

import { type ReactElement } from "react";

import { type AuditEvent } from "../../lib/api-client";
import { fmtDayMonth } from "../../lib/format-date";

interface Props {
  events: AuditEvent[] | undefined;
  loading: boolean;
}

function isUserFacingActivity(value: unknown): value is AuditEvent {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const event = value as Record<string, unknown>;
  for (const key of ["id", "action", "actor", "at", "description"] as const) {
    if (event[key] !== undefined && typeof event[key] !== "string")
      return false;
  }
  const action = typeof event.action === "string" ? event.action : "";
  const content =
    typeof event.description === "string" && event.description.trim()
      ? event.description
      : action;
  return content.trim().length > 0 && !action.toLowerCase().startsWith("http.");
}

export function AuditFeedCard({ events, loading }: Props): ReactElement {
  const filtered = (events ?? []).filter(isUserFacingActivity);
  const initialLoading = loading && events === undefined;
  const refreshing = loading && events !== undefined;

  return (
    <section
      className="card pw-dash-secondary-card"
      aria-labelledby="dashboard-activity-title"
      aria-busy={loading}
    >
      <header className="pw-dash-secondary-header">
        <div className="pw-dash-secondary-heading-group">
          <span className="pw-dash-secondary-eyebrow">Workspace activity</span>
          <h3 id="dashboard-activity-title">What&apos;s happening</h3>
        </div>
        {refreshing ? (
          <span className="pw-dash-secondary-refresh" role="status">
            Refreshing
          </span>
        ) : null}
      </header>
      {initialLoading ? (
        <div
          className="pw-dash-secondary-skeleton-stack"
          role="status"
          aria-live="polite"
          aria-label="Loading workspace activity"
        >
          <span className="sr-only">Loading workspace activity</span>
          {[0, 1, 2].map((i) => (
            <span
              key={i}
              className="skel pw-dash-secondary-skeleton-line"
              aria-hidden="true"
            />
          ))}
        </div>
      ) : filtered.length > 0 ? (
        <ul className="pw-dash-secondary-list pw-dash-secondary-activity-list">
          {filtered.slice(0, 6).map((e, i) => (
            <li key={String(e.id ?? i)}>
              <span className="pw-dash-secondary-activity-copy">
                <strong>{e.actor ?? "system"}</strong>
                <span>{e.description ?? e.action ?? "action"}</span>
              </span>
              <time
                className="pw-dash-secondary-time tabular"
                dateTime={e.at || undefined}
              >
                {fmtDayMonth(e.at)}
              </time>
            </li>
          ))}
        </ul>
      ) : (
        <div className="pw-dash-secondary-empty">
          <strong>No recent activity</strong>
          <span>
            New sends, audience changes, and account actions appear here.
          </span>
        </div>
      )}
    </section>
  );
}
