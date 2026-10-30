/**
 * hooks/useInvestigationReview.ts — deciding an AI investigation from a phone.
 *
 * Two rules the server enforces and this controller mirrors client-side, so
 * an operator is never taught to tap a button that can only fail:
 *
 *  1. A REJECTION NEEDS A REASON. `reason == ""` is a 400 `reason_required`
 *     (handlers/audit_investigations.go:290).
 *  2. ONLY A DRAFT IS DECIDABLE. `Store.Approve`/`Store.Reject` update
 *     `WHERE … AND status = 'draft'`; anything else is a 409, which is also
 *     the signal that the cached row is stale — so a conflict refetches
 *     rather than just apologising.
 *
 * And one rule the SERVER does not enforce but the product must: approving
 * does not execute anything. The confirm sheet carries that as its
 * `consequence`, which is the one line of a ConfirmSheet a user actually
 * reads before an irreversible tap.
 *
 * BOTH DECISIONS RE-READ THE ROW BEFORE THEY ASK. The row a decision starts
 * from is a LIST snapshot from whenever the screen last fetched, and rule 2
 * above is precisely the race that makes that dangerous: a teammate can have
 * decided it since. The re-read written for this hazard
 * (`useAuditInvestigation`) could never be called from here — it is a
 * declarative query keyed on an id, and this is a callback — so it sat unused
 * and the confirm sheet described a plan that might no longer exist. Now the
 * sheet is built from the row the server has RIGHT NOW, and a row that has
 * left `draft` is refused before anyone is asked to confirm something
 * irreversible.
 *
 * A FAILED RE-READ DOES NOT BLOCK THE DECISION. It is a safety net, not the
 * gate: `Store.Approve`/`Store.Reject` still carry `AND status = 'draft'`, so
 * a stale decision is a 409 and not a wrong write. Refusing to act because a
 * phone briefly lost signal would make the queue undecidable to protect
 * against something the server already prevents.
 */
import { useCallback, useState } from "react";

import type { useConfirm } from "@/components/ConfirmSheet";
import type { useToast } from "@/components/Toast";
import {
  useInvestigationDecision,
  useInvestigationReread,
} from "@/hooks/useAuditInvestigations";
import {
  investigationDecisionCopy,
  investigationDecisionError,
  type AuditInvestigation,
  type InvestigationStatus,
} from "@/lib/auditInvestigations";
import { haptics } from "@/lib/haptics";

/**
 * What to tell someone whose row was decided out from under them. Phrased from
 * the state the server reports, not from a guess about who did it.
 */
function alreadyDecidedMessage(status: InvestigationStatus): string {
  const what =
    status === "executed"
      ? "approved and executed"
      : status === "approved"
        ? "approved"
        : "rejected";
  return `This investigation was already ${what}. Nothing was changed — pull to refresh.`;
}

export interface InvestigationRejectDraft {
  id: string;
  label: string;
  reason: string;
}

export interface InvestigationReviewInput {
  confirm: ReturnType<typeof useConfirm>;
  toast: ReturnType<typeof useToast>["toast"];
}

export function useInvestigationReview({
  confirm,
  toast,
}: InvestigationReviewInput) {
  const decide = useInvestigationDecision();
  const reread = useInvestigationReread();
  const [decidingId, setDecidingId] = useState<string | null>(null);
  const [rejectDraft, setRejectDraft] = useState<InvestigationRejectDraft | null>(
    null,
  );
  const [rejectError, setRejectError] = useState<string | null>(null);

  /**
   * Ask the server what this row is right now.
   *
   * `refusal` set — it has left `draft` (or is gone); say so and stop.
   * `row` set     — go ahead, and describe THIS row rather than the list's.
   * BOTH null     — the re-read could not run at all. The caller proceeds on
   *                 what it had; see the header for why that is deliberate.
   */
  const currentDraft = useCallback(
    async (
      id: string,
    ): Promise<{ row: AuditInvestigation | null; refusal: string | null }> => {
      let fresh: AuditInvestigation | null;
      try {
        fresh = await reread(id);
      } catch {
        return { row: null, refusal: null };
      }
      if (!fresh) {
        return {
          row: null,
          refusal:
            "This investigation is no longer available. Nothing was changed — pull to refresh.",
        };
      }
      if (fresh.status !== "draft") {
        return { row: null, refusal: alreadyDecidedMessage(fresh.status) };
      }
      return { row: fresh, refusal: null };
    },
    [reread],
  );

  const approve = useCallback(
    (inv: AuditInvestigation) => {
      void (async () => {
        if (decide.isPending) return;
        // Before the sheet, not after: a confirm dialog describing a plan the
        // server has already decided is asking someone to approve a fiction.
        const current = await currentDraft(inv.id);
        if (current.refusal) {
          haptics.error();
          toast({ kind: "error", message: current.refusal });
          return;
        }
        const copy = investigationDecisionCopy(current.row ?? inv, "approve");
        const ok = await confirm(copy);
        if (!ok) return;
        haptics.impact();
        setDecidingId(inv.id);
        try {
          await decide.mutateAsync({ id: inv.id, decision: "approve" });
          haptics.success();
          toast({
            kind: "success",
            // Not "Remediation applied" — see lib/auditInvestigations. The
            // toast is the last thing the approver reads, so it is the last
            // chance to stop them believing the incident is contained.
            message:
              "Plan approved and recorded. Carrying the actions out is still a manual step.",
          });
        } catch (err) {
          haptics.error();
          toast({ kind: "error", message: investigationDecisionError(err) });
        } finally {
          setDecidingId(null);
        }
      })();
    },
    [confirm, currentDraft, decide, toast],
  );

  const openReject = useCallback((inv: AuditInvestigation) => {
    setRejectError(null);
    setRejectDraft({
      id: inv.id,
      label: `investigation from event #${inv.seed_audit_id}`,
      reason: "",
    });
  }, []);

  const submitReject = useCallback(() => {
    const draft = rejectDraft;
    if (!draft || decide.isPending) return;
    if (!draft.reason.trim()) {
      setRejectError("A reason is required — the server rejects an empty one.");
      return;
    }
    void (async () => {
      // The reject sheet can sit open while the queue moves underneath it, so
      // this one re-reads at SUBMIT rather than at open.
      const current = await currentDraft(draft.id);
      if (current.refusal) {
        haptics.error();
        setRejectError(current.refusal);
        return;
      }
      haptics.impact();
      setDecidingId(draft.id);
      try {
        await decide.mutateAsync({
          id: draft.id,
          decision: "reject",
          reason: draft.reason,
        });
        haptics.success();
        setRejectDraft(null);
        setRejectError(null);
        toast({ kind: "success", message: "Plan rejected and recorded." });
      } catch (err) {
        haptics.error();
        setRejectError(investigationDecisionError(err));
      } finally {
        setDecidingId(null);
      }
    })();
  }, [currentDraft, decide, rejectDraft, toast]);

  return {
    decidingId,
    isDeciding: decide.isPending,
    rejectDraft,
    setRejectDraft,
    rejectError,
    setRejectError,
    approve,
    openReject,
    submitReject,
  };
}
