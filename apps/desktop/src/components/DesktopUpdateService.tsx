import { type ReactElement, useEffect } from "react";

import {
  claimDesktopUpdatePrompt,
  closeDesktopUpdateRestartDecision,
  confirmDesktopUpdateRestart,
  deferDesktopUpdate,
  initializeDesktopUpdateService,
  installDesktopUpdate,
  requestDesktopUpdateRestart,
  useDesktopUpdateState,
} from "../lib/desktop-update-service";
import { Modal, ModalFooter } from "./Modal";
import { toast } from "./Toast";

import "../styles-desktop-update.css";

/**
 * Root-owned updater presentation. The singleton listener is initialized even
 * earlier from main.tsx; this component owns global prompts and the restart
 * safety decision for every boot/auth/application surface.
 */
export function DesktopUpdateService(): ReactElement | null {
  const update = useDesktopUpdateState();

  useEffect(() => {
    void initializeDesktopUpdateService();
  }, []);

  useEffect(() => {
    if (!claimDesktopUpdatePrompt()) return;
    if (update.phase === "ready_to_restart") {
      toast.info({
        message: "Restart to finish updating Moosewave",
        detail: update.latestVersion
          ? `Version ${update.latestVersion} is installed and ready.`
          : "The signed update is installed and ready.",
        action: {
          label: "Review restart",
          onClick: () => void requestDesktopUpdateRestart(),
        },
        duration: 30_000,
      });
      return;
    }
    if (update.phase === "available") {
      toast.info({
        message: `Moosewave ${update.latestVersion ?? "update"} is available`,
        detail: `${severityLabel(update.severity)} update. Review the release notes in Desktop settings.`,
        action: {
          label: "Install",
          onClick: () => void installDesktopUpdate(),
        },
        duration: 30_000,
      });
    }
  }, [
    update.latestVersion,
    update.phase,
    update.severity,
    update.snoozedUntil,
    update.lastPromptedAt,
  ]);

  const decision = update.restartDecision;
  if (!decision) return null;
  const blocking = decision.concerns.filter(
    (concern) => concern.level === "blocking",
  );
  const warnings = decision.concerns.filter(
    (concern) => concern.level === "warning",
  );
  const canRestart = decision.status === "ready" && blocking.length === 0;

  return (
    <Modal
      open
      size="sm"
      title="Restart Moosewave to finish the update?"
      description="Moosewave checks registered drafts and active operations before relaunching."
      onClose={closeDesktopUpdateRestartDecision}
    >
      <div className="desktop-update-restart-body">
        {decision.status === "scanning" ? (
          <div className="desktop-update-safety-status" role="status">
            <span className="desktop-update-spinner" aria-hidden="true" />
            Checking unsaved work and active operations…
          </div>
        ) : decision.concerns.length === 0 ? (
          <div className="desktop-update-safety-safe" role="status">
            <strong>Registered work is restart-safe.</strong>
            <span>
              No registered draft, upload, or background operation reported a
              risk. Moosewave will reopen on the installed version.
            </span>
          </div>
        ) : (
          <>
            <p className="desktop-update-safety-intro">
              {blocking.length > 0
                ? "Finish the blocking work below before restarting."
                : "The following work may be interrupted. Restart only if you have reviewed it."}
            </p>
            <ul className="desktop-update-concern-list">
              {decision.concerns.map((concern) => (
                <li key={`${concern.guardId}:${concern.label}`}>
                  <span
                    className={`badge ${
                      concern.level === "blocking" ? "danger" : "warning"
                    }`}
                  >
                    {concern.level === "blocking" ? "Blocking" : "Review"}
                  </span>
                  <div>
                    <strong>{concern.label}</strong>
                    {concern.detail ? <p>{concern.detail}</p> : null}
                  </div>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
      <ModalFooter>
        <button
          type="button"
          className="btn"
          onClick={() => {
            deferDesktopUpdate(4 * 60 * 60 * 1000);
            toast.info("Restart reminder set for four hours from now");
          }}
          disabled={update.restarting}
        >
          Restart later
        </button>
        {canRestart ? (
          <button
            type="button"
            className={
              warnings.length > 0 ? "btn btn-danger" : "btn btn-primary"
            }
            onClick={() => void confirmDesktopUpdateRestart()}
            disabled={update.restarting}
          >
            {update.restarting
              ? "Preparing restart…"
              : warnings.length > 0
                ? "Restart anyway"
                : "Restart now"}
          </button>
        ) : null}
      </ModalFooter>
    </Modal>
  );
}

function severityLabel(severity: string): string {
  switch (severity) {
    case "critical":
      return "Critical security";
    case "important":
      return "Important";
    case "informational":
      return "Optional";
    default:
      return "Recommended";
  }
}
