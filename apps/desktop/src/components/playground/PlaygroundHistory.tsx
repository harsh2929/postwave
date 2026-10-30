/** Identity-scoped, encrypted request history for the API Playground. */

import { type ReactElement, useState } from "react";

import {
  recordHistoryEntry,
  type HistoryEntry,
} from "./playground-history-storage";
import { usePlaygroundHistory } from "./usePlaygroundHistory";
import { ConfirmModal } from "../ConfirmModal";

export { recordHistoryEntry };
export type { HistoryEntry };

interface Props {
  identityScope: string | null;
  /** Called when the user clicks an entry. Parent selects the retained route
   *  template and opens a blank, value-free request draft. */
  onReplay: (entry: HistoryEntry) => void;
}

export function PlaygroundHistory({
  identityScope,
  onReplay,
}: Props): ReactElement {
  const history = usePlaygroundHistory(identityScope);
  // "Clear all" confirmation. In-app ConfirmModal replaces
  // window.confirm, which silently no-ops in the Tauri webview.
  const [confirmClearOpen, setConfirmClearOpen] = useState(false);
  const [confirmReplay, setConfirmReplay] = useState<{
    scope: string | null;
    entry: HistoryEntry;
  } | null>(null);
  const replayReview =
    confirmReplay?.scope === identityScope ? confirmReplay.entry : null;
  const storageNotice = history.warning ? (
    <div
      className={history.retryable ? "field-error" : "notice"}
      role={history.retryable ? "alert" : "status"}
    >
      <span>{history.warning}</span>
      {history.retryable ? (
        <button
          type="button"
          className="btn btn-sm"
          onClick={history.retryStorage}
          disabled={history.busy}
        >
          Retry encrypted history
        </button>
      ) : null}
    </div>
  ) : null;

  if (history.loading) {
    return (
      <div className="play-history-empty" role="status" aria-live="polite">
        <p>
          <strong>Loading encrypted request history…</strong>
        </p>
        <p>
          Request values, bodies, resolved URLs, and responses are never saved.
        </p>
      </div>
    );
  }

  if (history.entries.length === 0) {
    return (
      <div className="play-history-empty">
        {storageNotice}
        <p>
          <strong>No requests yet.</strong>
        </p>
        <p>
          Send a request from the explorer and it&apos;ll show up here. History
          is encrypted on this device for up to 30 days and isolated to the
          exact API authority, workspace, and principal. Parameter values,
          bodies, header values, resolved URLs, and responses are never saved.
        </p>
      </div>
    );
  }

  return (
    <div className="play-history">
      {storageNotice}
      <p className="muted" style={{ fontSize: 11, margin: 0 }}>
        Encrypted on this device for up to 30 days. Only route templates,
        methods, status, timing, outcome classification, and omitted-field names
        are retained.
      </p>
      <div className="play-history-toolbar">
        <span className="muted" style={{ fontSize: 12 }}>
          {history.entries.length}{" "}
          {history.entries.length === 1 ? "request" : "requests"}
        </span>
        <span className="spacer" />
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          onClick={() => setConfirmClearOpen(true)}
          disabled={history.busy}
        >
          Clear all
        </button>
      </div>
      <ConfirmModal
        open={confirmClearOpen}
        title="Clear all playground history?"
        description="This permanently removes the encrypted history for this signed-in workspace on this device."
        confirmLabel="Clear all"
        danger
        busy={history.busy}
        onConfirm={async () => {
          if (await history.clear()) setConfirmClearOpen(false);
        }}
        onClose={() => setConfirmClearOpen(false)}
      />
      <ConfirmModal
        open={replayReview !== null}
        title="Open a replay after an unknown outcome?"
        description="The server may have committed the prior request. Verify server state first. This opens a blank new request because values and the exact idempotency key were not saved."
        confirmLabel="Open blank replay draft"
        danger
        onConfirm={() => {
          if (!replayReview) return;
          setConfirmReplay(null);
          onReplay(replayReview);
        }}
        onClose={() => setConfirmReplay(null)}
      />
      <ul className="play-history-list" aria-busy={history.busy}>
        {history.entries.map((e, index) => (
          <li key={e.id} className="play-history-row">
            <button
              type="button"
              className="play-history-entry"
              onClick={() => {
                if (e.ambiguous) {
                  setConfirmReplay({ scope: identityScope, entry: e });
                } else {
                  onReplay(e);
                }
              }}
              aria-label={historyReplayLabel(e, index, history.entries.length)}
            >
              <span
                className={`badge ${methodTone(e.method)}`}
                style={{ fontFamily: "var(--pw-font-mono)" }}
              >
                {e.method}
              </span>
              <span className="play-history-path">{e.pathTemplate}</span>
              {e.bodyOmitted ? (
                <span className="badge" aria-label="Request body was not saved">
                  body private
                </span>
              ) : null}
              {e.customHeaderNamesOmitted?.length ? (
                <span
                  className="badge"
                  aria-label="Custom-header values were not saved"
                >
                  headers private
                </span>
              ) : null}
              {e.parameterNamesOmitted &&
              Object.values(e.parameterNamesOmitted).some(
                (names) => names && names.length > 0,
              ) ? (
                <span
                  className="badge"
                  aria-label="Parameter values were not saved"
                >
                  values private
                </span>
              ) : null}
              {e.ambiguous ? (
                <span
                  className="badge danger"
                  aria-label="Prior request outcome may be unknown"
                >
                  outcome unknown
                </span>
              ) : null}
              <span className={`badge ${historyTone(e)}`}>
                {historyStatus(e)}
              </span>
              <span
                className="muted"
                style={{ fontSize: 11, marginLeft: "auto" }}
              >
                {fmtRelative(e.ts)} · {e.durationMs}ms
              </span>
            </button>
            <span className="play-history-row-actions">
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                aria-label={`Remove ${e.method} ${e.pathTemplate}, request ${index + 1} of ${history.entries.length}, from history`}
                disabled={history.busy}
                onClick={() => void history.remove(e.id)}
              >
                ×
              </button>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function methodTone(m: string): string {
  switch (m.toUpperCase()) {
    case "GET":
      return "";
    case "POST":
      return "success";
    case "PUT":
    case "PATCH":
      return "warning";
    case "DELETE":
      return "danger";
  }
  return "";
}

function historyTone(entry: HistoryEntry): string {
  if (entry.ambiguous || entry.outcome !== "http") return "danger";
  if (entry.status >= 200 && entry.status < 300) return "success";
  if (entry.status >= 300 && entry.status < 400) return "";
  if (entry.status >= 400 && entry.status < 500) return "warning";
  return "danger";
}

function historyStatus(entry: HistoryEntry): string {
  if (entry.ambiguous) return "UNKNOWN";
  switch (entry.outcome) {
    case "aborted":
      return "CANCELLED";
    case "timeout":
      return "TIMEOUT";
    case "network":
      return "NETWORK";
    case "contract":
      return "BLOCKED";
    case "unknown":
      return "UNKNOWN";
    default:
      return entry.status > 0 ? String(entry.status) : "ERROR";
  }
}

function historyReplayLabel(
  entry: HistoryEntry,
  index: number,
  total: number,
): string {
  const omissions = [
    entry.bodyOmitted ? "body private" : "",
    entry.customHeaderNamesOmitted?.length ? "header values private" : "",
    entry.parameterNamesOmitted &&
    Object.values(entry.parameterNamesOmitted).some(
      (names) => names && names.length > 0,
    )
      ? "parameter values private"
      : "",
  ].filter(Boolean);
  const action = `${entry.ambiguous ? "Review unknown outcome before replaying" : "Replay"} ${entry.method} ${entry.pathTemplate}, request ${index + 1} of ${total}`;
  return [
    action,
    `status ${historyStatus(entry)}`,
    `${entry.durationMs} milliseconds`,
    fmtRelative(entry.ts),
    ...omissions,
  ].join(", ");
}

function fmtRelative(ts: number): string {
  const sec = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.round(hr / 24)}d ago`;
}
