/**
 * SegmentDecisionsPanel — SUB-070 right-to-explanation for automated
 * decisions (EU AI Act Art. 86), shown in the subscriber slideover
 * "Segment Decisions" tab.
 *
 * Surfaces WHY an automated system placed this profile in a segment (or
 * recorded a campaign decision):
 *
 *   1. Live segment membership — for every tenant segment, whether the
 *      subscriber currently belongs and the matched/total leaf-condition
 *      count, each condition rendered in natural language (matches /
 *      does not match) from the compiled QueryAST.
 *   2. Stored decision snapshots — any persisted segment/campaign
 *      decision explanations (admin/automation recorded), newest-first.
 *
 * Backed by (apps/api/internal/subscribers/decision_explanations.go):
 *   GET /api/v1/subscribers/{id}/segment-membership
 *   GET /api/v1/subscribers/{id}/decision-explanations
 * Both read scope.
 *
 * Graceful degradation: a 404 (routes not deployed) hides the whole tab
 * via onUnavailable, matching the slideover convention.
 */

import { type ReactElement, useCallback, useEffect, useState } from "react";

import {
  type DecisionExplanation,
  type SegmentMembership,
  decisionExplanationsApi,
} from "../../lib/api/decision-explanations";
import { fmtDateTime } from "../../lib/format-date";

interface Props {
  /** Subscriber UUID (the explanation endpoints key rows by it). */
  subscriberId: string;
  /** Fired when the decision routes are not deployed (404). */
  onUnavailable?: () => void;
}

/** Short human label for a stored decision_type. */
function decisionTypeLabel(t: string): string {
  switch (t) {
    case "segment":
      return "Segment";
    case "campaign":
      return "Campaign";
    default:
      return t;
  }
}

/** Render the freeform reasoning snapshot as readable key/value rows.
 *  The snapshot is operator/automation-defined JSON, so we stringify
 *  non-scalar values rather than assume a shape. */
function snapshotRows(
  snapshot: Record<string, unknown>,
): Array<[string, string]> {
  return Object.entries(snapshot).map(([k, v]) => {
    const val =
      v == null ? "—" : typeof v === "object" ? JSON.stringify(v) : String(v);
    return [k, val];
  });
}

export function SegmentDecisionsPanel(props: Props): ReactElement {
  return <SegmentDecisionsPanelState key={props.subscriberId} {...props} />;
}

function SegmentDecisionsPanelState({
  subscriberId,
  onUnavailable,
}: Props): ReactElement {
  const [memberships, setMemberships] = useState<SegmentMembership[] | null>(
    null,
  );
  const [stored, setStored] = useState<DecisionExplanation[] | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [err, setErr] = useState<string | null>(null);
  // Per-segment expand toggle so the per-condition breakdown stays
  // collapsed until the operator drills in.
  const [openSeg, setOpenSeg] = useState<Set<string>>(new Set());

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setErr(null);
    const [memRes, storedRes] = await Promise.all([
      decisionExplanationsApi.getSegmentMembership(subscriberId),
      decisionExplanationsApi.getSubscriberDecisionExplanations(subscriberId),
    ]);
    setLoading(false);
    // 404 on EITHER read → the routes aren't on this deployment; latch
    // the tab hidden.
    if (memRes.error?.status === 404 || storedRes.error?.status === 404) {
      onUnavailable?.();
      return;
    }
    if (memRes.error) {
      setErr(memRes.error.message);
      return;
    }
    setMemberships(memRes.data?.segments ?? []);
    // The stored-snapshot read is non-fatal: a failure there shouldn't
    // hide the live membership reasoning (the headline surface).
    if (storedRes.error) {
      setErr(
        `Live membership loaded, but stored explanations couldn't be refreshed: ${storedRes.error.message}`,
      );
    } else {
      setStored(storedRes.data?.items ?? []);
    }
  }, [subscriberId, onUnavailable]);

  useEffect(() => {
    void load();
  }, [load]);

  const toggleSeg = (id: string): void => {
    setOpenSeg((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  if (loading && memberships === null) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <div className="skel" style={{ height: 40 }} />
        <div className="skel" style={{ height: 40 }} />
      </div>
    );
  }

  if (err && memberships === null) {
    return (
      <div className="notice">
        <span>Couldn&apos;t load segment decisions: {err}</span>
        <span className="spacer" style={{ flex: 1 }} />
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          onClick={() => void load()}
        >
          Retry
        </button>
      </div>
    );
  }

  const segs = memberships ?? [];
  // Members first (those that actually placed the subscriber), then the
  // rest so an operator can also see near-misses.
  const memberSegs = segs.filter((s) => s.is_member);
  const otherSegs = segs.filter((s) => !s.is_member);
  const ordered = [...memberSegs, ...otherSegs];
  const storedRows = stored ?? [];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {err ? (
        <div className="notice" role="alert">
          <span>{err}</span>
          <span className="spacer" style={{ flex: 1 }} />
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            onClick={() => void load()}
          >
            Retry
          </button>
        </div>
      ) : null}
      <div>
        <div className="label">Segment decisions</div>
        <p className="muted" style={{ fontSize: 12, margin: "4px 0 0" }}>
          Why this profile is (or is not) in each segment. Conditions are
          derived live from the segment&apos;s compiled rules — your
          right-to-explanation under EU AI Act Article 86.
        </p>
      </div>

      {ordered.length === 0 ? (
        <div className="muted" style={{ fontSize: 12 }}>
          No segments defined for this account yet.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {ordered.map((s) => {
            const open = openSeg.has(s.segment_id);
            return (
              <div
                key={s.segment_id}
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: 6,
                  border: "1px solid var(--pw-border)",
                  borderRadius: 6,
                  padding: "8px 10px",
                  background: "var(--pw-bg-elev)",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    flexWrap: "wrap",
                  }}
                >
                  <span
                    className={s.is_member ? "badge success" : "badge"}
                    style={{ fontSize: 11 }}
                  >
                    {s.is_member ? "Member" : "Not a member"}
                  </span>
                  <span style={{ fontSize: 13, fontWeight: 600 }}>
                    {s.segment_name}
                  </span>
                  <span className="spacer" style={{ flex: 1 }} />
                  <span className="muted tabular" style={{ fontSize: 11 }}>
                    {s.matched_count}/{s.total_conditions} conditions
                  </span>
                  {s.conditions.length > 0 ? (
                    <button
                      type="button"
                      className="btn btn-xs"
                      onClick={() => toggleSeg(s.segment_id)}
                      aria-expanded={open}
                    >
                      {open ? "Hide reasons" : "Why?"}
                    </button>
                  ) : null}
                </div>
                <div className="muted" style={{ fontSize: 12 }}>
                  {s.summary}
                </div>
                {open && s.conditions.length > 0 ? (
                  <div style={{ display: "grid", gap: 4, marginTop: 2 }}>
                    {s.conditions.map((c, i) => (
                      <div
                        key={`${c.field}-${c.comparator}-${i}`}
                        style={{
                          display: "flex",
                          gap: 8,
                          alignItems: "baseline",
                        }}
                      >
                        <span
                          className={c.matched ? "badge success" : "badge"}
                          style={{ fontSize: 10 }}
                        >
                          {c.matched ? "✓" : "✕"}
                        </span>
                        <span style={{ fontSize: 12 }}>{c.description}</span>
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      )}

      {/* ---- stored decision snapshots ------------------------------- */}
      {storedRows.length > 0 ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div>
            <div className="label">Recorded decisions</div>
            <p className="muted" style={{ fontSize: 12, margin: "4px 0 0" }}>
              Point-in-time decision snapshots persisted for this profile.
            </p>
          </div>
          {storedRows.map((d) => (
            <div
              key={d.id}
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 6,
                border: "1px solid var(--pw-border)",
                borderRadius: 6,
                padding: "8px 10px",
                background: "var(--pw-bg-elev)",
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  flexWrap: "wrap",
                }}
              >
                <span className="badge accent" style={{ fontSize: 11 }}>
                  {decisionTypeLabel(d.decision_type)}
                </span>
                <span
                  className="muted tabular"
                  style={{ fontSize: 11 }}
                  title={d.target_id}
                >
                  {d.target_id}
                </span>
                <span className="spacer" style={{ flex: 1 }} />
                <span className="muted" style={{ fontSize: 11 }}>
                  {fmtDateTime(d.created_at)}
                </span>
              </div>
              {Object.keys(d.reasoning_snapshot).length > 0 ? (
                <div style={{ display: "grid", gap: 2 }}>
                  {snapshotRows(d.reasoning_snapshot).map(([k, v]) => (
                    <div
                      key={k}
                      className="muted"
                      style={{ fontSize: 11, display: "flex", gap: 8 }}
                    >
                      <span style={{ fontWeight: 600 }}>{k}</span>
                      <span>{v}</span>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
