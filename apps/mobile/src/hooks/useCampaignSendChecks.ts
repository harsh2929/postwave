/**
 * hooks/useCampaignSendChecks.ts — the two reads that stand between an
 * operator's thumb and a send to a whole list.
 *
 *   GET /api/v1/campaigns/{id}/checklist     → six pass/warn/fail gates
 *   GET /api/v1/campaigns/{id}/send-preview  → who actually receives it
 *
 * Both are read-scoped on the server (ScopeReadCampaigns), so a viewer can
 * ask "what would happen if I sent this" — which is exactly what the confirm
 * sheet needs. Both are `enabled` only while the confirm sheet is open, so
 * the campaign detail screen doesn't pay for them on every visit.
 *
 * Neither is fatal: a deployment without the endpoint (404/405/501) resolves
 * to null and the UI says so, rather than blocking a legitimate send behind a
 * missing feature.
 */
import { useQuery } from "@tanstack/react-query";

import { getClient } from "@/api/client";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import {
  summarizeChecklist,
  type ChecklistResponse,
  type ChecklistSummary,
} from "@/lib/campaignChecklist";
import { campaignErrorStatus } from "@/lib/campaignErrors";
import type { SendPreviewResponse } from "@/lib/campaignSendPreview";

/** 404/405/501 = "this deployment doesn't expose the endpoint", not a failure. */
function isOptionalEndpointError(err: unknown): boolean {
  const status = campaignErrorStatus(err);
  return status === 404 || status === 405 || status === 501;
}

export function useCampaignChecklist(
  id: string | undefined,
  options: { enabled?: boolean } = {},
) {
  const gate = useOnlineQueryGate();
  const active = options.enabled !== false;
  return useQuery({
    queryKey: ["campaign-checklist", gate.tenantId, id],
    enabled: active && gate.enabled && Boolean(gate.tenantId && id),
    // The gates read live campaign state; a stale pass is worse than a
    // re-fetch, so never serve a cached answer to a send confirmation.
    staleTime: 0,
    gcTime: 60_000,
    queryFn: async (): Promise<ChecklistSummary | null> => {
      const { client } = getClient();
      try {
        const res = await client.request<ChecklistResponse>(
          "GET",
          `/api/v1/campaigns/${encodeURIComponent(id!)}/checklist`,
        );
        return summarizeChecklist(res);
      } catch (err) {
        if (isOptionalEndpointError(err)) return null;
        throw err;
      }
    },
  });
}

export function useCampaignSendPreview(
  id: string | undefined,
  options: { enabled?: boolean } = {},
) {
  const gate = useOnlineQueryGate();
  const active = options.enabled !== false;
  return useQuery({
    queryKey: ["campaign-send-preview", gate.tenantId, id],
    enabled: active && gate.enabled && Boolean(gate.tenantId && id),
    staleTime: 0,
    gcTime: 60_000,
    queryFn: async (): Promise<SendPreviewResponse | null> => {
      const { client } = getClient();
      try {
        const res = await client.request<SendPreviewResponse>(
          "GET",
          `/api/v1/campaigns/${encodeURIComponent(id!)}/send-preview`,
        );
        return res ?? null;
      } catch (err) {
        if (isOptionalEndpointError(err)) return null;
        throw err;
      }
    },
  });
}
