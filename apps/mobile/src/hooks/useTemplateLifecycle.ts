/**
 * hooks/useTemplateLifecycle.ts — archive / restore a template (recoverable
 * lifecycle; desktop parity: TemplateDetailSlideover's archive row).
 *
 * DISTINCT FROM THE ABSENT DELETE. The templates surface records DELETE as a
 * one-way door it will not offer, and that stands. Archive is the opposite
 * kind of act: `archived_at` is a timestamp restore clears, both verbs answer
 * with the updated template, and the archived shelf keeps the design
 * reachable. Retiring a stale design IS a browsing-adjacent decision, which
 * is why it belongs on the phone while authoring does not.
 *
 * ONLINE-ONLY, like the other two verbs and for the same contract reason:
 * neither PATCH is in lib/offlineMutationContract, and a replayed archive
 * would carry an If-Match tag hours stale — guaranteed 412, or worse, a
 * surprise flip of a design someone un-archived in the meantime.
 *
 * The If-Match tag comes off the DETAIL read (the sheet always fetches it);
 * api/campaignTemplates.setTemplateArchived fails closed without a strong
 * tag rather than sending a header the server will 412.
 */
import { useCallback } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { archiveTemplate, restoreTemplate } from "@/api/campaignTemplates";
import { useConfirm } from "@/components/ConfirmSheet";
import { useToast } from "@/components/Toast";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { haptics } from "@/lib/haptics";
import type { MobileTemplate } from "@/lib/templateCatalog";
import {
  templateArchiveConfirm,
  templateLifecycleFailureFallback,
  templateLifecycleSuccessMessage,
  templateLifecycleVerb,
} from "@/lib/templateLifecycle";
import { templateActionErrorMessage } from "@/lib/templatePolicy";

export interface TemplateLifecycle {
  /** Archive (confirmed, reversible) or restore, based on the row's state. */
  toggleArchived: (template: MobileTemplate) => Promise<void>;
  pending: boolean;
}

export function useTemplateLifecycle(onSettled: () => void): TemplateLifecycle {
  const gate = useOnlineQueryGate();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const { toast } = useToast();

  const invalidate = useCallback(() => {
    // Archive moves the row between shelves, shifts the goal rail and the
    // stats tiles, and stales the detail + recent shelf that show its state.
    void qc.invalidateQueries({ queryKey: ["campaign-templates", gate.tenantId] });
    void qc.invalidateQueries({ queryKey: ["campaign-template-goals", gate.tenantId] });
    void qc.invalidateQueries({ queryKey: ["campaign-template", gate.tenantId] });
    void qc.invalidateQueries({ queryKey: ["campaign-template-stats", gate.tenantId] });
    void qc.invalidateQueries({ queryKey: ["campaign-template-recent", gate.tenantId] });
  }, [gate.tenantId, qc]);

  const mutation = useMutation<
    MobileTemplate | null,
    Error,
    { template: MobileTemplate; archive: boolean }
  >({
    mutationFn: ({ template, archive }) =>
      archive
        ? archiveTemplate(template.id, template.etag)
        : restoreTemplate(template.id, template.etag),
    onSuccess: invalidate,
  });

  const toggleArchived = useCallback(
    async (template: MobileTemplate): Promise<void> => {
      if (mutation.isPending) return;
      const verb = templateLifecycleVerb(template);
      const archiving = verb === "archive";
      if (archiving) {
        // Confirmed, in the danger colour: reversible, but it pulls the design
        // off every browse shelf in the workspace the moment it lands. Restore
        // is the recoverable half and goes straight through.
        const ok = await confirm(templateArchiveConfirm(template.name));
        if (!ok) return;
      }
      haptics.impact();
      try {
        await mutation.mutateAsync({ template, archive: archiving });
        haptics.success();
        onSettled();
        toast({
          kind: "success",
          message: templateLifecycleSuccessMessage(verb, template.name),
        });
      } catch (error) {
        haptics.error();
        toast({
          kind: "error",
          message: templateActionErrorMessage(
            error,
            templateLifecycleFailureFallback(verb),
          ),
        });
      }
    },
    [confirm, mutation, onSettled, toast],
  );

  return { toggleArchived, pending: mutation.isPending };
}
