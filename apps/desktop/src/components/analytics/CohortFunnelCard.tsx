/**
 * CohortFunnelCard — subscriber cohort funnel analysis (SUB-128).
 *
 * Surfaces the GET /api/v1/analytics/subscribers/funnel roll-up:
 * signup → first-purchase → repeat-purchase, bucketed by signup-month
 * cohort. The conversions are computed server-side in one CTE-based
 * query (commerce_orders joined to subscribers by email), so this card
 * is a pure read view. Only currently paid orders from signup through the
 * query snapshot qualify. Because conversion is lifetime-to-date rather than
 * window-normalized, newer cohorts have had less opportunity to convert.
 *
 * Two complementary reads:
 *   1. A 3-stage waterfall: each stage bar is sized to the FIRST stage
 *      (signups), so the visual width IS the share that survived to that
 *      stage — the drop-off reads as the shrinking bar. The stage label
 *      carries the absolute count and the conversion % from the prior
 *      stage (drop-off is 100 − conversion).
 *   2. A per-cohort table (one row per signup month) with the same three
 *      counts plus the two conversion rates, newest cohort first.
 *
 * An optional audience filter (tenant tags) scopes the funnel to a
 * tagged cohort — the backend matches audience_id against subscribers.tags
 * with the same `= ANY(tags)` idiom the segment compiler uses. The funnel
 * is NOT range-windowed; `weeks` controls how many trailing cohorts to
 * include (defaults to 12, backend cap 24).
 */

import { type ReactElement, useEffect, useMemo, useState } from "react";

import {
  type SubscriberFunnel,
  type Tag,
  analyticsExtrasApi,
  api,
} from "../../lib/api-client";
import { remoteFailureFromError } from "../../lib/remote-resource";
import { AccessibleChartData } from "../charts/AccessibleChartData";
import { Funnel } from "../charts/Funnel";
import { dux025Provenance } from "../charts/dux-025-visual-manifest";
import { InlineHelp } from "../InlineHelp";

const COHORT_COUNT = 12;

function fmtPct(v: number): string {
  if (!Number.isFinite(v)) return "—";
  return `${v.toFixed(v >= 10 ? 0 : 1)}%`;
}

export function CohortFunnelCard(): ReactElement {
  const [funnel, setFunnel] = useState<SubscriberFunnel | null>(null);
  const [tags, setTags] = useState<Tag[]>([]);
  const [tagErr, setTagErr] = useState<string | null>(null);
  const [tagReloadKey, setTagReloadKey] = useState(0);
  const [audienceId, setAudienceId] = useState<string>("");
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [reloadKey, setReloadKey] = useState(0);

  // Load tag catalogue once for the audience filter. Failure here is
  // non-fatal — the funnel still works without an audience scope.
  useEffect(() => {
    let cancelled = false;
    setTagErr(null);
    void (async (): Promise<void> => {
      try {
        const res = await api.listTags();
        if (cancelled) return;
        if (res.error) {
          setTagErr(remoteFailureFromError(res.error).message);
          return;
        }
        const items = res.data.items ?? res.data.data ?? res.data.results ?? [];
        setTags(items);
      } catch {
        if (cancelled) return;
        setTagErr(remoteFailureFromError({ kind: "network" }).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tagReloadKey]);

  useEffect(() => {
    let cancelled = false;
    void (async (): Promise<void> => {
      setLoading(true);
      setErr(null);
      try {
        const res = await analyticsExtrasApi.getSubscriberFunnel({
          weeks: COHORT_COUNT,
          audienceId: audienceId || undefined,
        });
        if (cancelled) return;
        if (res.error) {
          setErr(remoteFailureFromError(res.error).message);
          setFunnel(null);
        } else {
          setFunnel(res.data);
        }
      } catch {
        if (cancelled) return;
        setErr(remoteFailureFromError({ kind: "network" }).message);
        setFunnel(null);
      }
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [audienceId, reloadKey]);

  const steps = funnel?.steps ?? [];
  const cohorts = funnel?.cohorts ?? [];
  // Waterfall bars are sized to the first stage (signups) so a bar's width
  // is the surviving share. Guard against an empty/zero first stage.
  const topCount = steps.length > 0 ? steps[0].count : 0;
  const hasData = topCount > 0;

  const audienceLabel = useMemo(() => {
    if (!audienceId) return "all subscribers";
    return `audience "${audienceId}"`;
  }, [audienceId]);

  return (
    <div className="card pw-chart-card" style={{ marginTop: 12 }}>
      <div className="pw-chart-head">
        <div className="section-title" style={{ marginBottom: 0 }}>
          Cohort funnel
          <InlineHelp text="Subscribers who signed up, then placed a first and repeat paid order. Matching is case-insensitive by email. Only currently paid orders dated on or after signup and no later than the current snapshot qualify; pending, cancelled, refunded, pre-signup, and future-dated orders do not. This is lifetime-to-date, so newer cohorts have had less time to convert." />
        </div>
        <div
          style={{ display: "flex", alignItems: "center", gap: 8 }}
          className="muted"
        >
          {tags.length > 0 ? (
            <label
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                fontSize: 11,
              }}
            >
              <span>Audience</span>
              <select
                value={audienceId}
                onChange={(e) => setAudienceId(e.target.value)}
                aria-label="Scope funnel to a tagged audience"
                style={{ fontSize: 12, maxWidth: 200 }}
              >
                <option value="">All subscribers</option>
                {tags.map((t) => (
                  <option key={t.id} value={t.name}>
                    {t.name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <span style={{ fontSize: 11 }}>last {COHORT_COUNT} cohorts</span>
        </div>
      </div>

      <p
        className="muted"
        role="note"
        style={{ fontSize: 11, lineHeight: 1.5, margin: "0 0 12px" }}
      >
        <strong style={{ color: "var(--pw-fg)" }}>
          Lifetime-to-date snapshot.
        </strong>{" "}
        Paid orders count from each subscriber&apos;s signup onward; newer
        cohorts have had less time to reach purchase stages.
      </p>

      {tagErr ? (
        <div className="notice" role="alert" style={{ marginBottom: 8 }}>
          <span>
            Audience filter unavailable: {tagErr}. Showing all subscribers.
          </span>
          <span className="spacer" />
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => setTagReloadKey((key) => key + 1)}
          >
            Retry audience filter
          </button>
        </div>
      ) : null}

      {err ? (
        <div className="notice" role="alert">
          <span>Couldn&apos;t load cohort funnel: {err}</span>
          <span className="spacer" />
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => setReloadKey((k) => k + 1)}
          >
            Retry
          </button>
        </div>
      ) : loading ? (
        <div className="pw-chart-empty" role="status">
          Computing signup → purchase cohorts…
        </div>
      ) : !hasData ? (
        <div className="pw-chart-empty" role="status">
          No signups in the last {COHORT_COUNT} months for {audienceLabel} — the
          funnel appears once subscribers and matched orders accumulate.
        </div>
      ) : (
        <>
          <Funnel
            title="Signup-to-repeat-purchase cohort funnel"
            valueLabel="Subscribers"
            rows={steps.map((step) => ({
              label: step.label,
              value: step.count,
            }))}
            total={topCount}
            showConversion
            provenance={dux025Provenance("cohortFunnel", {
              scope: `${audienceLabel} · last ${COHORT_COUNT} monthly signup cohorts`,
              note: "Aggregate stages count currently paid orders dated from each subscriber's signup through the query snapshot. The measure is lifetime-to-date, so newer cohorts are less mature.",
            })}
            exportFileName="cohort-funnel-aggregate.csv"
            exportPrivacy="confidential"
          />

          {/* --- Per-cohort breakdown --- */}
          {cohorts.length > 0 ? (
            <div style={{ marginTop: 16 }}>
              <AccessibleChartData
                title="Cohort funnel by signup month"
                summary={`${cohorts.length} monthly signup cohorts for ${audienceLabel}; values show exact stage counts and conversion percentages from the prior stage. Purchases are currently paid orders on or after signup through the query snapshot. Results are lifetime-to-date, so newer cohorts have had less time to convert.`}
                rowHeaderLabel="Signup cohort"
                columns={[
                  { key: "signups", label: "Signups" },
                  { key: "first", label: "First purchases" },
                  { key: "firstRate", label: "First-purchase conversion" },
                  { key: "repeat", label: "Repeat purchases" },
                  { key: "repeatRate", label: "Repeat-purchase conversion" },
                ]}
                rows={cohorts.map((cohort) => ({
                  key: cohort.cohort_label,
                  label: cohort.cohort_label,
                  values: {
                    signups: cohort.signup_count.toLocaleString(),
                    first: cohort.first_purchase_count.toLocaleString(),
                    firstRate: fmtPct(cohort.first_purchase_rate),
                    repeat: cohort.repeat_purchase_count.toLocaleString(),
                    repeatRate: fmtPct(cohort.repeat_purchase_rate),
                  },
                  exportValues: {
                    signups: cohort.signup_count,
                    first: cohort.first_purchase_count,
                    firstRate: cohort.first_purchase_rate,
                    repeat: cohort.repeat_purchase_count,
                    repeatRate: cohort.repeat_purchase_rate,
                  },
                }))}
                provenance={dux025Provenance("cohortFunnel", {
                  scope: `${audienceLabel} · last ${COHORT_COUNT} monthly signup cohorts · per-cohort detail`,
                  note: "Currently paid orders from signup through the query snapshot; lifetime-to-date maturity differs by cohort age.",
                })}
                exportFileName="cohort-funnel-by-signup-month.csv"
                exportPrivacy="confidential"
              />
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
