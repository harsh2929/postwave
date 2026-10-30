// SPDX-License-Identifier: AGPL-3.0-only
//
// SUB-037 — the reviewed-merge dialog. It ALWAYS previews before it commits:
// on open it POSTs /merge/apply with dry_run=true and renders the exact
// server-computed plan (which fields the duplicate loses, whether the survivor
// gets downgraded, what moves), then commits that identical plan by re-posting
// with the returned plan_fingerprint. The merge is irreversible, so nothing is
// hidden and nothing is inferred client-side.
"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import { toast } from "sonner";
import { AlertTriangle, ArrowRight, ArrowLeftRight } from "lucide-react";
import { useMutation, useQuery } from "@tanstack/react-query";

import { apiErrorMessage, isApiError } from "@/lib/api";
import {
  applyMerge,
  previewMerge,
  type DuplicatePair,
  type MergeApplyResponse,
  type MergeTarget,
} from "@/lib/subscriber-dedupe-api";
import {
  reauthorizeSubscriberMutation,
  type SubscriberAuthority,
} from "@/lib/subscriber-authority";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

// Maps a merge failure to honest, non-alarming copy. Compliance/conflict
// failures are terminal (no auto-retry); a stale/precondition failure means the
// data moved under the plan and the operator must re-scan.
function mergeErrorMessage(err: unknown): string {
  if (isApiError(err)) {
    switch (err.code) {
      case "erasure_blocked":
        return "One of these addresses was erased under a privacy request and can't be re-linked.";
      case "merge_conflict":
        return "These records conflict (different accounts, or an identifier owned by a third record) and need review.";
      case "not_found":
        return "One or both records no longer exist — re-scan to refresh.";
      case "plan_changed":
      case "fingerprint_mismatch":
        return "These records changed since you previewed — re-open to review the new plan.";
    }
    if (err.status === 412 || err.status === 428) {
      return "These records changed since the scan — re-scan to refresh.";
    }
  }
  return apiErrorMessage(err);
}

function shortValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

export function MergePreviewDialog({
  pair,
  scanId,
  authority,
  returnFocusRef,
  fallbackFocusRef,
  onClose,
  onMerged,
}: {
  pair: DuplicatePair | null;
  scanId: string;
  authority: SubscriberAuthority | null;
  returnFocusRef: RefObject<HTMLElement | null>;
  fallbackFocusRef?: RefObject<HTMLElement | null>;
  onClose: () => void;
  onMerged: (result: MergeApplyResponse) => void;
}) {
  // Which side survives. Default: the scan's primary. The operator can swap,
  // since the survivor keeps its scalar values on every conflict.
  const [swapped, setSwapped] = useState(false);
  const [mutationPending, setMutationPending] = useState(false);
  const open = pair !== null;

  // Reset the survivor choice whenever a different pair is reviewed (or the
  // dialog is closed programmatically after a merge) — a controlled-prop close
  // does not fire onOpenChange, so this is the reliable reset.
  useEffect(() => {
    setSwapped(false);
  }, [pair?.primary_id, pair?.duplicate_id]);

  const target: MergeTarget | null = pair
    ? swapped
      ? {
          scanId,
          primaryId: pair.duplicate_id,
          duplicateId: pair.primary_id,
          primaryUpdatedAt: pair.duplicate_updated_at,
          duplicateUpdatedAt: pair.primary_updated_at,
        }
      : {
          scanId,
          primaryId: pair.primary_id,
          duplicateId: pair.duplicate_id,
          primaryUpdatedAt: pair.primary_updated_at,
          duplicateUpdatedAt: pair.duplicate_updated_at,
        }
    : null;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && mutationPending) return;
        if (!next) {
          setSwapped(false);
          onClose();
        }
      }}
    >
      <DialogContent
        className="max-w-lg"
        aria-busy={mutationPending}
        onEscapeKeyDown={(event) => {
          if (mutationPending) event.preventDefault();
        }}
        onPointerDownOutside={(event) => {
          if (mutationPending) event.preventDefault();
        }}
        onCloseAutoFocus={(event) => {
          const returnTarget = returnFocusRef.current;
          const target =
            returnTarget?.isConnected &&
            !returnTarget.matches(":disabled, [aria-disabled='true']")
              ? returnTarget
              : fallbackFocusRef?.current;
          if (!target?.isConnected) return;
          event.preventDefault();
          target.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>Merge duplicate records</DialogTitle>
          <DialogDescription>
            Review exactly what will happen before you merge. This can&apos;t be
            undone.
          </DialogDescription>
        </DialogHeader>
        {pair && target && authority ? (
          <MergePreviewBody
            pair={pair}
            swapped={swapped}
            onSwap={() => setSwapped((s) => !s)}
            target={target}
            authority={authority}
            onPendingChange={setMutationPending}
            onMerged={onMerged}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function MergePreviewBody({
  pair,
  swapped,
  onSwap,
  target,
  authority,
  onPendingChange,
  onMerged,
}: {
  pair: DuplicatePair;
  swapped: boolean;
  onSwap: () => void;
  target: MergeTarget;
  authority: SubscriberAuthority;
  onPendingChange: (pending: boolean) => void;
  onMerged: (result: MergeApplyResponse) => void;
}) {
  const survivorEmail = swapped ? pair.duplicate_email : pair.primary_email;
  const removedEmail = swapped ? pair.primary_email : pair.duplicate_email;
  const [typedConfirmation, setTypedConfirmation] = useState("");
  const mutationGenerationRef = useRef(0);
  const mutationAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    setTypedConfirmation("");
    mutationGenerationRef.current += 1;
    mutationAbortRef.current?.abort();
    mutationAbortRef.current = null;
    onPendingChange(false);
  }, [
    onPendingChange,
    target.primaryId,
    target.duplicateId,
    target.primaryUpdatedAt,
    target.duplicateUpdatedAt,
  ]);

  useEffect(
    () => () => {
      mutationGenerationRef.current += 1;
      mutationAbortRef.current?.abort();
      onPendingChange(false);
    },
    [onPendingChange],
  );

  // Re-preview whenever the survivor side (swap) or either revision changes, so
  // the fingerprint the operator commits always matches what they saw.
  const previewQuery = useQuery({
    queryKey: [
      "merge-preview",
      target.scanId,
      target.primaryId,
      target.duplicateId,
      target.primaryUpdatedAt,
      target.duplicateUpdatedAt,
      authority.tenantId,
      authority.userId,
      authority.role,
    ],
    queryFn: async ({ signal }) => {
      await reauthorizeSubscriberMutation(authority);
      const result = await previewMerge(target, { signal });
      await reauthorizeSubscriberMutation(authority);
      return result;
    },
    enabled: Boolean(target.primaryId && target.duplicateId),
    retry: false,
    staleTime: 0,
  });

  const applyMutation = useMutation({
    // An irreversible write must never auto-retry.
    retry: 0,
    mutationFn: async ({
      fingerprint,
      idempotencyKey,
    }: {
      fingerprint: string;
      idempotencyKey: string;
    }) => {
      const generation = ++mutationGenerationRef.current;
      const controller = new AbortController();
      mutationAbortRef.current?.abort();
      mutationAbortRef.current = controller;
      onPendingChange(true);
      await reauthorizeSubscriberMutation(authority);
      const result = await applyMerge(target, fingerprint, {
        idempotencyKey,
        signal: controller.signal,
      });
      let authorityChanged = false;
      try {
        await reauthorizeSubscriberMutation(authority);
      } catch {
        authorityChanged = true;
      }
      if (generation !== mutationGenerationRef.current) {
        throw new DOMException("Stale merge response", "AbortError");
      }
      return { result, authorityChanged };
    },
    onSuccess: ({ result, authorityChanged }) => {
      toast.success("Records merged.");
      if (authorityChanged) {
        toast.info(
          "The merge committed, but workspace access changed afterward. The duplicate list was reloaded.",
        );
      }
      onMerged(result);
    },
    onError: (err) => {
      toast.error(mergeErrorMessage(err));
      // A stale/mismatched plan means the records moved under the preview —
      // refetch so the operator reviews (and commits) the fresh plan, never the
      // rejected fingerprint again.
      if (
        isApiError(err) &&
        (err.status === 412 ||
          err.status === 428 ||
          err.code === "plan_changed" ||
          err.code === "fingerprint_mismatch")
      ) {
        void previewQuery.refetch();
      }
    },
    onSettled: () => {
      mutationAbortRef.current = null;
      onPendingChange(false);
    },
  });

  const plan = previewQuery.data?.plan;
  const statusConflict = plan?.conflicts?.find((c) => c.field === "status");
  const statusDowngrade =
    statusConflict &&
    String(plan?.status) !== String(statusConflict.primary_value);
  const fieldConflicts =
    plan?.conflicts?.filter((c) => c.field !== "status") ?? [];

  return (
    <>
      <div className="space-y-4">
        {/* Who survives */}
        <div className="rounded-md border p-3 text-sm">
          <div className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate font-medium">
              {removedEmail}
            </span>
            <ArrowRight
              className="size-4 shrink-0 text-muted-foreground"
              aria-hidden
            />
            <span className="min-w-0 flex-1 truncate font-medium text-foreground">
              {survivorEmail}
            </span>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            <span className="font-medium text-foreground">{survivorEmail}</span>{" "}
            survives and keeps its values.{" "}
            <span className="font-medium">{removedEmail}</span> is removed.
          </p>
          <button
            type="button"
            onClick={onSwap}
            disabled={previewQuery.isFetching || applyMutation.isPending}
            className="mt-2 inline-flex min-h-11 items-center gap-1 text-left text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
          >
            <ArrowLeftRight className="size-3" aria-hidden />
            Keep {removedEmail} instead
          </button>
        </div>

        {/* Why they matched */}
        <div className="space-y-1">
          <p className="text-xs font-medium text-muted-foreground">
            Why these matched
          </p>
          <ul className="space-y-1">
            {pair.evidence.map((e, i) => (
              <li key={i} className="text-xs text-muted-foreground">
                <span className="font-medium text-foreground">{e.kind}</span> (
                {Math.round(e.confidence * 100)}%) — {e.reason}
              </li>
            ))}
          </ul>
        </div>

        {/* Preview outcome */}
        {previewQuery.isPending ? (
          <p className="text-sm text-muted-foreground">
            Computing the merge plan…
          </p>
        ) : previewQuery.isError ? (
          <p className="text-sm text-destructive" role="alert">
            {mergeErrorMessage(previewQuery.error)}
          </p>
        ) : plan ? (
          <div className="space-y-3">
            {statusDowngrade ? (
              <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-2.5 text-xs">
                <AlertTriangle
                  className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-500"
                  aria-hidden
                />
                <span>
                  The surviving record&apos;s status will change to{" "}
                  <span className="font-semibold">{plan.status}</span> — the
                  more restrictive of the two. This can suppress a
                  currently-active contact.
                </span>
              </div>
            ) : null}

            {fieldConflicts.length > 0 ? (
              <div>
                <p className="text-xs font-medium text-muted-foreground">
                  Conflicting fields — the surviving value is kept, the other is
                  discarded:
                </p>
                <ul className="mt-1 space-y-1">
                  {fieldConflicts.map((c, i) => (
                    <li key={i} className="text-xs">
                      <span className="font-mono">{c.field}</span>: keep{" "}
                      <span className="font-medium text-foreground">
                        {shortValue(c.primary_value)}
                      </span>
                      , discard{" "}
                      <span className="text-muted-foreground line-through">
                        {shortValue(c.duplicate_value)}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">
                No conflicting field values. Tags, custom fields, events and
                suppressions are combined onto the survivor.
              </p>
            )}

            <p className="text-xs text-muted-foreground">
              {previewQuery.data?.events_moved ?? 0} events and{" "}
              {previewQuery.data?.suppressions_moved ?? 0} suppressions
              preserved on the surviving record.
            </p>

            <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-2.5 text-xs text-destructive-emphasis">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
              <span>
                This permanently combines the two contacts into one and removes{" "}
                {removedEmail}. It cannot be undone.
              </span>
            </div>

            <div className="grid gap-1.5">
              <Label htmlFor={`merge-confirm-${pair.primary_id}`}>
                Type {removedEmail} to confirm
              </Label>
              <Input
                id={`merge-confirm-${pair.primary_id}`}
                value={typedConfirmation}
                autoComplete="off"
                disabled={applyMutation.isPending}
                onChange={(event) => setTypedConfirmation(event.target.value)}
              />
            </div>
          </div>
        ) : null}
      </div>

      <DialogFooter>
        <DialogClose asChild>
          <Button
            type="button"
            variant="outline"
            disabled={applyMutation.isPending}
          >
            Cancel
          </Button>
        </DialogClose>
        <Button
          type="button"
          variant="destructive"
          disabled={
            !plan ||
            previewQuery.isFetching ||
            applyMutation.isPending ||
            !previewQuery.data?.plan_fingerprint ||
            typedConfirmation !== removedEmail
          }
          onClick={() => {
            const fp = previewQuery.data?.plan_fingerprint;
            if (fp) {
              applyMutation.mutate({
                fingerprint: fp,
                idempotencyKey: `subscriber-merge:${globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`}`,
              });
            }
          }}
        >
          {applyMutation.isPending ? "Merging…" : "Merge permanently"}
        </Button>
      </DialogFooter>
    </>
  );
}
