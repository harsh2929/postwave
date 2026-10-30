// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import {
  useEffect,
  useRef,
  useState,
  type MutableRefObject,
  type RefObject,
} from "react";
import Link from "next/link";
import { useQueryClient } from "@tanstack/react-query";
import { ExternalLink } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
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
import {
  ApprovalTargetChangedError,
  isApprovalAuthorityFailure,
  isSelfApprovalDenial,
  recordVerifiedRejection,
  type RejectionAttempt,
} from "@/lib/approval-rejection";
import { ApiError } from "@/lib/api";
import {
  resourceHref,
  resourceTypeLabel,
  type Approval,
} from "@/lib/approvals-api";
import { FreshAdminAuthorityError } from "@/lib/admin-mutation-authority";
import type { MeResponse } from "@/lib/auth-api";
import { newUUIDv7 } from "@/lib/http-fetch";
import { qk } from "@/lib/query-keys";
import { asRoute } from "@/lib/typed-routes";

export type ApprovalDecisionKind = "reject";
export type ApprovalActionLock = MutableRefObject<symbol | null>;

const REJECTION_REASON_LIMIT = 500;

export function ApprovalDecisionDialog({
  approval,
  kind,
  identity,
  authorityKey,
  protectedQueryKey,
  actionLock,
  onAuthorityDenied,
  onClose,
  onReconciled,
  onRecorded,
  returnFocusRef,
  fallbackFocusRef,
}: {
  approval: Approval | null;
  kind: ApprovalDecisionKind | null;
  identity: MeResponse;
  authorityKey: string;
  protectedQueryKey: readonly unknown[];
  actionLock: ApprovalActionLock;
  onAuthorityDenied: () => void;
  onClose: () => void;
  onReconciled: (latest: Approval) => void;
  onRecorded: (recorded: Approval) => void;
  returnFocusRef?: RefObject<HTMLElement | null>;
  fallbackFocusRef?: RefObject<HTMLElement | null>;
}) {
  if (!approval || !kind) return null;
  return (
    <RejectionDialogBody
      key={`${authorityKey}\u001f${approval.id}\u001f${kind}`}
      openedApproval={approval}
      identity={identity}
      authorityKey={authorityKey}
      protectedQueryKey={protectedQueryKey}
      actionLock={actionLock}
      onAuthorityDenied={onAuthorityDenied}
      onClose={onClose}
      onReconciled={onReconciled}
      onRecorded={onRecorded}
      returnFocusRef={returnFocusRef}
      fallbackFocusRef={fallbackFocusRef}
    />
  );
}

function RejectionDialogBody({
  openedApproval,
  identity,
  authorityKey,
  protectedQueryKey,
  actionLock,
  onAuthorityDenied,
  onClose,
  onReconciled,
  onRecorded,
  returnFocusRef,
  fallbackFocusRef,
}: {
  openedApproval: Approval;
  identity: MeResponse;
  authorityKey: string;
  protectedQueryKey: readonly unknown[];
  actionLock: ApprovalActionLock;
  onAuthorityDenied: () => void;
  onClose: () => void;
  onReconciled: (latest: Approval) => void;
  onRecorded: (recorded: Approval) => void;
  returnFocusRef?: RefObject<HTMLElement | null>;
  fallbackFocusRef?: RefObject<HTMLElement | null>;
}) {
  const queryClient = useQueryClient();
  const [approval] = useState<Approval>(() => ({ ...openedApproval }));
  const [notes, setNotes] = useState("");
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const workingRef = useRef(false);
  const mountedRef = useRef(true);
  const controllerRef = useRef<AbortController | null>(null);
  const ownedLockRef = useRef<symbol | null>(null);
  const attemptRef = useRef<RejectionAttempt | null>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);
  const href = resourceHref(approval.resourceType, approval.resourceId);

  useEffect(() => {
    return () => {
      mountedRef.current = false;
      controllerRef.current?.abort();
      const ownedLock = ownedLockRef.current;
      if (ownedLock && actionLock.current === ownedLock) {
        actionLock.current = null;
      }
      ownedLockRef.current = null;
      workingRef.current = false;
    };
  }, [actionLock]);

  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);

  function restoreReturnFocus(): void {
    const active = document.activeElement;
    const activeElement = active instanceof HTMLElement ? active : null;
    const activeIsUsableElsewhere =
      activeElement?.isConnected &&
      activeElement !== document.body &&
      !activeElement.closest('[role="dialog"]');
    if (activeIsUsableElsewhere) return;

    const trigger = returnFocusRef?.current;
    const target = trigger?.isConnected ? trigger : fallbackFocusRef?.current;
    if (target?.isConnected) target.focus();
  }

  function queueReturnFocus(): void {
    setTimeout(() => {
      restoreReturnFocus();
      requestAnimationFrame(restoreReturnFocus);
    }, 0);
  }

  function requestClose(): void {
    if (workingRef.current || working) return;
    controllerRef.current?.abort();
    onClose();
  }

  function containAuthorityFailure(cause: unknown): void {
    void queryClient.cancelQueries({
      queryKey: protectedQueryKey,
      exact: false,
    });
    queryClient.removeQueries({ queryKey: protectedQueryKey, exact: false });
    if (cause instanceof FreshAdminAuthorityError) {
      queryClient.setQueryData(qk.authMe(), cause.freshIdentity);
    } else {
      void queryClient.invalidateQueries({
        queryKey: qk.authMe(),
        exact: true,
      });
    }
  }

  async function submit(): Promise<void> {
    if (workingRef.current) return;
    if (actionLock.current !== null) {
      setError(
        "Another approval action is already running. Wait for it to finish before retrying.",
      );
      return;
    }
    const cleanNotes = notes.trim();
    if (cleanNotes.length === 0) {
      setError("A rejection reason is required for the approval audit record.");
      return;
    }
    if (cleanNotes.length > REJECTION_REASON_LIMIT) {
      setError(
        `Keep the rejection reason to ${REJECTION_REASON_LIMIT} characters.`,
      );
      return;
    }

    const fingerprint = [
      authorityKey,
      approval.id,
      approval.tenantId,
      approval.resourceType,
      approval.resourceId,
      approval.requestedAt,
      cleanNotes,
    ].join("\u001f");
    let attempt = attemptRef.current;
    if (!attempt || attempt.fingerprint !== fingerprint) {
      attempt = {
        fingerprint,
        idempotencyKey: newUUIDv7(),
        requestStarted: false,
      };
      attemptRef.current = attempt;
    }

    const lockToken = Symbol("approval-rejection");
    actionLock.current = lockToken;
    ownedLockRef.current = lockToken;
    workingRef.current = true;
    setWorking(true);
    setError(null);
    const controller = new AbortController();
    controllerRef.current = controller;

    try {
      const recorded = await recordVerifiedRejection({
        approval,
        attempt,
        identity,
        notes: cleanNotes,
        signal: controller.signal,
      });

      attemptRef.current = null;
      toast.success("Rejection decision recorded.", {
        description:
          "Requester notification and downstream effects were not verified.",
      });
      onRecorded(recorded);
    } catch (cause) {
      if (isAbort(cause) || !mountedRef.current) return;
      if (isApprovalAuthorityFailure(cause)) {
        containAuthorityFailure(cause);
        onAuthorityDenied();
        onClose();
        return;
      }
      if (isSelfApprovalDenial(cause)) {
        attemptRef.current = null;
        setError(
          "You requested this approval, so separation-of-duties policy prevents you from rejecting it. Another workspace owner or admin must decide it.",
        );
        return;
      }
      if (cause instanceof ApprovalTargetChangedError) {
        attemptRef.current = null;
        toast.error("Approval changed. No rejection was sent.", {
          description: cause.message,
        });
        onReconciled(cause.latest);
        onClose();
        return;
      }
      setError(
        cause instanceof Error
          ? cause.message
          : "The decision could not be verified. No successful rejection is claimed.",
      );
    } finally {
      if (controllerRef.current === controller) controllerRef.current = null;
      if (actionLock.current === lockToken) actionLock.current = null;
      if (ownedLockRef.current === lockToken) ownedLockRef.current = null;
      workingRef.current = false;
      if (mountedRef.current) setWorking(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && requestClose()}>
      <DialogContent
        aria-busy={working}
        closeDisabled={working}
        className="max-h-[calc(100dvh-2rem)] overflow-y-auto [&_a]:min-h-11 [&_a]:min-w-11 [&_a]:focus-visible:ring-2 [&_button]:min-h-11 [&_button]:min-w-11 [&_textarea]:text-base sm:[&_button]:min-w-0 sm:[&_textarea]:text-sm"
        onEscapeKeyDown={(event) => {
          if (workingRef.current) event.preventDefault();
        }}
        onPointerDownOutside={(event) => {
          if (workingRef.current) event.preventDefault();
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          restoreReturnFocus();
          queueReturnFocus();
        }}
      >
        <DialogHeader>
          <DialogTitle>
            Reject {resourceTypeLabel(approval.resourceType)}
          </DialogTitle>
          <DialogDescription>
            This records a rejection decision on the exact approval after a
            fresh authority check. It does not prove requester notification or
            any downstream effect.
          </DialogDescription>
        </DialogHeader>
        {href ? (
          <Link
            href={asRoute(href)}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex w-fit max-w-full items-center gap-1 break-all text-sm text-primary hover:underline"
          >
            Inspect {approval.resourceId}
            <ExternalLink className="size-3.5 shrink-0" aria-hidden />
          </Link>
        ) : (
          <p className="break-all font-mono text-xs text-muted-foreground">
            {approval.resourceId || "No resource identifier"}
          </p>
        )}
        <div className="space-y-1.5">
          <Label htmlFor="decision-notes">Reason (required)</Label>
          <Textarea
            id="decision-notes"
            value={notes}
            onChange={(event) => {
              setNotes(event.target.value);
              if (error) setError(null);
            }}
            placeholder="What must change before this can be reconsidered?"
            rows={4}
            maxLength={REJECTION_REASON_LIMIT}
            required
            disabled={working}
            aria-invalid={Boolean(error)}
            aria-describedby={error ? "decision-error" : "decision-help"}
          />
          <p id="decision-help" className="text-xs text-muted-foreground">
            Up to {REJECTION_REASON_LIMIT} characters. The submitted text is
            frozen for the duration of this attempt. A recorded rejection saves
            this reason in the approval audit record. Do not include
            credentials, recipient data, or other secrets.
          </p>
          {error ? (
            <p
              ref={errorRef}
              id="decision-error"
              role="alert"
              tabIndex={-1}
              className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive-emphasis outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {error}
            </p>
          ) : null}
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            onClick={requestClose}
            disabled={working}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            onClick={() => void submit()}
            loading={working}
          >
            Reject
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function isAbort(cause: unknown): boolean {
  return (
    (cause instanceof DOMException && cause.name === "AbortError") ||
    (cause instanceof ApiError && cause.kind === "aborted")
  );
}
