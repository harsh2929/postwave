/**
 * Fatal renderer recovery surface. Error messages and stacks are deliberately
 * absent: either may contain customer content or credentials. Operators get a
 * stable incident ID and structural diagnostics instead.
 */

import { useState, type ReactElement } from "react";

import type { DesktopIncident } from "../lib/desktop-diagnostics";

const loadRecovery = () => import("../lib/desktop-recovery");

interface ErrorScreenProps {
  error: unknown;
  incident?: DesktopIncident | null;
  onRetry?: (() => void) | undefined;
}

type RecoveryAction =
  | "copy"
  | "restart"
  | "safe-mode"
  | "web"
  | "support"
  | null;

export function ErrorScreen({
  error: _error,
  incident = null,
  onRetry,
}: ErrorScreenProps): ReactElement {
  const [pending, setPending] = useState<RecoveryAction>(null);
  const [feedback, setFeedback] = useState("");
  const incidentLabel = incident?.incidentId ?? "being prepared";

  const run = (
    action: Exclude<RecoveryAction, null>,
    task: () => Promise<void>,
  ): void => {
    if (pending !== null) return;
    setPending(action);
    setFeedback("");
    void task()
      .catch(() => {
        setFeedback(
          "That recovery action could not be completed. Try again or open Support.",
        );
      })
      .finally(() => setPending(null));
  };

  const copy = (): void => {
    if (pending !== null) return;
    setPending("copy");
    setFeedback("");
    void loadRecovery()
      .then((recovery) => recovery.copyDesktopDiagnostics(incident))
      .then((result) => {
        setFeedback(
          result.ok
            ? "Diagnostics copied. The report excludes messages, identities, customer content, and credentials."
            : result.message,
        );
      })
      .catch(() => {
        setFeedback(
          "Diagnostics could not be copied. Keep the incident ID and open Support.",
        );
      })
      .finally(() => setPending(null));
  };

  return (
    <main
      className="pw-screen desktop-error-screen"
      aria-labelledby="fatal-title"
    >
      <div className="pw-wordmark">postwave</div>
      <div role="alert">
        <h1 id="fatal-title">Moosewave hit an unexpected problem</h1>
        <p className="desktop-error-summary">
          Your durable drafts and queued changes remain on this device. Try the
          screen once, restart the app, or use Safe Mode if the problem repeats.
        </p>
      </div>
      <p className="desktop-error-incident">
        <span>Incident</span>
        <strong>{incidentLabel}</strong>
      </p>
      <p className="desktop-error-privacy">
        Copied diagnostics contain app version, platform, incident IDs, error
        types, and component names only. They exclude raw messages, stacks,
        workspace identity, customer content, and credentials.
      </p>
      <div className="pw-actions" aria-label="Recovery actions">
        {onRetry && (
          <button
            type="button"
            className="btn btn-primary"
            disabled={pending !== null}
            onClick={onRetry}
          >
            Try this screen again
          </button>
        )}
        <button
          type="button"
          className="btn btn-secondary"
          disabled={pending !== null}
          onClick={() =>
            run("restart", async () =>
              (await loadRecovery()).restartDesktopApp(),
            )
          }
        >
          {pending === "restart" ? "Restarting…" : "Restart App"}
        </button>
        <button
          type="button"
          className="btn btn-secondary"
          disabled={pending !== null}
          onClick={() =>
            run("safe-mode", async () =>
              (await loadRecovery()).restartDesktopInSafeMode(),
            )
          }
        >
          {pending === "safe-mode" ? "Restarting…" : "Restart in Safe Mode"}
        </button>
        <button
          type="button"
          className="btn btn-secondary"
          disabled={pending !== null}
          onClick={copy}
        >
          {pending === "copy" ? "Copying…" : "Copy diagnostics"}
        </button>
        <button
          type="button"
          className="btn btn-ghost"
          disabled={pending !== null}
          onClick={() =>
            run("web", async () => (await loadRecovery()).openDesktopWebApp())
          }
        >
          {pending === "web" ? "Opening…" : "Open Web App"}
        </button>
        <button
          type="button"
          className="btn btn-ghost"
          disabled={pending !== null}
          onClick={() =>
            run("support", async () =>
              (await loadRecovery()).openDesktopSupport({
                task: "recovery",
                errorCode: incident?.errorCode ?? "RENDERER_FAILURE",
                ...(incident?.incidentId
                  ? { incidentId: incident.incidentId }
                  : {}),
              }),
            )
          }
        >
          {pending === "support" ? "Opening…" : "Support"}
        </button>
      </div>
      <p className="desktop-error-feedback" role="status" aria-live="polite">
        {feedback}
      </p>
    </main>
  );
}
