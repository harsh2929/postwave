/**
 * PayoutChecklist — fail-closed boundary for the historical milestone-reward
 * queue implementation (GET/PATCH /api/v1/referrals/payouts).
 *
 * Table of payouts (referrer, milestone, reward, status, created)
 * with status filter chips and per-row lifecycle actions:
 *
 *   pending  → Approve   (PATCH status=approved)
 *   pending  → Mark paid (PATCH status=paid)
 *   approved → Mark paid (PATCH status=paid)
 *
 * The exported component returns a static explanation before any request while
 * REFERRAL_PAYOUT_OPERATIONS_AVAILABLE is false. The dormant implementation
 * below is retained only for remediation work and must not be considered
 * release evidence.
 */

import { type ReactElement, useEffect, useId, useRef, useState } from "react";

import { SectionHeader } from "../SectionHeader";
import { toast } from "../Toast";
import {
  type ReferralMilestonePayout,
  type ReferralMilestonePayoutStatus,
  api,
} from "../../lib/api-client";
import { redact } from "../../lib/auth";
import { fmtDateTime } from "../../lib/format-date";
import {
  decodeReferralPayout,
  decodeReferralPayoutList,
} from "../../lib/referral-contracts";
import {
  REFERRAL_PAYOUT_OPERATIONS_AVAILABLE,
  REFERRAL_PAYOUT_OPERATIONS_UNAVAILABLE_REASON,
} from "../../lib/referral-operational-availability";
import {
  type PayoutFilter,
  applyPayoutStatus,
  payoutActionsFor,
  stripRewardPrefix,
} from "./payout-helpers";

const COLS = "1.6fr 90px 1.4fr 110px 160px 180px";

const FILTERS: Array<[PayoutFilter, string]> = [
  ["all", "All"],
  ["pending", "Pending"],
  ["approved", "Approved"],
  ["paid", "Paid"],
];

function statusBadge(s: ReferralMilestonePayoutStatus | string): ReactElement {
  if (s === "paid") return <span className="badge success">Paid</span>;
  if (s === "approved") return <span className="badge accent">Approved</span>;
  if (s === "pending") return <span className="badge warning">Pending</span>;
  return <span className="badge">{String(s)}</span>;
}

export function PayoutChecklist({
  canMutate,
}: {
  canMutate: boolean;
}): ReactElement {
  const [items, setItems] = useState<ReferralMilestonePayout[] | null>(null);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [filter, setFilter] = useState<PayoutFilter>("all");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);
  const operationRef = useRef<string | null>(null);
  const actionGuidanceId = useId();

  useEffect(() => {
    if (!REFERRAL_PAYOUT_OPERATIONS_AVAILABLE) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    void (async () => {
      setLoading(true);
      setErr(null);
      try {
        const res = await api.listReferralPayouts({
          status: filter === "all" ? undefined : filter,
          limit: 100,
        });
        if (cancelled) return;
        if (res.error) {
          setErr(redact(res.error.message));
          setItems(null);
          return;
        }
        const decoded = decodeReferralPayoutList(res.data);
        if (!decoded) {
          setErr("The payout service returned an invalid response.");
          setItems(null);
          return;
        }
        setItems(decoded.items);
        setTotal(decoded.total);
      } catch (requestError) {
        if (cancelled) return;
        setItems(null);
        setErr(
          requestError instanceof Error
            ? redact(requestError.message)
            : "The payout request did not complete.",
        );
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [filter, retryNonce]);

  const advance = async (
    row: ReferralMilestonePayout,
    next: "approved" | "paid",
  ): Promise<void> => {
    if (
      !REFERRAL_PAYOUT_OPERATIONS_AVAILABLE ||
      !canMutate ||
      operationRef.current
    )
      return;
    const prev = row.status;
    operationRef.current = row.id;
    setBusyId(row.id);
    // Optimistic: flip the status immediately; roll back on error.
    setItems((cur) => applyPayoutStatus(cur ?? [], row.id, next));
    try {
      const res = await api.updateReferralPayout(row.id, next);
      if (res.error) {
        setItems((cur) => applyPayoutStatus(cur ?? [], row.id, prev));
        // A conflict commonly means a teammate already advanced this row.
        toast.error(`Couldn't update payout: ${redact(res.error.message)}`);
        return;
      }
      // Sync the authoritative row (updated_at etc.) back in.
      const updated = decodeReferralPayout(res.data);
      if (updated) {
        setItems((cur) =>
          (cur ?? []).map((p) => (p.id === updated.id ? updated : p)),
        );
      } else {
        setItems((cur) => applyPayoutStatus(cur ?? [], row.id, prev));
        toast.error(
          "The payout update returned an invalid response. Refresh before acting again.",
        );
        return;
      }
      toast.success(
        next === "approved" ? "Payout approved" : "Payout marked paid",
      );
    } catch {
      setItems((cur) => applyPayoutStatus(cur ?? [], row.id, prev));
      toast.error("Couldn't update payout. Refresh the queue and try again.");
    } finally {
      operationRef.current = null;
      setBusyId(null);
    }
  };

  if (!REFERRAL_PAYOUT_OPERATIONS_AVAILABLE) {
    return (
      <div data-testid="referral-payout-checklist">
        <SectionHeader
          title="Reward fulfillment"
          description="Reward operations remain unavailable while the ledger contract is being release-qualified."
        />
        <div className="notice" role="status">
          <span>{REFERRAL_PAYOUT_OPERATIONS_UNAVAILABLE_REASON}</span>
        </div>
      </div>
    );
  }

  return (
    <div data-testid="referral-payout-checklist">
      <SectionHeader
        title="Payout checklist"
        description="Milestone rewards waiting on fulfilment. Approve to acknowledge, then mark paid once the reward has been sent."
        helpText="Rows are created automatically when a referrer crosses a milestone. Legal transitions: pending → approved → paid (pending can also go straight to paid)."
      />

      <div className="chips" style={{ marginBottom: 8 }}>
        {FILTERS.map(([key, label]) => (
          <button
            key={key}
            type="button"
            className={`chip${filter === key ? " is-active" : ""}`}
            onClick={() => setFilter(key)}
            aria-pressed={filter === key}
          >
            {label}
          </button>
        ))}
        {!loading && !err && items ? (
          <span
            className="muted tabular"
            style={{ fontSize: 11, alignSelf: "center" }}
          >
            {items.length === total
              ? `${total.toLocaleString()} payout${total === 1 ? "" : "s"}`
              : `showing ${items.length.toLocaleString()} of ${total.toLocaleString()}`}
          </span>
        ) : null}
      </div>

      {items && items.length > 0 ? (
        <p
          id={actionGuidanceId}
          className="muted"
          role="status"
          style={{ fontSize: 11, margin: "0 0 8px" }}
        >
          {canMutate
            ? "Approve acknowledges a pending reward; Mark paid records that the reward was sent."
            : "Payout administration is restricted to workspace admins. You can inspect the queue but cannot approve payouts or record rewards as paid."}
        </p>
      ) : null}

      {err ? (
        <div className="notice" role="alert">
          <span>Couldn&apos;t load payouts: {err}</span>
          <span className="spacer" />
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => setRetryNonce((n) => n + 1)}
          >
            Retry
          </button>
        </div>
      ) : loading ? (
        <div className="card" style={{ padding: 12 }}>
          <div
            className="skel"
            style={{ height: 12, width: 220, marginBottom: 8 }}
          />
          <div className="skel" style={{ height: 12, width: 180 }} />
        </div>
      ) : !items || items.length === 0 ? (
        <div className="empty-state" style={{ padding: 16 }}>
          <div className="empty-state-icon">·</div>
          <h3>
            {filter === "all" ? "No payouts yet" : `No ${filter} payouts`}
          </h3>
          <p className="muted">
            {filter === "all"
              ? "Rows appear here when a referrer crosses a milestone."
              : "Switch filters to see the rest of the queue."}
          </p>
        </div>
      ) : (
        <div className="list">
          <div className="list-header" style={{ gridTemplateColumns: COLS }}>
            <div>Referrer</div>
            <div>Milestone</div>
            <div>Reward</div>
            <div>Status</div>
            <div>Created</div>
            <div style={{ textAlign: "right" }}>Actions</div>
          </div>
          {items.map((p) => {
            const actions = payoutActionsFor(p.status);
            return (
              <div
                key={p.id}
                className="list-row"
                style={{ gridTemplateColumns: COLS }}
              >
                <div
                  className="mono"
                  style={{
                    fontSize: 12,
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                  title={p.referrer_id}
                >
                  {p.referrer_id}
                </div>
                <div className="tabular">{p.milestone.toLocaleString()}</div>
                <div
                  style={{
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                  title={p.reward_label}
                >
                  {stripRewardPrefix(p.reward_label) || "—"}
                </div>
                <div>{statusBadge(p.status)}</div>
                <div className="muted tabular" style={{ fontSize: 12 }}>
                  {fmtDateTime(p.created_at)}
                </div>
                <div
                  style={{
                    display: "flex",
                    gap: 6,
                    justifyContent: "flex-end",
                  }}
                >
                  {actions.includes("approved") ? (
                    <button
                      type="button"
                      className="btn btn-sm"
                      disabled={busyId != null}
                      aria-disabled={!canMutate || undefined}
                      aria-describedby={actionGuidanceId}
                      onClick={() => void advance(p, "approved")}
                    >
                      {busyId === p.id ? "Saving…" : "Approve"}
                    </button>
                  ) : null}
                  {actions.includes("paid") ? (
                    <button
                      type="button"
                      className="btn btn-sm btn-primary"
                      disabled={busyId != null}
                      aria-disabled={!canMutate || undefined}
                      aria-describedby={actionGuidanceId}
                      onClick={() => void advance(p, "paid")}
                    >
                      {busyId === p.id ? "Saving…" : "Mark paid"}
                    </button>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
