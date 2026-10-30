import { type ReactElement, useEffect, useId, useRef, useState } from "react";

import { Modal, ModalFooter } from "../Modal";
import { TimeEvidence } from "./MigrationHistorySurface";
import { formatMigrationCount } from "./migrations-surface-helpers";

interface MigrationDestructiveDialogProps {
  open: boolean;
  kind: "cancel" | "rollback";
  jobId: string;
  sourceLabel: string;
  busy: boolean;
  importedSubscribers?: number;
  rollbackDeadline?: string | null;
  onClose: () => void;
  onConfirm: () => void;
}

export function MigrationDestructiveDialog({
  open,
  kind,
  jobId,
  sourceLabel,
  busy,
  importedSubscribers,
  rollbackDeadline,
  onClose,
  onConfirm,
}: MigrationDestructiveDialogProps): ReactElement | null {
  const [typed, setTyped] = useState("");
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const inputId = useId();
  const instructionId = useId();
  const validationId = useId();
  const busyId = useId();
  const matches = typed === jobId;
  const unavailable = busy || !matches;
  const copy = destructiveCopy(kind);

  useEffect(() => {
    if (open) setTyped("");
  }, [jobId, kind, open]);

  if (!open) return null;
  return (
    <Modal
      open={true}
      onClose={() => {
        if (!busy) onClose();
      }}
      title={copy.title}
      description={copy.description}
      role="alertdialog"
      initialFocusRef={cancelRef}
      closeOnBackdrop={false}
      closeOnEscape={!busy}
    >
      <div className="migration-confirm-body">
        <dl className="migration-kv-list">
          <div>
            <dt>Source</dt>
            <dd>{sourceLabel}</dd>
          </div>
          <div>
            <dt>Exact job identifier</dt>
            <dd>
              <code>{jobId}</code>
            </dd>
          </div>
          <div>
            <dt>Subscribers reported imported</dt>
            <dd>{formatMigrationCount(importedSubscribers)}</dd>
          </div>
          {kind === "rollback" ? (
            <div>
              <dt>Verified rollback deadline</dt>
              <dd>
                {rollbackDeadline ? (
                  <TimeEvidence value={rollbackDeadline} />
                ) : (
                  "Not reported"
                )}
              </dd>
            </div>
          ) : null}
        </dl>

        <div className="migration-truth-callout is-limited">
          <strong>{copy.consequenceTitle}</strong>
          <span>{copy.consequence}</span>
        </div>

        <div className="field migration-confirm-field">
          <label id={instructionId} className="field-label" htmlFor={inputId}>
            Type the exact job identifier <strong>{jobId}</strong>
          </label>
          <input
            id={inputId}
            className="input mono"
            type="text"
            autoComplete="off"
            spellCheck={false}
            value={typed}
            readOnly={busy}
            aria-invalid={typed.length > 0 && !matches ? "true" : undefined}
            aria-describedby={`${instructionId} ${validationId}${busy ? ` ${busyId}` : ""}`}
            onChange={(event) => setTyped(event.target.value)}
          />
          <p
            id={validationId}
            className={matches ? "field-help" : "field-error"}
          >
            {matches
              ? "Exact identifier matched. Review the consequence before confirming."
              : "The full identifier must match exactly; spaces and partial identifiers are not accepted."}
          </p>
        </div>

        {busy ? (
          <p id={busyId} className="migration-action-reason" role="status">
            The server acknowledgement is pending. This dialog cannot be
            dismissed or submitted again until it settles.
          </p>
        ) : null}
      </div>

      <ModalFooter>
        <button
          ref={cancelRef}
          type="button"
          className="btn"
          aria-disabled={busy || undefined}
          aria-describedby={busy ? busyId : undefined}
          onClick={() => {
            if (!busy) onClose();
          }}
        >
          {copy.cancelLabel}
        </button>
        <button
          type="button"
          className="btn btn-danger"
          aria-disabled={unavailable || undefined}
          aria-busy={busy || undefined}
          aria-describedby={!matches ? validationId : busy ? busyId : undefined}
          onClick={() => {
            if (!unavailable) onConfirm();
          }}
        >
          {busy ? copy.busyLabel : copy.confirmLabel}
        </button>
      </ModalFooter>
    </Modal>
  );
}

function destructiveCopy(kind: "cancel" | "rollback"): {
  title: string;
  description: string;
  consequenceTitle: string;
  consequence: string;
  confirmLabel: string;
  busyLabel: string;
  cancelLabel: string;
} {
  if (kind === "cancel") {
    return {
      title: "Cancel at the next safe checkpoint?",
      description:
        "The source platform is unchanged. Destination records already acknowledged by the runner remain in Moosewave.",
      consequenceTitle: "Cancellation does not roll back imported records.",
      consequence:
        "After the runner stops, review the partial verification evidence and verified rollback deadline before resuming or managing destination data.",
      confirmLabel: "Cancel this migration",
      busyLabel: "Requesting cancellation…",
      cancelLabel: "Keep running",
    };
  }
  return {
    title: "Roll back this migration's destination records?",
    description:
      "The source platform is unchanged. This queues a tenant data mutation for the exact migration job below.",
    consequenceTitle: "Records attributed to this job will be removed.",
    consequence:
      "Review the final verification evidence first. Records that predated the migration should remain, but the rollback acknowledgement does not itself prove final deletion completeness.",
    confirmLabel: "Roll back this migration",
    busyLabel: "Requesting rollback…",
    cancelLabel: "Keep imported records",
  };
}
