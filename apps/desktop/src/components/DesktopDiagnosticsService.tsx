import { useState, useSyncExternalStore, type ReactElement } from "react";

import {
  dismissNativeCrashNotice,
  getDesktopDiagnosticsState,
  subscribeDesktopDiagnostics,
} from "../lib/desktop-diagnostics";
import {
  copyDesktopDiagnostics,
  openDesktopSupport,
  restartDesktopInSafeMode,
  restartDesktopNormally,
} from "../lib/desktop-recovery";

type PendingAction = "copy" | "safe-mode" | "normal" | "support" | null;

/**
 * Root-level recovery notice. It intentionally lives outside AppErrorBoundary
 * so a failed product surface cannot remove the operator's recovery controls.
 */
export function DesktopDiagnosticsService(): ReactElement | null {
  const state = useSyncExternalStore(
    subscribeDesktopDiagnostics,
    getDesktopDiagnosticsState,
    getDesktopDiagnosticsState,
  );
  const [pending, setPending] = useState<PendingAction>(null);
  const [announcement, setAnnouncement] = useState("");

  if (!state.safeMode && !state.nativeCrash) return null;

  const run = (
    action: Exclude<PendingAction, null>,
    task: () => Promise<void>,
  ) => {
    if (pending !== null) return;
    setPending(action);
    setAnnouncement("");
    void task()
      .catch(() => {
        setAnnouncement(
          "That recovery action could not be completed. Try again or open Support.",
        );
      })
      .finally(() => setPending(null));
  };

  const copy = (): void => {
    if (pending !== null) return;
    setPending("copy");
    setAnnouncement("");
    void copyDesktopDiagnostics(state.nativeCrash)
      .then((result) => {
        setAnnouncement(
          result.ok
            ? "Diagnostics copied. The report contains structural app details, not messages, identities, content, or credentials."
            : result.message,
        );
      })
      .catch(() => {
        setAnnouncement(
          "Diagnostics could not be copied. Keep the incident ID and open Support.",
        );
      })
      .finally(() => setPending(null));
  };

  return (
    <aside
      className="desktop-diagnostics-notice"
      aria-labelledby="desktop-diagnostics-notice-title"
    >
      <div>
        <strong id="desktop-diagnostics-notice-title">
          {state.safeMode
            ? "Moosewave is running in Safe Mode"
            : "Moosewave recovered from a native crash"}
        </strong>
        <p>
          {state.safeMode
            ? "Optional telemetry, update checks, live notifications, tours, and onboarding are paused for this launch. Your durable drafts and sync journal are preserved."
            : `Incident ${state.nativeCrash?.incidentId ?? "unavailable"}. Copy the privacy-safe diagnostics before continuing if the problem repeats.`}
        </p>
      </div>
      <div className="desktop-diagnostics-notice-actions">
        <button
          type="button"
          className="btn btn-secondary"
          disabled={pending !== null}
          onClick={copy}
        >
          {pending === "copy" ? "Copying…" : "Copy diagnostics"}
        </button>
        {state.safeMode ? (
          <button
            type="button"
            className="btn btn-primary"
            disabled={pending !== null}
            onClick={() => run("normal", () => restartDesktopNormally())}
          >
            {pending === "normal" ? "Restarting…" : "Restart normally"}
          </button>
        ) : (
          <button
            type="button"
            className="btn btn-secondary"
            disabled={pending !== null}
            onClick={() => run("safe-mode", () => restartDesktopInSafeMode())}
          >
            {pending === "safe-mode" ? "Restarting…" : "Restart in Safe Mode"}
          </button>
        )}
        <button
          type="button"
          className="btn btn-ghost"
          disabled={pending !== null}
          onClick={() =>
            run("support", () =>
              openDesktopSupport({
                task: "recovery",
                errorCode: state.safeMode ? "SAFE_MODE" : "NATIVE_CRASH",
                ...(state.nativeCrash?.incidentId
                  ? { incidentId: state.nativeCrash.incidentId }
                  : {}),
              }),
            )
          }
        >
          {pending === "support" ? "Opening…" : "Support"}
        </button>
        {state.nativeCrash && (
          <button
            type="button"
            className="btn btn-ghost"
            disabled={pending !== null}
            onClick={dismissNativeCrashNotice}
            aria-label="Dismiss native crash notice"
          >
            Dismiss
          </button>
        )}
      </div>
      <p className="visually-hidden" role="status" aria-live="polite">
        {announcement}
      </p>
      {announcement && (
        <p className="desktop-diagnostics-feedback" aria-hidden="true">
          {announcement}
        </p>
      )}
    </aside>
  );
}
