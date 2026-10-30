/**
 * hooks/useAuditForensics.ts — react-query around the per-event forensic
 * endpoints (api/auditForensics).
 *
 * Every read here is PRESS-DRIVEN: `enabled` flips only when the operator
 * expands the section that shows the answer. That is a cost decision for the
 * anomaly/proof/replay lookups (three extra requests per opened row would be
 * pure waste on rows nobody interrogates) and a correctness one for the chain
 * (which is a search, not a property of the open row).
 *
 * The unmask mutation is the one read that MINTS state — it writes a PII
 * access record server-side — so it is a mutation, never a query, never
 * retried, and its result lives in component state rather than the cache
 * (decrypted PII does not belong in a persisted query cache).
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  fetchAnomalyExplanation,
  fetchAuditChain,
  fetchInclusionProof,
  fetchSessionReplay,
  setAuditRetentionOverride,
  unmaskAuditEvent,
  type RetentionOverrideInput,
} from "@/api/auditForensics";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import type { UnmaskResult } from "@/lib/auditForensics";

/** The chain lookup: enabled only once a request id has been submitted. */
export function useAuditChain(requestId: string | null) {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: ["audit-chain", gate.tenantId, requestId],
    enabled: gate.enabled && Boolean(gate.tenantId) && Boolean(requestId),
    staleTime: 60_000,
    retry: false,
    queryFn: () => fetchAuditChain(requestId!),
  });
}

export function useAnomalyExplanation(auditId: number | null, open: boolean) {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: ["audit-anomaly-why", gate.tenantId, auditId],
    enabled: open && gate.enabled && Boolean(gate.tenantId) && auditId !== null,
    staleTime: 5 * 60_000,
    retry: false,
    queryFn: () => fetchAnomalyExplanation(auditId!),
  });
}

export function useInclusionProof(auditId: number | null, open: boolean) {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: ["audit-inclusion-proof", gate.tenantId, auditId],
    enabled: open && gate.enabled && Boolean(gate.tenantId) && auditId !== null,
    // A "pending" answer changes as the Merkle worker anchors; don't pin it.
    staleTime: 30_000,
    retry: false,
    queryFn: () => fetchInclusionProof(auditId!),
  });
}

export function useSessionReplayLookup(auditId: number | null, open: boolean) {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: ["audit-session-replay", gate.tenantId, auditId],
    enabled: open && gate.enabled && Boolean(gate.tenantId) && auditId !== null,
    staleTime: 5 * 60_000,
    retry: false,
    queryFn: () => fetchSessionReplay(auditId!),
  });
}

/**
 * Reveal sealed metadata. Result is handed to the caller, NOT cached: the
 * decrypted blob must live exactly as long as the sheet showing it.
 * Invalidates the log feed because the reveal itself appends an
 * audit.pii_unmask row.
 */
export function useUnmaskAuditEvent() {
  const gate = useOnlineQueryGate();
  const queryClient = useQueryClient();
  return useMutation<UnmaskResult, Error, { auditId: number; reason: string }>({
    mutationFn: ({ auditId, reason }) => unmaskAuditEvent(auditId, reason),
    retry: false,
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ["audit", gate.tenantId],
      });
    },
  });
}

/**
 * Place/extend a per-event retention override or flip its legal hold.
 * ONLINE-ONLY on purpose: "the evidence is preserved" must mean the server
 * said so, not that a phone queued a promise — a hold that silently replays
 * later is false evidence-preservation at the moment it mattered.
 */
export function useSetRetentionOverride() {
  const gate = useOnlineQueryGate();
  const queryClient = useQueryClient();
  return useMutation<void, Error, { auditId: number } & RetentionOverrideInput>({
    mutationFn: ({ auditId, ...input }) =>
      setAuditRetentionOverride(auditId, input),
    retry: false,
    onSuccess: () => {
      // The list rows carry legalHold/retentionOverrideDays, so the feed —
      // a true prefix of everything this changes — is stale on success.
      void queryClient.invalidateQueries({
        queryKey: ["audit", gate.tenantId],
      });
    },
  });
}
