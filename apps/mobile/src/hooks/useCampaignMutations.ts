/**
 * hooks/useCampaignMutations.ts — the campaign writes mobile did not have.
 *
 *   POST /api/v1/campaigns             → create (mobile could never START one)
 *   POST /api/v1/campaigns/{id}/clone  → duplicate (admin-scoped server-side)
 *
 * Both go through `client.request` rather than an SDK resource method: the
 * SDK's `CreateCampaignInput` omits preview_text / from_name / reply_to,
 * which the Go authoring contract does accept, and it has no clone method at
 * all.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { getClient } from "@/api/client";
import {
  campaignCreatePayload,
  type CampaignDraftInput,
} from "@/lib/campaignCreate";

export interface CreatedCampaign {
  id: string;
  name?: string;
  subject?: string;
  status?: string;
}

/**
 * Create a draft campaign.
 *
 * The payload deliberately carries no `status` / `scheduled_at`: the gateway
 * rejects a create body containing either with 422
 * `campaign_dispatch_state_owned` because dispatch state belongs to the
 * lifecycle endpoints.
 *
 * Online-only by design. Queuing a create offline would mint a local id the
 * follow-up navigation cannot use, so the sheet tells the operator plainly
 * that a connection is required rather than silently deferring.
 */
export function useCreateCampaign() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: CampaignDraftInput): Promise<CreatedCampaign> => {
      const { client } = getClient();
      return client.request<CreatedCampaign>("POST", "/api/v1/campaigns", {
        body: campaignCreatePayload(input),
      });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["campaigns"] });
      void queryClient.invalidateQueries({ queryKey: ["campaign-counts"] });
    },
  });
}

export interface ClonedCampaign {
  id: string;
  name?: string;
}

/**
 * Duplicate a campaign. The server clones every column except identity and
 * dispatch state, so the copy always lands as a fresh draft with no
 * scheduled_at / sent_at and its archive flags reset.
 *
 * Requires the admin scope server-side (campaign_clone.go mounts it behind
 * `apikeys.RequireScope(apikeys.ScopeAdmin)`), which is why the UI gates the
 * affordance on `campaignAccess(...).canAdmin`.
 */
export function useCloneCampaign() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      campaignId: string;
      name?: string;
    }): Promise<ClonedCampaign> => {
      const { client } = getClient();
      return client.request<ClonedCampaign>(
        "POST",
        `/api/v1/campaigns/${encodeURIComponent(input.campaignId)}/clone`,
        { body: input.name ? { name: input.name } : {} },
      );
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["campaigns"] });
      void queryClient.invalidateQueries({ queryKey: ["campaign-counts"] });
    },
  });
}

/**
 * Delete a campaign. Kept here (rather than inline in the detail screen) so
 * the cache invalidation set matches every other campaign write.
 */
export function useDeleteCampaign() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (campaignId: string) => {
      const { client } = getClient();
      return client.campaigns.delete(campaignId);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["campaigns"] });
      void queryClient.invalidateQueries({ queryKey: ["campaign-counts"] });
    },
  });
}
