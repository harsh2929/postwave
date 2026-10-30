/**
 * OfflineBanner — top-of-app yellow strip that appears only when we are
 * offline AND the outbox is non-empty. Clicking "View" opens the
 * QueueTray.
 *
 * Mounting once at AppShell level keeps this banner orthogonal to per-page
 * layout — it sits above the topbar without colliding with any route.
 *
 * Also fires a sonner-equivalent toast on the offline→online transition
 * once the outbox has fully drained: "All changes synced".
 */

import {
  Suspense,
  lazy,
  type ReactElement,
  useEffect,
  useRef,
  useState,
} from "react";

import { flushQueuedMutations } from "../lib/api-client";
import { connectivitySupportErrorCode } from "../lib/contextual-help";
import { requestContextualHelpOpen } from "../lib/help-launcher";
import {
  useConnectivity,
  type ConnectivityReason,
} from "../lib/online-manager";
import { useOutbox } from "../lib/outbox";
import { toast } from "./Toast";

const QueueTray = lazy(() =>
  import("./QueueTray").then((module) => ({ default: module.QueueTray })),
);

export function OfflineBanner(): ReactElement | null {
  const connectivity = useConnectivity();
  const conn = connectivity.status;
  const outbox = useOutbox();
  const [trayOpen, setTrayOpen] = useState(false);
  const lastConnRef = useRef(conn);

  // Reconnect handler: flush queued mutations and fire a one-shot toast
  // reporting the outcome. Uses the same flushQueuedMutations entry
  // point as the api-client so we don't fork the drain policy.
  useEffect(() => {
    const prev = lastConnRef.current;
    lastConnRef.current = conn;
    if (prev !== "online" && conn === "online") {
      const queuedAtTransition = outbox.pendingCount + outbox.attentionCount;
      if (queuedAtTransition === 0) return;
      void (async () => {
        const summary = await flushQueuedMutations();
        if (
          summary.replayed > 0 &&
          summary.failed === 0 &&
          summary.conflicts === 0
        ) {
          toast.success("All changes synced");
        } else if (summary.failed > 0 || summary.conflicts > 0) {
          toast.error({
            message: "Some changes failed to sync",
            detail: `${summary.failed} failed, ${summary.conflicts} conflicts. Open the queue to retry.`,
            action: {
              label: "Open queue",
              onClick: () => setTrayOpen(true),
            },
          });
        }
      })();
    }
  }, [conn, outbox.pendingCount, outbox.attentionCount]);

  const total = outbox.pendingCount + outbox.attentionCount;
  const visible =
    conn !== "online" || total > 0 || outbox.persistenceError !== null;

  const statusCopy = outbox.persistenceError
    ? "Offline storage needs attention — open the sync journal before closing Moosewave."
    : conn === "offline"
      ? `${connectivityReasonCopy(connectivity.reason)}${
          total > 0
            ? ` · ${total} ${total === 1 ? "change is" : "changes are"} retained on this device.`
            : ""
        }`
      : conn === "connecting"
        ? "Checking the Moosewave API connection…"
        : `${total} ${total === 1 ? "change is" : "changes are"} pending server confirmation.`;

  return (
    <>
      {visible ? (
        <div
          className="offline-banner"
          role={outbox.persistenceError ? "alert" : "status"}
          aria-live={outbox.persistenceError ? "assertive" : "polite"}
        >
          <span className="offline-banner-dot" aria-hidden="true" />
          <span className="offline-banner-text">{statusCopy}</span>
          <button
            type="button"
            className="offline-banner-link"
            onClick={() => setTrayOpen(true)}
          >
            Open sync journal →
          </button>
          {conn === "offline" && !outbox.persistenceError ? (
            <button
              type="button"
              className="offline-banner-link"
              onClick={() => {
                const errorCode = connectivitySupportErrorCode(
                  connectivity.reason,
                );
                requestContextualHelpOpen({
                  task: "recovery",
                  ...(errorCode ? { errorCode } : {}),
                });
              }}
            >
              Connection help
            </button>
          ) : null}
        </div>
      ) : null}
      {trayOpen ? (
        <Suspense fallback={null}>
          <QueueTray open onClose={() => setTrayOpen(false)} />
        </Suspense>
      ) : null}
    </>
  );
}

function connectivityReasonCopy(reason: ConnectivityReason): string {
  switch (reason) {
    case "no-interface":
      return "No network connection";
    case "internet-unavailable":
      return "Network connected, but the internet is unavailable";
    case "api-unavailable":
      return "Internet may be available, but the Moosewave API is unreachable";
    case "maintenance":
      return "Moosewave API maintenance is in progress";
    case "authentication":
      return "Moosewave is reachable, but this session needs authentication";
    case "captive-portal":
      return "A network sign-in page may be blocking Moosewave";
    case "proxy-tls":
      return "A proxy or TLS certificate is blocking the Moosewave API";
    case "connecting":
      return "Checking the Moosewave API connection…";
    case "online":
      return "Online";
  }
}
