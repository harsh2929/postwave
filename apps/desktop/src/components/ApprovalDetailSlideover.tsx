/**
 * ApprovalDetailSlideover — exact, read-only approval review evidence.
 *
 * The parent list row is only a navigation snapshot. Decisions remain hidden
 * until GET /approvals/{id} returns the same id, and an older request can never
 * replace the currently selected approval. Metadata is intentionally omitted:
 * this surface has a small, reviewed display allowlist rather than a JSON dump.
 */

import {
  type ReactElement,
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import "../styles-approval-detail.css";

import {
  type AgentRoutineDraftPreview,
  type AgentRoutineDraftStep,
  type AgentRoutineRun,
  agentRoutinesApi,
  api,
  type ApprovalRow,
} from "../lib/api-client";
import {
  type DecodedApproval,
  approvalIsoInstant,
  canRejectApproval,
  decodeApprovalDetail,
} from "../lib/approvals-helpers";
import { AgentTrustPanel } from "./ai/AgentTrustPanel";
import { SlideoverShell } from "./SlideoverShell";

interface Props {
  row: ApprovalRow;
  onClose: () => void;
  /** Optional actions reuse the parent's confirmation-modal flow. */
  canDecide?: boolean;
  onReject?: (row: ApprovalRow) => void;
}

type DetailPhase = "loading" | "verified" | "stale";
type EvidencePhase =
  | "awaiting-verification"
  | "loading"
  | "verified"
  | "none"
  | "not-applicable"
  | "unavailable";

interface DetailState {
  requestedId: string;
  row: ApprovalRow;
  phase: DetailPhase;
  fetching: boolean;
  verificationRevision: number;
  verifiedAt: string | null;
}

interface EvidenceState {
  requestedId: string;
  phase: EvidencePhase;
  run: AgentRoutineRun | null;
}

interface StatusPresentation {
  key: "pending" | "approved" | "rejected" | "expired" | "unknown";
  label: string;
  description: string;
}

interface DatePresentation {
  dateTime: string;
  label: string;
}

const RESOURCE_LABELS: Readonly<Record<string, string>> = {
  campaign: "Campaign",
  sequence: "Sequence",
  automation_send: "Automation send",
};

const ACTOR_LABELS: Readonly<Record<string, string>> = {
  user: "User",
  human: "User",
  api_key: "API key",
  agent: "Agent",
  service: "Service",
  system: "System",
  slack: "Slack",
  partner_app: "Partner app",
  app: "Application",
  stream: "Stream client",
};

const EVIDENCE_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/u;
const EVIDENCE_UNSAFE_CHARACTER_PATTERN =
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u;
const INVALID_EVIDENCE_FIELD = Symbol("invalid-agent-evidence-field");
type EvidenceField = string | undefined | typeof INVALID_EVIDENCE_FIELD;

function isEvidenceRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function evidenceIdentifier(value: unknown): string | null {
  return typeof value === "string" && EVIDENCE_IDENTIFIER_PATTERN.test(value)
    ? value
    : null;
}

function evidenceText(value: unknown, maximum: number): EvidenceField {
  if (value === undefined || value === null) return undefined;
  if (
    typeof value !== "string" ||
    value.length > maximum * 2 ||
    Array.from(value).length > maximum ||
    EVIDENCE_UNSAFE_CHARACTER_PATTERN.test(value)
  ) {
    return INVALID_EVIDENCE_FIELD;
  }
  const normalized = value.replace(/\r\n?/gu, "\n").trim();
  return normalized || undefined;
}

function evidenceStep(value: unknown): AgentRoutineDraftStep | null {
  if (!isEvidenceRecord(value) || Object.keys(value).length > 8) return null;
  const subject = evidenceText(value.subject, 500);
  const body = evidenceText(value.body, 12_000);
  if (subject === INVALID_EVIDENCE_FIELD || body === INVALID_EVIDENCE_FIELD) {
    return null;
  }
  const position = value.position;
  const delayHours = value.delay_hours;
  if (
    position !== undefined &&
    (!Number.isSafeInteger(position) ||
      Number(position) < 0 ||
      Number(position) > 1_000)
  ) {
    return null;
  }
  if (
    delayHours !== undefined &&
    (!Number.isFinite(delayHours) ||
      Number(delayHours) < 0 ||
      Number(delayHours) > 87_600)
  ) {
    return null;
  }
  return {
    ...(position === undefined ? {} : { position: Number(position) }),
    ...(delayHours === undefined ? {} : { delay_hours: Number(delayHours) }),
    ...(subject ? { subject } : {}),
    ...(body ? { body } : {}),
  };
}

function evidencePreview(value: unknown): AgentRoutineDraftPreview | null {
  if (!isEvidenceRecord(value) || Object.keys(value).length > 10) return null;
  const kind = value.kind;
  if (kind !== undefined && kind !== "campaign" && kind !== "sequence") {
    return null;
  }
  const name = evidenceText(value.name, 160);
  const subject = evidenceText(value.subject, 500);
  const previewText = evidenceText(value.preview_text, 500);
  const body = evidenceText(value.body, 12_000);
  if (
    name === INVALID_EVIDENCE_FIELD ||
    subject === INVALID_EVIDENCE_FIELD ||
    previewText === INVALID_EVIDENCE_FIELD ||
    body === INVALID_EVIDENCE_FIELD
  ) {
    return null;
  }
  const rawSteps = value.steps;
  if (
    rawSteps !== undefined &&
    (!Array.isArray(rawSteps) || rawSteps.length > 20)
  ) {
    return null;
  }
  const steps = rawSteps?.map(evidenceStep);
  if (steps?.some((step) => step === null)) return null;
  const positionedSteps = (steps ?? []).flatMap((step) =>
    step?.position === undefined ? [] : [step.position],
  );
  if (new Set(positionedSteps).size !== positionedSteps.length) return null;
  return {
    ...(kind ? { kind } : {}),
    ...(name ? { name } : {}),
    ...(subject ? { subject } : {}),
    ...(previewText ? { preview_text: previewText } : {}),
    ...(body ? { body } : {}),
    ...(steps ? { steps: steps as AgentRoutineDraftStep[] } : {}),
  };
}

function exactAgentEvidence(
  value: unknown,
  approvalId: string,
): AgentRoutineRun | null {
  if (!isEvidenceRecord(value) || Object.keys(value).length > 32) return null;
  const id = evidenceIdentifier(value.id);
  const routineId = evidenceIdentifier(value.routine_id);
  const linkedApprovalId = evidenceIdentifier(value.approval_id);
  const status = evidenceText(value.status, 32);
  const startedAt = datePresentation(value.started_at)?.dateTime ?? null;
  const reasoning = evidenceText(value.reasoning, 4_000);
  const prompt = evidenceText(value.prompt_used, 4_000);
  const context = evidenceText(value.context_used, 4_000);
  const draftPreview =
    value.draft_preview === undefined
      ? undefined
      : evidencePreview(value.draft_preview);
  if (
    !id ||
    !routineId ||
    linkedApprovalId !== approvalId ||
    !status ||
    status === INVALID_EVIDENCE_FIELD ||
    !startedAt ||
    reasoning === INVALID_EVIDENCE_FIELD ||
    prompt === INVALID_EVIDENCE_FIELD ||
    context === INVALID_EVIDENCE_FIELD ||
    draftPreview === null
  ) {
    return null;
  }
  const outputKind =
    value.output_kind === "campaign" || value.output_kind === "sequence"
      ? value.output_kind
      : undefined;
  return {
    id,
    routine_id: routineId,
    approval_id: linkedApprovalId,
    status,
    started_at: startedAt,
    ...(outputKind ? { output_kind: outputKind } : {}),
    ...(reasoning ? { reasoning } : {}),
    ...(prompt ? { prompt_used: prompt } : {}),
    ...(context ? { context_used: context } : {}),
    ...(draftPreview ? { draft_preview: draftPreview } : {}),
  };
}

function initialDetail(row: ApprovalRow): DetailState {
  return {
    requestedId: row.id,
    row,
    phase: "loading",
    fetching: true,
    verificationRevision: 0,
    verifiedAt: null,
  };
}

function initialEvidence(id: string, actorType: unknown): EvidenceState {
  return {
    requestedId: id,
    phase: actorType === "agent" ? "awaiting-verification" : "not-applicable",
    run: null,
  };
}

function projectedApprovalRow(row: DecodedApproval): ApprovalRow {
  return {
    id: row.id,
    resourceType: row.resourceType,
    resourceId: row.resourceId,
    requestedByActorType: row.requestedByActorType,
    requestedByActorLabel: row.requestedByActorLabel,
    status: row.status,
    requestedAt: row.requestedAt,
    decidedAt: row.decidedAt,
    notes: row.notes,
    expiresAt: row.expiresAt,
  };
}

function exactApproval(value: unknown, id: string): ApprovalRow | null {
  const decoded = decodeApprovalDetail(value);
  return decoded.ok && decoded.data.id === id
    ? projectedApprovalRow(decoded.data)
    : null;
}

function boundedLabel(value: unknown, fallback: string, max = 96): string {
  if (typeof value !== "string") return fallback;
  const clipped = value.slice(0, max + 1);
  const normalized = clipped.replace(/\s+/g, " ").trim();
  if (!normalized) return fallback;
  return value.length <= max && normalized.length <= max
    ? normalized
    : `${normalized.slice(0, max - 1)}…`;
}

function boundedNarrative(value: unknown, max = 1_600): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.slice(0, max + 1).trim();
  if (!normalized) return null;
  return value.length <= max && normalized.length <= max
    ? normalized
    : `${normalized.slice(0, max - 1)}…`;
}

function compactIdentifier(value: unknown): string {
  if (typeof value !== "string" || value.length > 512) return "Unavailable";
  const normalized = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/.test(normalized)) {
    return "Unavailable";
  }
  if (normalized.length <= 40) return normalized;
  return `${normalized.slice(0, 14)}…${normalized.slice(-8)}`;
}

function resourceLabel(value: unknown): string {
  if (typeof value !== "string" || value.length > 64) {
    return "Unrecognized approval type";
  }
  return (
    RESOURCE_LABELS[value.trim().toLowerCase()] ?? "Unrecognized approval type"
  );
}

function actorLabel(value: unknown): string {
  if (typeof value !== "string") return "Requester type unavailable";
  if (value.length > 64) return "Unverified requester type";
  return (
    ACTOR_LABELS[value.trim().toLowerCase()] ?? "Unverified requester type"
  );
}

function statusPresentation(value: unknown): StatusPresentation {
  const normalized =
    typeof value === "string" && value.length <= 64 ? value.toLowerCase() : "";
  if (normalized === "pending") {
    return {
      key: "pending",
      label: "Pending review",
      description: "Awaiting an approval decision.",
    };
  }
  if (normalized === "approved") {
    return {
      key: "approved",
      label: "Approved",
      description: "The review record was accepted.",
    };
  }
  if (normalized === "rejected") {
    return {
      key: "rejected",
      label: "Rejected",
      description: "The review record was declined.",
    };
  }
  if (normalized === "expired") {
    return {
      key: "expired",
      label: "Expired",
      description: "The review window ended without a current decision.",
    };
  }
  return {
    key: "unknown",
    label: "Unrecognized state",
    description: "This record cannot be acted on until its state is verified.",
  };
}

function datePresentation(value: unknown): DatePresentation | null {
  const instant = approvalIsoInstant(value);
  if (!instant) return null;
  const parsed = new Date(instant);
  return {
    dateTime: parsed.toISOString(),
    label: parsed.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }),
  };
}

function DateValue({ value }: { value: unknown }): ReactElement {
  const presentation = datePresentation(value);
  return presentation ? (
    <time dateTime={presentation.dateTime}>{presentation.label}</time>
  ) : (
    <>Unavailable</>
  );
}

function VerificationBanner({
  state,
  focusRef,
  onRetry,
}: {
  state: DetailState;
  focusRef: RefObject<HTMLElement | null>;
  onRetry: () => void;
}): ReactElement {
  const verified = datePresentation(state.verifiedAt);
  const isInitialFailure = state.phase === "stale" && !state.verifiedAt;
  let title = "Loading exact approval record";
  let detail = "Checking the latest status before any review action is shown.";
  if (state.phase === "verified" && state.fetching) {
    title = "Checking for a newer record";
    detail = "The last verified record remains visible while this check runs.";
  } else if (state.phase === "verified") {
    title = "Exact record verified";
    detail = verified
      ? `Verified ${verified.label}.`
      : "The latest record matched this approval request.";
  } else if (isInitialFailure) {
    title = "Latest record unavailable";
    detail = "Showing the list snapshot read-only until verification succeeds.";
  } else if (state.phase === "stale") {
    title = "Last verified record may be stale";
    detail = "A newer check failed. Decisions are paused until retry succeeds.";
  }

  return (
    <section
      ref={focusRef}
      className={`approval-detail-truth is-${state.phase}`}
      role="status"
      aria-live="polite"
      aria-atomic="true"
      tabIndex={-1}
    >
      <span className="approval-detail-truth-mark" aria-hidden="true" />
      <div className="approval-detail-truth-copy">
        <strong>{title}</strong>
        <span>{detail}</span>
      </div>
      {state.phase === "stale" ? (
        <button
          type="button"
          className="btn btn-sm approval-detail-retry"
          onClick={onRetry}
          disabled={state.fetching}
        >
          {state.fetching ? "Retrying…" : "Retry"}
        </button>
      ) : null}
    </section>
  );
}

function ApprovalFacts({ row }: { row: ApprovalRow }): ReactElement {
  const status = statusPresentation(row.status);
  const requester = boundedLabel(
    row.requestedByActorLabel,
    actorLabel(row.requestedByActorType),
  );
  return (
    <>
      <dl className="approval-detail-facts" aria-label="Approval summary">
        <div>
          <dt>Review state</dt>
          <dd>
            <span
              className={`approval-detail-status is-${status.key}`}
              data-state={status.key}
            >
              {status.label}
            </span>
            <span className="approval-detail-fact-help">
              {status.description}
            </span>
          </dd>
        </div>
        <div>
          <dt>Request type</dt>
          <dd>{resourceLabel(row.resourceType)}</dd>
        </div>
        <div>
          <dt>Requested</dt>
          <dd className="tabular">
            <DateValue value={row.requestedAt} />
          </dd>
        </div>
        <div>
          <dt>Requester</dt>
          <dd>
            {requester}
            <span className="approval-detail-fact-help">
              {actorLabel(row.requestedByActorType)}
            </span>
          </dd>
        </div>
      </dl>

      <section className="approval-detail-section" aria-label="References">
        <h3>Record references</h3>
        <dl className="approval-detail-reference-list">
          <div>
            <dt>Resource</dt>
            <dd>
              <code>{compactIdentifier(row.resourceId)}</code>
            </dd>
          </div>
          <div>
            <dt>Approval</dt>
            <dd>
              <code>{compactIdentifier(row.id)}</code>
            </dd>
          </div>
        </dl>
      </section>

      <DecisionTiming row={row} />
    </>
  );
}

function DecisionTiming({ row }: { row: ApprovalRow }): ReactElement | null {
  if (!row.expiresAt && !row.decidedAt) return null;
  return (
    <section className="approval-detail-section" aria-label="Decision timing">
      <h3>Decision timing</h3>
      <dl className="approval-detail-reference-list">
        {row.expiresAt ? (
          <div>
            <dt>Review expires</dt>
            <dd className="tabular">
              <DateValue value={row.expiresAt} />
            </dd>
          </div>
        ) : null}
        {row.decidedAt ? (
          <div>
            <dt>Decision recorded</dt>
            <dd className="tabular">
              <DateValue value={row.decidedAt} />
            </dd>
          </div>
        ) : null}
      </dl>
    </section>
  );
}

function EvidencePanel({
  evidence,
  onRetry,
}: {
  evidence: EvidenceState;
  onRetry: () => void;
}): ReactElement {
  return (
    <section className="approval-detail-section" aria-label="Agent evidence">
      <h3>Origin evidence</h3>
      {evidence.phase === "verified" && evidence.run ? (
        <>
          <p className="approval-detail-evidence-copy is-verified">
            A linked agent run was verified for this approval.
          </p>
          <AgentTrustPanel run={evidence.run} />
        </>
      ) : (
        <div className="approval-detail-evidence-state">
          <p className="approval-detail-evidence-copy">
            {evidence.phase === "loading"
              ? "Checking for a linked agent run…"
              : evidence.phase === "awaiting-verification"
                ? "Agent evidence waits for exact approval verification."
                : evidence.phase === "not-applicable"
                  ? "This record does not identify an agent-authored request, so no agent-run lookup was made."
                  : evidence.phase === "none"
                    ? "No linked agent run was returned. This does not prove who authored the request."
                    : "Agent provenance could not be verified right now."}
          </p>
          {evidence.phase === "unavailable" ? (
            <button type="button" className="btn btn-sm" onClick={onRetry}>
              Retry evidence
            </button>
          ) : null}
        </div>
      )}
    </section>
  );
}

function LoadingDetails(): ReactElement {
  return (
    <div className="approval-detail-loading" aria-hidden="true">
      <span />
      <span />
      <span />
    </div>
  );
}

export function ApprovalDetailSlideover({
  row,
  onClose,
  canDecide,
  onReject,
}: Props): ReactElement {
  const [detail, setDetail] = useState<DetailState>(() => initialDetail(row));
  const [evidence, setEvidence] = useState<EvidenceState>(() =>
    initialEvidence(row.id, row.requestedByActorType),
  );
  const detailOwnerRef = useRef(0);
  const evidenceOwnerRef = useRef(0);
  const initialFocusRef = useRef<HTMLElement | null>(null);

  const requestDetail = useCallback(
    (snapshot: ApprovalRow, replace: boolean): void => {
      const owner = ++detailOwnerRef.current;
      const requestedId = snapshot.id;
      setDetail((current) =>
        replace || current.requestedId !== requestedId
          ? initialDetail(snapshot)
          : { ...current, fetching: true },
      );
      void (async () => {
        try {
          const result = await api.getApproval(requestedId);
          if (owner !== detailOwnerRef.current) return;
          const verifiedRow =
            "data" in result ? exactApproval(result.data, requestedId) : null;
          if (verifiedRow) {
            setDetail({
              requestedId,
              row: verifiedRow,
              phase: "verified",
              fetching: false,
              verificationRevision: owner,
              verifiedAt: new Date().toISOString(),
            });
            return;
          }
        } catch {
          // Failure copy is local and bounded below; provider text is private.
        }
        if (owner !== detailOwnerRef.current) return;
        setDetail((current) =>
          current.requestedId === requestedId
            ? { ...current, phase: "stale", fetching: false }
            : current,
        );
      })();
    },
    [],
  );

  const requestEvidence = useCallback((requestedId: string): void => {
    const owner = ++evidenceOwnerRef.current;
    setEvidence({ requestedId, phase: "loading", run: null });
    void (async () => {
      try {
        const result = await agentRoutinesApi.runByApproval(requestedId);
        if (owner !== evidenceOwnerRef.current) return;
        const evidenceData =
          "data" in result
            ? exactAgentEvidence(result.data, requestedId)
            : null;
        if (evidenceData) {
          setEvidence({
            requestedId,
            phase: "verified",
            run: evidenceData,
          });
          return;
        }
        const evidenceError = "error" in result ? result.error : undefined;
        if (evidenceError?.status === 404) {
          setEvidence({ requestedId, phase: "none", run: null });
          return;
        }
      } catch {
        // Do not expose transport, provider, or server exception text.
      }
      if (owner === evidenceOwnerRef.current) {
        setEvidence({ requestedId, phase: "unavailable", run: null });
      }
    })();
  }, []);

  useEffect(() => {
    requestDetail(row, true);
    evidenceOwnerRef.current += 1;
    setEvidence(initialEvidence(row.id, row.requestedByActorType));
    return () => {
      detailOwnerRef.current += 1;
      evidenceOwnerRef.current += 1;
    };
  }, [requestDetail, row]);

  useEffect(() => {
    if (detail.requestedId !== row.id || detail.phase !== "verified") return;
    if (detail.row.requestedByActorType === "agent") {
      requestEvidence(row.id);
      return;
    }
    evidenceOwnerRef.current += 1;
    setEvidence(initialEvidence(row.id, detail.row.requestedByActorType));
  }, [
    detail.phase,
    detail.requestedId,
    detail.row.requestedByActorType,
    detail.verificationRevision,
    requestEvidence,
    row.id,
  ]);

  const activeDetail =
    detail.requestedId === row.id ? detail : initialDetail(row);
  const activeEvidence =
    evidence.requestedId === row.id
      ? evidence
      : initialEvidence(row.id, activeDetail.row.requestedByActorType);
  const status = statusPresentation(activeDetail.row.status);
  const hasExactRecord = activeDetail.phase === "verified";
  const canAct =
    hasExactRecord &&
    !activeDetail.fetching &&
    status.key === "pending" &&
    canRejectApproval({
      actionable: activeDetail.row.resourceType !== "unverified",
      expiresAt:
        typeof activeDetail.row.expiresAt === "string"
          ? activeDetail.row.expiresAt
          : undefined,
    }) &&
    Boolean(canDecide && onReject);
  const notes = boundedNarrative(activeDetail.row.notes);

  const refresh = (): void => {
    requestDetail(activeDetail.row, false);
  };

  const footer = (
    <div className="approval-detail-footer-content">
      <span className="approval-detail-footer-note">
        {canDecide && !canAct
          ? "Decisions require a verified, recognized pending record."
          : "A decision opens a separate confirmation step."}
      </span>
      <div className="approval-detail-footer-actions">
        {canAct && onReject ? (
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => onReject(activeDetail.row)}
          >
            Reject request
          </button>
        ) : null}
        <button type="button" className="btn btn-sm" onClick={onClose}>
          Close details
        </button>
      </div>
    </div>
  );

  return (
    <SlideoverShell
      open
      onClose={onClose}
      size="lg"
      eyebrow="Governance review"
      title={
        hasExactRecord
          ? `${resourceLabel(activeDetail.row.resourceType)} approval`
          : "Approval details"
      }
      subtitle="Review evidence only — downstream execution is not shown here."
      initialFocusRef={initialFocusRef}
      headerActions={
        activeDetail.phase === "verified" ? (
          <button
            type="button"
            className="btn btn-sm approval-detail-refresh"
            onClick={refresh}
            disabled={activeDetail.fetching}
          >
            {activeDetail.fetching ? "Checking…" : "Refresh"}
          </button>
        ) : null
      }
      footer={footer}
      className="approval-detail-shell"
    >
      <VerificationBanner
        state={activeDetail}
        focusRef={initialFocusRef}
        onRetry={refresh}
      />

      {activeDetail.phase === "loading" ? (
        <LoadingDetails />
      ) : (
        <>
          <div className="approval-detail-boundary">
            <strong>Approval record boundary</strong>
            <span>
              Status describes this review record only. It does not confirm a
              send, publish, automation, or other downstream operation.
            </span>
          </div>
          <ApprovalFacts row={activeDetail.row} />
          {notes ? (
            <section className="approval-detail-section" aria-label="Reason">
              <h3>Review reason</h3>
              <p className="approval-detail-notes">{notes}</p>
            </section>
          ) : null}
          <EvidencePanel
            evidence={activeEvidence}
            onRetry={() => requestEvidence(activeDetail.requestedId)}
          />
        </>
      )}
    </SlideoverShell>
  );
}
