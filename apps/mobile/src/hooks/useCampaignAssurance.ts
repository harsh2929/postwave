import { useQuery } from "@tanstack/react-query";
import type {
  CampaignAssuranceEnvelope,
  CampaignAssuranceEvidence,
  CampaignAssuranceLatest,
  CampaignAssuranceRun,
} from "@postwave/sdk";

import { getClient } from "@/api/client";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { campaignErrorStatus } from "@/lib/campaignErrors";

const TERMINAL_STATES = new Set([
  "complete",
  "incomplete",
  "failed",
  "cancelled",
  "stale",
]);

export interface MobileCampaignAssuranceReceipt {
  latest: CampaignAssuranceEnvelope<CampaignAssuranceLatest>;
  /** Evidence failure is partial unavailability; it must not hide run status. */
  evidence: CampaignAssuranceEnvelope<CampaignAssuranceEvidence> | null;
  /** Epoch ms of the evidence download that `evidence` came from. */
  evidenceFetchedAt: number;
}

/**
 * While a run is still active, re-download its evidence at most this often.
 *
 * `latest` polls every 2 s, and the evidence route answers `private, no-cache`
 * with no ETag, so re-reading the limit-200 page on every tick was a full 200
 * (and three full server-side list reads) each time (SEC-API-3). Evidence is
 * not frozen mid-run, though: extraction and finding rows are committed as they
 * land and the card renders them, so this is a refresh ceiling, not a
 * terminal-only gate.
 */
export const EVIDENCE_REFRESH_WHILE_ACTIVE_MS = 30_000;

/**
 * The previous evidence page, when it still answers for `run`; otherwise null,
 * meaning "download it again". A new run id, a state change (including the
 * terminal transition), a terminal run, a failed previous read and an aged-out
 * page all read again at once.
 */
function reusableEvidence(
  prev: MobileCampaignAssuranceReceipt | null | undefined,
  run: CampaignAssuranceRun,
  now: number,
): MobileCampaignAssuranceReceipt["evidence"] {
  if (TERMINAL_STATES.has(run.state) || !prev?.evidence) return null;
  const prevRun = prev.latest.data.detail.run;
  if (prevRun.id !== run.id || prevRun.state !== run.state) return null;
  return now - prev.evidenceFetchedAt < EVIDENCE_REFRESH_WHILE_ACTIVE_MS
    ? prev.evidence
    : null;
}

/** Read-only latest receipt for the mobile campaign review surface. */
export function useCampaignAssurance(campaignId: string | undefined) {
  const gate = useOnlineQueryGate();
  // Explicit type argument: a queryFn that destructures its context is
  // context-sensitive, so inference would otherwise type the data as `{}`.
  return useQuery<MobileCampaignAssuranceReceipt | null>({
    queryKey: [
      "campaign-assurance",
      gate.tenantId,
      gate.effectiveRole,
      campaignId,
      "latest",
    ],
    enabled: gate.enabled && Boolean(gate.tenantId && campaignId),
    staleTime: 5_000,
    refetchInterval: (query) => {
      const state = query.state.data?.latest.data.detail.run.state;
      return state && !TERMINAL_STATES.has(state) ? 2_000 : false;
    },
    queryFn: async ({
      client: cache,
      queryKey,
    }): Promise<MobileCampaignAssuranceReceipt | null> => {
      const { client } = getClient();
      try {
        const latest = await client.campaignAssurance.getLatest(campaignId!);
        const prev = cache.getQueryData<MobileCampaignAssuranceReceipt | null>(
          queryKey,
        );
        const reused = reusableEvidence(
          prev,
          latest.data.detail.run,
          Date.now(),
        );
        if (reused && prev) {
          return {
            latest,
            evidence: reused,
            evidenceFetchedAt: prev.evidenceFetchedAt,
          };
        }
        let evidence: CampaignAssuranceEnvelope<CampaignAssuranceEvidence> | null =
          null;
        try {
          evidence = await client.campaignAssurance.getEvidence(
            campaignId!,
            latest.data.detail.run.id,
            { limit: 200 },
          );
        } catch {
          // The immutable receipt/status remains useful. The card names the
          // missing evidence instead of turning a partial read into a pass.
        }
        return { latest, evidence, evidenceFetchedAt: Date.now() };
      } catch (error) {
        if (campaignErrorStatus(error) === 404) return null;
        throw error;
      }
    },
  });
}

/** Latest-only read for the compact send-sheet gate preview. */
export function useCampaignAssuranceStatus(
  campaignId: string | undefined,
  options: { enabled?: boolean } = {},
) {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: [
      "campaign-assurance",
      gate.tenantId,
      gate.effectiveRole,
      campaignId,
      "latest-status",
    ],
    enabled:
      (options.enabled ?? true) &&
      gate.enabled &&
      Boolean(gate.tenantId && campaignId),
    staleTime: 5_000,
    refetchInterval: (query) => {
      const state = query.state.data?.data.detail.run.state;
      return state && !TERMINAL_STATES.has(state) ? 2_000 : false;
    },
    queryFn:
      async (): Promise<CampaignAssuranceEnvelope<CampaignAssuranceLatest> | null> => {
        const { client } = getClient();
        try {
          return await client.campaignAssurance.getLatest(campaignId!);
        } catch (error) {
          if (campaignErrorStatus(error) === 404) return null;
          throw error;
        }
      },
  });
}
