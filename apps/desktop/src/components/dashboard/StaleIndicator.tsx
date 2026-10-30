/**
 * StaleIndicator — compact, truthful transport + receipt status.
 *
 * An open SSE stream can be perfectly healthy without receiving a business
 * event for minutes, so elapsed event silence is not labelled "stale". The
 * UI reports the connection mode and, only when known, the last receipt time.
 */

import { type ReactElement } from "react";

import { LiveDot } from "../LiveDot";
import { type DashboardRange } from "../../lib/api-client";
import { rangeLabel } from "../../lib/dashboard-helpers";
import { type SseStatus } from "../../lib/sse";

interface Props {
  range: DashboardRange;
  liveStatus: SseStatus;
  /** The latest refresh failed while the runtime was offline. */
  offline?: boolean;
  /** Epoch-ms of the last successful HTTP or live stats receipt. */
  lastSuccessAt: number;
  /** Epoch-ms "now" tick provided by parent so we re-render once a second. */
  now: number;
}

export function StaleIndicator({
  range,
  liveStatus,
  offline = false,
  lastSuccessAt,
  now,
}: Props): ReactElement | null {
  const age = lastSuccessAt > 0 ? Math.max(0, now - lastSuccessAt) : null;
  const receipt = age === null ? null : relativeAge(age);
  if (offline) {
    return (
      <span
        className="dash-polling-indicator"
        aria-label={`Offline. ${receipt ? `Last confirmed metrics updated ${receipt}` : "No confirmed metrics received"}`}
      >
        <span className="dash-polling-dot" aria-hidden="true" />
        Offline · {receipt ? "Last confirmed data" : "No confirmed data"}
        {receipt ? (
          <span className="dash-receipt-time">Updated {receipt}</span>
        ) : null}
      </span>
    );
  }
  if (range === "30d" && liveStatus === "open") {
    return (
      <span className="dash-data-freshness">
        <LiveDot status={liveStatus} label="Live updates on" />
        {age !== null ? (
          <span className="dash-receipt-time">Updated {receipt}</span>
        ) : null}
      </span>
    );
  }
  if (
    range === "30d" &&
    (liveStatus === "connecting" || liveStatus === "reconnecting")
  ) {
    return (
      <span className="dash-data-freshness">
        <LiveDot status={liveStatus} />
        <span className="dash-receipt-time">Polling every 5s</span>
        {receipt ? (
          <span className="dash-receipt-time">Updated {receipt}</span>
        ) : null}
      </span>
    );
  }
  return (
    <span
      className="dash-polling-indicator"
      aria-label={`${rangeLabel(range)} metrics poll every 5 seconds. ${receipt ? `Updated ${receipt}` : "No confirmed metrics received yet"}`}
    >
      <span className="dash-polling-dot" aria-hidden="true" />
      Polling every 5s
      {age !== null ? (
        <span className="dash-receipt-time">Updated {receipt}</span>
      ) : null}
    </span>
  );
}

function relativeAge(ageMs: number): string {
  const seconds = Math.floor(ageMs / 1000);
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ago`;
}
