/**
 * SendTimeOptBanner — deterministic historical recommendation shown above a campaign
 * schedule picker. Calls the segment-aware send-time-opt endpoint and
 * surfaces a single best-send recommendation with a one-click apply.
 *
 * Honest-fallback policy:
 *   - 404 insufficient-data responses → muted message
 *     ("Send-time analysis unavailable yet — needs at least 30 subscribers
 *      with signal"). NEVER fakes a recommendation.
 *   - Network / unknown errors → same muted message, suffixed with the
 *     short error.
 *
 * Skeleton (not spinner) during fetch.
 */
import { type ReactElement, useEffect, useId, useState } from "react";

import { type SegmentBestSendTime, apiSendTimeAssets } from "../lib/api-client";
import { decodeSegmentBest } from "./sendtime/contract";

interface Props {
  /** Tenant-scoped segment id the campaign targets. Optional — when
   *  omitted, the banner asks the predictor for a campaign-only
   *  recommendation (which today still 404s, hence the fallback). */
  segmentId?: string | null;
  /** Campaign id for tenant-scoped predictions. Optional. */
  campaignId?: string | number | null;
  /**
   * Called when the user clicks "Use this time". The argument is an
   * ISO-8601 timestamp. The banner does NOT mutate any form state on
   * its own — the parent owns the time picker.
   */
  onApply: (isoTimestamp: string) => void;
}

/**
 * Normalize the backend SegmentBest shape onto the weekday/hour fields the
 * banner renders. The /send-time-opt endpoint is hour-of-day level (UTC)
 * and returns `best_hour_utc` ("HH:00") + `computed_at` — NOT weekday/hour/
 * recommended_at — so without this the banner always fell back to "not
 * enough history" (D06#7).
 */
export function normalizeSendTime(data: unknown): SegmentBestSendTime | null {
  const decoded = decodeSegmentBest(data);
  if (!decoded || typeof decoded.best_hour_utc !== "string") return null;
  return {
    ...decoded,
    hour: Number(decoded.best_hour_utc.slice(0, 2)),
  };
}

/** Format an hour-of-week / weekday-hour pair into a friendly label. */
function formatLabel(rec: SegmentBestSendTime): string {
  if (rec.label) return rec.label;
  const weekday = typeof rec.weekday === "number" ? rec.weekday : null;
  const hour = typeof rec.hour === "number" ? rec.hour : null;
  if (weekday == null || hour == null) {
    // Hour-of-day only (the send-time endpoint has no weekday): render the
    // UTC hour without a day.
    if (hour != null) {
      const hh = ((hour % 24) + 24) % 24;
      const ampm = hh >= 12 ? "PM" : "AM";
      const h12 = hh % 12 === 0 ? 12 : hh % 12;
      return `${h12}:00 ${ampm} UTC`;
    }
    if (rec.recommended_at) {
      try {
        return new Date(rec.recommended_at).toLocaleString(undefined, {
          weekday: "long",
          hour: "numeric",
          minute: "2-digit",
        });
      } catch {
        /* fall through */
      }
    }
    return "Unknown";
  }
  // ISO weekday: 1 = Monday … 7 = Sunday.
  const days = [
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
    "Sunday",
  ];
  const day = days[Math.max(0, Math.min(6, weekday - 1))] ?? "Unknown";
  const h = ((hour % 24) + 24) % 24;
  const ampm = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${day} ${h12}:00 ${ampm}`;
}

/**
 * Compute an ISO timestamp for the *next* occurrence of the recommended
 * weekday/hour. Used when the server doesn't supply an explicit
 * `recommended_at`. The result is in the user's local zone (Date is
 * inherently local-aware) but emitted as an ISO-8601 UTC string, which
 * is what the campaign update endpoint expects for `scheduled_at`.
 */
function computeNextOccurrence(rec: SegmentBestSendTime): string | null {
  if (rec.recommended_at) return rec.recommended_at;
  if (typeof rec.hour !== "number") {
    return null;
  }
  // Hour-of-day only (no weekday): next occurrence of that UTC hour.
  if (typeof rec.weekday !== "number") {
    const nowUtc = new Date();
    const targetUtc = new Date(nowUtc);
    targetUtc.setUTCHours(rec.hour, 0, 0, 0);
    if (targetUtc.getTime() <= nowUtc.getTime()) {
      targetUtc.setUTCDate(targetUtc.getUTCDate() + 1);
    }
    return targetUtc.toISOString();
  }
  const now = new Date();
  // ISO weekday: 1=Mon..7=Sun. Date.getDay(): 0=Sun..6=Sat.
  const targetIsoDow = (((rec.weekday - 1) % 7) + 7) % 7; // 0..6 (Mon=0)
  const todayIsoDow = (now.getDay() + 6) % 7; // 0..6 (Mon=0)
  let daysAhead = (targetIsoDow - todayIsoDow + 7) % 7;
  if (daysAhead === 0 && now.getHours() >= rec.hour) {
    daysAhead = 7; // already past the slot today — go to next week
  }
  const target = new Date(now);
  target.setDate(now.getDate() + daysAhead);
  target.setHours(rec.hour, 0, 0, 0);
  return target.toISOString();
}

export function SendTimeOptBanner({
  segmentId,
  campaignId,
  onApply,
}: Props): ReactElement {
  const applyReasonId = useId();
  const [loading, setLoading] = useState(true);
  const [rec, setRec] = useState<SegmentBestSendTime | null>(null);
  const [fallbackMsg, setFallbackMsg] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setRec(null);
    setFallbackMsg(null);

    if (
      !segmentId &&
      (campaignId == null || String(campaignId).trim() === "")
    ) {
      setLoading(false);
      setFallbackMsg(
        "Choose a segment or campaign audience before requesting send-time analysis.",
      );
      return () => {
        cancelled = true;
      };
    }

    void (async () => {
      const res = await apiSendTimeAssets.getSegmentBestSendTime({
        segmentId: segmentId ?? null,
        campaignId: campaignId ?? null,
      });
      if (cancelled) return;
      setLoading(false);
      if (res.error) {
        const status = res.error.status;
        if (
          status === 404 ||
          status === 405 ||
          status === 501 ||
          status === 503
        ) {
          setFallbackMsg(
            "Send-time analysis unavailable yet — needs at least 30 subscribers with cached engagement signal.",
          );
        } else {
          setFallbackMsg(
            `Send-time analysis unavailable: ${res.error.message}`,
          );
        }
        return;
      }
      // Normalize best_hour_utc→hour, then require an hour-of-day OR an
      // explicit recommended_at (the endpoint is hour-level, no weekday).
      const data = normalizeSendTime(res.data);
      if (!data) {
        setFallbackMsg(
          "Send-time analysis unavailable yet — needs at least 30 subscribers with cached engagement signal.",
        );
        return;
      }
      setRec(data);
    })();

    return () => {
      cancelled = true;
    };
  }, [segmentId, campaignId]);

  if (loading) {
    return (
      <div className="ai-banner ai-banner-loading" role="status">
        <div
          className="ai-banner-icon skel"
          style={{ width: 16, height: 16 }}
        />
        <div style={{ flex: 1, display: "grid", gap: 6 }}>
          <div className="skel" style={{ height: 12, width: "60%" }} />
          <div className="skel" style={{ height: 10, width: "40%" }} />
        </div>
      </div>
    );
  }

  if (fallbackMsg) {
    return (
      <div className="ai-banner ai-banner-muted" role="status">
        <span className="ai-banner-icon" aria-hidden="true">
          ◐
        </span>
        <span className="muted" style={{ fontSize: 12 }}>
          {fallbackMsg}
        </span>
      </div>
    );
  }

  if (!rec) return <></>;

  const label = formatLabel(rec);
  const coverage =
    typeof rec.confidence === "number"
      ? Math.round(Math.max(0, Math.min(1, rec.confidence)) * 100)
      : null;
  const iso = computeNextOccurrence(rec);

  return (
    <div className="ai-banner" role="status">
      <span className="ai-banner-icon" aria-hidden="true">
        ✦
      </span>
      <div className="ai-banner-body">
        <div className="ai-banner-title">
          Best send time for this segment: <strong>{label}</strong>
          {coverage != null ? (
            <span className="badge accent" style={{ marginLeft: 8 }}>
              {coverage}% model coverage
            </span>
          ) : null}
        </div>
        {typeof rec.sample_size === "number" && rec.sample_size > 0 ? (
          <div className="ai-banner-sub">
            {rec.sample_size.toLocaleString()} subscribers have cached signal.
          </div>
        ) : null}
        {!iso ? (
          <div id={applyReasonId} className="ai-banner-sub">
            No concrete calendar timestamp is available for this suggestion.
          </div>
        ) : null}
      </div>
      <button
        type="button"
        className="btn btn-sm btn-primary"
        onClick={() => {
          if (iso) onApply(iso);
        }}
        disabled={!iso}
        aria-describedby={!iso ? applyReasonId : undefined}
      >
        Use this time
      </button>
    </div>
  );
}
