/**
 * SegmentPnLPanel — per-segment economics (feature #4, "Segment P&L").
 * Mounts inside SegmentDetailSlideover after SegmentSnapshotsSection.
 *
 * Six pillars, led by NET CONTRIBUTION PER MEMBER:
 *   a. Net contribution / member (leading metric; Estimate when no cost
 *      config; "not available" under cross-currency).
 *   b. Revenue (observed conversions) + per-member + attribution split.
 *   c. AOV (commerce_orders) — honest empty state when no order data.
 *   d. CLV reconciliation (realised vs predicted; Estimate on predicted).
 *   e. Holdout lift (CTA to configure when absent; honest skip reasons).
 *   f. Cost side (unsub/complaint counts + total; notice when defaults).
 *
 * Honest-UI: EVERY non-observed figure is badged via the Provenance
 * primitives. Nothing here invents a number — a missing lift / AOV / CLV
 * ratio renders an explicit "not configured" / "no data" state, never a
 * fabricated 0. The sequence-attribution gap is always disclosed.
 */

import { type ReactElement, useEffect, useId, useState } from "react";

import {
  ComputedFrom,
  ConfidenceNote,
  EstimateBadge,
  SampleSize,
} from "../common/Provenance";
import {
  colourForNetContribution,
  fmtCLVRatio,
  fmtLift,
  fmtMoneyCents,
  fmtNetContribution,
} from "../../lib/segment-pnl-helpers";
import { type SegmentPnLResponse, segmentPnlClient } from "./segmentPnlClient";
import { parseSegmentPnl } from "./segment-pnl-contract";
import { SegmentHoldoutConfigModal } from "./SegmentHoldoutConfigModal";

const DAY_CHOICES = [30, 90, 365] as const;

function Row({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}): ReactElement {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 4,
        padding: "12px 0",
        borderTop: "1px solid var(--pw-border)",
      }}
    >
      <span
        style={{ fontSize: 12, fontWeight: 600, color: "var(--pw-fg-muted)" }}
      >
        {label}
      </span>
      {children}
    </div>
  );
}

export function SegmentPnLPanel({
  segmentId,
  canMutate,
}: {
  segmentId: string;
  canMutate: boolean;
}): ReactElement {
  const [data, setData] = useState<SegmentPnLResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [days, setDays] = useState<number>(90);
  const [showHoldoutModal, setShowHoldoutModal] = useState(false);

  const load = async (): Promise<void> => {
    setLoading(true);
    const res = await segmentPnlClient.pnl(segmentId, {
      days,
      includeLift: true,
    });
    setLoading(false);
    const payload = parseSegmentPnl(res.data);
    if (res.error || !payload) {
      setErr(res.error?.message ?? "The segment P&L response was invalid");
      setData(null);
      return;
    }
    setErr(null);
    setData(payload);
  };

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoading(true);
      const res = await segmentPnlClient.pnl(segmentId, {
        days,
        includeLift: true,
      });
      if (cancelled) return;
      setLoading(false);
      const payload = parseSegmentPnl(res.data);
      if (res.error || !payload) {
        setErr(res.error?.message ?? "The segment P&L response was invalid");
        setData(null);
        return;
      }
      setErr(null);
      setData(payload);
    })();
    return () => {
      cancelled = true;
    };
  }, [segmentId, days]);

  return (
    <div style={{ marginTop: 16 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <h3 style={{ margin: 0 }}>Segment P&amp;L</h3>
        <div style={{ display: "flex", gap: 6 }}>
          {DAY_CHOICES.map((d) => (
            <button
              key={d}
              type="button"
              className={`btn btn-sm ${days === d ? "btn-primary" : "btn-ghost"}`}
              onClick={() => setDays(d)}
            >
              {d}d
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <p className="muted" style={{ fontSize: 13 }}>
          Computing economics…
        </p>
      ) : err ? (
        <p
          className="muted"
          style={{ fontSize: 13, color: "var(--pw-danger)" }}
        >
          Couldn&apos;t load P&amp;L: {err}
        </p>
      ) : !data ? (
        <p className="muted" style={{ fontSize: 13 }}>
          No P&amp;L data yet.
        </p>
      ) : (
        <PnLBody
          data={data}
          canMutate={canMutate}
          onConfigureHoldout={() => setShowHoldoutModal(true)}
        />
      )}

      {showHoldoutModal ? (
        <SegmentHoldoutConfigModal
          segmentId={segmentId}
          onClose={() => setShowHoldoutModal(false)}
          onConfigured={() => void load()}
        />
      ) : null}
    </div>
  );
}

function PnLBody({
  data,
  canMutate,
  onConfigureHoldout,
}: {
  data: SegmentPnLResponse;
  canMutate: boolean;
  onConfigureHoldout: () => void;
}): ReactElement {
  const currency = data.currency || data.cost_currency || "";
  const holdoutReasonId = useId();
  const lift = fmtLift(data.lift, data.lift_skipped_reason);
  const clvRatio = fmtCLVRatio(data.clv_realised_vs_predicted ?? null);

  return (
    <div>
      {/* a. Net contribution per member — the leading metric. */}
      <Row label="Net contribution / member">
        <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
          <span
            style={{
              fontSize: 24,
              fontWeight: 700,
              color: colourForNetContribution(
                data.net_contribution_per_member_cents ?? null,
              ),
            }}
          >
            {fmtNetContribution(
              data.net_contribution_per_member_cents ?? null,
              currency,
            )}
          </span>
          {!data.cost_config_present ? (
            <EstimateBadge
              label="Estimate"
              title="Cost side uses default zero — configure a cost schedule for a real net figure."
            />
          ) : null}
        </div>
        {!data.cost_config_present ? (
          <span className="muted" style={{ fontSize: 11 }}>
            Add cost per unsub / complaint in Settings → Segment P&amp;L for
            true net contribution.
          </span>
        ) : null}
        {data.net_contribution_per_member_cents == null ? (
          <span className="muted" style={{ fontSize: 11 }}>
            Revenue and cost are in different currencies — net contribution
            isn&apos;t computed (no honest cross-currency subtraction).
          </span>
        ) : null}
      </Row>

      {/* b. Revenue. */}
      <Row label="Revenue (observed)">
        <span style={{ fontSize: 16, fontWeight: 600 }}>
          {fmtMoneyCents(data.revenue_cents, currency)}
        </span>
        <SampleSize n={data.revenue_conversions} noun="conversions" />
        <ComputedFrom
          n={data.revenue_conversions}
          m={data.member_count}
          unit="member conversions"
        />
        <span className="muted" style={{ fontSize: 11 }}>
          from conversions · last {data.window_days} days · scope:{" "}
          {data.revenue_scope === "member_all_sources"
            ? "all conversions by members"
            : data.revenue_scope}
        </span>
        <span className="muted" style={{ fontSize: 11 }}>
          attribution: {data.revenue_provenance.explicit} explicit ·{" "}
          {data.revenue_provenance.last_touch} last-touch (heuristic) ·{" "}
          {data.revenue_provenance.none} none ·{" "}
          {data.revenue_provenance.code_redemption} issued-code assignment (not reader identity) ·{" "}
          {data.revenue_provenance.campaign_vanity_path} shared campaign path ·{" "}
          {data.revenue_provenance.unclassified} legacy unclassified
        </span>
        {data.sequence_attribution_unsupported ? (
          <span className="muted" style={{ fontSize: 11 }}>
            Sequence-attributed revenue is not supported — conversions carry
            campaign attribution only.
          </span>
        ) : null}
        {data.cross_currency_revenue_excluded ? (
          <span className="muted" style={{ fontSize: 11 }}>
            Revenue shown in {currency}; {data.currencies.length - 1} other
            currenc{data.currencies.length - 1 === 1 ? "y" : "ies"} excluded
            from the sum.
          </span>
        ) : null}
      </Row>

      {/* c. AOV. */}
      <Row label="Average order value">
        {data.aov_cents != null ? (
          <>
            <span style={{ fontSize: 16, fontWeight: 600 }}>
              {fmtMoneyCents(data.aov_cents, data.aov_currency || currency)}
            </span>
            <SampleSize n={data.aov_order_count} noun="orders" />
            <span className="muted" style={{ fontSize: 11 }}>
              AOV matches commerce orders to subscriber email — mismatched
              customer emails are excluded.
            </span>
          </>
        ) : (
          <span className="muted" style={{ fontSize: 12 }}>
            No order data — connect a commerce integration to see AOV.
          </span>
        )}
      </Row>

      {/* d. CLV reconciliation. */}
      <Row label="CLV reconciliation">
        {clvRatio != null ? (
          <>
            <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
              <span style={{ fontSize: 16, fontWeight: 600 }}>{clvRatio}</span>
              <EstimateBadge
                label="Estimate"
                title="Realised vs predicted is a heuristic model output (heuristic-v1), not an exact figure."
              />
            </div>
            <span className="muted" style={{ fontSize: 11 }}>
              historic {fmtMoneyCents(data.clv_historic_sum_cents, currency)} vs
              predicted {fmtMoneyCents(data.clv_predicted_sum_cents, currency)}
            </span>
            <ComputedFrom
              n={data.clv_members_scored}
              m={data.member_count}
              unit="subscribers"
            />
          </>
        ) : (
          <SampleSize n={data.clv_members_scored} noun="scored subscribers" />
        )}
      </Row>

      {/* e. Holdout lift. */}
      <Row label="Holdout-validated lift">
        {data.lift != null ? (
          <>
            <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
              <span style={{ fontSize: 16, fontWeight: 600 }}>
                {lift.label}
              </span>
              {data.lift.confidence_low ? (
                <EstimateBadge
                  label="Low sample"
                  title="One cohort has fewer than 30 members — interpret the lift with caution."
                />
              ) : null}
            </div>
            <span className="muted" style={{ fontSize: 11 }}>
              control {data.lift.control_size} @{" "}
              {(data.lift.control_conv_rate * 100).toFixed(1)}% vs treated{" "}
              {data.lift.treated_size} @{" "}
              {(data.lift.treated_conv_rate * 100).toFixed(1)}% ·{" "}
              {data.lift.holdout_percent}% holdout · {data.lift.window_days}d
            </span>
            {data.lift.confidence_low ? <ConfidenceNote level="low" /> : null}
          </>
        ) : (
          <>
            <span className="muted" style={{ fontSize: 12 }}>
              {lift.label} — causal lift requires a control group.
            </span>
            {data.lift_skipped_reason !==
            "segment_too_large_for_in_process_lift" ? (
              <>
                <button
                  type="button"
                  className="btn btn-sm btn-ghost"
                  style={{ alignSelf: "flex-start", marginTop: 4 }}
                  onClick={() => {
                    if (!canMutate) return;
                    onConfigureHoldout();
                  }}
                  aria-disabled={!canMutate || undefined}
                  aria-describedby={!canMutate ? holdoutReasonId : undefined}
                >
                  Configure holdout
                </button>
                {!canMutate ? (
                  <span
                    id={holdoutReasonId}
                    className="muted"
                    style={{ fontSize: 11 }}
                  >
                    Editor or admin role required to configure a holdout.
                  </span>
                ) : null}
              </>
            ) : null}
          </>
        )}
      </Row>

      {/* f. Cost side. */}
      <Row label="Cost side">
        <span style={{ fontSize: 14 }}>
          {data.unsub_count.toLocaleString()} unsubs ·{" "}
          {data.complaint_count.toLocaleString()} complaints
        </span>
        {data.cost_config_present ? (
          <span className="muted" style={{ fontSize: 11 }}>
            total cost{" "}
            {fmtMoneyCents(data.total_cost_cents, data.cost_currency)}
          </span>
        ) : (
          <span className="muted" style={{ fontSize: 11 }}>
            No cost config set — total cost defaults to zero. Add a cost
            schedule for true net contribution.
          </span>
        )}
      </Row>
    </div>
  );
}
