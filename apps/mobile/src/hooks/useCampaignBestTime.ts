/**
 * hooks/useCampaignBestTime.ts — the dry run and the commit for
 * "send at each recipient's best time".
 *
 * The preview is a POST that persists nothing, so it is modelled as a QUERY:
 * it is cached per (campaign, window, anchor), it re-runs when the operator
 * changes the window, and it is `enabled` only while the toggle is on — a
 * campaign detail screen must not pay for a recipient-set aggregate nobody
 * asked for.
 *
 * Failures resolve to copy rather than throwing. A deployment without
 * send-time optimisation answers 404, which is a capability boundary and must
 * not render as a red error; a 5xx is retryable and says so. Modelling that as
 * data (rather than as a thrown error with a message the card would have to
 * re-classify) keeps the classification in one tested pure function.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  commitBestTimeSchedule,
  previewBestTimeSchedule,
} from "@/api/bestTimeSchedule";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import {
  bestTimeRequestBody,
  bestTimeUnavailableMessage,
  type BestTimeScheduleCommit,
  type BestTimeSchedulePreview,
} from "@/lib/bestTimeSchedule";

export interface BestTimePreviewResult {
  preview: BestTimeSchedulePreview | null;
  /** Non-null when the dry run could not be produced. Already user-facing. */
  problem: string | null;
  /** True when trying again could plausibly succeed (5xx, transport). */
  retryable: boolean;
}

/** 404/405/501 = the deployment doesn't expose it. Retrying won't help. */
function isAbsentEndpoint(status: number): boolean {
  return status === 404 || status === 405 || status === 501;
}

export function useBestTimeSchedulePreview(
  campaignId: string | undefined,
  input: { withinDays: number; referenceAt: Date | null; enabled: boolean },
) {
  const gate = useOnlineQueryGate();
  const body = bestTimeRequestBody({
    withinDays: input.withinDays,
    referenceAt: input.referenceAt,
  });
  return useQuery({
    queryKey: [
      "campaign-best-time-preview",
      gate.tenantId,
      campaignId,
      body.within_days,
      body.reference_at ?? "",
    ],
    enabled:
      input.enabled && gate.enabled && Boolean(gate.tenantId && campaignId),
    staleTime: 30_000,
    queryFn: async (): Promise<BestTimePreviewResult> => {
      const res = await previewBestTimeSchedule(campaignId!, body);
      if (res.error) {
        return {
          preview: null,
          problem: bestTimeUnavailableMessage(
            res.error.status,
            res.error.message,
          ),
          retryable:
            !isAbsentEndpoint(res.error.status) && res.error.status !== 403,
        };
      }
      return { preview: res.data ?? null, problem: null, retryable: false };
    },
  });
}

/**
 * The commit. Invalidates the same key set the plain schedule save does, plus
 * the preview itself — the dry run describes a recipient set that the write
 * has just consumed, so leaving it cached would show a stale "before" state
 * next to a committed "after".
 */
export function useCommitBestTimeSchedule(campaignId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      withinDays: number;
      referenceAt: Date | null;
    }): Promise<BestTimeScheduleCommit> => {
      const res = await commitBestTimeSchedule(
        campaignId!,
        bestTimeRequestBody(input),
      );
      if (res.error) {
        const err = new Error(res.error.message) as Error & {
          status?: number;
          code?: string;
        };
        err.status = res.error.status;
        if (res.error.code) err.code = res.error.code;
        throw err;
      }
      return res.data ?? {};
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["campaign"] });
      void queryClient.invalidateQueries({ queryKey: ["campaign-report"] });
      void queryClient.invalidateQueries({ queryKey: ["campaigns"] });
      void queryClient.invalidateQueries({ queryKey: ["campaign-counts"] });
      void queryClient.invalidateQueries({
        queryKey: ["campaign-best-time-preview"],
      });
    },
  });
}
