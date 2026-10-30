/**
 * hooks/useCampaignIdentitySave.ts — executing an IdentitySavePlan.
 *
 * The identity sheet computes WHAT to save (lib/campaignSenderEdit
 * identitySavePlan); this hook owns HOW each branch travels:
 *
 *   - "offline": the pointer-decoded field diff rides the offline outbox
 *     (OFFLINE_MUTATION_KEYS.campaignUpdate → executeCampaignUpdate), exactly
 *     as identity saves always have.
 *   - "online": a sender change carries the FULL delivery_settings replace
 *     built from the freshest map the client holds, via the online-only
 *     authoring PATCH (useCampaignAuthoringPatch). It must never be queued:
 *     a replay hours later would overwrite whatever operational knobs someone
 *     changed in the meantime — the stale-map data-loss class the subscribers
 *     PATCH bug taught us.
 *
 * Both branches close the sheet and toast on success; failures render through
 * campaignErrorMessage.
 */
import { useCallback } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { useToast } from "@/components/Toast";
import { useCampaignAuthoringPatch } from "@/hooks/useCampaignAuthoring";
import { campaignErrorMessage } from "@/lib/campaignErrors";
import type { IdentitySavePlan } from "@/lib/campaignSenderEdit";
import { haptics } from "@/lib/haptics";
import {
  executeCampaignUpdate,
  newOfflineMutationMetadata,
  OFFLINE_MUTATION_KEYS,
  recordCampaignUpdateFailure,
} from "@/lib/offlineMutations";
import { offlineSafeMutationMeta } from "@/lib/queryClient";

export function useCampaignIdentitySave({
  campaignId,
  onSaved,
}: {
  campaignId: string;
  onSaved: () => void;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const senderMutation = useCampaignAuthoringPatch(campaignId);

  const updateMutation = useMutation({
    mutationKey: OFFLINE_MUTATION_KEYS.campaignUpdate,
    meta: offlineSafeMutationMeta,
    mutationFn: executeCampaignUpdate,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["campaign"] });
      void queryClient.invalidateQueries({ queryKey: ["campaign-report"] });
      void queryClient.invalidateQueries({ queryKey: ["campaigns"] });
      onSaved();
      toast({ kind: "success", message: "Campaign updated." });
    },
    onError: (err: unknown, vars) => {
      recordCampaignUpdateFailure(vars, err);
      haptics.error();
      toast({
        kind: "error",
        message: campaignErrorMessage(err, "Couldn't save your changes."),
      });
    },
  });

  const pending = updateMutation.isPending || senderMutation.isPending;

  const save = useCallback(
    (plan: IdentitySavePlan, subject: string) => {
      if (pending || plan.kind === "none") return;
      if (plan.kind === "online") {
        senderMutation.mutate(plan.body, {
          onSuccess: () => {
            onSaved();
            toast({ kind: "success", message: "Campaign updated." });
          },
          onError: (err: unknown) => {
            haptics.error();
            toast({
              kind: "error",
              message: campaignErrorMessage(err, "Couldn't save your changes."),
            });
          },
        });
        return;
      }
      updateMutation.mutate({
        ...newOfflineMutationMetadata(),
        id: campaignId,
        subject,
        fields: plan.fields,
      });
    },
    [campaignId, onSaved, pending, senderMutation, toast, updateMutation],
  );

  return { pending, save };
}
