/**
 * AuditEventSlideover — details for a single audit_log row.
 *
 * Refined Audit PR 1: gained
 *   - severity badge in the header (Destructive / Auth / Export / Ops)
 *   - "Filter by this actor" affordance so an auditor can pivot from
 *     a single suspicious row to "everything by this actor"
 *   - before/after diff view of the metadata payload (via AuditDiff),
 *     falling back to raw JSON when the payload doesn't carry a pair
 *
 * Pilot of SlideoverShell — the chrome (overlay, header, body, escape,
 * scroll lock, focus restore) lives in the shell; we own only the
 * detail content.
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactElement,
  type RefObject,
} from "react";

import { useDraftLifecycleController } from "../hooks/useDraftLifecycleController";
import { useTabsInteraction } from "../hooks/useTabsInteraction";
import {
  lifecycleOperationError,
  useExistingSettingLifecycle,
  useSingleFlightOperation,
} from "../hooks/useSettingsDraftLifecycle";
import {
  api,
  type AuditRow,
  type InclusionProofResponse,
  type SessionReplayResponse,
} from "../lib/api-client";
import { useAuditScopes } from "../lib/auditScopes";
import { writeClipboardText } from "../lib/clipboard";
import { navigateDesktopRoute } from "../lib/desktop-router";
import { saveFile } from "../lib/file-transfer";

import { AuditDiff } from "./audit/AuditDiff";
import { ConfirmModal } from "./ConfirmModal";
import { toast } from "./Toast";
import { AuditProofPath } from "./audit/AuditProofPath";
import { AuditReplayModal } from "./audit/AuditReplayModal";
import { AuditRequestChain } from "./audit/AuditRequestChain";
import { classifyAction, severityLabel } from "./audit/AuditSeverity";
import { WhyHighRiskModal } from "./audit/WhyHighRiskModal";
import { SlideoverShell } from "./SlideoverShell";
import "../styles-action-availability.css";

interface Props {
  row: AuditRow;
  onClose: () => void;
  /** Exact event control that receives focus after the drawer closes. */
  returnFocusRef?: RefObject<HTMLElement | null>;
  /**
   * Keeps server workflows that are still being release-qualified unmounted.
   * The event remains inspectable, traceable, and filterable.
   */
  releaseContained?: boolean;
  /** Refined PR 1: optional — when present, header shows a "Filter to
   *  this actor" button that calls back to the parent to update the
   *  list filter and close the slideover. */
  onFilterActor?: (actorLabel: string) => void;
  /** sse-pinned-tail (Audit UX, P1): optional — when present, the
   *  Resource section gets a "Filter to resource" button that updates
   *  the parent's filter state and closes the slideover. */
  onFilterResourceId?: (resourceId: string) => void;
}

type UnmaskState = "idle" | "confirming" | "loading" | "revealed" | "error";

function fmtDate(s: string | undefined): string {
  if (!s) return "—";
  const d = new Date(s);
  return Number.isNaN(d.getTime())
    ? s
    : d.toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
        second: "2-digit",
      });
}

async function copyAuditMetadata(
  payload: string,
  markCopied: (copied: boolean) => void,
): Promise<void> {
  const result = await writeClipboardText(payload, {
    contentClass: "personal",
    label: "Audit metadata JSON",
  });
  if (!result.ok) {
    toast.error(result.message);
    return;
  }
  markCopied(true);
  window.setTimeout(() => markCopied(false), 1500);
}

function auditActionBlockReasons(
  retentionDirty: boolean,
  unmaskReason: string,
): {
  retentionDraftReason: string | null;
  navigationDraftReason: string | null;
} {
  const retentionDraftReason = retentionDirty
    ? "Save or discard the retention override before starting another audit action."
    : null;
  return {
    retentionDraftReason,
    navigationDraftReason:
      retentionDraftReason ??
      (unmaskReason.trim()
        ? "Submit or discard the PII-access reason before changing the audit list filter."
        : null),
  };
}

export function AuditEventSlideover({
  row,
  onClose,
  returnFocusRef,
  releaseContained = false,
  onFilterActor,
  onFilterResourceId,
}: Props): ReactElement {
  const severity = releaseContained ? null : classifyAction(row.action);
  const scopes = useAuditScopes();

  // sse-pinned-tail (Audit UX, P1): Parsed / JSON tabs in the metadata
  // section. Parsed renders the structured diff (existing behaviour);
  // JSON shows the raw payload with a copy-to-clipboard button so an
  // auditor exporting evidence doesn't need to scrape the rendered DOM.
  const [metaTab, setMetaTab] = useState<"parsed" | "json">("parsed");
  const [copied, setCopied] = useState(false);
  // D13-governance-privacy#10: separate feedback flag for the meta-read
  // "Copy metadata JSON" button (distinct from the JSON-pane copy above).
  const [metaCopied, setMetaCopied] = useState(false);

  const [proof, setProof] = useState<InclusionProofResponse | null>(null);
  const [proofLoading, setProofLoading] = useState(false);
  const [proofErr, setProofErr] = useState<string | null>(null);
  const proofOperation = useSingleFlightOperation({
    ownerId: `audit-event-proof-${row.id}`,
    label: "Audit event inclusion proof",
    detail: "Wait for the inclusion-proof request to finish before leaving.",
  });

  // pii-redaction (Compliance, P0): Reveal-PII state machine.
  //   idle       — initial; button visible if encrypted blob exists.
  //   confirming — second-click confirmation; emits the unmask request.
  //   revealed   — decrypted metadata returned + merged for display.
  //   error      — show inline error (permission denied / cipher down).
  // The two-step confirm is deliberate: PII access is a compliance
  // event and should not be a single-click accident. The unmask call
  // itself records to audit_pii_unmask_history + emits an audit row.
  const [unmaskState, setUnmaskState] = useState<UnmaskState>("idle");
  const [unmaskedMeta, setUnmaskedMeta] = useState<Record<
    string,
    unknown
  > | null>(null);
  const [unmaskErr, setUnmaskErr] = useState<string | null>(null);
  const [unmaskReason, setUnmaskReason] = useState("");

  const canRevealPII =
    !releaseContained &&
    !!row.hasEncryptedMetadata &&
    scopes.hasScope("audit:read_pii");

  const localCloseTargetRef = useRef<"panel" | "pii" | null>(null);
  const retentionDiscardRef = useRef<() => void>(() => undefined);
  const [retentionDirty, setRetentionDirty] = useState(false);
  const [retentionBusy, setRetentionBusy] = useState(false);
  const [retentionCloseConfirm, setRetentionCloseConfirm] = useState(false);
  const reportRetentionLifecycle = useCallback(
    (dirty: boolean, busy: boolean, discard: () => void): void => {
      retentionDiscardRef.current = discard;
      setRetentionDirty(dirty);
      setRetentionBusy(busy);
    },
    [],
  );
  const actionLifecycle = useDraftLifecycleController({
    ownerId: `audit-event-action-${row.id}`,
    label: "Audit event action draft",
    mode: "action",
    enabled: true,
    dirty: unmaskState === "confirming" && Boolean(unmaskReason.trim()),
    discard: () => {
      setUnmaskReason("");
      if (unmaskState === "confirming") setUnmaskState("idle");
    },
    close: () => {
      const target = localCloseTargetRef.current;
      localCloseTargetRef.current = null;
      if (target === "pii") setUnmaskState("idle");
      else if (target === "panel") onClose();
    },
    detail:
      "This audited PII-access reason has not been submitted. Return to it or explicitly discard it.",
    operationDetail:
      "Wait for the audit-event action request to finish before leaving Moosewave.",
  });

  const requestActionClose = (target: "panel" | "pii"): void => {
    if (retentionBusy || actionLifecycle.promiseRef.current) return;
    localCloseTargetRef.current = target;
    if (target === "panel" && retentionDirty) {
      setRetentionCloseConfirm(true);
      return;
    }
    actionLifecycle.requestClose();
  };

  const handleReveal = async (): Promise<void> => {
    const request = actionLifecycle.runOperation(async () => {
      setUnmaskState("loading");
      setUnmaskErr(null);
      try {
        const res = await api.auditUnmaskPII(row.id, unmaskReason.trim());
        if (res.error) {
          setUnmaskErr(
            res.error.code === "missing_scope"
              ? "Your role does not have audit:read_pii. Ask an owner to grant it under Settings → Team → Roles."
              : (res.error.message ?? "Unable to reveal PII."),
          );
          setUnmaskState("error");
          return;
        }
        if (res.data) {
          setUnmaskReason("");
          setUnmaskedMeta(res.data.metadata);
          setUnmaskState("revealed");
        }
      } catch (error) {
        setUnmaskErr(lifecycleOperationError(error, "Unable to reveal PII."));
        setUnmaskState("error");
      }
    });
    if (request) await request;
  };

  // session-replay-deeplink: lazy lookup on slideover open. The API
  // returns {available:false} for system/agent rows or when no replay
  // provider is configured — we render the button only when available.
  const [replay, setReplay] = useState<SessionReplayResponse | null>(null);
  const [replayOpen, setReplayOpen] = useState(false);
  // ueba-baselines (AI/Anomaly, P1): "Why high risk?" modal state.
  const [whyOpen, setWhyOpen] = useState(false);
  useEffect(() => {
    if (releaseContained) {
      setReplay(null);
      setReplayOpen(false);
      return;
    }
    let cancelled = false;
    void (async () => {
      const res = await api.auditSessionReplay(row.id);
      if (cancelled) return;
      if (res.error) {
        // Quietly degrade — the button just won't render.
        setReplay({ available: false, reason: "lookup_failed" });
        return;
      }
      setReplay(res.data ?? { available: false });
    })();
    return () => {
      cancelled = true;
    };
  }, [releaseContained, row.id]);

  // Seed the autonomous AI investigator from this event and navigate through
  // the canonical resource route so reload, Back and app reopen preserve it.
  const [investigating, setInvestigating] = useState(false);
  const handleInvestigate = async (): Promise<void> => {
    const request = actionLifecycle.runOperation(
      async (): Promise<string | null> => {
        setInvestigating(true);
        try {
          const res = await api.investigateAuditEvent(row.id);
          if (res.error) {
            toast.error(
              res.error.message ?? "Couldn't start an investigation.",
            );
            return null;
          }
          return res.data?.id ?? "";
        } catch (error) {
          toast.error(
            lifecycleOperationError(error, "Couldn't start an investigation."),
          );
          return null;
        } finally {
          setInvestigating(false);
        }
      },
    );
    if (!request) return;
    const invId = await request;
    if (invId === null) return;
    if (!invId) {
      toast.error("Investigation started but no id was returned.");
      return;
    }
    navigateDesktopRoute({
      section: "auditInvestigation",
      resourceId: invId,
    });
  };

  const handleVerify = async (): Promise<void> => {
    const existing = proofOperation.promiseRef.current;
    if (existing) {
      await existing;
      return;
    }
    const request = proofOperation.run(async () => {
      setProofLoading(true);
      setProofErr(null);
      try {
        const res = await api.getInclusionProof(row.id);
        if (res.error) {
          // 425 Too Early surfaces as a friendly retry hint.
          const msg = res.error.message ?? "Unable to generate proof.";
          setProofErr(
            res.error.code === "no_checkpoint"
              ? "The chain hasn't been rooted yet. Try again in about a minute."
              : msg,
          );
          return;
        }
        if (res.data) setProof(res.data);
      } catch (error) {
        setProofErr(
          lifecycleOperationError(error, "Unable to generate proof."),
        );
      } finally {
        setProofLoading(false);
      }
    });
    if (request) await request;
  };

  const auditActionBusy = retentionBusy || actionLifecycle.active;
  const { retentionDraftReason, navigationDraftReason } =
    auditActionBlockReasons(retentionDirty, unmaskReason);

  const headerActions = (
    <AuditEventHeaderActions
      actorLabel={row.actorLabel}
      canInvestigate={!releaseContained && scopes.hasScope("audit:read")}
      releaseContained={releaseContained}
      busy={auditActionBusy}
      investigating={investigating}
      retentionDraftReason={retentionDraftReason}
      navigationDraftReason={navigationDraftReason}
      onWhy={() => setWhyOpen(true)}
      onInvestigate={handleInvestigate}
      onFilterActor={onFilterActor}
      onClose={onClose}
    />
  );

  return (
    <SlideoverShell
      open
      onClose={() => requestActionClose("panel")}
      returnFocusRef={returnFocusRef}
      size="md"
      eyebrow={severity ? severityLabel(severity) : "Recorded event"}
      title={
        <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
          <span>{row.action || "Event"}</span>
          {severity ? (
            <span
              className={`audit-severity-badge is-${severity}`}
              aria-label={`${severityLabel(severity)} action severity`}
            >
              {severityLabel(severity)}
            </span>
          ) : null}
        </span>
      }
      subtitle={fmtDate(row.at)}
      headerActions={headerActions}
    >
      {releaseContained ? (
        <section
          className="audit-event-release-boundary"
          aria-labelledby="audit-event-release-boundary-title"
          data-testid="audit-event-release-boundary"
        >
          <span
            className="audit-event-release-boundary__mark"
            aria-hidden="true"
          >
            ✓
          </span>
          <div>
            <div
              id="audit-event-release-boundary-title"
              className="audit-event-release-boundary__title"
            >
              Read-only evidence view
            </div>
            <p>
              This event can be inspected and traced without starting AI,
              replay, proof, retention, or PII mutation workflows.
            </p>
          </div>
        </section>
      ) : (
        <div id="audit-investigate-description" className="pw-action-status">
          AI investigation correlates related audit events into hypotheses and
          proposed remediations.
        </div>
      )}
      {navigationDraftReason ? (
        <div
          id="audit-action-block-reason"
          className="pw-action-status"
          role="status"
        >
          {navigationDraftReason}
        </div>
      ) : null}
      <AuditEventContext
        row={row}
        busy={auditActionBusy}
        navigationDraftReason={navigationDraftReason}
        onFilterResourceId={onFilterResourceId}
        onClose={onClose}
      />

      <AuditEventMetadata
        row={row}
        metaTab={metaTab}
        setMetaTab={setMetaTab}
        copied={copied}
        setCopied={setCopied}
        metaCopied={metaCopied}
        setMetaCopied={setMetaCopied}
        copyMetadata={copyAuditMetadata}
        unmaskedMeta={unmaskedMeta}
        canRevealPII={canRevealPII}
        unmaskState={unmaskState}
        setUnmaskState={setUnmaskState}
        unmaskReason={unmaskReason}
        setUnmaskReason={setUnmaskReason}
        unmaskErr={unmaskErr}
        handleReveal={handleReveal}
        requestPiiClose={() => requestActionClose("pii")}
        actionBusy={actionLifecycle.active}
      />

      <AuditEventSupportingSections
        row={row}
        releaseContained={releaseContained}
        replay={replay}
        replayOpen={replayOpen}
        whyOpen={whyOpen}
        proof={proof}
        proofLoading={proofLoading}
        proofOperationActive={proofOperation.active}
        proofError={proofErr}
        retentionCloseConfirm={retentionCloseConfirm}
        actionDiscardConfirm={actionLifecycle.discardConfirmOpen}
        confirmBusy={retentionBusy || actionLifecycle.active}
        onReplayOpen={() => setReplayOpen(true)}
        onReplayClose={() => setReplayOpen(false)}
        onWhyClose={() => setWhyOpen(false)}
        onRetentionLifecycle={reportRetentionLifecycle}
        onVerify={() => void handleVerify()}
        onRetentionDiscard={() => {
          retentionDiscardRef.current();
          setRetentionCloseConfirm(false);
          actionLifecycle.requestClose();
        }}
        onRetentionKeep={() => {
          localCloseTargetRef.current = null;
          setRetentionCloseConfirm(false);
        }}
        onActionDiscard={actionLifecycle.discardAndClose}
        onActionKeep={() => {
          localCloseTargetRef.current = null;
          actionLifecycle.keepEditing();
        }}
      />
    </SlideoverShell>
  );
}

interface AuditEventSupportingSectionsProps {
  row: AuditRow;
  releaseContained: boolean;
  replay: SessionReplayResponse | null;
  replayOpen: boolean;
  whyOpen: boolean;
  proof: InclusionProofResponse | null;
  proofLoading: boolean;
  proofOperationActive: boolean;
  proofError: string | null;
  retentionCloseConfirm: boolean;
  actionDiscardConfirm: boolean;
  confirmBusy: boolean;
  onReplayOpen: () => void;
  onReplayClose: () => void;
  onWhyClose: () => void;
  onRetentionLifecycle: (
    dirty: boolean,
    busy: boolean,
    discard: () => void,
  ) => void;
  onVerify: () => void;
  onRetentionDiscard: () => void;
  onRetentionKeep: () => void;
  onActionDiscard: () => void;
  onActionKeep: () => void;
}

function AuditEventSupportingSections({
  row,
  releaseContained,
  replay,
  replayOpen,
  whyOpen,
  proof,
  proofLoading,
  proofOperationActive,
  proofError,
  retentionCloseConfirm,
  actionDiscardConfirm,
  confirmBusy,
  onReplayOpen,
  onReplayClose,
  onWhyClose,
  onRetentionLifecycle,
  onVerify,
  onRetentionDiscard,
  onRetentionKeep,
  onActionDiscard,
  onActionKeep,
}: AuditEventSupportingSectionsProps): ReactElement {
  if (releaseContained) {
    return (
      <div className="audit-event-release-footnote">
        <span>Evidence identifier</span>
        <code>{row.id}</code>
      </div>
    );
  }

  return (
    <>
      {replay?.available ? (
        <div data-testid="audit-session-replay-section">
          <div className="label">Session replay</div>
          <button
            type="button"
            className="btn btn-sm btn-secondary"
            onClick={onReplayOpen}
            aria-describedby="audit-session-replay-description"
          >
            Watch session replay
          </button>
          <div
            id="audit-session-replay-description"
            className="muted"
            style={{ fontSize: 11, marginTop: 6 }}
          >
            Player opens scoped to ±2 minutes around the event.
          </div>
        </div>
      ) : null}

      {replay && replayOpen ? (
        <AuditReplayModal row={row} reply={replay} onClose={onReplayClose} />
      ) : null}

      {whyOpen ? <WhyHighRiskModal row={row} onClose={onWhyClose} /> : null}

      <RetentionOverridePanel
        key={row.id}
        row={row}
        onLifecycleState={onRetentionLifecycle}
      />

      {row.actorType === "agent" && row.sessionId ? (
        <AIVSBundleButton sessionId={row.sessionId} />
      ) : null}

      <div>
        <div className="label">Integrity proof</div>
        {!proof ? (
          <div>
            <button
              type="button"
              className="btn btn-sm btn-secondary"
              onClick={onVerify}
              disabled={proofLoading || proofOperationActive}
              aria-describedby="audit-proof-description"
            >
              {proofLoading ? "Verifying…" : "Generate proof for this event"}
            </button>
            {proofError ? (
              <div
                id="audit-proof-description"
                className="notice"
                style={{ marginTop: 8, fontSize: 12 }}
                role="alert"
              >
                {proofError}
              </div>
            ) : (
              <div
                id="audit-proof-description"
                className="muted"
                style={{ fontSize: 11, marginTop: 6 }}
              >
                Generates a SHA-256 hash-chain proof anchored at the latest
                signed Merkle root. Verifiable offline with the{" "}
                <code>postwave-verify</code> CLI.
              </div>
            )}
          </div>
        ) : (
          <AuditProofPath proof={proof} />
        )}
      </div>

      <div className="muted" style={{ fontSize: 11, marginTop: "auto" }}>
        ID {row.id}
      </div>
      <ConfirmModal
        open={retentionCloseConfirm}
        title="Discard retention override changes?"
        description="The per-event retention override will be restored to its last acknowledged value."
        confirmLabel="Discard changes"
        danger
        busy={confirmBusy}
        onConfirm={onRetentionDiscard}
        onClose={onRetentionKeep}
      />
      <ConfirmModal
        open={actionDiscardConfirm}
        title="Discard audited action draft?"
        description="The PII-access reason has not been submitted."
        confirmLabel="Discard reason"
        danger
        busy={confirmBusy}
        onConfirm={onActionDiscard}
        onClose={onActionKeep}
      />
    </>
  );
}

function AuditEventHeaderActions({
  actorLabel,
  canInvestigate,
  releaseContained,
  busy,
  investigating,
  retentionDraftReason,
  navigationDraftReason,
  onWhy,
  onInvestigate,
  onFilterActor,
  onClose,
}: {
  actorLabel?: string;
  canInvestigate: boolean;
  releaseContained: boolean;
  busy: boolean;
  investigating: boolean;
  retentionDraftReason: string | null;
  navigationDraftReason: string | null;
  onWhy: () => void;
  onInvestigate: () => Promise<void>;
  onFilterActor?: (actorLabel: string) => void;
  onClose: () => void;
}): ReactElement {
  return (
    <>
      {!releaseContained ? (
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          onClick={onWhy}
          data-testid="audit-slideover-why-high-risk"
        >
          Why high risk?
        </button>
      ) : null}
      {canInvestigate ? (
        <button
          type="button"
          className={`btn btn-sm btn-secondary${retentionDraftReason ? " pw-discoverable-unavailable" : ""}`}
          onClick={() => {
            if (!retentionDraftReason) void onInvestigate();
          }}
          disabled={investigating || busy}
          aria-disabled={retentionDraftReason ? "true" : undefined}
          aria-describedby={`audit-investigate-description${retentionDraftReason ? " audit-action-block-reason" : ""}`}
          data-testid="audit-slideover-investigate"
        >
          {investigating ? "Investigating…" : "Investigate"}
        </button>
      ) : null}
      {onFilterActor && actorLabel ? (
        <button
          type="button"
          className={`btn btn-sm btn-ghost${navigationDraftReason ? " pw-discoverable-unavailable" : ""}`}
          onClick={() => {
            if (navigationDraftReason) return;
            onFilterActor(actorLabel);
            onClose();
          }}
          disabled={busy}
          aria-disabled={navigationDraftReason ? "true" : undefined}
          aria-describedby={
            navigationDraftReason ? "audit-action-block-reason" : undefined
          }
        >
          Filter to actor
        </button>
      ) : null}
    </>
  );
}

function AuditEventContext({
  row,
  busy,
  navigationDraftReason,
  onFilterResourceId,
  onClose,
}: {
  row: AuditRow;
  busy: boolean;
  navigationDraftReason: string | null;
  onFilterResourceId?: (resourceId: string) => void;
  onClose: () => void;
}): ReactElement {
  return (
    <>
      <div>
        <div className="label">Actor</div>
        <div style={{ fontSize: 13 }}>{row.actorLabel ?? "—"}</div>
        <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>
          {row.actorType}
          {row.userId ? ` · user ${row.userId.slice(0, 8)}…` : ""}
        </div>
      </div>
      <div>
        <div
          className="row"
          style={{
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: 2,
          }}
        >
          <div className="label">Resource</div>
          {onFilterResourceId && row.resourceId ? (
            <button
              type="button"
              className={`btn btn-xs btn-ghost${navigationDraftReason ? " pw-discoverable-unavailable" : ""}`}
              onClick={() => {
                if (navigationDraftReason) return;
                onFilterResourceId(row.resourceId!);
                onClose();
              }}
              disabled={busy}
              aria-disabled={navigationDraftReason ? "true" : undefined}
              aria-describedby={
                navigationDraftReason ? "audit-action-block-reason" : undefined
              }
              data-testid="audit-slideover-filter-resource"
            >
              Filter to resource
            </button>
          ) : null}
        </div>
        <div className="mono" style={{ fontSize: 12, wordBreak: "break-all" }}>
          {row.resourceType ? `${row.resourceType} · ` : ""}
          {row.resourceId ?? "—"}
        </div>
      </div>
      {/* ECO-22: "what else did this request do?" — renders nothing for rows
          written outside a request (workers, queue consumers), which carry no
          correlation id and therefore have no chain to open. */}
      <AuditRequestChain row={row} />
      {row.ip ? (
        <div>
          <div className="label">IP</div>
          <div className="mono" style={{ fontSize: 12 }}>
            {row.ip}
          </div>
        </div>
      ) : null}
      {row.userAgent ? (
        <div>
          <div className="label">User agent</div>
          <pre
            className="muted mono pw-pre"
            style={{
              fontSize: 11,
              whiteSpace: "pre-wrap",
              wordBreak: "break-all",
            }}
          >
            {row.userAgent}
          </pre>
        </div>
      ) : null}
    </>
  );
}

function AuditEventMetadata({
  row,
  metaTab,
  setMetaTab,
  copied,
  setCopied,
  metaCopied,
  setMetaCopied,
  copyMetadata,
  unmaskedMeta,
  canRevealPII,
  unmaskState,
  setUnmaskState,
  unmaskReason,
  setUnmaskReason,
  unmaskErr,
  handleReveal,
  requestPiiClose,
  actionBusy,
}: {
  row: AuditRow;
  metaTab: "parsed" | "json";
  setMetaTab: (tab: "parsed" | "json") => void;
  copied: boolean;
  setCopied: (copied: boolean) => void;
  metaCopied: boolean;
  setMetaCopied: (copied: boolean) => void;
  copyMetadata: (
    payload: string,
    markCopied: (copied: boolean) => void,
  ) => Promise<void>;
  unmaskedMeta: Record<string, unknown> | null;
  canRevealPII: boolean;
  unmaskState: UnmaskState;
  setUnmaskState: (state: UnmaskState) => void;
  unmaskReason: string;
  setUnmaskReason: (reason: string) => void;
  unmaskErr: string | null;
  handleReveal: () => Promise<void>;
  requestPiiClose: () => void;
  actionBusy: boolean;
}): ReactElement {
  const metadata = unmaskedMeta ?? row.metadata;
  const tabs = useTabsInteraction({
    value: metaTab,
    items: [{ value: "parsed" }, { value: "json" }] as const,
    onChange: setMetaTab,
  });
  return (
    <>
      {row.action.startsWith("audit.read") && row.metadata ? (
        <AuditReadMetadata
          metadata={row.metadata}
          copied={metaCopied}
          onCopy={() =>
            copyMetadata(JSON.stringify(row.metadata, null, 2), setMetaCopied)
          }
        />
      ) : null}
      <div>
        <div
          className="row"
          style={{
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: 4,
          }}
        >
          <div className="label">Metadata</div>
          <div
            ref={tabs.listRef}
            className="row"
            {...tabs.listProps}
            aria-label="Metadata view"
            style={{ gap: 4 }}
            data-testid="audit-metadata-tabs"
          >
            {(["parsed", "json"] as const).map((tab) => (
              <button
                key={tab}
                type="button"
                {...tabs.getTabProps(tab)}
                className={
                  metaTab === tab
                    ? "btn btn-xs btn-primary"
                    : "btn btn-xs btn-ghost"
                }
                data-testid={`audit-meta-tab-${tab}`}
              >
                {tab === "json" ? "JSON" : "Parsed"}
              </button>
            ))}
          </div>
        </div>
        {row.redactedFields && row.redactedFields.length > 0 ? (
          <div
            className="muted"
            style={{ fontSize: 11, marginBottom: 6 }}
            data-testid="audit-redacted-banner"
          >
            {row.redactedFields.length} field
            {row.redactedFields.length === 1 ? "" : "s"} were redacted on write:{" "}
            <code>{row.redactedFields.join(", ")}</code>
          </div>
        ) : null}
        <section {...tabs.getPanelProps("parsed")}>
          {metaTab === "parsed" ? <AuditDiff metadata={metadata} /> : null}
        </section>
        <section {...tabs.getPanelProps("json")}>
          {metaTab === "json" ? (
            <div data-testid="audit-meta-json-pane">
              <div
                className="row"
                style={{ justifyContent: "flex-end", marginBottom: 4 }}
              >
                <button
                  type="button"
                  className="btn btn-xs btn-secondary"
                  onClick={() => {
                    void copyMetadata(
                      JSON.stringify(metadata ?? {}, null, 2),
                      setCopied,
                    ).catch(() =>
                      toast.error("The audit metadata couldn't be copied."),
                    );
                  }}
                  data-testid="audit-meta-copy-json"
                >
                  {copied ? "Copied!" : "Copy JSON"}
                </button>
              </div>
              <pre
                className="mono pw-pre"
                style={{
                  fontSize: 11,
                  padding: 8,
                  background: "var(--pw-bg-elev-2)",
                  borderRadius: 4,
                  border: "1px solid var(--pw-border)",
                  maxHeight: 360,
                  overflow: "auto",
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-all",
                }}
              >
                {JSON.stringify(metadata ?? {}, null, 2)}
              </pre>
            </div>
          ) : null}
        </section>
        <PiiRevealPanel
          visible={canRevealPII}
          state={unmaskState}
          reason={unmaskReason}
          error={unmaskErr}
          busy={actionBusy}
          onStateChange={setUnmaskState}
          onReasonChange={setUnmaskReason}
          onReveal={handleReveal}
          onClose={requestPiiClose}
        />
      </div>
    </>
  );
}

function AuditReadMetadata({
  metadata,
  copied,
  onCopy,
}: {
  metadata: Record<string, unknown>;
  copied: boolean;
  onCopy: () => Promise<void>;
}): ReactElement {
  const rowCount = metadata.row_count;
  const rowCountLabel =
    Number.isSafeInteger(rowCount) && Number(rowCount) >= 0
      ? String(rowCount)
      : "Not recorded";
  return (
    <div>
      <div className="label">Audit-read metadata</div>
      <div
        style={{
          border: "1px solid var(--pw-border)",
          borderRadius: 6,
          padding: 8,
          fontSize: 12,
          display: "grid",
          gap: 4,
        }}
        data-testid="audit-meta-read-block"
      >
        <div>
          <span className="muted">Path:</span>{" "}
          <code>{String(metadata.path ?? "—")}</code>
        </div>
        <div>
          <span className="muted">Canonical query:</span>{" "}
          <code>{String(metadata.query_canonical ?? "")}</code>
        </div>
        <div>
          <span className="muted">Rows returned:</span>{" "}
          <code>{rowCountLabel}</code>
        </div>
        <button
          type="button"
          className="btn btn-sm btn-secondary"
          style={{ justifySelf: "start", marginTop: 4 }}
          onClick={() =>
            void onCopy().catch(() =>
              toast.error("The audit metadata couldn't be copied."),
            )
          }
        >
          {copied ? "Copied!" : "Copy metadata JSON"}
        </button>
      </div>
    </div>
  );
}

function PiiRevealPanel({
  visible,
  state,
  reason,
  error,
  busy,
  onStateChange,
  onReasonChange,
  onReveal,
  onClose,
}: {
  visible: boolean;
  state: UnmaskState;
  reason: string;
  error: string | null;
  busy: boolean;
  onStateChange: (state: UnmaskState) => void;
  onReasonChange: (reason: string) => void;
  onReveal: () => Promise<void>;
  onClose: () => void;
}): ReactElement | null {
  if (state === "revealed") {
    return (
      <div
        className="muted"
        style={{ fontSize: 11, marginTop: 6 }}
        data-testid="audit-revealed-banner"
      >
        PII revealed at {new Date().toLocaleTimeString()}. This view is local —
        the unmask was logged to audit_pii_unmask_history.
      </div>
    );
  }
  if (!visible) return null;
  return (
    <div
      style={{
        marginTop: 10,
        padding: 10,
        border: "1px solid var(--pw-border)",
        borderRadius: 6,
        background: "var(--pw-bg-elev-2)",
      }}
      data-testid="audit-reveal-pii-section"
    >
      <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>
        Reveal PII
      </div>
      <div
        id="audit-pii-consequence"
        className="muted"
        style={{ fontSize: 11, marginBottom: 8 }}
      >
        Decrypting redacted fields is recorded in audit_pii_unmask_history and
        emits an audit.pii_unmask event with your user id.
      </div>
      {state === "idle" ? (
        <button
          type="button"
          className="btn btn-sm btn-secondary"
          onClick={() => onStateChange("confirming")}
          aria-describedby="audit-pii-consequence"
        >
          Reveal PII
        </button>
      ) : null}
      {state === "confirming" ? (
        <div style={{ display: "grid", gap: 6 }}>
          <label className="field-label" htmlFor="audit-pii-reason">
            Reason <span className="muted">(optional)</span>
          </label>
          <input
            id="audit-pii-reason"
            type="text"
            className="input"
            placeholder="Reason (optional, surfaced to compliance reviewers)"
            value={reason}
            disabled={busy}
            aria-describedby="audit-pii-consequence"
            onChange={(event) => onReasonChange(event.target.value)}
            style={{ fontSize: 12 }}
          />
          <div style={{ display: "flex", gap: 6 }}>
            <button
              type="button"
              className="btn btn-sm btn-danger"
              onClick={() => void onReveal()}
              disabled={busy}
              aria-describedby="audit-pii-consequence"
            >
              {busy ? "Revealing and logging…" : "Confirm — reveal and log"}
            </button>
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              onClick={onClose}
              disabled={busy}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}
      {state === "loading" ? (
        <span className="muted" style={{ fontSize: 12 }}>
          Decrypting…
        </span>
      ) : null}
      {state === "error" && error ? (
        <div
          className="notice"
          role="alert"
          style={{ fontSize: 12, marginTop: 4 }}
        >
          {error}
          <button
            type="button"
            className="btn btn-xs btn-ghost"
            style={{ marginLeft: 8 }}
            onClick={() => onStateChange("idle")}
          >
            Dismiss
          </button>
        </div>
      ) : null}
    </div>
  );
}

/* ----------------------------------------------------------------------
 * AIVSBundleButton — downloads the AIVS proof bundle for the row's
 * agent session. EU AI Act Article 50 transparency support.
 *
 * The .tar.gz contains manifest.json + events.jsonl + chain.json +
 * verify.py (a Python stdlib-only verifier). An inspector who has the
 * Moosewave-published rotation log can verify chain integrity offline
 * without any further trust in the API.
 * -------------------------------------------------------------------- */

function AIVSBundleButton({ sessionId }: { sessionId: string }): ReactElement {
  const [err, setErr] = useState<string | null>(null);
  const [doneMsg, setDoneMsg] = useState<string | null>(null);
  const operation = useSingleFlightOperation({
    ownerId: `audit-aivs-bundle-${sessionId}`,
    label: "Audit AIVS proof bundle",
    detail: "Wait for the proof bundle to finish before leaving.",
  });

  const handleDownload = async (): Promise<void> => {
    const existing = operation.promiseRef.current;
    if (existing) {
      await existing;
      return;
    }
    const request = operation.run(async () => {
      setErr(null);
      setDoneMsg(null);
      try {
        const res = await api.downloadAIVSBundle(sessionId);
        if (res.error) {
          setErr(
            res.error.code === "no_agent_events"
              ? "No AI agent events recorded for this session."
              : (res.error.message ?? "Unable to build bundle."),
          );
          return;
        }
        if (!res.data) {
          setErr("Empty response from server.");
          return;
        }
        const saved = await saveFile({
          data: res.data.blob,
          suggestedName: res.data.filename,
          label: "Audit AIVS proof bundle",
          privacy: "confidential",
          mimeType: "application/zip",
        });
        if (!saved.ok) {
          setErr(saved.message);
          return;
        }
        if (saved.status !== "cancelled") {
          setDoneMsg(`Saved ${res.data.filename}`);
        }
      } catch (error) {
        setErr(lifecycleOperationError(error, "Unable to build bundle."));
      }
    });
    if (request) await request;
  };

  return (
    <div data-testid="aivs-bundle-panel">
      <div className="label">AI session bundle</div>
      <div
        id="audit-aivs-description"
        className="muted"
        style={{ fontSize: 11, marginBottom: 6 }}
      >
        Download the AIVS proof bundle for this agent session (manifest.json,
        events.jsonl, chain.json, verify.py). Verify offline with{" "}
        <code>python3 verify.py</code>.
      </div>
      <button
        type="button"
        className="btn btn-sm btn-secondary"
        onClick={() => void handleDownload()}
        disabled={operation.active}
        aria-describedby="audit-aivs-description"
        data-testid="aivs-bundle-download"
      >
        {operation.active
          ? "Building bundle…"
          : "Download AIVS bundle for session"}
      </button>
      {err ? (
        <div
          className="notice"
          style={{ marginTop: 6, fontSize: 12 }}
          role="alert"
        >
          {err}
        </div>
      ) : null}
      {doneMsg && !err ? (
        <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>
          {doneMsg}
        </div>
      ) : null}
    </div>
  );
}

/* ----------------------------------------------------------------------
 * RetentionOverridePanel — legal hold + per-row retention override.
 *
 * Reads the initial flag state from the row (audit.list populates the
 * `legalHold` + `retentionOverrideDays` fields). Mutates via PATCH
 * /api/v1/audit/{id}/retention-override; the server meta-audits every
 * change as audit.retention.override_set so the chain of custody is
 * preserved.
 * -------------------------------------------------------------------- */

function RetentionOverridePanel({
  row,
  onLifecycleState,
}: {
  row: AuditRow;
  onLifecycleState: (
    dirty: boolean,
    busy: boolean,
    discard: () => void,
  ) => void;
}): ReactElement {
  const [hold, setHold] = useState<boolean>(!!row.legalHold);
  const initialOverride =
    row.retentionOverrideDays != null ? String(row.retentionOverrideDays) : "";
  const [override, setOverride] = useState<string>(initialOverride);
  const [baselineOverride, setBaselineOverride] = useState<string>(
    row.retentionOverrideDays != null ? String(row.retentionOverrideDays) : "",
  );
  const [err, setErr] = useState<string | null>(null);
  const [okMsg, setOkMsg] = useState<string | null>(null);
  const [operationKind, setOperationKind] = useState<
    "hold" | "override" | null
  >(null);
  const operation = useSingleFlightOperation({
    ownerId: `audit-event-retention-${row.id}`,
    label: "Audit event retention update",
    detail: "Wait for the event-retention request to finish before leaving.",
  });
  const dirty = override !== baselineOverride;
  const discard = useCallback((): void => {
    setOverride(baselineOverride);
    setErr(null);
    setOkMsg(null);
  }, [baselineOverride]);

  const apply = async (patch: {
    legal_hold?: boolean;
    retention_override_days?: number | null;
  }): Promise<boolean> => {
    const pending = operation.promiseRef.current;
    if (pending) return (await pending) === true;
    const request = operation.run(async (): Promise<boolean> => {
      setOperationKind(patch.legal_hold !== undefined ? "hold" : "override");
      setErr(null);
      setOkMsg(null);
      try {
        const res = await api.setEventRetentionOverride(row.id, patch);
        if (res.error) {
          setErr(res.error.message);
          return false;
        }
        if (patch.legal_hold !== undefined) setHold(!!patch.legal_hold);
        if (patch.retention_override_days !== undefined) {
          const next =
            patch.retention_override_days == null
              ? ""
              : String(patch.retention_override_days);
          setOverride(next);
          setBaselineOverride(next);
        }
        setOkMsg("Saved.");
        return true;
      } catch (error) {
        setErr(lifecycleOperationError(error, "The retention update failed."));
        return false;
      } finally {
        setOperationKind(null);
      }
    });
    return request ? await request : false;
  };

  const submitOverride = async (): Promise<boolean> => {
    const trimmed = override.trim();
    if (trimmed === "") return apply({ retention_override_days: null });
    const days = Number.parseInt(trimmed, 10);
    if (!Number.isFinite(days) || days < 1 || days > 3650) {
      setErr("Override days must be 1..3650, or blank to clear.");
      return false;
    }
    return apply({ retention_override_days: days });
  };

  useExistingSettingLifecycle({
    ownerId: `audit-event-retention-${row.id}`,
    label: "Audit event retention override",
    dirty,
    operationRef: operation.promiseRef,
    save: submitOverride,
    discard,
    detail: "This event retention override has not been saved.",
    operationDetail:
      "Wait for the event-retention request to finish before leaving Moosewave.",
  });
  useEffect(() => {
    onLifecycleState(dirty, operation.active, discard);
  }, [dirty, discard, onLifecycleState, operation.active]);

  return (
    <div
      data-testid="retention-override-panel"
      aria-busy={operation.active ? "true" : undefined}
    >
      <div className="label">Retention &amp; legal hold</div>
      <div
        className="row"
        style={{ gap: 8, alignItems: "center", marginTop: 4, flexWrap: "wrap" }}
      >
        <button
          type="button"
          className={`btn btn-sm ${hold ? "btn-warning" : "btn-secondary"}`}
          onClick={() => void apply({ legal_hold: !hold })}
          disabled={operation.active}
          aria-describedby="audit-retention-hold-consequence"
          data-testid="retention-hold-toggle"
        >
          {operation.active && operationKind === "hold"
            ? "Updating hold…"
            : hold
              ? "Release hold"
              : "Place hold"}
        </button>
        {hold ? (
          <span
            className="audit-severity-badge is-destructive"
            aria-label="On legal hold — exempt from retention trimming"
          >
            On hold
          </span>
        ) : null}
        <label
          className="muted small"
          htmlFor="retention-override-days"
          style={{ marginLeft: 8 }}
        >
          Override (days)
        </label>
        <input
          id="retention-override-days"
          type="number"
          min={1}
          max={3650}
          className="input"
          style={{ width: 96, fontSize: 12 }}
          value={override}
          onChange={(e) => setOverride(e.target.value)}
          placeholder="—"
          disabled={operation.active}
        />
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => void submitOverride()}
          disabled={operation.active}
          aria-describedby="audit-retention-override-consequence"
        >
          {operation.active && operationKind === "override"
            ? "Applying…"
            : "Apply"}
        </button>
      </div>
      <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>
        <span id="audit-retention-hold-consequence">
          {hold
            ? "Releasing the legal hold makes this row eligible for retention trimming again."
            : "A legal hold exempts this row from retention trimming until released."}
        </span>{" "}
        <span id="audit-retention-override-consequence">
          The per-row override replaces the tenant default for this row only;
          leave it blank and apply to clear the override.
        </span>{" "}
        Both changes are recorded as audit.retention.override_set events.
      </div>
      {operation.active ? (
        <div className="pw-action-status" role="status">
          {operationKind === "hold"
            ? "Updating the legal-hold state…"
            : "Applying the retention override…"}
        </div>
      ) : null}
      {err ? (
        <div
          className="notice"
          style={{ marginTop: 6, fontSize: 12 }}
          role="alert"
        >
          {err}
        </div>
      ) : null}
      {okMsg && !err ? (
        <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>
          {okMsg}
        </div>
      ) : null}
    </div>
  );
}
