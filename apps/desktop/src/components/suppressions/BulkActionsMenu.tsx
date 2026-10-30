/**
 * BulkActionsMenu — appears above the suppressions table when ≥1 row
 * is selected (GAP-LS-016 + 017). Parent (Suppressions page) only
 * mounts the selection UI for admins, so every verb here is
 * admin-gated upstream — matching the server, which mounts both bulk
 * routes behind the admin scope.
 *
 * Two verbs against the new bulk wrappers:
 *   • Delete selected — POST /api/v1/suppressions/bulk-delete
 *   • Change reason   — POST /api/v1/suppressions/bulk-action
 *                       (action="change_reason", canonical X1 reason)
 *
 * Rows are addressed by EMAIL, not id. The parent only makes canonical
 * deliverability-search rows selectable: the ordinary library is backed by
 * email_suppressions and must not be passed to an action that re-resolves a
 * different subscriber_suppressions row by address.
 *
 * Force handling is two-phase and honest: the first delete runs
 * WITHOUT force; rows the server refuses come back in `blocked`
 * ("<id>: <reason> requires force=true" / "… is permanent") and are
 * shown verbatim. The operator can then force-release the forceable
 * subset; permanent (DSAR) rows stay blocked regardless.
 *
 * There is deliberately NO "export selected": the export endpoint
 * streams the whole reason-scoped table and ignores an `ids=` param,
 * so an "Export selected" button would lie about its scope.
 */

import { type ReactElement, useId, useRef, useState } from "react";

import {
  SUPPRESSION_REASONS_X1,
  type SuppressionBulkDeleteResult,
  type SuppressionReason,
  type SuppressionRow,
  suppressionsApi,
} from "../../lib/api-client";
import { redact } from "../../lib/auth";
import { Modal, ModalFooter } from "../Modal";
import { toast } from "../Toast";
import { forceSelector, splitBlocked } from "./bulk-blocked";

interface Props {
  /** Rows currently selected in the table. */
  selected: SuppressionRow[];
  /** Clear the parent's selection state after an action completes. */
  onClear: () => void;
  /** Refetch the table after a bulk mutation changed rows. */
  onAfterMutate: () => void;
}

interface DeleteResultReportProps {
  result: SuppressionBulkDeleteResult;
  blockedSplit: ReturnType<typeof splitBlocked>;
}

function DeleteResultReport({
  result,
  blockedSplit,
}: DeleteResultReportProps): ReactElement {
  return (
    <>
      <div className="notice" style={{ marginBottom: 8 }}>
        <span>
          {result.deleted_count.toLocaleString()} removed ·{" "}
          {(result.blocked?.length ?? 0).toLocaleString()} blocked by policy
          {(result.errors?.length ?? 0) > 0
            ? ` · ${result.errors.length.toLocaleString()} error${
                result.errors.length === 1 ? "" : "s"
              }`
            : ""}
          .
        </span>
      </div>
      {(result.blocked?.length ?? 0) > 0 ? (
        <div className="field">
          <div className="field-label">Blocked rows</div>
          <div
            className="mono muted"
            style={{
              fontSize: 11,
              maxHeight: 160,
              overflowY: "auto",
              border: "1px solid var(--pw-border)",
              borderRadius: 6,
              padding: 8,
            }}
          >
            {result.blocked.map((line, index) => (
              <div key={index} style={{ wordBreak: "break-all" }}>
                {line}
              </div>
            ))}
          </div>
          {blockedSplit.permanent.length > 0 ? (
            <div className="field-help" style={{ marginTop: 6 }}>
              {blockedSplit.permanent.length.toLocaleString()} row
              {blockedSplit.permanent.length === 1 ? " is" : "s are"} permanent
              (DSAR) and cannot be released.
            </div>
          ) : null}
        </div>
      ) : null}
      {(result.errors?.length ?? 0) > 0 ? (
        <div className="field">
          <div className="field-label">Errors</div>
          <div
            className="mono muted"
            style={{
              fontSize: 11,
              maxHeight: 120,
              overflowY: "auto",
              border: "1px solid var(--pw-border)",
              borderRadius: 6,
              padding: 8,
            }}
          >
            {result.errors.map((line, index) => (
              <div key={index} style={{ wordBreak: "break-all" }}>
                {redact(line)}
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </>
  );
}

export function BulkActionsMenu({
  selected,
  onClear,
  onAfterMutate,
}: Props): ReactElement | null {
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [reasonOpen, setReasonOpen] = useState(false);
  const [newReason, setNewReason] =
    useState<SuppressionReason>("manual_unsubscribe");
  const [busy, setBusy] = useState(false);
  /** Result of the last delete pass — non-null switches the delete
   *  modal from "confirm" to "report" mode. */
  const [deleteResult, setDeleteResult] =
    useState<SuppressionBulkDeleteResult | null>(null);
  const [deleteErr, setDeleteErr] = useState<string | null>(null);
  const operationRef = useRef(false);
  const forceWarningId = useId();

  // Keep rendering while a modal is open even if the selection
  // drained to zero — the parent refetch after a delete pass prunes
  // deleted rows from the selection, and yanking the report modal
  // out from under the operator would hide the errors/blocked list.
  if (selected.length === 0 && !deleteOpen && !reasonOpen) return null;

  const emails = selected.map((s) => s.email);

  const closeDelete = (): void => {
    if (busy) return;
    setDeleteOpen(false);
    setDeleteResult(null);
    setDeleteErr(null);
  };

  const blockedSplit = splitBlocked(deleteResult?.blocked ?? []);

  const runDelete = async (force: boolean): Promise<void> => {
    if (operationRef.current) return;
    operationRef.current = true;
    setBusy(true);
    setDeleteErr(null);
    // First pass targets the operator's selection by email. The force
    // pass targets ONLY the rows the server reported back as
    // force-releasable ("Force remove N blocked" must act on exactly
    // those N rows) — re-sending the full original selection would
    // force-release rows the first pass never flagged.
    try {
      const selector = force
        ? forceSelector(blockedSplit.forceable)
        : { emails };
      const res = await suppressionsApi.bulkDelete({ ...selector, force });
      if (res.error) {
        // Keep the modal open so the operator sees the failure in
        // context and can retry or cancel.
        setDeleteErr(redact(res.error.message));
        return;
      }
      const r = res.data;
      if (r.deleted_count > 0) onAfterMutate();
      const blocked = r.blocked?.length ?? 0;
      const errs = r.errors?.length ?? 0;
      if (blocked === 0 && errs === 0) {
        toast.success(
          r.deleted_count > 0
            ? `${r.deleted_count.toLocaleString()} canonical suppression rule${
                r.deleted_count === 1 ? "" : "s"
              } removed`
            : "No matching canonical rules were removed",
        );
        setDeleteOpen(false);
        setDeleteResult(null);
        onClear();
        return;
      }
      // Something was blocked or errored — show the report in-modal
      // instead of burying it in a toast.
      setDeleteResult(r);
    } catch {
      setDeleteErr("The suppression request failed. Try again.");
    } finally {
      operationRef.current = false;
      setBusy(false);
    }
  };

  const submitChangeReason = async (): Promise<void> => {
    if (operationRef.current) return;
    operationRef.current = true;
    setBusy(true);
    try {
      const res = await suppressionsApi.bulkAction({
        emails,
        action: "change_reason",
        reason: newReason,
      });
      if (res.error) {
        toast.error({
          message: "Couldn't change reason",
          detail: redact(res.error.message),
        });
        return;
      }
      if (!("updated_count" in res.data)) {
        toast.error("Unexpected response shape from bulk-action");
        return;
      }
      const { updated_count: updated, errors } = res.data;
      const reasonLabel =
        SUPPRESSION_REASONS_X1.find((r) => r.value === newReason)?.label ??
        newReason;
      toast.success({
        message: `${updated.toLocaleString()} row${
          updated === 1 ? "" : "s"
        } updated to ${reasonLabel}`,
        detail:
          errors.length > 0
            ? `${errors.length.toLocaleString()} row${
                errors.length === 1 ? "" : "s"
              } failed: ${redact(errors[0] ?? "unknown error")}`
            : updated < selected.length
              ? `${(selected.length - updated).toLocaleString()} selected row${
                  selected.length - updated === 1 ? "" : "s"
                } had no converged entry to update.`
              : undefined,
      });
      setReasonOpen(false);
      onClear();
      if (updated > 0) onAfterMutate();
    } catch {
      toast.error("Couldn't change the suppression reason. Try again.");
    } finally {
      operationRef.current = false;
      setBusy(false);
    }
  };

  return (
    <div
      role="region"
      aria-label="Bulk actions"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        marginBottom: 8,
        padding: "8px 10px",
        background: "var(--pw-bg-elev)",
        border: "1px solid var(--pw-border)",
        borderRadius: 8,
        flexWrap: "wrap",
      }}
    >
      <strong style={{ fontSize: 13 }}>
        {selected.length.toLocaleString()} selected
      </strong>
      <span style={{ flex: 1 }} />
      <button
        type="button"
        className="btn btn-sm"
        onClick={() => setReasonOpen(true)}
        disabled={busy}
      >
        Change reason
      </button>
      <button
        type="button"
        className="btn btn-sm btn-danger"
        onClick={() => {
          setDeleteResult(null);
          setDeleteErr(null);
          setDeleteOpen(true);
        }}
        disabled={busy}
      >
        Remove selected
      </button>
      <button
        type="button"
        className="btn btn-sm btn-ghost"
        onClick={onClear}
        disabled={busy}
        aria-label="Clear selection"
      >
        Cancel
      </button>

      <Modal
        open={deleteOpen}
        onClose={closeDelete}
        title={`Remove ${selected.length.toLocaleString()} suppression rule${
          selected.length === 1 ? "" : "s"
        }?`}
        description="This removes matching canonical rules only. It does not re-enable subscribers or restore consent, and other evidence or provider state may continue blocking delivery. Bounce and complaint rules require a second admin override; DSAR rules can never be removed here."
      >
        {deleteResult ? (
          <DeleteResultReport
            result={deleteResult}
            blockedSplit={blockedSplit}
          />
        ) : null}
        {deleteErr ? <div className="field-error">{deleteErr}</div> : null}
        {deleteResult && blockedSplit.forceable.length > 0 ? (
          <p
            id={forceWarningId}
            className="field-help"
            role="alert"
            style={{ marginTop: 8 }}
          >
            Admin override releases bounce or complaint rows. They may bounce or
            complain again and damage deliverability.
          </p>
        ) : null}
        <ModalFooter>
          <button
            type="button"
            className="btn"
            onClick={() => {
              const mutated = (deleteResult?.deleted_count ?? 0) > 0;
              closeDelete();
              if (mutated) onClear();
            }}
            disabled={busy}
          >
            {deleteResult ? "Done" : "Cancel"}
          </button>
          {deleteResult ? (
            blockedSplit.forceable.length > 0 ? (
              <button
                type="button"
                className="btn btn-danger"
                onClick={() => void runDelete(true)}
                disabled={busy}
                aria-describedby={forceWarningId}
              >
                {busy
                  ? "Removing…"
                  : `Override and remove ${blockedSplit.forceable.length.toLocaleString()} blocked`}
              </button>
            ) : null
          ) : (
            <button
              type="button"
              className="btn btn-danger"
              onClick={() => void runDelete(false)}
              disabled={busy}
            >
              {busy ? "Reviewing…" : "Review and remove"}
            </button>
          )}
        </ModalFooter>
      </Modal>

      <Modal
        open={reasonOpen}
        onClose={() => (busy ? undefined : setReasonOpen(false))}
        title="Change reason for selected"
        description={`Apply a new canonical reason to ${selected.length.toLocaleString()} row${
          selected.length === 1 ? "" : "s"
        }. The original reason is overwritten (the audit trail keeps it).`}
      >
        <div className="field">
          <label className="field-label" htmlFor="bulk-reason-select">
            New reason
          </label>
          <select
            id="bulk-reason-select"
            className="input"
            value={newReason}
            onChange={(e) => setNewReason(e.target.value as SuppressionReason)}
          >
            {SUPPRESSION_REASONS_X1.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
          </select>
        </div>
        <ModalFooter>
          <button
            type="button"
            className="btn"
            onClick={() => setReasonOpen(false)}
            disabled={busy}
          >
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => void submitChangeReason()}
            disabled={busy}
          >
            {busy ? "Updating…" : "Apply reason"}
          </button>
        </ModalFooter>
      </Modal>
    </div>
  );
}
