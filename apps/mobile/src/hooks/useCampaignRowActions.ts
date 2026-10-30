/**
 * hooks/useCampaignRowActions.ts — the swipe/rotor actions on a campaign row.
 *
 * Every row in the list was a bare Pressable that only opened the detail, so
 * the two most-used actions in any ESP (duplicate, delete a dead draft) cost a
 * three-screen round trip. They are now one gesture — and, because
 * SwipeableRow republishes each action as an accessibilityAction, one
 * VoiceOver rotor action.
 *
 * The gating mirrors the server: clone is admin-scoped
 * (apps/api/internal/campaign_clone), delete is editor+ and draft-only.
 */
import { useCallback } from "react";

import { useConfirm } from "@/components/ConfirmSheet";
import type { SwipeAction } from "@/components/SwipeableRow";
import { useToast } from "@/components/Toast";
import {
  useCloneCampaign,
  useDeleteCampaign,
} from "@/hooks/useCampaignMutations";
import { isDraftCampaignStatus, type Campaign } from "@/hooks/useCampaigns";
import { campaignErrorMessage } from "@/lib/campaignErrors";

export function useCampaignRowActions(access: {
  canMutate: boolean;
  canAdmin: boolean;
}): (campaign: Campaign) => SwipeAction[] {
  const { toast } = useToast();
  const confirm = useConfirm();
  const cloneMutation = useCloneCampaign();
  const deleteMutation = useDeleteCampaign();

  const duplicate = useCallback(
    (c: Campaign) => {
      cloneMutation.mutate(
        { campaignId: String(c.id) },
        {
          onSuccess: () =>
            toast({
              kind: "success",
              message: `Duplicated "${c.name ?? c.subject ?? "campaign"}" as a new draft.`,
            }),
          onError: (err: unknown) =>
            toast({
              kind: "error",
              message: campaignErrorMessage(
                err,
                "Couldn't duplicate the campaign.",
              ),
            }),
        },
      );
    },
    [cloneMutation, toast],
  );

  const removeDraft = useCallback(
    (c: Campaign) => {
      const label = c.name ?? c.subject ?? "Untitled";
      void (async () => {
        // Deleting is irreversible — this is the case a pre-confirm exists
        // for, rather than an undo toast.
        const ok = await confirm({
          title: "Delete this draft?",
          message: `"${label}" will be permanently removed.`,
          confirmLabel: "Delete",
          destructive: true,
          consequence: "This can't be undone.",
        });
        if (!ok) return;
        deleteMutation.mutate(String(c.id), {
          onSuccess: () => toast({ kind: "success", message: "Draft deleted." }),
          onError: (err: unknown) =>
            toast({
              kind: "error",
              message: campaignErrorMessage(err, "Couldn't delete the draft."),
            }),
        });
      })();
    },
    [confirm, deleteMutation, toast],
  );

  const { canAdmin, canMutate } = access;
  return useCallback(
    (c: Campaign): SwipeAction[] => {
      const actions: SwipeAction[] = [];
      if (canAdmin) {
        actions.push({
          label: "Duplicate",
          kind: "primary",
          onPress: () => duplicate(c),
        });
      }
      if (canMutate && isDraftCampaignStatus(c.status)) {
        actions.push({
          label: "Delete",
          kind: "danger",
          onPress: () => removeDraft(c),
        });
      }
      return actions;
    },
    [canAdmin, canMutate, duplicate, removeDraft],
  );
}
