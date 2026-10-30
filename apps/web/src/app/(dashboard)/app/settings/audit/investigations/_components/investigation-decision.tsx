// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useId, useRef, useState } from "react";

import { RelativeTime } from "@/components/relative-time";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { apiErrorMessage } from "@/lib/api";
import {
  rejectionReasonError,
  type AuditInvestigation,
} from "@/lib/audit-investigations-api";
import { useUnsavedChangesGuard } from "@/lib/use-unsaved-changes-guard";

export const ADMIN_REQUIRED_TO_DECIDE =
  "Approving or rejecting a remediation plan requires a workspace admin. Ask an admin to review this investigation.";

interface Props {
  investigation: AuditInvestigation;
  isAdmin: boolean;
  busy: boolean;
  onApprove: () => Promise<void>;
  onReject: (reason: string) => Promise<void>;
}

/**
 * Whole-plan Approve / Reject, offered only while the plan is a draft and
 * only to an admin (the server gates both routes on ScopeAdmin). Anyone
 * else sees why the controls are absent rather than a button that 403s.
 */
export function InvestigationDecision({
  investigation,
  isAdmin,
  busy,
  onApprove,
  onReject,
}: Props) {
  if (investigation.status !== "draft") {
    return <DecisionRecord investigation={investigation} />;
  }
  if (!isAdmin) {
    return (
      <p
        className="text-sm text-muted-foreground"
        data-testid="decision-withheld"
      >
        {ADMIN_REQUIRED_TO_DECIDE}
      </p>
    );
  }
  const actionCount = investigation.proposed_actions.length;
  return (
    <div className="flex flex-wrap justify-end gap-2">
      <RejectInvestigationDialog busy={busy} onReject={onReject} />
      <ConfirmDialog
        trigger={
          <Button type="button" disabled={busy}>
            Approve remediation plan
          </Button>
        }
        title="Approve the remediation plan?"
        description={
          <>
            This records that a human accepted all {actionCount} proposed{" "}
            {actionCount === 1 ? "action" : "actions"}. Moosewave will not
            apply the identity, key, token, MFA, or IP changes itself — carry
            them out through your external operations workflow. Approval
            cannot be undone.
          </>
        }
        confirmLabel="Approve plan"
        confirmVariant="default"
        onConfirm={onApprove}
      />
    </div>
  );
}

function DecisionRecord({
  investigation,
}: {
  investigation: AuditInvestigation;
}) {
  const decidedAt =
    investigation.status === "approved"
      ? (investigation.approved_at ?? investigation.updated_at)
      : investigation.status === "executed"
        ? (investigation.executed_at ?? investigation.updated_at)
        : investigation.updated_at;
  return (
    <div className="space-y-2 text-sm" data-testid="decision-record">
      <p>
        This investigation was{" "}
        <strong className="font-medium">{investigation.status}</strong>{" "}
        {decidedAt ? <RelativeTime iso={decidedAt} /> : null}
        {investigation.approved_by ? (
          <>
            {" "}
            by{" "}
            <span className="font-mono text-xs">
              {investigation.approved_by}
            </span>
          </>
        ) : null}
        . Approve and reject are only offered while a plan is a draft.
      </p>
      {investigation.status === "rejected" && investigation.rejection_reason ? (
        <div className="rounded-md border bg-muted/40 p-3">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Rejection reason
          </p>
          <p className="mt-1 whitespace-pre-wrap">
            {investigation.rejection_reason}
          </p>
        </div>
      ) : null}
    </div>
  );
}

function RejectInvestigationDialog({
  busy,
  onReject,
}: {
  busy: boolean;
  onReject: (reason: string) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [discardOpen, setDiscardOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const reasonId = useId();
  const errorId = useId();
  const dirty = reason.trim().length > 0;
  // A typed reason is unsent work: guard the tab close and in-app navigation
  // the same way every other settings draft is guarded.
  useUnsavedChangesGuard(open && dirty && !pending);

  function reset(): void {
    setReason("");
    setError(null);
  }

  // Closing with a draft asks first; closing empty just closes.
  function requestClose(): void {
    if (pending) return;
    if (dirty) {
      setDiscardOpen(true);
      return;
    }
    reset();
    setOpen(false);
  }

  async function submit(): Promise<void> {
    const validation = rejectionReasonError(reason);
    if (validation) {
      setError(validation);
      return;
    }
    setPending(true);
    setError(null);
    try {
      await onReject(reason.trim());
      reset();
      setOpen(false);
    } catch (cause) {
      setError(apiErrorMessage(cause, "The rejection could not be recorded."));
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <Button
        ref={triggerRef}
        type="button"
        variant="outline"
        disabled={busy}
        onClick={() => setOpen(true)}
      >
        Reject
      </Button>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (next) setOpen(true);
          else requestClose();
        }}
      >
        <DialogContent
          closeDisabled={pending}
          onEscapeKeyDown={(event) => {
            if (pending) event.preventDefault();
          }}
          onPointerDownOutside={(event) => {
            if (pending) event.preventDefault();
          }}
        >
          <DialogHeader>
            <DialogTitle>Reject investigation</DialogTitle>
            <DialogDescription>
              Rejecting records the dismissal with your reason in the audit
              trail. The reason is visible to anyone with audit:read.
            </DialogDescription>
          </DialogHeader>
          <form
            className="space-y-2"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <Label htmlFor={reasonId}>Reason</Label>
            <Textarea
              id={reasonId}
              value={reason}
              onChange={(event) => {
                setReason(event.target.value);
                if (error) setError(null);
              }}
              rows={4}
              disabled={pending}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? errorId : undefined}
              placeholder="e.g. confirmed false positive — the actor reset their own password from a new device"
            />
            {error ? (
              <p id={errorId} role="alert" className="text-sm text-destructive">
                {error}
              </p>
            ) : null}
            <DialogFooter>
              <Button
                type="button"
                variant="ghost"
                disabled={pending}
                onClick={requestClose}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                variant="destructive"
                disabled={pending}
                loading={pending}
              >
                {pending ? "Rejecting…" : "Reject investigation"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={discardOpen}
        onOpenChange={setDiscardOpen}
        title="Discard rejection reason?"
        description="The rejection has not been submitted. The reason you typed will be lost."
        confirmLabel="Discard reason"
        cancelLabel="Keep editing"
        returnFocusRef={triggerRef}
        onConfirm={() => {
          reset();
          setOpen(false);
        }}
      />
    </>
  );
}
