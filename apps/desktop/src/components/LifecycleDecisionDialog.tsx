import { type ReactElement, useRef } from "react";

import {
  cancelLifecycleTransition,
  continueLifecycleTransition,
  discardAndRecheckLifecycleTransition,
  recoverAndRecheckLifecycleTransition,
  recheckLifecycleTransition,
  retryLifecycleTransition,
  saveAndRecheckLifecycleTransition,
  useLifecycleDecisionState,
} from "../lib/lifecycle-coordinator";
import { Modal, ModalFooter } from "./Modal";

import "../styles-lifecycle.css";

export function LifecycleDecisionDialog(): ReactElement | null {
  const decision = useLifecycleDecisionState();
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  if (!decision.intent || decision.phase === "idle") return null;

  const busy = [
    "scanning",
    "preparing",
    "discarding",
    "recovering",
    "proceeding",
  ].includes(decision.phase);
  const blockers = decision.concerns.filter(
    (concern) => concern.level === "blocking",
  );
  const hasSave = decision.concerns.some((concern) => concern.canSave);
  const hasDiscard = decision.concerns.some((concern) => concern.canDiscard);
  const hasRecover = decision.concerns.some((concern) => concern.canRecover);
  const canContinue = decision.phase === "review" && blockers.length === 0;

  return (
    <Modal
      open
      size="sm"
      role="alertdialog"
      title={decision.intent.title}
      description={decision.intent.description}
      initialFocusRef={cancelRef}
      closeOnBackdrop={false}
      closeOnEscape={!busy}
      onClose={cancelLifecycleTransition}
    >
      <div className="lifecycle-decision" aria-busy={busy || undefined}>
        {busy ? (
          <div className="lifecycle-decision-status" role="status">
            <span className="lifecycle-decision-spinner" aria-hidden="true" />
            {phaseLabel(decision.phase)}
          </div>
        ) : null}

        {decision.error ? (
          <div className="notice notice-error" role="alert">
            {decision.error}
          </div>
        ) : null}

        {!busy && decision.concerns.length === 0 && !decision.error ? (
          <div className="notice" role="status">
            Registered work is safe for this transition.
          </div>
        ) : null}

        {decision.concerns.length > 0 ? (
          <>
            <p className="lifecycle-decision-intro">
              {blockers.length > 0
                ? "Resolve the blocking work before continuing. Nothing will be discarded automatically."
                : "Review the recoverable work below before continuing."}
            </p>
            <ul className="lifecycle-concern-list">
              {decision.concerns.map((concern) => (
                <li
                  key={`${concern.guardId}:${concern.detail ?? concern.label}`}
                >
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
                    <span className="lifecycle-concern-options">
                      {[
                        concern.canSave ? "save" : null,
                        concern.canRecover ? "recover" : null,
                        concern.canDiscard ? "discard" : null,
                      ]
                        .filter(Boolean)
                        .join(" · ") || "return to this work"}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          </>
        ) : null}
      </div>

      <ModalFooter>
        <button
          ref={cancelRef}
          type="button"
          className="btn"
          disabled={decision.phase === "proceeding"}
          onClick={cancelLifecycleTransition}
        >
          Cancel
        </button>
        {decision.phase === "error" ? (
          <button
            type="button"
            className="btn btn-primary"
            onClick={retryLifecycleTransition}
          >
            Try again
          </button>
        ) : null}
        {decision.phase === "review" ? (
          <>
            <button
              type="button"
              className="btn"
              onClick={() => void recheckLifecycleTransition()}
            >
              Recheck
            </button>
            {hasRecover ? (
              <button
                type="button"
                className="btn"
                onClick={() => void recoverAndRecheckLifecycleTransition()}
              >
                Recover and recheck
              </button>
            ) : null}
            {hasSave ? (
              <button
                type="button"
                className="btn"
                onClick={() => void saveAndRecheckLifecycleTransition()}
              >
                Save and recheck
              </button>
            ) : null}
            {hasDiscard ? (
              <button
                type="button"
                className="btn btn-danger"
                onClick={() => void discardAndRecheckLifecycleTransition()}
              >
                Discard recoverable work
              </button>
            ) : null}
            {canContinue ? (
              <button
                type="button"
                className={
                  decision.intent.danger ? "btn btn-danger" : "btn btn-primary"
                }
                onClick={continueLifecycleTransition}
              >
                {decision.intent.confirmLabel}
              </button>
            ) : null}
          </>
        ) : null}
      </ModalFooter>
    </Modal>
  );
}

function phaseLabel(phase: string): string {
  switch (phase) {
    case "scanning":
      return "Checking drafts, active operations, and recoverable journals…";
    case "preparing":
      return "Saving and rechecking registered work…";
    case "discarding":
      return "Discarding the selected recoverable work…";
    case "recovering":
      return "Recovering registered work…";
    case "proceeding":
      return "Completing the requested transition…";
    default:
      return "Checking registered work…";
  }
}
