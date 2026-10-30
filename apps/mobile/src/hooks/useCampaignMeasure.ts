/**
 * hooks/useCampaignMeasure.ts — holdout setup, the content-optimizer, and
 * content remix on the campaign detail screen.
 *
 * Transport in api/campaignMeasure (routes + role floors re-verified there):
 *   GET/POST/DELETE /campaigns/{id}/holdout — the POST/DELETE handler binds
 *        ScopeAdmin (holdout.go:103-106), so the setup card gates on canAdmin.
 *   GET /campaigns/{id}/content-optimizer          viewer (404 = no run yet)
 *   POST /campaigns/{id}/content-optimizer/preview editor (nothing persisted)
 *   POST /campaigns/{id}/remix                     editor (synchronous)
 *
 * The holdout writes are ONLINE-ONLY: they partition a future send's audience
 * for measurement, and replaying a stale queued config over one someone else
 * set meanwhile would silently change what an experiment measures. The remix
 * and optimizer preview return derived content and persist nothing, so replay
 * semantics are moot — they are plain on-demand mutations.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  createCampaignHoldout,
  deleteCampaignHoldout,
  getCampaignHoldout,
  getContentOptimizerRun,
  previewContentOptimizer,
  remixCampaignContent,
} from "@/api/campaignMeasure";
import { checkedApiResult } from "@/api/request";
import { readHoldout, type HoldoutReading } from "@/lib/campaignHoldout";
import {
  readOptimizerPreview,
  readOptimizerRun,
  type OptimizerPreviewReading,
  type OptimizerRunReading,
} from "@/lib/campaignOptimizer";
import { readRemixAssets, type RemixAssetRow } from "@/lib/campaignRemix";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";

function absentToNull(status: number | undefined): boolean {
  return status === 404 || status === 405 || status === 501;
}

/** GET …/holdout — the configured holdout; 404 = none. */
export function useCampaignHoldout(
  campaignId: string | undefined,
  options: { enabled: boolean },
) {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: ["campaign-holdout", gate.tenantId, campaignId],
    enabled:
      options.enabled && gate.enabled && Boolean(gate.tenantId && campaignId),
    staleTime: 30_000,
    queryFn: async (): Promise<HoldoutReading | null> => {
      const res = await getCampaignHoldout(campaignId!);
      if (res.error) {
        if (absentToNull(res.error.status)) return null;
        throw Object.assign(new Error(res.error.message), res.error);
      }
      return readHoldout(res.data);
    },
  });
}

/** POST / DELETE …/holdout — admin only on the session path. */
export function useCampaignHoldoutWrite(campaignId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (
      action: { kind: "create"; percent: number } | { kind: "remove" },
    ): Promise<void> => {
      if (action.kind === "create") {
        await checkedApiResult(
          createCampaignHoldout(campaignId, action.percent),
        );
        return;
      }
      await checkedApiResult(deleteCampaignHoldout(campaignId));
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["campaign-holdout"] });
      // The lift drilldown reads what the holdout config produces.
      void queryClient.invalidateQueries({ queryKey: ["campaign-insight"] });
    },
  });
}

/** GET …/content-optimizer — the latest persisted run; 404 = none yet. */
export function useCampaignOptimizerRun(
  campaignId: string | undefined,
  options: { enabled: boolean },
) {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: ["campaign-content-optimizer", gate.tenantId, campaignId],
    enabled:
      options.enabled && gate.enabled && Boolean(gate.tenantId && campaignId),
    staleTime: 60_000,
    queryFn: async (): Promise<OptimizerRunReading | null> => {
      const res = await getContentOptimizerRun(campaignId!);
      if (res.error) {
        if (absentToNull(res.error.status)) return null;
        throw Object.assign(new Error(res.error.message), res.error);
      }
      return readOptimizerRun(res.data);
    },
  });
}

/** POST …/content-optimizer/preview — allocation preview, nothing persisted. */
export function useCampaignOptimizerPreview(campaignId: string) {
  return useMutation({
    mutationFn: async (): Promise<OptimizerPreviewReading> => {
      const res = await checkedApiResult(previewContentOptimizer(campaignId));
      const reading = readOptimizerPreview(res.data);
      if (!reading) {
        throw new Error("The optimizer answered in an unexpected shape.");
      }
      return reading;
    },
  });
}

/** POST …/remix — derive cross-channel assets from the body. */
export function useCampaignRemixRun(campaignId: string) {
  return useMutation({
    mutationFn: async (): Promise<RemixAssetRow[]> => {
      const res = await checkedApiResult(remixCampaignContent(campaignId));
      return readRemixAssets(res.data);
    },
  });
}
