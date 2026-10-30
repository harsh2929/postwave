/**
 * hooks/useApprovalDecisions.ts — the decide-an-approval orchestration, lifted
 * out of `app/(tabs)/approvals/index.tsx`.
 *
 * The screen is a list; this is the part that CHANGES something, and it is the
 * part with all the rules. Keeping them together and away from layout is what
 * makes them reviewable:
 *
 *  - THE HAPTIC ORDER IS DELIBERATE. `impact()` fires on press to acknowledge
 *    the tap, but the SUCCESS thump waits for the server to commit. Firing it
 *    optimistically makes a failing network feel like a success immediately
 *    followed by an error, which is worse than a slightly late confirmation.
 *  - A PARTIAL SUCCESS IS NOT A SUCCESS. The server can commit the decision and
 *    still fail the follow-up action it triggers; that comes back as
 *    `followupFailed` and is reported as a WARNING, because telling someone
 *    "Approved" when the thing they approved did not run is a lie.
 *  - REJECTION IS A TWO-STEP, ON PURPOSE. Approve is a single ConfirmSheet;
 *    reject needs a reason, so it opens an in-app modal with INLINE validation.
 *    An OS Alert on top of a modal to say "type something" is two dismissals
 *    for one piece of feedback.
 *  - TELEMETRY IS STRUCTURAL ONLY. Decision enum, surface, whether the
 *    follow-up failed, and an age in seconds. No resource ids, no notes, no
 *    requester identity — this is a governance queue and its contents are the
 *    tenant's, not ours.
 *
 * The decision itself is final and audit-logged, which is why it stays a real
 * pre-confirm rather than an undo toast: there is nothing to undo.
 */
import {
  useCallback,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import { EVENTS } from "@postwave/telemetry";

import {
  rejectDraftSubmitState,
  type RejectDraft,
} from "@/components/approvals/approvalPresentation";
import {
  approvalDecisionSuccessMessage,
  decisionErrorMessage,
  useApprovalDecision,
  type Approval,
  type ApprovalDecision,
} from "@/hooks/useApprovals";
import { haptics } from "@/lib/haptics";
import { track } from "@/lib/telemetry";

export interface ApprovalDecisionsInput {
  /** Rows currently on screen — used to resolve the reject draft's target. */
  rows: readonly Approval[];
  confirm: (options: {
    title: string;
    message: string;
    confirmLabel: string;
    consequence: string;
    restoreFocusTo?: { current: unknown } | null;
  }) => Promise<boolean>;
  toast: (options: {
    kind: "success" | "error" | "warning" | "info";
    message: string;
  }) => void;
}

export interface ApprovalDecisions {
  isDeciding: boolean;
  decidingId: string | null;
  rejectDraft: RejectDraft;
  setRejectDraft: Dispatch<SetStateAction<RejectDraft>>;
  rejectError: string | null;
  setRejectError: Dispatch<SetStateAction<string | null>>;
  confirmApprove: (
    approval: Approval,
    label: string,
    restoreFocusTo?: { current: unknown } | null,
  ) => Promise<void>;
  openReject: (
    approval: Approval,
    label: string,
    restoreFocusTo?: { current: unknown } | null,
  ) => void;
  submitReject: () => void;
  /**
   * LOVE#75 — the row whose swipe opened the reject sheet, for the sheet to
   * hand screen-reader focus back to. A stable cell rather than a piece of
   * state: it is read once, on dismiss, and re-rendering the queue because a
   * focus target changed would be a re-render for nobody.
   */
  rejectFocusTarget: { current: unknown } | null;
}

export function useApprovalDecisions({
  rows,
  confirm,
  toast,
}: ApprovalDecisionsInput): ApprovalDecisions {
  const [rejectDraft, setRejectDraft] = useState<RejectDraft>(null);
  const [rejectError, setRejectError] = useState<string | null>(null);
  const rejectFocusTarget = useRef<{ current: unknown } | null>(null);
  const {
    mutateAsync: decideAsync,
    isPending: isDeciding,
    variables: decidingVars,
  } = useApprovalDecision();
  const decidingId = isDeciding ? (decidingVars?.id ?? null) : null;

  const runDecision = useCallback(
    (approval: Approval, decision: ApprovalDecision, notes?: string) => {
      if (isDeciding) return;
      const verb = decision === "approve" ? "Approve" : "Reject";
      const input: { id: string; decision: ApprovalDecision; notes?: string } =
        notes && notes.trim()
          ? { id: approval.id, decision, notes: notes.trim() }
          : { id: approval.id, decision };
      // Acknowledge the press, but do NOT claim success — the request has not
      // left the device yet. See the module header.
      haptics.impact();
      const requestedAt = Date.parse(approval.requestedAt);
      decideAsync(input)
        .then((response) => {
          const result = approvalDecisionSuccessMessage(decision, response);
          if (result.followupFailed) {
            haptics.error();
            toast({ kind: "warning", message: result.message });
          } else {
            haptics.success();
            toast({ kind: "success", message: result.message });
          }
          track(EVENTS.APPROVAL_DECIDED, {
            decision,
            surface: "list",
            followup_failed: result.followupFailed,
            ...(Number.isFinite(requestedAt)
              ? {
                  seconds_since_requested: Math.max(
                    0,
                    Math.round((Date.now() - requestedAt) / 1000),
                  ),
                }
              : {}),
          });
        })
        .catch((e: unknown) => {
          haptics.error();
          toast({
            kind: "error",
            message: `${verb} failed. ${decisionErrorMessage(e)}`,
          });
        });
    },
    [decideAsync, isDeciding, toast],
  );

  const confirmApprove = useCallback(
    async (
      approval: Approval,
      label: string,
      restoreFocusTo?: { current: unknown } | null,
    ) => {
      const ok = await confirm({
        title: `Approve "${label}"?`,
        message:
          "This decision is final, cannot be undone, and is recorded in the audit log.",
        confirmLabel: "Approve",
        consequence: "The requested action will proceed immediately.",
        ...(restoreFocusTo ? { restoreFocusTo } : {}),
      });
      if (ok) runDecision(approval, "approve");
    },
    [confirm, runDecision],
  );

  const openReject = useCallback(
    (
      approval: Approval,
      label: string,
      restoreFocusTo?: { current: unknown } | null,
    ) => {
      setRejectError(null);
      rejectFocusTarget.current = restoreFocusTo ?? null;
      setRejectDraft({ id: approval.id, label, reason: "" });
    },
    [],
  );

  const rejectTarget = useMemo(() => {
    if (!rejectDraft) return null;
    return rows.find((row) => row.id === rejectDraft.id) ?? null;
  }, [rows, rejectDraft]);

  const submitReject = useCallback(() => {
    const submit = rejectDraftSubmitState(rejectDraft, isDeciding);
    if (submit.kind === "idle" || submit.kind === "busy") return;
    if (submit.kind === "reason_required") {
      // Inline, in the sheet the user is already looking at.
      setRejectError(submit.message);
      haptics.warning();
      return;
    }
    const target = rejectTarget;
    setRejectDraft(null);
    setRejectError(null);
    if (target) runDecision(target, "reject", submit.input.notes);
  }, [isDeciding, rejectDraft, rejectTarget, runDecision]);

  return {
    isDeciding,
    decidingId,
    rejectDraft,
    setRejectDraft,
    rejectError,
    setRejectError,
    confirmApprove,
    openReject,
    submitReject,
    rejectFocusTarget: rejectFocusTarget.current,
  };
}
