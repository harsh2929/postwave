/**
 * Production detail surface for one saved audience segment.
 *
 * A recompute is a synchronous server evaluation. The count shown here is a
 * cached evaluation result, not a live audience total, and evaluation
 * snapshots remain separate bounded records owned by SegmentSnapshotsSection.
 */

import { type ReactElement, useEffect, useId, useRef, useState } from "react";

import { useSingleFlightOperation } from "../../hooks/useSettingsDraftLifecycle";
import { useSlideoverBehavior } from "../../hooks/useSlideoverBehavior";
import { fmtDateTime, fmtRelative } from "../../lib/format-date";
import {
  remoteFailureFromError,
  type RemoteApiError,
  type RemoteFailure,
} from "../../lib/remote-resource";
import { useCanWrite } from "../../lib/store";
import { toast } from "../Toast";
import { SegmentDecaySection } from "./SegmentDecaySection";
import { SegmentGrowthReport } from "./SegmentGrowthReport";
import { SegmentPnLPanel } from "./SegmentPnLPanel";
import { SegmentSnapshotsSection } from "./SegmentSnapshotsSection";
import {
  type RecomputeResult,
  type Segment,
  segmentsClient,
} from "./segmentsClient";

import "./SegmentDetailSlideover.css";

interface Props {
  segment: Segment;
  onClose: () => void;
  /** Called with the refreshed segment after a verified recompute response. */
  onRecomputed?: (next: Segment) => void;
  /** Opens the owner's destructive-action confirmation; this surface never deletes directly. */
  onDelete?: (segment: Segment) => void;
}

interface ConfirmedEvaluation {
  segmentId: string;
  count: number;
  startedAt: string;
  parentReconciliation: "not-requested" | "notified" | "failed";
}

interface RecomputeFailure extends RemoteFailure {
  segmentId: string;
}

interface RecomputeController {
  active: boolean;
  activeTargetId: string | null;
  confirmed: ConfirmedEvaluation | null;
  failure: RecomputeFailure | null;
  isActive: () => boolean;
  recompute: () => Promise<void>;
}

const MAX_AST_DISPLAY_CHARACTERS = 100_000;

function validIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value === value.trim() &&
    value.length > 0 &&
    value.length <= 512
  );
}

function validTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 128 &&
    Number.isFinite(Date.parse(value))
  );
}

function validCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function hasStoredPredicate(segment: Segment): boolean {
  return segment.queryAst !== undefined && segment.queryAst !== null;
}

function normalizeRecomputeResult(value: unknown): RecomputeResult | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  return validCount(record.count) && validTimestamp(record.scheduled_at)
    ? { count: record.count, scheduled_at: record.scheduled_at }
    : null;
}

function mutationFailure(error: RemoteApiError): RemoteFailure {
  const failure = remoteFailureFromError(error);
  if (failure.access === "denied") {
    return {
      ...failure,
      message:
        "Your current role no longer permits segment recomputation. Ask a workspace administrator to review your access.",
    };
  }
  if (error.kind === "parse") {
    return {
      ...failure,
      message:
        "The server returned a recompute result that could not be verified. Retry before relying on a new count.",
    };
  }
  return failure;
}

function diagnosticReference(failure: RemoteFailure): string {
  return [failure.code, failure.requestId].filter(Boolean).join(" · ");
}

function useSegmentRecompute({
  segment,
  canMutate,
  onRecomputed,
}: Pick<Props, "segment" | "onRecomputed"> & {
  canMutate: boolean;
}): RecomputeController {
  const mountedRef = useRef(true);
  const currentSegmentIdRef = useRef(segment.id);
  currentSegmentIdRef.current = segment.id;
  const [activeTargetId, setActiveTargetId] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState<ConfirmedEvaluation | null>(null);
  const [failure, setFailure] = useState<RecomputeFailure | null>(null);
  const operation = useSingleFlightOperation({
    ownerId: `segment-recompute:${segment.id}`,
    label: "Segment recompute",
    detail:
      "Wait for the server to confirm this segment evaluation before leaving Moosewave.",
  });

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const isCurrent = (segmentId: string): boolean =>
    mountedRef.current && currentSegmentIdRef.current === segmentId;

  const reportFailure = (segmentId: string, error: RemoteApiError): void => {
    if (!isCurrent(segmentId)) return;
    const next = { ...mutationFailure(error), segmentId };
    setFailure(next);
    const reference = diagnosticReference(next);
    toast.error({
      message: "Segment recompute was not confirmed.",
      detail: `${next.message}${reference ? ` Reference: ${reference}.` : ""} The previous cached count remains unchanged.`,
    });
  };

  const recompute = async (): Promise<void> => {
    if (
      !canMutate ||
      !validIdentifier(segment.id) ||
      !hasStoredPredicate(segment) ||
      operation.promiseRef.current
    ) {
      return;
    }
    const target = segment;
    setFailure(null);
    setConfirmed(null);
    setActiveTargetId(target.id);
    const request = operation.run(async (): Promise<void> => {
      let response;
      try {
        response = await Promise.resolve().then(() =>
          segmentsClient.recompute(target.id),
        );
      } catch {
        reportFailure(target.id, { kind: "network" });
        return;
      }
      if (!isCurrent(target.id)) return;
      if (response.error) {
        reportFailure(target.id, response.error);
        return;
      }
      const result = normalizeRecomputeResult(response.data);
      if (!result) {
        reportFailure(target.id, {
          kind: "parse",
          code: "invalid_segment_recompute_result",
        });
        return;
      }
      const nextEvaluation: ConfirmedEvaluation = {
        segmentId: target.id,
        count: result.count,
        startedAt: result.scheduled_at,
        parentReconciliation: "not-requested",
      };
      setFailure(null);
      if (onRecomputed) {
        try {
          onRecomputed({
            ...target,
            lastCount: result.count,
            lastEvaluatedAt: result.scheduled_at,
          });
          nextEvaluation.parentReconciliation = "notified";
        } catch {
          nextEvaluation.parentReconciliation = "failed";
        }
      }
      setConfirmed(nextEvaluation);
      toast.success({
        message: "Segment recompute confirmed.",
        detail: `The server confirmed ${result.count.toLocaleString()} member${result.count === 1 ? "" : "s"} for segment ${target.id}. Evaluation started ${fmtDateTime(result.scheduled_at)}.${nextEvaluation.parentReconciliation === "failed" ? " Refresh the segment list to reconcile its row." : ""}`,
      });
    });
    if (!request) return;
    try {
      await request;
    } catch {
      reportFailure(target.id, { kind: "network" });
    } finally {
      if (mountedRef.current) {
        setActiveTargetId((current) =>
          current === target.id ? null : current,
        );
      }
    }
  };

  return {
    active: operation.active || operation.promiseRef.current !== null,
    activeTargetId,
    confirmed,
    failure,
    isActive: () => operation.promiseRef.current !== null,
    recompute,
  };
}

function MetadataTime({
  value,
  absent,
}: {
  value: string | null | undefined;
  absent: string;
}): ReactElement {
  if (!value) return <span className="muted">{absent}</span>;
  if (!validTimestamp(value)) {
    return (
      <span className="segment-detail-unverified">Unverified timestamp</span>
    );
  }
  return (
    <span>
      <time dateTime={value}>{fmtDateTime(value)}</time>{" "}
      <span className="muted">({fmtRelative(value)})</span>
    </span>
  );
}

function segmentType(segment: Segment): {
  label: string;
  description: string;
  tone: string;
} {
  if (segment.kind === "static") {
    return {
      label: "Static",
      description: "Type supplied by this segment record.",
      tone: "",
    };
  }
  if (segment.kind === "ai") {
    return {
      label: "AI-suggested",
      description:
        "Suggestion origin supplied by this segment record; the stored predicate remains the evaluation source.",
      tone: "accent",
    };
  }
  return {
    label: "Dynamic",
    description:
      segment.kind === "dynamic"
        ? "Type supplied by this segment record."
        : "No type was supplied, so this UI labels the saved predicate as dynamic.",
    tone: "success",
  };
}

function serializedPredicate(queryAst: unknown): {
  text: string | null;
  truncated: boolean;
  unavailable: boolean;
} {
  if (queryAst === undefined || queryAst === null) {
    return { text: null, truncated: false, unavailable: false };
  }
  try {
    const text = JSON.stringify(queryAst, null, 2);
    if (text === undefined) {
      return { text: null, truncated: false, unavailable: true };
    }
    return text.length > MAX_AST_DISPLAY_CHARACTERS
      ? {
          text: `${text.slice(0, MAX_AST_DISPLAY_CHARACTERS)}\n… Display truncated after ${MAX_AST_DISPLAY_CHARACTERS.toLocaleString()} characters.`,
          truncated: true,
          unavailable: false,
        }
      : { text, truncated: false, unavailable: false };
  } catch {
    return { text: null, truncated: false, unavailable: true };
  }
}

function SegmentOverview({
  segment,
  count,
  evaluatedAt,
  evaluationStatus,
}: {
  segment: Segment;
  count: number | null;
  evaluatedAt: string | null | undefined;
  evaluationStatus: string;
}): ReactElement {
  const headingId = useId();
  const type = segmentType(segment);
  return (
    <section className="card segment-detail-card" aria-labelledby={headingId}>
      <header className="segment-detail-card-header">
        <div>
          <h3 id={headingId} className="section-title">
            Segment record
          </h3>
          <p className="muted">
            Identifiers, lifecycle timestamps, and the provenance of the values
            shown in this panel.
          </p>
        </div>
        <span className={`badge ${type.tone}`.trim()}>{type.label}</span>
      </header>
      {segment.description ? (
        <p className="segment-detail-description">{segment.description}</p>
      ) : (
        <p className="muted segment-detail-description">
          No description is stored for this segment.
        </p>
      )}
      <dl className="segment-detail-metadata">
        <div>
          <dt>Segment ID</dt>
          <dd>
            <code>
              {validIdentifier(segment.id) ? segment.id : "Missing or invalid"}
            </code>
          </dd>
        </div>
        <div>
          <dt>Workspace ID</dt>
          <dd>
            {validIdentifier(segment.tenantId) ? (
              <code>{segment.tenantId}</code>
            ) : (
              <span className="muted">Not included in this response</span>
            )}
          </dd>
        </div>
        <div>
          <dt>Evaluation status</dt>
          <dd>{evaluationStatus}</dd>
        </div>
        <div>
          <dt>Cached member count</dt>
          <dd className="tabular">
            {count === null
              ? "No verified count"
              : `${count.toLocaleString()} member${count === 1 ? "" : "s"}`}
          </dd>
        </div>
        <div>
          <dt>Created</dt>
          <dd>
            <MetadataTime value={segment.createdAt} absent="Not included" />
          </dd>
        </div>
        <div>
          <dt>Last definition update</dt>
          <dd>
            <MetadataTime value={segment.updatedAt} absent="Not included" />
          </dd>
        </div>
        <div className="segment-detail-wide-fact">
          <dt>Latest evaluation started</dt>
          <dd>
            <MetadataTime value={evaluatedAt} absent="Not yet evaluated" />
          </dd>
        </div>
        <div className="segment-detail-wide-fact">
          <dt>Type provenance</dt>
          <dd>{type.description}</dd>
        </div>
        <div className="segment-detail-wide-fact">
          <dt>Count provenance</dt>
          <dd>
            Cached from the latest server-confirmed evaluation. It is not a live
            total and can become stale as subscribers and events change.
          </dd>
        </div>
      </dl>
    </section>
  );
}

function RecomputeCard({
  canMutate,
  segment,
  controller,
  buttonRef,
  reasonId,
}: {
  canMutate: boolean;
  segment: Segment;
  controller: RecomputeController;
  buttonRef: React.RefObject<HTMLButtonElement | null>;
  reasonId: string;
}): ReactElement {
  const headingId = useId();
  const validId = validIdentifier(segment.id);
  const hasPredicate = hasStoredPredicate(segment);
  const busyCurrent =
    controller.active && controller.activeTargetId === segment.id;
  const busyOther = controller.active && !busyCurrent;
  const unavailable =
    !canMutate || !validId || !hasPredicate || controller.active;
  const failure =
    controller.failure?.segmentId === segment.id ? controller.failure : null;
  const reason = !canMutate
    ? "An editor or administrator role is required to recompute segments."
    : !validId
      ? "This record has no valid segment ID, so Moosewave cannot address the recompute endpoint."
      : !hasPredicate
        ? "No stored predicate is included in this record. Edit and save a valid definition before recomputing."
        : busyCurrent
          ? "The server is evaluating this segment. The prior cached count remains visible until a verified response replaces it."
          : busyOther
            ? `A recompute for segment ${controller.activeTargetId ?? "previously selected"} is still finishing. Wait before starting another evaluation.`
            : failure
              ? "Retry starts a new synchronous server evaluation. The failed attempt did not replace the cached count."
              : "Recompute synchronously evaluates the stored predicate and replaces the cached count only after the server confirms the result.";
  return (
    <section className="card segment-detail-card" aria-labelledby={headingId}>
      <header className="segment-detail-action-header">
        <div>
          <h3 id={headingId} className="section-title">
            Refresh evaluation
          </h3>
          <p className="muted">
            Re-run the stored predicate to include current subscriber and event
            data. Background evaluation can also update this count.
          </p>
        </div>
        <button
          ref={buttonRef}
          type="button"
          className="btn btn-sm segment-detail-action"
          aria-disabled={unavailable || undefined}
          aria-busy={busyCurrent || undefined}
          aria-describedby={reasonId}
          onClick={() => {
            if (!unavailable) void controller.recompute();
          }}
        >
          {busyCurrent
            ? "Recomputing…"
            : failure
              ? "Retry recompute"
              : "Recompute now"}
        </button>
      </header>
      <p id={reasonId} className="segment-detail-action-reason">
        {reason}
      </p>
      {failure ? (
        <div className="segment-detail-error" role="alert">
          <strong>Recompute not confirmed.</strong> {failure.message}
          {diagnosticReference(failure) ? (
            <span className="muted">
              {" "}
              Reference: {diagnosticReference(failure)}.
            </span>
          ) : null}
        </div>
      ) : null}
      {controller.confirmed?.segmentId === segment.id ? (
        <div className="segment-detail-confirmation" role="status">
          <strong>Server-confirmed evaluation.</strong>{" "}
          {controller.confirmed.count.toLocaleString()} member
          {controller.confirmed.count === 1 ? "" : "s"}; evaluation started{" "}
          <time dateTime={controller.confirmed.startedAt}>
            {fmtDateTime(controller.confirmed.startedAt)}
          </time>
          . This refresh does not create or expand an evaluation snapshot.
          {controller.confirmed.parentReconciliation === "failed"
            ? " The detail is server-confirmed, but the parent segment row could not be reconciled; refresh the segment list before relying on that row."
            : ""}
        </div>
      ) : null}
    </section>
  );
}

function PredicateCard({ queryAst }: { queryAst: unknown }): ReactElement {
  const headingId = useId();
  const predicate = serializedPredicate(queryAst);
  return (
    <section className="card segment-detail-card" aria-labelledby={headingId}>
      <h3 id={headingId} className="section-title">
        Stored predicate
      </h3>
      <p className="muted segment-detail-predicate-copy">
        Read-only JSON from the saved segment record. This stored definition,
        not the formatted display below, is the recompute input.
      </p>
      {predicate.text ? (
        <details className="segment-detail-predicate">
          <summary>View stored predicate JSON</summary>
          {predicate.truncated ? (
            <p className="notice">
              This display is capped at{" "}
              {MAX_AST_DISPLAY_CHARACTERS.toLocaleString()} characters to keep
              the desktop renderer responsive. The saved server definition was
              not changed.
            </p>
          ) : null}
          <pre aria-label="Stored segment predicate JSON">{predicate.text}</pre>
        </details>
      ) : (
        <p className="segment-detail-empty-predicate">
          {predicate.unavailable
            ? "A predicate is present but could not be rendered safely. Refresh the segment record before editing or recomputing it."
            : "No predicate is included in this segment record. Edit and save a valid definition before relying on recomputation."}
        </p>
      )}
    </section>
  );
}

export function SegmentDetailSlideover({
  segment,
  onClose,
  onRecomputed,
  onDelete,
}: Props): ReactElement {
  const canMutate = useCanWrite();
  const layerRef = useRef<HTMLDivElement | null>(null);
  const dialogRef = useRef<HTMLElement | null>(null);
  const recomputeButtonRef = useRef<HTMLButtonElement | null>(null);
  const titleId = useId();
  const subtitleId = useId();
  const recomputeReasonId = useId();
  const deleteReasonId = useId();
  const controller = useSegmentRecompute({
    segment,
    canMutate,
    onRecomputed,
  });
  const busy = controller.active;
  const currentConfirmation =
    controller.confirmed?.segmentId === segment.id
      ? controller.confirmed
      : null;
  const baselineCount = validCount(segment.lastCount)
    ? segment.lastCount
    : null;
  const count = currentConfirmation?.count ?? baselineCount;
  const evaluatedAt = currentConfirmation?.startedAt ?? segment.lastEvaluatedAt;
  const incomingEvaluationInvalid =
    (segment.lastCount != null && !validCount(segment.lastCount)) ||
    (segment.lastEvaluatedAt != null &&
      !validTimestamp(segment.lastEvaluatedAt));
  const evaluationStatus = busy
    ? controller.activeTargetId === segment.id
      ? "Recomputing"
      : "Waiting for another recompute"
    : incomingEvaluationInvalid && !currentConfirmation
      ? "Record needs refresh"
      : count !== null || validTimestamp(evaluatedAt)
        ? "Evaluated"
        : "Not yet evaluated";
  const deleteUnavailable = !canMutate || busy || !validIdentifier(segment.id);
  const close = (): void => {
    if (!controller.isActive()) onClose();
  };

  useSlideoverBehavior({
    open: true,
    onClose: close,
    dialogRef,
    isolationRef: layerRef,
    initialFocusRef: recomputeButtonRef,
    disableEscape: busy,
  });

  return (
    <div ref={layerRef} className="slideover-layer">
      <div
        className="slideover-overlay slideover-overlay-v2"
        onPointerDown={close}
        role="presentation"
      />
      <aside
        ref={dialogRef}
        className="slideover slideover-v2 slideover-lg segment-detail-slideover"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={subtitleId}
        aria-busy={busy || undefined}
        tabIndex={-1}
      >
        <header className="slideover-header">
          <div className="segment-detail-heading">
            <div className="slideover-eyebrow">Audience segment</div>
            <h2 id={titleId} className="slideover-title">
              {segment.name.trim() || "Unnamed segment"}
            </h2>
            <p id={subtitleId} className="slideover-subtitle">
              Saved definition, evaluation evidence, and bounded snapshot
              records.
            </p>
          </div>
          <button
            type="button"
            className="slideover-close segment-detail-close"
            onClick={close}
            aria-label="Close segment details"
            aria-disabled={busy || undefined}
            aria-describedby={busy ? recomputeReasonId : undefined}
          >
            ✕
          </button>
        </header>
        <div className="slideover-body segment-detail-content">
          <SegmentOverview
            segment={segment}
            count={count}
            evaluatedAt={evaluatedAt}
            evaluationStatus={evaluationStatus}
          />
          <RecomputeCard
            canMutate={canMutate}
            segment={segment}
            controller={controller}
            buttonRef={recomputeButtonRef}
            reasonId={recomputeReasonId}
          />
          <PredicateCard queryAst={segment.queryAst} />

          <SegmentSnapshotsSection
            segmentId={segment.id}
            canMutate={canMutate}
          />
          <SegmentPnLPanel segmentId={segment.id} canMutate={canMutate} />
          <SegmentGrowthReport
            segmentId={segment.id}
            segmentName={segment.name}
          />
          <SegmentDecaySection segmentId={segment.id} canMutate={canMutate} />

          {onDelete ? (
            <section className="card segment-detail-card segment-detail-danger-zone">
              <div className="segment-detail-action-header">
                <div>
                  <h3 className="section-title">Delete segment</h3>
                  <p className="muted">
                    Opens a typed confirmation. Subscriber records are not
                    deleted, but campaigns and flows may need a new audience.
                  </p>
                </div>
                <button
                  type="button"
                  className="btn btn-sm btn-ghost segment-detail-action"
                  aria-disabled={deleteUnavailable || undefined}
                  aria-describedby={deleteReasonId}
                  onClick={() => {
                    if (!deleteUnavailable && !controller.isActive()) {
                      onDelete(segment);
                    }
                  }}
                >
                  Delete segment
                </button>
              </div>
              <p id={deleteReasonId} className="segment-detail-action-reason">
                {!canMutate
                  ? "An editor or administrator role is required to delete a segment."
                  : busy
                    ? "Wait for the active recompute to finish before opening the delete confirmation."
                    : !validIdentifier(segment.id)
                      ? "This record has no valid segment ID and cannot be deleted from this panel."
                      : "Deletion begins only after the separate confirmation is completed."}
              </p>
            </section>
          ) : null}
        </div>
      </aside>
    </div>
  );
}
