/**
 * ReferralStatsCards — admin analytics: funnel + top referrers +
 * recent conversions. Refined Referrals PR 1.
 *
 * Keeps loading, failure and verified-empty states visible so a transport
 * failure cannot masquerade as "no conversions". The admin program editor
 * stays visible regardless — these cards are additive.
 */

import { type ReactElement, useEffect, useState } from "react";

import { type ReferralStatsResponse, api } from "../../lib/api-client";
import { decodeReferralStats } from "../../lib/referral-contracts";
import { AccessibleChartData } from "../charts/AccessibleChartData";
import { dux025Provenance } from "../charts/dux-025-visual-manifest";
import { fmtDateTime } from "../../lib/format-date";

function shortId(s: string): string {
  if (s.length <= 8) return s;
  return s.slice(0, 8);
}

function safeCount(value: unknown): number {
  const count = Number(value);
  return Number.isFinite(count) && count >= 0 ? count : 0;
}

export function ReferralStatsCards(): ReactElement | null {
  const [stats, setStats] = useState<ReferralStatsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setErr(null);
    void (async () => {
      try {
        const res = await api.getReferralStats();
        if (cancelled) return;
        if (res?.error)
          setErr(res.error.message ?? "Referral statistics failed.");
        else {
          const decoded = decodeReferralStats(res?.data);
          if (decoded) setStats(decoded);
          else
            setErr(
              "The referral statistics service returned an invalid response.",
            );
        }
      } catch (requestError) {
        if (cancelled) return;
        setErr(
          requestError instanceof Error
            ? requestError.message
            : "Referral statistics request failed.",
        );
      }
      if (!cancelled) setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  if (loading && !stats) {
    return (
      <div className="card" role="status" style={{ padding: 16 }}>
        Loading referral statistics…
      </div>
    );
  }
  if (!stats) {
    return (
      <div className="card notice" role="alert" style={{ padding: 16 }}>
        <span>Couldn&apos;t load referral statistics: {err ?? "No data"}</span>
        <span className="spacer" />
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => setReloadKey((key) => key + 1)}
        >
          Retry
        </button>
      </div>
    );
  }
  const funnel = stats.funnel;
  const topReferrers = stats.top_referrers;
  const recent = stats.recent;
  const hasAny =
    safeCount(funnel.conversions_90d) > 0 ||
    safeCount(funnel.clicks_total) > 0 ||
    safeCount(funnel.fraud_filtered_count) > 0 ||
    topReferrers.length > 0 ||
    recent.length > 0;
  if (!hasAny) {
    return (
      <div className="card" role="status" style={{ padding: 16 }}>
        No historical referral activity has been recorded yet.
      </div>
    );
  }

  const maxCount =
    topReferrers.reduce((m, r) => Math.max(m, safeCount(r.count)), 0) || 1;
  const conversionWindows = [
    { key: "7d", label: "7 days", count: safeCount(funnel.conversions_7d) },
    {
      key: "30d",
      label: "30 days",
      count: safeCount(funnel.conversions_30d),
    },
    {
      key: "90d",
      label: "90 days",
      count: safeCount(funnel.conversions_90d),
    },
  ];

  return (
    <>
      {err ? (
        <div className="notice" role="alert">
          <span>
            Statistics refresh failed. Showing the last verified historical
            snapshot.
          </span>
          <span className="spacer" />
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => setReloadKey((key) => key + 1)}
          >
            Retry
          </button>
        </div>
      ) : loading ? (
        <div className="notice" role="status" aria-live="polite">
          <span>Refreshing · showing the last verified statistics</span>
        </div>
      ) : null}
      <div
        className="ref-stat-grid"
        aria-busy={loading || undefined}
        data-referral-stats-state={err ? "degraded" : "verified"}
      >
        {/* Funnel */}
        <div className="card" style={{ padding: 16 }}>
          <div className="section-title" style={{ marginBottom: 12 }}>
            Historical activity
          </div>
          <div className="ref-stat-signal-grid">
            <div>
              <span className="muted">Captured clicks</span>
              <strong className="tabular">
                {funnel.clicks_total.toLocaleString()}
              </strong>
            </div>
            <div>
              <span className="muted">Fraud-filtered records</span>
              <strong className="tabular">
                {funnel.fraud_filtered_count.toLocaleString()}
              </strong>
            </div>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {conversionWindows.map(({ key, label, count }) => (
              <div
                key={key}
                style={{
                  display: "flex",
                  alignItems: "baseline",
                  justifyContent: "space-between",
                }}
              >
                <span className="muted" style={{ fontSize: 12 }}>
                  {label}
                </span>
                <span
                  className="tabular"
                  style={{ fontSize: 18, fontWeight: 600 }}
                >
                  {count.toLocaleString()}
                </span>
              </div>
            ))}
          </div>
          <AccessibleChartData
            title="Historical credited records by rolling creation-time window"
            summary="Credited referral records in overlapping rolling 7-, 30- and 90-day creation-time windows. These directional counts must not be summed and do not prove live signup qualification."
            rowHeaderLabel="Rolling window"
            columns={[{ key: "conversions", label: "Conversions" }]}
            rows={conversionWindows.map((window) => ({
              key: window.key,
              label: window.label,
              values: { conversions: window.count.toLocaleString() },
              exportValues: { conversions: window.count },
            }))}
            provenance={dux025Provenance("referralConversions")}
            exportFileName="referral-conversions-by-window.csv"
            exportPrivacy="confidential"
          />
        </div>

        {/* Top referrers */}
        <div className="card" style={{ padding: 0, overflow: "hidden" }}>
          <div
            style={{
              padding: "12px 16px",
              borderBottom: "1px solid var(--pw-border-soft)",
            }}
          >
            <div className="section-title" style={{ marginBottom: 0 }}>
              Top referrers
            </div>
          </div>
          {topReferrers.length === 0 ? (
            <div className="list-empty">No conversions yet</div>
          ) : (
            topReferrers.map((r) => (
              <div
                key={r.subscriber_id}
                className="ref-leaderboard-row"
                aria-label={`Subscriber ${shortId(r.subscriber_id)}, ${safeCount(r.count).toLocaleString()} historical credited records, last recorded ${fmtDateTime(r.last_at)}`}
              >
                <span className="mono" style={{ fontSize: 11 }}>
                  {shortId(r.subscriber_id)}
                </span>
                <div
                  className="dash-rate-bar"
                  style={{ flex: 1 }}
                  aria-hidden="true"
                >
                  <span
                    style={{
                      width: `${(safeCount(r.count) / maxCount) * 100}%`,
                      backgroundImage:
                        "repeating-linear-gradient(135deg, transparent 0 3px, color-mix(in srgb, var(--pw-bg) 45%, transparent) 3px 4px)",
                    }}
                  />
                </div>
                <span
                  className="tabular"
                  style={{ fontSize: 12, minWidth: 32 }}
                >
                  {safeCount(r.count)}
                </span>
                <span
                  className="muted tabular"
                  style={{ fontSize: 11, minWidth: 64, textAlign: "right" }}
                >
                  {fmtDateTime(r.last_at)}
                </span>
              </div>
            ))
          )}
          {topReferrers.length > 0 ? (
            <div style={{ padding: "0 16px 12px" }}>
              <AccessibleChartData
                title="Top referrers by conversion count"
                summary={`${topReferrers.length} top referrers returned by the referral statistics API; bars are normalized to the largest returned count.`}
                rowHeaderLabel="Referrer"
                columns={[
                  { key: "conversions", label: "Conversions" },
                  { key: "last", label: "Last conversion" },
                ]}
                rows={topReferrers.map((referrer) => ({
                  key: referrer.subscriber_id,
                  label: referrer.subscriber_id,
                  values: {
                    conversions: safeCount(referrer.count).toLocaleString(),
                    last: referrer.last_at,
                  },
                  exportValues: {
                    conversions: safeCount(referrer.count),
                    last: referrer.last_at,
                  },
                }))}
                provenance={dux025Provenance("referralTopReferrers")}
                exportFileName="top-referrers-by-conversions.csv"
                exportPrivacy="confidential"
              />
            </div>
          ) : null}
        </div>

        {/* Recent conversions */}
        <div className="card" style={{ padding: 0, overflow: "hidden" }}>
          <div
            style={{
              padding: "12px 16px",
              borderBottom: "1px solid var(--pw-border-soft)",
            }}
          >
            <div className="section-title" style={{ marginBottom: 0 }}>
              Recent conversions
            </div>
          </div>
          {recent.length === 0 ? (
            <div className="list-empty">Nothing yet</div>
          ) : (
            recent.map((c, i) => (
              <div
                key={`${c.created_at}-${i}`}
                className="ref-conversion-row"
                aria-label={`Historical referral record from subscriber ${shortId(c.referrer_id)} to subscriber ${shortId(c.referee_id)}, created ${fmtDateTime(c.created_at)}`}
              >
                <span className="mono" style={{ fontSize: 11 }}>
                  {shortId(c.referrer_id)}
                </span>
                <span className="muted" aria-hidden>
                  →
                </span>
                <span className="mono" style={{ fontSize: 11 }}>
                  {shortId(c.referee_id)}
                </span>
                <span
                  className="muted tabular"
                  style={{ marginLeft: "auto", fontSize: 11 }}
                >
                  {fmtDateTime(c.created_at)}
                </span>
              </div>
            ))
          )}
        </div>
      </div>
    </>
  );
}
