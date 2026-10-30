/**
 * hooks/useCampaignPresendChecks.ts — the opt-in pre-send check services.
 *
 * Three checks join the send flow through this module, all press-driven and
 * none auto-fired (the verdict is LLM-cost, the a11y check walks the whole
 * body, and the refine preview runs a churn-score scan):
 *
 *   POST /api/v1/presend/verdict                 editor — one-shot AI verdict
 *   POST /api/v1/a11y/check                      admin  — WCAG heuristics
 *   GET/POST/DELETE /campaigns/{id}/presend-refine
 *        viewer / editor / editor — churn-risk exclusion set
 *
 * Role floors are enforced by the CALLERS omitting the affordance (see the
 * cards in components/campaigns); this module only carries transport + parse.
 *
 * The refine COMMIT and CLEAR are online-only on purpose: they partition who
 * a future send reaches, against scores computed now — a queued copy replayed
 * after a tunnel would exclude people by a stale scoreboard nobody looked at.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  clearPresendRefine,
  getPresendRefine,
  postPresendRefine,
  requestPresendVerdict,
  runA11yCheck,
} from "@/api/campaignPresend";
import { checkedApiResult } from "@/api/request";
import { readA11yReport, type A11yReading } from "@/lib/campaignA11y";
import { campaignErrorStatus } from "@/lib/campaignErrors";
import {
  readPresendRefine,
  type PresendRefineReading,
} from "@/lib/campaignPresendRefine";
import {
  readPresendVerdict,
  type PresendVerdictReading,
} from "@/lib/campaignVerdict";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";

/** POST /api/v1/presend/verdict — on demand only. */
export function useCampaignVerdictCheck() {
  return useMutation({
    mutationFn: async (input: {
      campaignId: string;
      subject: string;
      html: string;
      from: string;
    }): Promise<PresendVerdictReading> => {
      const res = await checkedApiResult(requestPresendVerdict(input));
      const reading = readPresendVerdict(res.data);
      if (!reading) {
        throw new Error("The verdict service answered in an unexpected shape.");
      }
      return reading;
    },
  });
}

/** POST /api/v1/a11y/check — on demand only. */
export function useCampaignA11yCheck() {
  return useMutation({
    mutationFn: async (input: {
      html: string;
      subject?: string;
    }): Promise<A11yReading> => {
      const res = await checkedApiResult(runA11yCheck(input));
      const reading = readA11yReport(res.data);
      if (!reading) {
        throw new Error(
          "The accessibility checker answered in an unexpected shape.",
        );
      }
      return reading;
    },
  });
}

/** GET …/presend-refine — the active exclusion set; 404 = none. */
export function useCampaignPresendRefine(
  campaignId: string | undefined,
  options: { enabled: boolean },
) {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: ["campaign-presend-refine", gate.tenantId, campaignId],
    enabled:
      options.enabled && gate.enabled && Boolean(gate.tenantId && campaignId),
    staleTime: 0,
    queryFn: async (): Promise<PresendRefineReading | null> => {
      const res = await getPresendRefine(campaignId!);
      if (res.error) {
        const status = res.error.status;
        if (status === 404 || status === 405 || status === 501) return null;
        throw Object.assign(new Error(res.error.message), res.error);
      }
      return readPresendRefine(res.data);
    },
  });
}

export type PresendRefineAction =
  | { kind: "preview"; churnThreshold: number }
  | { kind: "apply"; churnThreshold: number }
  | { kind: "clear" };

/** POST (dry-run / commit) and DELETE on the refine set. */
export function useCampaignPresendRefineWrite(campaignId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (
      action: PresendRefineAction,
    ): Promise<PresendRefineReading | null> => {
      if (action.kind === "clear") {
        await checkedApiResult(clearPresendRefine(campaignId));
        return null;
      }
      const res = await checkedApiResult(
        postPresendRefine(campaignId, {
          churnThreshold: action.churnThreshold,
          dryRun: action.kind === "preview",
        }),
      );
      return readPresendRefine(res.data);
    },
    onSuccess: (_data, action) => {
      // A dry-run persists nothing, so nothing is stale after it.
      if (action.kind === "preview") return;
      void queryClient.invalidateQueries({
        queryKey: ["campaign-presend-refine"],
      });
      void queryClient.invalidateQueries({ queryKey: ["campaign-send-preview"] });
    },
  });
}

/** Shared: 404/405/501 = "not installed", every other failure is real. */
export function isAbsentPresendEndpoint(err: unknown): boolean {
  const status = campaignErrorStatus(err);
  return status === 404 || status === 405 || status === 501;
}
