/**
 * SegmentDecaySection — Segment Decay Radar (feature #5).
 *
 * Mounts inside SegmentDetailSlideover (below SegmentSnapshotsSection).
 * Surfaces, per segment:
 *   - the decay-alert timeline (anomaly chip, date, prior→new delta,
 *     dismiss), each row expandable to:
 *       · per-clause attribution bars (EstimateBadge — clauses overlap in
 *         AND predicates, so attribution is structurally an estimate;
 *         ConfidenceNote when the leaver sample is small),
 *       · the exit-set member list via DecayEventMembersPanel (ComputedFrom
 *         honest about the 1,000-row/direction log cap, D1),
 *       · the on-demand LLM narration block (EstimateBadge; hidden
 *         entirely when no narration exists — never fabricated).
 *   - a definition-integrity journal of segment.update events.
 *
 * Advisory-only: nothing here gates a send or changes segment state. Copy
 * says "Heads up", and dismiss is the only mutating action.
 */

import { type ReactElement, useEffect, useId, useRef, useState } from "react";

import {
  ComputedFrom,
  ConfidenceNote,
  EstimateBadge,
  SampleSize,
} from "../common/Provenance";
import { fmtDate } from "../../lib/format-date";
import {
  anomalyKindLabel,
  anomalyKindTone,
  attributionBars,
  attributionLowConfidence,
  boundedLeaverNote,
  definitionDiffSummary,
  deltaLabel,
} from "../../lib/decay-helpers";
import { toast } from "../Toast";
import { AccessibleChartData } from "../charts/AccessibleChartData";
import { dux025Provenance } from "../charts/dux-025-visual-manifest";
import {
  type DecayEvent,
  type DecayEventMember,
  type DefinitionHistoryEntry,
  decayClient,
} from "./decayClient";

const MEMBERS_PER_PAGE = 50;

export function SegmentDecaySection({
  segmentId,
  canMutate,
}: {
  segmentId: string;
  canMutate: boolean;
}): ReactElement {
  const [events, setEvents] = useState<DecayEvent[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [dismissingIds, setDismissingIds] = useState<Set<string>>(new Set());
  const dismissFlightsRef = useRef(new Set<string>());

  useEffect(() => {
    let cancelled = false;
    setEvents(null);
    setErr(null);
    void (async () => {
      try {
        const res = await decayClient.listDecayEvents(segmentId, { limit: 50 });
        if (cancelled) return;
        if (res.error) {
          setErr(res.error.message);
          setEvents([]);
          return;
        }
        setEvents(Array.isArray(res.data?.items) ? res.data.items : []);
      } catch (requestError) {
        if (cancelled) return;
        setErr(
          requestError instanceof Error
            ? requestError.message
            : "Segment decay request failed.",
        );
        setEvents([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [segmentId, reloadKey]);

  const list = Array.isArray(events) ? events : [];
  const undismissed = list.filter((e) => !e.dismissed_at).length;

  const dismiss = async (ev: DecayEvent): Promise<void> => {
    if (!canMutate || dismissFlightsRef.current.has(ev.id)) return;
    dismissFlightsRef.current.add(ev.id);
    setDismissingIds((current) => new Set(current).add(ev.id));
    // Optimistic removal from the undismissed view.
    setEvents((prev) =>
      (prev ?? []).map((e) =>
        e.id === ev.id ? { ...e, dismissed_at: new Date().toISOString() } : e,
      ),
    );
    try {
      const res = await decayClient.dismissDecayEvent(segmentId, ev.id);
      if (!res.error) {
        dismissFlightsRef.current.delete(ev.id);
        setDismissingIds((current) => {
          const next = new Set(current);
          next.delete(ev.id);
          return next;
        });
        return;
      }
      toast.error(`Couldn't dismiss alert: ${res.error.message}`);
    } catch (requestError) {
      toast.error(
        `Couldn't dismiss alert: ${requestError instanceof Error ? requestError.message : "Request failed."}`,
      );
    }
    // Roll back the optimistic update after any failed result or throw.
    setEvents((prev) =>
      (prev ?? []).map((e) =>
        e.id === ev.id ? { ...e, dismissed_at: null } : e,
      ),
    );
    dismissFlightsRef.current.delete(ev.id);
    setDismissingIds((current) => {
      const next = new Set(current);
      next.delete(ev.id);
      return next;
    });
  };

  return (
    <div className="card" style={{ padding: 12 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          marginBottom: 8,
        }}
      >
        <div className="section-title" style={{ marginBottom: 0, flex: 1 }}>
          Decay alerts
        </div>
        {undismissed > 0 ? (
          <span className="badge" title="Undismissed decay alerts">
            {undismissed}
          </span>
        ) : null}
      </div>

      <div className="muted" style={{ fontSize: 11, marginBottom: 8 }}>
        Heads up when this segment&apos;s membership drops sharply, empties out,
        or matches everyone. Advisory only — nothing is paused or changed.
      </div>

      {err ? (
        <div className="notice" role="alert" style={{ fontSize: 12 }}>
          <span>Couldn&apos;t load decay alerts: {err}</span>
          <span className="spacer" />
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => setReloadKey((key) => key + 1)}
          >
            Retry
          </button>
        </div>
      ) : events === null ? (
        <div className="muted" style={{ fontSize: 12 }} role="status">
          Loading decay alerts…
        </div>
      ) : list.length === 0 ? (
        <div className="muted" style={{ fontSize: 12 }} role="status">
          No decay alerts. This segment looks stable.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {list.map((ev) => (
            <DecayEventRow
              key={ev.id}
              segmentId={segmentId}
              ev={ev}
              open={openId === ev.id}
              canMutate={canMutate}
              dismissing={dismissingIds.has(ev.id)}
              onToggle={() => setOpenId(openId === ev.id ? null : ev.id)}
              onDismiss={() => void dismiss(ev)}
            />
          ))}
        </div>
      )}

      <DefinitionHistory segmentId={segmentId} />
    </div>
  );
}

function DecayEventRow({
  segmentId,
  ev,
  open,
  canMutate,
  dismissing,
  onToggle,
  onDismiss,
}: {
  segmentId: string;
  ev: DecayEvent;
  open: boolean;
  canMutate: boolean;
  dismissing: boolean;
  onToggle: () => void;
  onDismiss: () => void;
}): ReactElement {
  const dismissed = !!ev.dismissed_at;
  const tone = anomalyKindTone(ev.anomaly_kind);
  const bars = attributionBars(ev.clause_attrs);
  const dismissReasonId = useId();
  const dismissUnavailableReason = !canMutate
    ? "Editor or admin role required to dismiss decay alerts."
    : dismissing
      ? "This alert dismissal is already in progress."
      : null;

  return (
    <div
      style={{
        border: "1px solid var(--pw-border)",
        borderRadius: 6,
        padding: "8px 10px",
        opacity: dismissed ? 0.6 : 1,
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
          className="badge"
          style={{
            fontSize: 10,
            color: tone === "warn" ? "var(--pw-warning)" : undefined,
          }}
          title={`Anomaly: ${ev.anomaly_kind}`}
        >
          {anomalyKindLabel(ev.anomaly_kind)}
        </span>
        <strong className="tabular" style={{ fontSize: 12 }}>
          {deltaLabel(ev.prior_count, ev.new_count)}
        </strong>
        <span className="muted" style={{ fontSize: 11 }}>
          {ev.prior_count.toLocaleString()} → {ev.new_count.toLocaleString()}
        </span>
        <span className="muted" style={{ fontSize: 11 }}>
          {fmtDate(ev.created_at || ev.snapshot_date)}
        </span>
        <span className="spacer" style={{ flex: 1 }} />
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          onClick={onToggle}
        >
          {open ? "Hide detail" : "View detail"}
        </button>
        {!dismissed ? (
          <>
            {dismissUnavailableReason ? (
              <span
                id={dismissReasonId}
                className="muted"
                style={{ fontSize: 11 }}
              >
                {dismissUnavailableReason}
              </span>
            ) : null}
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              onClick={() => {
                if (dismissUnavailableReason) return;
                onDismiss();
              }}
              aria-disabled={dismissUnavailableReason ? true : undefined}
              aria-describedby={
                dismissUnavailableReason ? dismissReasonId : undefined
              }
            >
              {dismissing ? "Dismissing…" : "Dismiss"}
            </button>
          </>
        ) : (
          <span className="muted" style={{ fontSize: 11 }}>
            dismissed
          </span>
        )}
      </div>

      {open ? (
        <div
          style={{
            marginTop: 8,
            display: "flex",
            flexDirection: "column",
            gap: 10,
          }}
        >
          {/* Per-clause attribution */}
          <div>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                marginBottom: 4,
              }}
            >
              <span style={{ fontSize: 12, fontWeight: 600 }}>
                Clause attribution
              </span>
              <EstimateBadge
                label="Estimated attribution"
                title="Clause contributions overlap in AND predicates — these percentages reflect which clauses were still satisfied, not exclusive causation."
              />
            </div>
            {bars.length === 0 ? (
              <div className="muted" style={{ fontSize: 11 }}>
                Clause attribution unavailable — the predicate may be empty or
                too complex to attribute.
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                {bars.map((b) => (
                  <div key={b.clauseIndex} style={{ fontSize: 11 }}>
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                      }}
                    >
                      <span>Clause {b.clauseIndex + 1}</span>
                      <span className="tabular muted">
                        {b.count.toLocaleString()} · {b.pct}%
                      </span>
                    </div>
                    <div
                      aria-hidden="true"
                      style={{
                        height: 6,
                        borderRadius: 3,
                        background: "var(--pw-border)",
                        overflow: "hidden",
                      }}
                    >
                      <div
                        style={{
                          width: `${b.pct}%`,
                          height: "100%",
                          background: "var(--pw-accent)",
                          backgroundImage:
                            "repeating-linear-gradient(135deg, transparent 0 3px, color-mix(in srgb, var(--pw-bg) 45%, transparent) 3px 4px)",
                        }}
                      />
                    </div>
                  </div>
                ))}
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <SampleSize n={ev.leaver_count} noun="leavers analysed" />
                  {attributionLowConfidence(ev.leaver_count) ? (
                    <ConfidenceNote level="low" />
                  ) : null}
                </div>
                <AccessibleChartData
                  title="Segment-decay clause attribution"
                  summary={`${bars.length} predicate clauses attributed across ${ev.leaver_count.toLocaleString()} analyzed leavers for this decay event. Contributions can overlap.`}
                  rowHeaderLabel="Predicate clause"
                  columns={[
                    { key: "leavers", label: "Attributed leavers" },
                    { key: "attribution", label: "Attribution (%)" },
                  ]}
                  rows={bars.map((bar) => ({
                    key: String(bar.clauseIndex),
                    label: `Clause ${bar.clauseIndex + 1}`,
                    values: {
                      leavers: bar.count.toLocaleString(),
                      attribution: `${bar.pct}%`,
                    },
                    exportValues: {
                      leavers: bar.count,
                      attribution: bar.pct,
                    },
                  }))}
                  provenance={dux025Provenance("segmentDecayAttribution", {
                    scope: `Segment ${segmentId} · decay event ${ev.id}`,
                    asOf: ev.created_at || ev.snapshot_date || null,
                    note: `${ev.leaver_count.toLocaleString()} leavers were analyzed; clause contributions can overlap.`,
                  })}
                  exportFileName="segment-decay-clause-attribution.csv"
                  exportPrivacy="confidential"
                />
              </div>
            )}
          </div>

          {/* Exit-set members */}
          <DecayEventMembersPanel segmentId={segmentId} eventId={ev.id} />

          {/* LLM narration — only when genuinely present */}
          {ev.narration ? (
            <div>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  marginBottom: 4,
                }}
              >
                <span style={{ fontSize: 12, fontWeight: 600 }}>
                  AI narration
                </span>
                <EstimateBadge
                  label="AI narration"
                  title="Generated by an LLM from the exit set and predicate; may miss context not captured in the definition."
                />
              </div>
              <div className="muted" style={{ fontSize: 12, lineHeight: 1.5 }}>
                {ev.narration}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** Paginated exit-set list with honest log-cap provenance (ComputedFrom). */
function DecayEventMembersPanel({
  segmentId,
  eventId,
}: {
  segmentId: string;
  eventId: string;
}): ReactElement {
  const [members, setMembers] = useState<DecayEventMember[] | null>(null);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [totalInLog, setTotalInLog] = useState(0);
  const [bounded, setBounded] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setErr(null);
    setMembers(null);
    void (async () => {
      try {
        const res = await decayClient.decayEventMembers(segmentId, eventId, {
          direction: "left",
          page,
          perPage: MEMBERS_PER_PAGE,
        });
        if (cancelled) return;
        setLoading(false);
        if (res.error) {
          setErr(res.error.message);
          setMembers([]);
          return;
        }
        setMembers(Array.isArray(res.data?.items) ? res.data.items : []);
        setTotal(res.data?.total ?? 0);
        setTotalInLog(res.data?.total_in_log ?? 0);
        setBounded(res.data?.bounded_by_log_cap ?? false);
      } catch (requestError) {
        if (cancelled) return;
        setLoading(false);
        setErr(
          requestError instanceof Error
            ? requestError.message
            : "Departed-member request failed.",
        );
        setMembers([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [segmentId, eventId, page]);

  const rows = Array.isArray(members) ? members : [];
  const totalPages = Math.max(1, Math.ceil(total / MEMBERS_PER_PAGE));

  return (
    <div>
      <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>
        Departed members
      </div>
      <div className="muted" style={{ fontSize: 11, marginBottom: 6 }}>
        {boundedLeaverNote(rows.length, totalInLog, bounded)}
      </div>
      <div style={{ marginBottom: 6 }}>
        <ComputedFrom n={rows.length} m={totalInLog} unit="leavers logged" />
      </div>
      {err ? (
        <div className="muted" style={{ fontSize: 11 }} role="alert">
          Couldn&apos;t load members: {err}
        </div>
      ) : members === null ? (
        <div className="muted" style={{ fontSize: 11 }} role="status">
          Loading members…
        </div>
      ) : rows.length === 0 ? (
        <div className="muted" style={{ fontSize: 11 }} role="status">
          No departed members logged for this event.
        </div>
      ) : (
        <>
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 2,
              maxHeight: 220,
              overflow: "auto",
            }}
          >
            {rows.map((m, i) => (
              <div
                key={`${m.subscriber_id || m.email || "m"}-${i}`}
                className="mono"
                style={{ fontSize: 11 }}
              >
                {m.email || m.subscriber_id || "—"}
              </div>
            ))}
          </div>
          {totalPages > 1 ? (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                marginTop: 6,
              }}
            >
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                disabled={page <= 1 || loading}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
              >
                Prev
              </button>
              <span className="muted tabular" style={{ fontSize: 11 }}>
                Page {page} of {totalPages}
              </span>
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                disabled={page >= totalPages || loading}
                onClick={() => setPage((p) => p + 1)}
              >
                Next
              </button>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}

/** Definition-integrity journal: segment.update events with before/after. */
function DefinitionHistory({ segmentId }: { segmentId: string }): ReactElement {
  const [items, setItems] = useState<DefinitionHistoryEntry[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setItems(null);
    setErr(null);
    void (async () => {
      try {
        const res = await decayClient.definitionHistory(segmentId, {
          limit: 20,
        });
        if (cancelled) return;
        if (res.error) {
          setErr(res.error.message);
          setItems([]);
          return;
        }
        setItems(Array.isArray(res.data?.items) ? res.data.items : []);
      } catch (requestError) {
        if (cancelled) return;
        setErr(
          requestError instanceof Error
            ? requestError.message
            : "Definition-history request failed.",
        );
        setItems([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [segmentId]);

  const list = Array.isArray(items) ? items : [];

  return (
    <div
      style={{
        marginTop: 12,
        borderTop: "1px solid var(--pw-border)",
        paddingTop: 10,
      }}
    >
      <div className="section-title" style={{ marginBottom: 6 }}>
        Definition changes
      </div>
      {err ? (
        <div className="muted" style={{ fontSize: 11 }} role="alert">
          Couldn&apos;t load definition history: {err}
        </div>
      ) : items === null ? (
        <div className="muted" style={{ fontSize: 11 }} role="status">
          Loading definition history…
        </div>
      ) : list.length === 0 ? (
        <div className="muted" style={{ fontSize: 11 }} role="status">
          No recorded definition changes for this segment.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {list.map((it) => (
            <div key={it.audit_id} style={{ fontSize: 11 }}>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <span className="muted">{fmtDate(it.at)}</span>
                <span className="muted">{it.actor_label || "system"}</span>
              </div>
              <div className="muted">
                {definitionDiffSummary(it.before, it.after)}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
