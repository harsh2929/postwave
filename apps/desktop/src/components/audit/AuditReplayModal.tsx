/**
 * AuditReplayModal — session-replay deep-link player surface.
 *
 * audit-2026 session-replay-deeplink (UX, P1).
 *
 * Renders the configured provider's player inside an iframe scoped to
 * the ±2min window the server picked. Falls back to a "Replay not
 * available" message when the lookup returns available:false (no
 * provider configured or the audit row carries no session_id).
 *
 * We deliberately embed an iframe rather than pulling in the rrweb
 * player as a hard dependency — every operator-side provider (PostHog,
 * rrweb-on-S3, FullStory) ships its own hosted player and the deep
 * link is the cheapest, license-clean integration. The iframe is
 * sandboxed so the third-party page cannot reach back into the SPA.
 */

import { type ReactElement } from "react";

import type { AuditRow, SessionReplayResponse } from "../../lib/api-client";
import { Modal } from "../Modal";

interface Props {
  row: AuditRow;
  reply: SessionReplayResponse;
  onClose: () => void;
}

function fmtDate(iso: string | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
        second: "2-digit",
      });
}

export function AuditReplayModal({ row, reply, onClose }: Props): ReactElement {
  const available = reply.available && Boolean(reply.replay_url);
  return (
    <Modal
      open
      onClose={onClose}
      title="Session replay"
      description={`Replay scoped ±2 minutes around the audit event (id ${row.id}).`}
    >
      {available ? (
        <>
          <div
            className="row"
            style={{
              gap: 12,
              fontSize: 12,
              marginBottom: 8,
              alignItems: "center",
            }}
          >
            <span className="muted">Provider</span>
            <code>{reply.provider ?? "—"}</code>
            <span className="muted">Window</span>
            <code>
              {fmtDate(reply.scoped_start_at)} → {fmtDate(reply.scoped_end_at)}
            </code>
          </div>
          <div
            style={{
              border: "1px solid var(--pw-border)",
              borderRadius: 6,
              overflow: "hidden",
              background: "var(--pw-bg)",
              height: 480,
            }}
            data-testid="audit-replay-iframe-host"
          >
            <iframe
              src={reply.replay_url}
              title={`Session replay ${reply.session_id ?? ""}`}
              sandbox="allow-scripts allow-same-origin"
              referrerPolicy="no-referrer"
              style={{ width: "100%", height: "100%", border: 0 }}
            />
          </div>
          <div className="muted" style={{ fontSize: 11, marginTop: 8 }}>
            Session ID <code>{reply.session_id ?? "—"}</code>
            {reply.client_event_seq ? (
              <>
                {" · "}seq #{reply.client_event_seq}
              </>
            ) : null}
          </div>
        </>
      ) : (
        <div
          className="empty-state"
          data-testid="audit-replay-unavailable"
          style={{ textAlign: "center", padding: 24 }}
        >
          <div className="empty-state-icon">·</div>
          <h3>Replay not available for this event</h3>
          <p className="muted" style={{ fontSize: 12 }}>
            {reply.reason === "no_replay_for_session"
              ? "This audit row was not produced by a browser session that recorded a replay (system/agent action), or no replay provider is configured."
              : "No replay could be linked to this event."}
          </p>
        </div>
      )}
    </Modal>
  );
}
