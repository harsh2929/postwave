import { type ReactElement, useEffect, useId, useRef, useState } from "react";

import type { MigrationJob } from "../../lib/api-client";
import { findSource } from "../../lib/migration-sources";
import { Modal, ModalFooter } from "../Modal";
import { MigrationStatusBadge, TimeEvidence } from "./MigrationHistorySurface";
import {
  formatMigrationCount,
  migrationRollbackEligibility,
} from "./migrations-surface-helpers";

export type MigrationActionKind = "cancel" | "resume" | "rollback";

export function MigrationActionDialog({
  kind,
  job,
  busy,
  onClose,
  onConfirm,
}: {
  kind: MigrationActionKind;
  job: MigrationJob;
  busy: boolean;
  onClose: () => void;
  onConfirm: () => void;
}): ReactElement {
  const [typed, setTyped] = useState("");
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const inputId = useId();
  const instructionId = useId();
  const validationId = useId();
  const busyId = useId();
  const requiresExactJob = kind === "rollback" || kind === "cancel";
  const matches = !requiresExactJob || typed === job.id;
  const unavailable = busy || !matches;
  const copy = actionCopy(kind);
  const source = findSource(job.source)?.name ?? "Unknown source";
  const rollback = migrationRollbackEligibility(job, true);

  useEffect(() => setTyped(""), [job.id, kind]);

  return (
    <Modal
      open={true}
      onClose={() => {
        if (!busy) onClose();
      }}
      title={copy.title}
      description={copy.description}
      role={kind === "resume" ? "dialog" : "alertdialog"}
      initialFocusRef={cancelRef}
      closeOnBackdrop={false}
      closeOnEscape={!busy}
    >
      <div className="migration-confirm-body">
        <dl className="migration-kv-list">
          <div>
            <dt>Source</dt>
            <dd>
              {source} · <code>{job.source}</code>
            </dd>
          </div>
          <div>
            <dt>Exact job identifier</dt>
            <dd>
              <code>{job.id}</code>
            </dd>
          </div>
          <div>
            <dt>Current status</dt>
            <dd>
              <MigrationStatusBadge status={job.status} />
            </dd>
          </div>
          <div>
            <dt>Started</dt>
            <dd>
              <TimeEvidence value={job.started_at} />
            </dd>
          </div>
          {kind === "rollback" ? (
            <div>
              <dt>Verified rollback deadline</dt>
              <dd>
                {rollback.deadline ? (
                  <TimeEvidence value={rollback.deadline} />
                ) : (
                  rollback.reason
                )}
              </dd>
            </div>
          ) : null}
          <div>
            <dt>Subscribers reported imported</dt>
            <dd>
              {formatMigrationCount(
                job.verification_report?.subscribers_imported ??
                  job.progress?.subscribers_done,
              )}
            </dd>
          </div>
        </dl>

        <div
          className={`migration-truth-callout ${kind === "resume" ? "is-supported" : "is-limited"}`}
        >
          <strong>{copy.consequenceTitle}</strong>
          <span>{copy.consequence}</span>
        </div>

        {requiresExactJob ? (
          <div className="field migration-confirm-field">
            <label id={instructionId} className="field-label" htmlFor={inputId}>
              Type the exact job identifier <strong>{job.id}</strong>
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
        ) : null}

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
          className={kind === "resume" ? "btn btn-primary" : "btn btn-danger"}
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

function actionCopy(kind: MigrationActionKind): {
  title: string;
  description: string;
  consequenceTitle: string;
  consequence: string;
  confirmLabel: string;
  busyLabel: string;
  cancelLabel: string;
} {
  if (kind === "rollback") {
    return {
      title: "Roll back imported records?",
      description:
        "This is a one-shot tenant mutation. The source platform is never changed.",
      consequenceTitle: "Imported destination records will be removed.",
      consequence:
        "Subscribers, segments, and other resources attributed to this job are removed according to server rollback evidence. The rollback cannot be replayed after the window closes.",
      confirmLabel: "Roll back this job",
      busyLabel: "Requesting rollback…",
      cancelLabel: "Keep imported records",
    };
  }
  if (kind === "cancel") {
    return {
      title: "Cancel at the next checkpoint?",
      description:
        "The runner stops at a safe checkpoint; records already imported remain in Moosewave.",
      consequenceTitle: "This does not undo imported records.",
      consequence:
        "The cancellation request is idempotent. After the job stops, review its partial verification evidence before resuming or managing imported destination data.",
      confirmLabel: "Cancel this job",
      busyLabel: "Requesting cancellation…",
      cancelLabel: "Keep running",
    };
  }
  return {
    title: "Resume from the recorded checkpoint?",
    description:
      "The server restarts this cancelled job from its durable checkpoint.",
    consequenceTitle: "Previously imported records stay in place.",
    consequence:
      "The runner continues remaining work and does not intentionally re-import acknowledged records. Final completeness still depends on the post-run verification report.",
    confirmLabel: "Resume from checkpoint",
    busyLabel: "Requesting resume…",
    cancelLabel: "Leave cancelled",
  };
}
