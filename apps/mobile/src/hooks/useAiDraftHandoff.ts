/**
 * hooks/useAiDraftHandoff.ts — "Create campaign draft" from an AI reply.
 *
 * Desktop hands a chat draft to Campaigns through `setPendingCampaignDraft`
 * and its template editor; mobile has no body editor, so the handoff here is
 * the same one the create sheet performs — `POST /api/v1/campaigns` with the
 * model's body attached — followed by the push to the campaign detail, where
 * the person can preview, schedule or finish it on the web.
 *
 * The same cache policy as `useCreateCampaign`: the campaigns list and the
 * counts are what a new draft changes.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { router } from "expo-router";

import {
  createCampaignFromAiDraft,
  type CreatedCampaignFromDraft,
} from "@/api/aiChat";
import { checkedApiResult } from "@/api/request";
import type { AiChatDraft } from "@/lib/aiChat";
import { campaignErrorMessage } from "@/lib/campaignErrors";

export interface AiDraftHandoff {
  create: (draft: AiChatDraft) => void;
  creating: boolean;
}

export function useAiDraftHandoff(
  notify: (kind: "success" | "error", message: string) => void,
): AiDraftHandoff {
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: async (draft: AiChatDraft): Promise<CreatedCampaignFromDraft> => {
      const res = await checkedApiResult(createCampaignFromAiDraft(draft));
      if (res.data === null) throw new Error("The server returned no campaign.");
      return res.data;
    },
    onSuccess: (created) => {
      void queryClient.invalidateQueries({ queryKey: ["campaigns"] });
      void queryClient.invalidateQueries({ queryKey: ["campaign-counts"] });
      notify("success", "Draft created in Campaigns.");
      if (created.id) {
        router.push({
          pathname: "/(tabs)/campaigns/[id]",
          params: { id: String(created.id) },
        });
      }
    },
    onError: (err) => {
      notify(
        "error",
        campaignErrorMessage(err, "The draft could not be saved as a campaign."),
      );
    },
  });
  return { create: (draft) => mutation.mutate(draft), creating: mutation.isPending };
}
