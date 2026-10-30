/**
 * useDeliverabilityEvidence — the press-driven evidence lookups.
 *
 * All four are mutations-or-lazy by design, never prefetched:
 *  - the feedback trail carries a subscriber address in the request;
 *  - the EQ score carries draft content;
 *  - auth checks and the placement report are proxied DNS/seed reads that
 *    only matter when the operator asks for them.
 */
import { useMutation, useQuery } from "@tanstack/react-query";

import {
  diagnoseCampaign,
  type CampaignDiagnosis,
} from "@/api/deliverabilityDiagnose";

import {
  fetchAuthChecks,
  fetchFeedbackHistory,
  fetchPlacementReport,
  scoreEqDraft,
  type AuthCheckRow,
  type EqScoreResult,
  type FeedbackHistory,
  type PlacementReport,
} from "@/api/deliverabilityEvidence";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";

/**
 * Mutation-shaped although it is a read: the address must travel per explicit
 * press, and the result must never be revived from a cache keyed by email.
 */
export function useFeedbackHistoryLookup() {
  return useMutation<FeedbackHistory, Error, string>({
    mutationFn: (email) => fetchFeedbackHistory(email),
    retry: false,
  });
}

/**
 * The SPF/DKIM/DMARC/BIMI/PTR matrix. `armed` keeps this DNS-bound proxied
 * read press-driven — the card enables it on demand and the query then owns
 * refetching.
 */
export function useAuthChecks(armed: boolean) {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: ["auth-checks", gate.tenantId],
    enabled: armed && gate.enabled && Boolean(gate.tenantId),
    staleTime: 5 * 60_000,
    // A 502/503 "service not configured" answer will not change on retry.
    retry: false,
    queryFn: (): Promise<AuthCheckRow[]> => fetchAuthChecks(),
  });
}

/**
 * Where a sent campaign actually landed. `null` data is the REAL empty state
 * (no seed test has reported yet); a thrown 502/503 is "service not
 * configured" — the card renders those as different sentences.
 */
export function usePlacementReport(campaignId: string) {
  const gate = useOnlineQueryGate();
  const id = campaignId.trim();
  return useQuery({
    queryKey: ["placement-report", gate.tenantId, id],
    enabled: gate.enabled && Boolean(gate.tenantId) && id.length > 0,
    staleTime: 5 * 60_000,
    retry: false,
    queryFn: (): Promise<PlacementReport | null> => fetchPlacementReport(id),
  });
}

/** Grade a draft's quality signals. Press-driven; content travels per press. */
export function useEqScoreLookup() {
  return useMutation<
    EqScoreResult,
    Error,
    { from: string; subject: string; html?: string; text?: string }
  >({
    mutationFn: (input) => scoreEqDraft(input),
    retry: false,
  });
}

/**
 * The LLM diagnostician. Press-driven, single attempt, no retry — the model
 * call is expensive, and `diagnoseCampaign` already refuses to send a request
 * with no verified evidence.
 */
export function useDiagnoseCampaign() {
  return useMutation<CampaignDiagnosis, Error, string>({
    mutationFn: (campaignId) => diagnoseCampaign(campaignId),
    retry: false,
  });
}
