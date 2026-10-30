/**
 * StatusBar — VS Code-style bottom strip. Connection dot + URL + version.
 *
 * Now also hosts the offline queue chips (Feature 11):
 *   - "N pending" — total of pending + replaying outbox items.
 *   - "N needs attention" — failed + conflict + dead-letter items.
 * Both chips open the QueueTray slideover on click.
 *
 * Connection state is sourced from onlineManager (see lib/online-manager).
 * StatusBar's only job here is to boot the manager once and render the
 * unified status; visibility / heartbeat / DOM-event wiring lives in the
 * manager so other consumers (query pause, queue replay) can share a
 * single source of truth.
 */

import { Suspense, lazy, type ReactElement, useEffect, useState } from "react";

import { getApiUrl } from "../lib/api-client";
import { startOnlineManager, useOnline } from "../lib/online-manager";
import { useOutbox } from "../lib/outbox";
import { tauriApi } from "../lib/tauri";
import { ActiveSendStrip } from "./dashboard/ActiveSendStrip";

const QueueTray = lazy(() =>
  import("./QueueTray").then((module) => ({ default: module.QueueTray })),
);

export function StatusBar(): ReactElement {
  const conn = useOnline();
  const outbox = useOutbox();
  const [trayOpen, setTrayOpen] = useState(false);
  const [version, setVersion] = useState<string | null>(null);
  const [versionUnavailable, setVersionUnavailable] = useState(false);

  useEffect(() => {
    let mounted = true;
    void (async () => {
      try {
        const result = await tauriApi.getAppVersion();
        if (!mounted) return;
        if (result?.version) setVersion(result.version);
        else setVersionUnavailable(true);
      } catch {
        if (mounted) setVersionUnavailable(true);
      }
    })();
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    const stop = startOnlineManager();
    return () => {
      stop();
    };
  }, []);

  const dotClass =
    conn === "online" ? "dot up" : conn === "offline" ? "dot down" : "dot";
  const label =
    conn === "online"
      ? "Connected"
      : conn === "offline"
        ? "Disconnected"
        : "Connecting…";

  return (
    <>
      <footer className="statusbar" aria-label="Application status">
        <span className={dotClass} aria-hidden="true" />
        <span role="status" aria-live="polite">
          {label}
        </span>
        {outbox.pendingCount > 0 ? (
          <button
            type="button"
            className="statusbar-chip"
            onClick={() => setTrayOpen(true)}
            aria-haspopup="dialog"
            aria-expanded={trayOpen}
          >
            {outbox.pendingCount} offline change
            {outbox.pendingCount === 1 ? "" : "s"} pending
          </button>
        ) : null}
        {outbox.attentionCount > 0 ? (
          <button
            type="button"
            className="statusbar-chip statusbar-chip-danger"
            onClick={() => setTrayOpen(true)}
            aria-haspopup="dialog"
            aria-expanded={trayOpen}
          >
            {outbox.attentionCount} offline change
            {outbox.attentionCount === 1 ? "" : "s"} need attention
          </button>
        ) : null}
        <span className="statusbar-sep" />
        <span className="mono statusbar-api">{getApiUrl()}</span>
        <ActiveSendStrip />
        <span className="spacer" />
        <span className="statusbar-version" role="status" aria-live="polite">
          {version
            ? `Moosewave v${version}`
            : versionUnavailable
              ? "Moosewave version unavailable"
              : "Loading Moosewave version…"}
        </span>
      </footer>
      {trayOpen ? (
        <Suspense
          fallback={
            <div className="notice" role="status" aria-live="polite">
              Opening offline changes…
            </div>
          }
        >
          <QueueTray open onClose={() => setTrayOpen(false)} />
        </Suspense>
      ) : null}
    </>
  );
}
