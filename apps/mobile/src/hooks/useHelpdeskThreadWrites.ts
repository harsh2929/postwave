/**
 * hooks/useHelpdeskThreadWrites.ts — the three writes a Helpdesk thread can
 * make: claim/take over/unassign, change the recorded status, and record an
 * internal note.
 *
 * They live together because they share one invariant — `actionInFlight`, a
 * single in-flight slot for the two VERSIONED writes, so a status change and
 * an assignment can never race each other onto the same `etag`/`version`. The
 * note is idempotency-keyed rather than versioned and carries its own durable
 * recovery journal, whose retirement rules are commented at the call site.
 *
 * Split out of `useHelpdeskThreadScreen` only for size; every guard, message
 * and ordering decision is unchanged.
 */
import { useCallback, useRef } from "react";

import {
  helpdeskInternalNoteOutcomeIsAmbiguous,
  helpdeskVersionedMutationOutcomeIsAmbiguous,
  type HelpdeskConversationResource,
} from "@/api/serviceSuite";
import { useConfirm } from "@/components/ConfirmSheet";
import { useToast } from "@/components/Toast";
import type {
  useHelpdeskAssignment,
  useHelpdeskInternalNote,
  useHelpdeskStatusChange,
} from "@/hooks/useHelpdesk";
import { transitionLabel } from "@/lib/direction";
import { errorPresentation } from "@/lib/errorCopy";
import { haptics } from "@/lib/haptics";
import {
  humanizeToken,
  normalizeHelpdeskInternalNoteBody,
  type HelpdeskClaimAction,
  type HelpdeskConversation,
} from "@/lib/helpdesk";
import {
  completeHelpdeskNoteIntent,
  prepareHelpdeskNoteIntent,
  type HelpdeskNoteIntentScope,
} from "@/lib/helpdeskNoteIntentStore";

export interface HelpdeskThreadWritesInput {
  assignment: ReturnType<typeof useHelpdeskAssignment>;
  catalogStatuses: readonly string[];
  catalogVerified: boolean;
  claimAction: HelpdeskClaimAction;
  draft: string;
  id: string;
  /** Re-reads the durable note journal after every note outcome. */
  inspectIntent: () => Promise<void>;
  note: ReturnType<typeof useHelpdeskInternalNote>;
  noteBlocked: boolean;
  noteScope: HelpdeskNoteIntentScope | null;
  resource: HelpdeskConversationResource | null;
  row: HelpdeskConversation | null;
  setDraft: (next: string) => void;
  statusChange: ReturnType<typeof useHelpdeskStatusChange>;
}

export function useHelpdeskThreadWrites(input: HelpdeskThreadWritesInput) {
  const {
    assignment,
    catalogStatuses,
    catalogVerified,
    claimAction,
    draft,
    id,
    inspectIntent,
    note,
    noteBlocked,
    noteScope,
    resource,
    row,
    setDraft,
    statusChange,
  } = input;
  const { toast } = useToast();
  const confirm = useConfirm();
  const actionInFlight = useRef(false);

  const onClaim = useCallback(async () => {
    if (
      actionInFlight.current ||
      assignment.isPending ||
      statusChange.isPending ||
      claimAction === "none" ||
      !resource
    ) {
      return;
    }
    actionInFlight.current = true;
    try {
      if (claimAction === "takeover") {
        const ok = await confirm({
          title: "Take over this conversation?",
          message: `Conversation ${id}. Recorded assignment: ${transitionLabel("another or unverified workspace member", "your verified workspace identity")}. The server derives your member identity; no typed assignee is accepted.`,
          confirmLabel: "Take over",
        });
        if (!ok) return;
      } else if (claimAction === "unassign") {
        const ok = await confirm({
          title: "Unassign this conversation?",
          message: `Conversation ${id}. Recorded assignment: ${transitionLabel("your verified workspace identity", "unassigned")}. The conversation will return to the unassigned workspace queue.`,
          confirmLabel: "Unassign",
          destructive: true,
        });
        if (!ok) return;
      }
      await assignment.mutateAsync({
        action: claimAction === "unassign" ? "unassign" : "assign_self",
        ifMatch: resource.etag,
        expectedVersion: resource.conversation.version,
        ...(claimAction === "takeover"
          ? { reason: "mobile_helpdesk_takeover" }
          : {}),
      });
      haptics.success();
      toast({
        kind: "success",
        message:
          claimAction === "unassign"
            ? "Conversation unassigned."
            : "Assigned to your workspace identity.",
      });
    } catch (error) {
      haptics.error();
      toast({
        kind: "error",
        message: helpdeskVersionedMutationOutcomeIsAmbiguous(error)
          ? "The assignment outcome is unconfirmed. Refreshing the recorded conversation and queue before another change."
          : errorPresentation(error).message ||
            "The assignment did not change.",
      });
    } finally {
      actionInFlight.current = false;
    }
  }, [
    assignment,
    claimAction,
    confirm,
    id,
    resource,
    statusChange.isPending,
    toast,
  ]);

  const onSaveNote = useCallback(async () => {
    let body: string;
    try {
      body = normalizeHelpdeskInternalNoteBody(draft);
    } catch (error) {
      toast({ kind: "error", message: errorPresentation(error).message });
      return;
    }
    if (!body || !noteScope || note.isPending || noteBlocked) return;
    let preparedKey: string | null = null;
    let serverConfirmed = false;
    try {
      const prepared = await prepareHelpdeskNoteIntent({
        scope: noteScope,
        body,
      });
      preparedKey = prepared.idempotencyKey;
      const receipt = await note.mutateAsync({
        body,
        idempotencyKey: prepared.idempotencyKey,
      });
      serverConfirmed = true;
      await completeHelpdeskNoteIntent(noteScope, prepared.idempotencyKey);
      setDraft("");
      await inspectIntent();
      haptics.success();
      toast({
        kind: "success",
        message: receipt.replayed
          ? "The earlier internal note was confirmed. Nothing was delivered to the customer."
          : "Internal note recorded. Nothing was delivered to the customer.",
      });
    } catch (error) {
      let definitiveRefusalRetired = false;
      if (
        preparedKey &&
        !serverConfirmed &&
        !helpdeskInternalNoteOutcomeIsAmbiguous(error)
      ) {
        try {
          await completeHelpdeskNoteIntent(noteScope, preparedKey);
          definitiveRefusalRetired = true;
        } catch {
          // Keep the durable record when local retirement cannot be proven.
        }
      }
      await inspectIntent();
      haptics.error();
      toast({
        kind: "error",
        message: serverConfirmed
          ? "The internal note was confirmed, but this device could not retire its recovery key. Retry only with the exact same note."
          : definitiveRefusalRetired
            ? `${errorPresentation(error).message} The request was rejected before any internal note was recorded, so its recovery key was retired.`
            : preparedKey
              ? "The note outcome is unresolved. Its original key is held for an exact retry; no replacement key was created."
              : "The internal-note recovery record could not be prepared. No request was sent.",
      });
    }
  }, [draft, inspectIntent, note, noteBlocked, noteScope, setDraft, toast]);

  const onStatus = useCallback(
    async (next: string | null) => {
      if (
        actionInFlight.current ||
        !next ||
        !row ||
        next === row.status ||
        !resource ||
        assignment.isPending ||
        !catalogVerified ||
        !catalogStatuses.includes(next)
      ) {
        return;
      }
      const current = row.status;
      actionInFlight.current = true;
      try {
        if (["resolved", "closed", "spam", "archived"].includes(next)) {
          const currentLabel = humanizeToken(current);
          const nextLabel = humanizeToken(next);
          const transition = transitionLabel(currentLabel, nextLabel);
          const ok = await confirm({
            title: `Change recorded status from ${currentLabel} to ${nextLabel}?`,
            message: `Conversation ${id}. Recorded status: ${transition}. This transition may remove the conversation from active work queues.`,
            confirmLabel: `Record ${nextLabel}`,
            destructive: true,
          });
          if (!ok) return;
        }
        await statusChange.mutateAsync({
          status: next,
          ifMatch: resource.etag,
          expectedVersion: resource.conversation.version,
        });
        haptics.success();
        toast({
          kind: "success",
          message:
            "Recorded status: " + humanizeToken(next).toLowerCase() + ".",
        });
      } catch (error) {
        haptics.error();
        toast({
          kind: "error",
          message: helpdeskVersionedMutationOutcomeIsAmbiguous(error)
            ? "The status-change outcome is unconfirmed. Refreshing the recorded conversation and queue before another change."
            : errorPresentation(error).message || "The status did not change.",
        });
      } finally {
        actionInFlight.current = false;
      }
    },
    [
      assignment.isPending,
      catalogStatuses,
      catalogVerified,
      confirm,
      id,
      resource,
      row,
      statusChange,
      toast,
    ],
  );

  return { onClaim, onSaveNote, onStatus };
}
