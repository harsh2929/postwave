/**
 * SequenceStuckPanel — the "Stuck" tab body inside the participants
 * drawer. Lists participants whose last sequence activity is older
 * than the sequence's stuck_after_days threshold, via
 * voiceRoadmapApi.listStuckParticipants.
 *
 * Honest states (never fixture data):
 *   - threshold unconfigured (client-side 0 OR server 400) → "set a
 *     threshold first" pointing at the settings card;
 *   - 404 → an older gateway does not expose the report;
 *   - 503 and other transient failures → generic retryable error.
 *
 * Per-row "Open subscriber" uses the pending-deep-link handoff: stash
 * {section:"subscribers", id:<email>} then hop sections — the
 * Subscribers page consumes the slot on mount, seeds its search with
 * the email, and opens the matching detail slideover.
 */
import { type ReactElement, useEffect, useState } from "react";

import {
  type SequenceStuckResponse,
  voiceRoadmapApi,
} from "../../lib/api-client";
import { navigateDesktopSectionResource } from "../../lib/desktop-router";
import {
  STUCK_UNCONFIGURED_COPY,
  STUCK_UNAVAILABLE_COPY,
  type StuckErrorKind,
  classifyStuckError,
} from "./sequence-settings";

interface Props {
  sequenceId: string | number;
  /**
   * The sequence's configured threshold (0 = off) from the canvas
   * state. When < 1 the panel renders the "set a threshold first"
   * state WITHOUT fetching — the server would deterministically 400.
   */
  stuckAfterDays: number;
  /** Close the host drawer before hopping to the Subscribers section. */
  onNavigate: () => void;
}

export function SequenceStuckPanel({
  sequenceId,
  stuckAfterDays,
  onNavigate,
}: Props): ReactElement {
  const [data, setData] = useState<SequenceStuckResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<{
    kind: StuckErrorKind;
    message: string;
  } | null>(null);
  // Bumped by the Retry button to re-run the fetch effect.
  const [fetchSeq, setFetchSeq] = useState(0);

  const configured = stuckAfterDays >= 1;

  useEffect(() => {
    if (!configured) {
      setData(null);
      setErr(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setErr(null);
    void voiceRoadmapApi.listStuckParticipants(sequenceId).then((res) => {
      if (cancelled) return;
      setLoading(false);
      if (res.error) {
        setErr({
          kind: classifyStuckError(res.error),
          message: res.error.message,
        });
        setData(null);
        return;
      }
      setData(res.data ?? null);
    });
    return () => {
      cancelled = true;
    };
  }, [sequenceId, configured, fetchSeq]);

  const openSubscriber = (email: string): void => {
    navigateDesktopSectionResource("subscribers", email);
    onNavigate();
  };

  if (!configured || err?.kind === "unconfigured") {
    return (
      <div className="notice" role="status" style={{ marginTop: 8 }}>
        <span>{STUCK_UNCONFIGURED_COPY}</span>
      </div>
    );
  }

  if (err?.kind === "unavailable") {
    return (
      <div className="notice" role="status" style={{ marginTop: 8 }}>
        <span>{STUCK_UNAVAILABLE_COPY}</span>
      </div>
    );
  }

  if (err) {
    return (
      <div className="notice" role="alert" style={{ marginTop: 8 }}>
        <span>Couldn&apos;t load stuck participants: {err.message}</span>
        <span className="spacer" />
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => setFetchSeq((s) => s + 1)}
        >
          Retry
        </button>
      </div>
    );
  }

  if (loading && !data) {
    return (
      <div className="step-list" aria-busy="true">
        {[0, 1, 2].map((i) => (
          <div key={i} className="skel" style={{ height: 48 }} />
        ))}
      </div>
    );
  }

  const items = data?.items ?? [];
  const threshold = data?.threshold_days ?? stuckAfterDays;

  if (items.length === 0) {
    return (
      <div
        style={{
          padding: "32px 16px",
          textAlign: "center",
          border: "1px dashed var(--pw-border-soft)",
          borderRadius: "var(--pw-radius-md)",
          background: "var(--pw-bg-elev)",
        }}
      >
        <div style={{ fontWeight: 600, marginBottom: 6 }}>
          No stuck participants
        </div>
        <div className="muted" style={{ fontSize: 12, lineHeight: 1.5 }}>
          Nobody has been idle for {threshold} day{threshold === 1 ? "" : "s"}{" "}
          or more on a step of this sequence.
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="muted" style={{ fontSize: 12, margin: "4px 0 8px" }}>
        {items.length.toLocaleString()} participant
        {items.length === 1 ? "" : "s"} idle for {threshold} day
        {threshold === 1 ? "" : "s"} or more (report capped at 500 rows).
      </div>
      <ul
        className="step-list"
        aria-label="Stuck participants"
        style={{ display: "flex", flexDirection: "column", gap: 6 }}
      >
        {items.map((p) => (
          <li
            key={p.subscriber_id}
            className="list-row"
            style={{
              display: "flex",
              alignItems: "center",
              gap: 12,
              padding: 12,
            }}
          >
            <div style={{ flex: 1, minWidth: 0 }}>
              <div
                style={{
                  fontWeight: 600,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {p.email}
              </div>
              <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>
                Step {p.current_step} · idle {p.idle_days} day
                {p.idle_days === 1 ? "" : "s"}
              </div>
            </div>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => openSubscriber(p.email)}
              aria-label={`Open ${p.email} in the Subscribers section`}
            >
              Open subscriber
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}
