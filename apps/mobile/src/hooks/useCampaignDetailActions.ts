/**
 * hooks/useCampaignDetailActions.ts — the campaign detail screen's five
 * mutations and their confirmations, lifted out of the 826-line route file.
 *
 * Two behavioural changes travel with the extraction:
 *
 *  - CONFIRM vs TOAST. `Alert.alert` was doing both jobs: it asked "are you
 *    sure" AND it announced "queued". Every success cost a tap, and the
 *    genuinely dangerous prompts looked identical to the harmless ones. Now
 *    pre-action decisions go through ConfirmSheet and every OUTCOME is a
 *    non-blocking toast.
 *  - NO RAW ERRORS. Each failure path renders campaignErrorMessage(), so a
 *    403 says "your role doesn't allow this" instead of echoing the HTTP
 *    layer.
 */
import { useCallback } from "react";
import { router } from "expo-router";

import { useConfirm } from "@/components/ConfirmSheet";
import { useToast } from "@/components/Toast";
import {
  useCloneCampaign,
  useDeleteCampaign,
} from "@/hooks/useCampaignMutations";
import {
  campaignLifecycleActions,
  isDraftCampaignStatus,
  useCampaignLifecycleAction,
  type CampaignDetail,
  type CampaignLifecycleAction,
} from "@/hooks/useCampaigns";
import { campaignErrorMessage } from "@/lib/campaignErrors";
import { goBackOr } from "@/lib/nav";

function titleCase(word: string): string {
  return `${word[0]?.toUpperCase() ?? ""}${word.slice(1)}`;
}

export interface CampaignDetailActions {
  lifecycleActions: CampaignLifecycleAction[];
  lifecyclePending: boolean;
  lifecycleActionInFlight: CampaignLifecycleAction | null;
  deletePending: boolean;
  resendPending: boolean;
  clonePending: boolean;
  confirmDelete: () => void;
  confirmResend: () => void;
  confirmLifecycle: (action: CampaignLifecycleAction) => void;
  duplicate: () => void;
}

export function useCampaignDetailActions(input: {
  campaign: CampaignDetail | undefined;
  canMutate: boolean;
  canAdmin: boolean;
  /** Opens the guarded resend sheet. */
  onOpenResend: () => void;
}): CampaignDetailActions {
  const { campaign: c, canMutate, canAdmin, onOpenResend } = input;
  const { toast } = useToast();
  const confirm = useConfirm();
  const deleteMutation = useDeleteCampaign();
  const cloneMutation = useCloneCampaign();
  const lifecycleMutation = useCampaignLifecycleAction();

  const confirmDelete = useCallback(() => {
    if (!canMutate || !c) return;
    if (!isDraftCampaignStatus(c.status)) {
      toast({
        kind: "warning",
        message: "Only draft campaigns can be deleted. Cancel it instead.",
      });
      return;
    }
    const label = c.name ?? c.subject ?? "Untitled";
    void (async () => {
      // Irreversible, and it removes work someone did — a typed confirmation,
      // not an undo toast.
      const ok = await confirm({
        title: "Delete this draft?",
        message: `"${label}" will be permanently removed.`,
        confirmLabel: "Delete",
        destructive: true,
        consequence: "This can't be undone.",
      });
      if (!ok) return;
      deleteMutation.mutate(c.id, {
        onSuccess: () => {
          toast({ kind: "success", message: "Draft deleted." });
          goBackOr("/(tabs)/campaigns");
        },
        onError: (err: unknown) =>
          toast({
            kind: "error",
            message: campaignErrorMessage(err, "Couldn't delete the draft."),
          }),
      });
    })();
  }, [c, canMutate, confirm, deleteMutation, toast]);

  // The resend now opens a guarded sheet (subject + 24h floor) instead of a
  // two-button Alert that queued an identical-subject clone immediately.
  const confirmResend = useCallback(() => {
    if (!canMutate || !c) return;
    onOpenResend();
  }, [c, canMutate, onOpenResend]);

  const confirmLifecycle = useCallback(
    (action: CampaignLifecycleAction) => {
      if (!canMutate || !c || lifecycleMutation.isPending) return;
      void (async () => {
        const ok = await confirm({
          title: `${titleCase(action)} campaign?`,
          message:
            action === "pause"
              ? "Delivery will stop until you resume this campaign."
              : action === "resume"
                ? "Delivery will continue for the remaining recipients."
                : "This campaign will be cancelled and cannot resume.",
          confirmLabel: titleCase(action),
          destructive: action === "cancel",
          ...(action === "cancel"
            ? { consequence: "Cancelling is permanent — the send cannot restart." }
            : {}),
        });
        if (!ok) return;
        lifecycleMutation.mutate(
          { id: c.id, action },
          {
            onSuccess: () =>
              toast({
                kind: "success",
                message:
                  action === "pause"
                    ? "Delivery paused."
                    : action === "resume"
                      ? "Delivery resumed."
                      : "Campaign cancelled.",
              }),
            onError: (err: unknown) =>
              toast({
                kind: "error",
                message: campaignErrorMessage(err, `Couldn't ${action} the campaign.`),
              }),
          },
        );
      })();
    },
    [c, canMutate, confirm, lifecycleMutation, toast],
  );

  const duplicate = useCallback(() => {
    if (!canAdmin || !c || cloneMutation.isPending) return;
    cloneMutation.mutate(
      { campaignId: c.id },
      {
        onSuccess: (clone) => {
          toast({
            kind: "success",
            message: "Duplicated as a new draft.",
            ...(clone?.id
              ? {
                  action: {
                    label: "Open",
                    onPress: () =>
                      router.push({
                        pathname: "/(tabs)/campaigns/[id]",
                        params: { id: String(clone.id) },
                      }),
                  },
                }
              : {}),
          });
        },
        onError: (err: unknown) =>
          toast({
            kind: "error",
            message: campaignErrorMessage(err, "Couldn't duplicate the campaign."),
          }),
      },
    );
  }, [c, canAdmin, cloneMutation, toast]);

  return {
    lifecycleActions: campaignLifecycleActions(c?.status),
    lifecyclePending: lifecycleMutation.isPending,
    lifecycleActionInFlight: lifecycleMutation.isPending
      ? (lifecycleMutation.variables?.action ?? null)
      : null,
    deletePending: deleteMutation.isPending,
    resendPending: false,
    clonePending: cloneMutation.isPending,
    confirmDelete,
    confirmResend,
    confirmLifecycle,
    duplicate,
  };
}
