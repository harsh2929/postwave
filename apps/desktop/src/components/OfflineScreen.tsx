/**
 * Shown when `navigator.onLine === false` at boot, or when a redirect
 * fails because the network is unreachable.
 *
 * Lists which surfaces stay usable offline (cached reads + queued
 * writes) vs. which ones are online-only, so the operator can decide
 * whether to wait for connectivity or carry on. When the outbox is
 * non-empty, surfaces a deep link to QueueTray so they can review
 * what's parked.
 */

import { Suspense, lazy, type ReactElement, useState } from "react";

import { useOutbox } from "../lib/outbox";

const QueueTray = lazy(() =>
  import("./QueueTray").then((module) => ({ default: module.QueueTray })),
);

interface OfflineScreenProps {
  onRetry: () => void;
}

const OFFLINE_CACHED: string[] = [
  "Dashboard stats from a previous successful load (up to 1 hour old)",
  "The encrypted sync journal and conflict tools",
  "Edits already accepted into the journal before this screen appeared",
];

const ONLINE_ONLY: string[] = [
  "Opening forms, templates, lists, segments, tags, or subscribers",
  "Send campaign / schedule",
  "Billing, auth, API keys",
  "Privacy & compliance settings",
  "Migration tools",
];

export function OfflineScreen({ onRetry }: OfflineScreenProps): ReactElement {
  const outbox = useOutbox();
  const [trayOpen, setTrayOpen] = useState(false);
  const queued = outbox.pendingCount + outbox.attentionCount;

  return (
    <div className="pw-screen" role="alert">
      <div className="pw-wordmark">postwave</div>
      <h1>You appear to be offline</h1>
      <p>
        Moosewave cannot verify the API right now. Previously accepted queued
        changes remain encrypted on this device; they are not treated as server
        saves until replay succeeds.
      </p>
      {outbox.persistenceError ? (
        <div className="notice notice-danger" role="alert">
          <strong>Offline storage needs attention</strong>
          <div>{outbox.persistenceError}</div>
          <div>Keep Moosewave open and review the sync journal.</div>
        </div>
      ) : null}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 16,
          margin: "16px 0",
          maxWidth: 640,
          textAlign: "left",
        }}
      >
        <div>
          <h3
            style={{
              fontSize: 12,
              textTransform: "uppercase",
              letterSpacing: "0.04em",
              margin: "0 0 6px",
              opacity: 0.75,
            }}
          >
            Available on this screen
          </h3>
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13 }}>
            {OFFLINE_CACHED.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ul>
        </div>
        <div>
          <h3
            style={{
              fontSize: 12,
              textTransform: "uppercase",
              letterSpacing: "0.04em",
              margin: "0 0 6px",
              opacity: 0.75,
            }}
          >
            Online only
          </h3>
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13 }}>
            {ONLINE_ONLY.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ul>
        </div>
      </div>
      <div className="pw-actions">
        <button type="button" className="primary" onClick={onRetry}>
          Retry
        </button>
        {queued > 0 || outbox.persistenceError ? (
          <button type="button" onClick={() => setTrayOpen(true)}>
            Open sync journal{queued > 0 ? ` (${queued})` : ""}
          </button>
        ) : null}
      </div>
      {trayOpen ? (
        <Suspense fallback={null}>
          <QueueTray open onClose={() => setTrayOpen(false)} />
        </Suspense>
      ) : null}
    </div>
  );
}
