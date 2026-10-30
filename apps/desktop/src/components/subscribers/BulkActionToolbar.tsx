import { type ReactElement, useEffect, useId, useRef } from "react";

import {
  bulkBusyLabel,
  type BulkActionBarProps,
  type BulkActionCallbacks,
  type BulkActionUiState,
} from "./bulk-action-types";
import { emptyConsentEvidenceDraft } from "./consent-evidence";

interface BulkActionToolbarProps {
  count: number;
  canBulk: boolean;
  canMutate: boolean;
  onClear: BulkActionBarProps["onClear"];
  onOpenDedupeReview: BulkActionBarProps["onOpenDedupeReview"];
  state: BulkActionUiState;
  actions: BulkActionCallbacks;
}

export function BulkActionToolbar({
  count,
  canBulk,
  canMutate,
  onClear,
  onOpenDedupeReview,
  state,
  actions,
}: BulkActionToolbarProps): ReactElement {
  const availabilityId = useId();
  const guidanceId = useId();
  const extendedActionsId = useId();
  const label = (
    idle: string,
    working: string,
    kind: Parameters<typeof bulkBusyLabel>[4],
  ) => bulkBusyLabel(state.busy, state.progress, idle, working, kind);
  const busy = state.busy != null;
  const availability = bulkAvailabilityCopy(canBulk, canMutate, busy);
  const blockedDescription = availability ? availabilityId : undefined;

  return (
    <div
      role="region"
      aria-label="Bulk actions"
      style={{
        display: "flex",
        alignItems: "center",
        flexWrap: "wrap",
        gap: 10,
        padding: "8px 12px",
        background: "color-mix(in srgb, var(--pw-accent) 12%, transparent)",
        border: "1px solid var(--pw-accent)",
        borderRadius: 6,
        marginBottom: 8,
      }}
    >
      <span style={{ fontSize: 12, color: "var(--pw-fg)", fontWeight: 500 }}>
        {count.toLocaleString()} selected
      </span>
      <span className="spacer" style={{ flex: 1 }} />
      <button
        type="button"
        className="btn btn-sm"
        onClick={() => state.setShowTag(true)}
        disabled={!canBulk || busy}
        aria-describedby={!canBulk || busy ? blockedDescription : undefined}
      >
        {label("Add tag", "Tagging", "tag")}
      </button>
      <button
        type="button"
        className="btn btn-sm"
        onClick={() => void actions.validateEmails()}
        disabled={busy}
        aria-describedby={busy ? `${guidanceId} ${availabilityId}` : guidanceId}
      >
        {state.busy === "validate" ? "Validating…" : "Validate emails"}
      </button>
      <button
        type="button"
        className="btn btn-sm"
        onClick={() => {
          if (!busy) state.setShowLookalike(true);
        }}
        disabled={busy}
        aria-disabled={!canMutate || undefined}
        aria-describedby={
          !canMutate || busy ? `${guidanceId} ${availabilityId}` : guidanceId
        }
      >
        Generate Lookalike
      </button>
      <button
        type="button"
        className="btn btn-sm"
        onClick={() => state.setShowSuppress(true)}
        disabled={!canBulk || busy}
        aria-describedby={!canBulk || busy ? blockedDescription : undefined}
      >
        {label("Suppress", "Suppressing", "suppress")}
      </button>
      {count === 2 ? (
        <button
          type="button"
          className="btn btn-sm"
          onClick={onOpenDedupeReview}
          disabled={!canMutate || busy}
          aria-describedby={
            !canMutate || busy ? `${guidanceId} ${availabilityId}` : guidanceId
          }
        >
          Review duplicates…
        </button>
      ) : null}
      <button
        type="button"
        className="btn btn-sm"
        onClick={() => state.setShowMore((visible) => !visible)}
        disabled={busy}
        aria-expanded={state.showMore}
        aria-controls={extendedActionsId}
        aria-describedby={busy ? blockedDescription : undefined}
      >
        More…
      </button>
      {state.showMore ? (
        <BulkExtendedButtons
          canBulk={canBulk}
          descriptionId={blockedDescription}
          groupId={extendedActionsId}
          state={state}
          exportCsv={actions.exportCsv}
        />
      ) : null}
      <button
        type="button"
        className="btn btn-sm"
        onClick={() => state.setShowDelete(true)}
        disabled={!canBulk || busy}
        aria-describedby={!canBulk || busy ? blockedDescription : undefined}
        style={{ color: "var(--pw-danger)" }}
      >
        {label("Delete", "Deleting", "delete")}
      </button>
      <button
        type="button"
        className="btn btn-sm btn-ghost"
        onClick={onClear}
        disabled={busy}
        aria-label="Clear selection (Escape)"
        aria-describedby={busy ? blockedDescription : undefined}
      >
        Clear <kbd aria-hidden="true">Esc</kbd>
      </button>
      <p
        id={guidanceId}
        className="muted"
        style={{ flexBasis: "100%", margin: 0, fontSize: 11 }}
      >
        Validate is read-only and checks syntax, mail routing, disposable
        domains, and role accounts. Lookalike uses first-party data only.
        Duplicate review runs a complete server scan before any merge.
      </p>
      {availability ? (
        <p
          id={availabilityId}
          className="muted"
          role="status"
          aria-live="polite"
          style={{ flexBasis: "100%", margin: 0, fontSize: 11 }}
        >
          {availability}
        </p>
      ) : null}
    </div>
  );
}

function bulkAvailabilityCopy(
  canBulk: boolean,
  canMutate: boolean,
  busy: boolean,
): string | null {
  if (busy) {
    return "A bulk action is in progress. Other actions remain unavailable until it finishes.";
  }
  if (!canBulk && !canMutate) {
    return "Viewer access can validate selected emails but cannot change subscriber records.";
  }
  if (!canBulk) {
    return "Admin access is required for tagging, suppression, deletion, consent, list, field, and export actions.";
  }
  if (!canMutate) {
    return "Write access is required to generate lookalikes or merge subscribers.";
  }
  return null;
}

interface BulkExtendedButtonsProps {
  canBulk: boolean;
  descriptionId: string | undefined;
  groupId: string;
  state: BulkActionUiState;
  exportCsv: () => Promise<void>;
}

function BulkExtendedButtons({
  canBulk,
  descriptionId,
  groupId,
  state,
  exportCsv,
}: BulkExtendedButtonsProps): ReactElement {
  const disabled = !canBulk || state.busy != null;
  return (
    <div
      id={groupId}
      role="group"
      aria-label="More bulk actions"
      style={{
        display: "flex",
        alignItems: "center",
        flexWrap: "wrap",
        gap: 10,
      }}
    >
      <button
        type="button"
        className="btn btn-sm"
        onClick={() => {
          state.setConsentEvidence(emptyConsentEvidenceDraft());
          state.setShowResubscribe(true);
        }}
        disabled={disabled}
        aria-describedby={disabled ? descriptionId : undefined}
      >
        {state.busy === "resubscribe" ? "Resubscribing…" : "Resubscribe"}
      </button>
      <button
        type="button"
        className="btn btn-sm"
        onClick={() => state.setShowAddToList(true)}
        disabled={disabled}
        aria-describedby={disabled ? descriptionId : undefined}
      >
        {state.busy === "addToList" ? "Adding…" : "Add to list"}
      </button>
      <button
        type="button"
        className="btn btn-sm"
        onClick={() => state.setShowCustomField(true)}
        disabled={disabled}
        aria-describedby={disabled ? descriptionId : undefined}
      >
        {state.busy === "customField" ? "Saving…" : "Set custom field"}
      </button>
      <button
        type="button"
        className="btn btn-sm"
        onClick={() => state.setShowMergeField(true)}
        disabled={disabled}
        aria-describedby={disabled ? descriptionId : undefined}
      >
        {state.busy === "mergeField" ? "Saving…" : "Update merge field"}
      </button>
      <button
        type="button"
        className="btn btn-sm"
        onClick={() => {
          state.setConsentEvidence(emptyConsentEvidenceDraft());
          state.setShowConsent("grant");
        }}
        disabled={disabled}
        aria-describedby={disabled ? descriptionId : undefined}
      >
        {state.busy === "grantConsent" ? "Granting…" : "Grant consent"}
      </button>
      <button
        type="button"
        className="btn btn-sm"
        onClick={() => {
          state.setConsentEvidence(emptyConsentEvidenceDraft());
          state.setShowConsent("revoke");
        }}
        disabled={disabled}
        aria-describedby={disabled ? descriptionId : undefined}
      >
        {state.busy === "revokeConsent" ? "Revoking…" : "Revoke consent"}
      </button>
      <button
        type="button"
        className="btn btn-sm"
        onClick={() => void exportCsv()}
        disabled={disabled}
        aria-describedby={disabled ? descriptionId : undefined}
      >
        {state.busy === "export" ? "Exporting…" : "Export CSV"}
      </button>
    </div>
  );
}

interface BulkActionProgressProps {
  count: number;
  plural: string;
  state: BulkActionUiState;
}

export function BulkActionProgress({
  count,
  plural,
  state,
}: BulkActionProgressProps): ReactElement | null {
  const outcomeRef = useRef<HTMLDivElement | null>(null);
  const progress = state.busy == null ? null : state.progress;
  useEffect(() => {
    if (state.outcome?.focusOnRender) outcomeRef.current?.focus();
  }, [state.outcome]);
  if (progress == null && state.outcome == null) return null;
  const percentage =
    progress && progress.total > 0
      ? Math.round((progress.current / progress.total) * 100)
      : 0;
  return (
    <>
      {progress ? (
        <div
          ref={outcomeRef}
          role="status"
          aria-live="polite"
          aria-busy="true"
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 6,
            padding: "8px 12px",
            marginBottom: 8,
            fontSize: 12,
            color: "var(--pw-fg)",
            background: "var(--pw-bg-elev-2)",
            border: "1px solid var(--pw-border)",
            borderRadius: 6,
          }}
        >
          <span>
            {progress.label} {count.toLocaleString()} subscriber{plural}
            {progress.total > 1
              ? ` — step ${progress.current}/${progress.total}`
              : "…"}
            {progress.retrySeconds != null
              ? ` Rate limited — automatic attempt ${(progress.attempt ?? 1) + 1} of ${progress.maxAttempts ?? 3} starts in ${progress.retrySeconds}s.`
              : ""}
          </span>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <div
              role="progressbar"
              aria-label={`${progress.label} progress`}
              aria-valuemin={0}
              aria-valuemax={progress.total}
              aria-valuenow={progress.current}
              aria-valuetext={
                progress.retrySeconds != null
                  ? `Waiting ${progress.retrySeconds} seconds before the next automatic attempt`
                  : `${progress.current} of ${progress.total} steps complete`
              }
              style={{
                height: 4,
                flex: 1,
                borderRadius: 2,
                overflow: "hidden",
                background: "color-mix(in srgb, var(--pw-fg) 12%, transparent)",
              }}
            >
              <div
                aria-hidden="true"
                style={{
                  height: "100%",
                  width: `${percentage}%`,
                  background: "var(--pw-accent)",
                  transition: "width 160ms ease",
                }}
              />
            </div>
            {progress.retrySeconds != null ? (
              <button
                type="button"
                className="btn btn-sm"
                onClick={state.cancelRetry}
              >
                Cancel automatic retry
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
      {state.outcome ? (
        <div
          className={`notice${
            state.outcome.tone === "error"
              ? " danger"
              : state.outcome.tone === "warning"
                ? " warning"
                : ""
          }`}
          role={state.outcome.tone === "error" ? "alert" : "status"}
          tabIndex={-1}
          aria-live={state.outcome.tone === "error" ? "assertive" : "polite"}
          style={{ marginBottom: 8, fontSize: 12 }}
        >
          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <div style={{ flex: 1 }}>
              <strong>{state.outcome.title}</strong>
              <div>{state.outcome.message}</div>
            </div>
            {state.outcome.retry ? (
              <button
                type="button"
                className="btn btn-sm"
                disabled={state.busy != null}
                onClick={state.outcome.retry.run}
              >
                {state.outcome.retry.label}
              </button>
            ) : null}
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              disabled={state.busy != null}
              onClick={() => state.setOutcome(null)}
              aria-label="Dismiss bulk-action outcome"
            >
              Dismiss
            </button>
          </div>
        </div>
      ) : null}
    </>
  );
}
