/**
 * hooks/useGovernanceOps.ts — the governance cluster's WRITE paths.
 *
 * Every screen in this cluster was read-only, which reads as a deliberate
 * "phones are for looking, desks are for doing" policy until you notice
 * which specific actions were missing:
 *
 *   - REVOKE A SCIM TOKEN. A leaked provisioning bearer can create and
 *     deprovision workspace users. There is no version of that where the
 *     right answer is "wait until you are at a laptop".
 *   - RESET A TRIPPED AUDIT SINK CIRCUIT. While the breaker is open, every
 *     audit event is dead-lettering. Nothing re-closes it automatically.
 *   - REPLAY A DEAD-LETTERED BATCH. The other half of the same incident.
 *   - CANCEL A RUNNING MIGRATION. A runaway import writes to the live
 *     subscriber table; minutes matter.
 *
 * All four are deliberately ONLINE-ONLY (no offline mutation queue): a
 * governance action replayed later, out of context, from a stale phone is
 * worse than one that failed loudly at the time. They live here rather than
 * in useOps.ts so the governance surface owns its own mutations and the
 * shared ops hook file stops growing.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";

import {
  cancelAuditSinkReplayJob,
  deleteAuditSink,
  setAuditSinkEnabled,
  startAuditSinkReplay,
} from "@/api/auditSinks";
import {
  cancelMobileMigration,
  replayMobileAuditSinkDlq,
  resetMobileAuditSinkCircuit,
  revokeMobileScimToken,
  testMobileAuditSink,
} from "@/api/ops";
import { checkedApiResult } from "@/api/request";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import type { SinkReplayRange } from "@/lib/auditSinkReplay";

/**
 * checkedApiResult turns the `{data,error}` envelope into a rejecting
 * promise carrying `.status` and `.code`, so a caller can tell a 409
 * "already replayed" from a 403 "you lost the scope" instead of showing one
 * generic failure for both.
 */

export function useRevokeScimToken() {
  const queryClient = useQueryClient();
  const { tenantId } = useOnlineQueryGate();
  return useMutation({
    mutationFn: (id: string) => checkedApiResult(revokeMobileScimToken(id)),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ["mobile-scim-tokens", tenantId],
      });
    },
  });
}

export function useResetSinkCircuit() {
  const queryClient = useQueryClient();
  const { tenantId } = useOnlineQueryGate();
  return useMutation({
    mutationFn: (id: string) =>
      checkedApiResult(resetMobileAuditSinkCircuit(id)),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ["mobile-audit-sinks", tenantId],
      });
      // A closed circuit starts draining the DLQ, so the queue view is stale
      // the moment this succeeds.
      void queryClient.invalidateQueries({
        queryKey: ["mobile-audit-sink-dlq", tenantId],
      });
    },
  });
}

export function useTestSink() {
  const queryClient = useQueryClient();
  const { tenantId } = useOnlineQueryGate();
  return useMutation({
    mutationFn: (id: string) => checkedApiResult(testMobileAuditSink(id)),
    onSuccess: () => {
      // A probe updates last_success_at / last_error, which is the whole
      // point of running one.
      void queryClient.invalidateQueries({
        queryKey: ["mobile-audit-sinks", tenantId],
      });
    },
  });
}

export function useReplayDlqEntry() {
  const queryClient = useQueryClient();
  const { tenantId } = useOnlineQueryGate();
  return useMutation({
    mutationFn: (id: number | string) =>
      checkedApiResult(replayMobileAuditSinkDlq(id)),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ["mobile-audit-sink-dlq", tenantId],
      });
      void queryClient.invalidateQueries({
        queryKey: ["mobile-audit-sinks", tenantId],
      });
    },
  });
}

/**
 * Disable (or re-enable) a sink's delivery. The softer stopping half beside
 * delete: a sink streaming evidence to a compromised destination stops NOW,
 * and nothing about its configuration is lost.
 */
export function useSetSinkEnabled() {
  const queryClient = useQueryClient();
  const { tenantId } = useOnlineQueryGate();
  return useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      setAuditSinkEnabled(id, enabled),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ["mobile-audit-sinks", tenantId],
      });
    },
  });
}

/**
 * Delete a sink outright. The DB row goes with its encrypted credentials and
 * its DLQ linkage, so the screen confirms with a TYPED phrase before this
 * ever runs.
 */
export function useDeleteSink() {
  const queryClient = useQueryClient();
  const { tenantId } = useOnlineQueryGate();
  return useMutation({
    mutationFn: (id: string) => deleteAuditSink(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ["mobile-audit-sinks", tenantId],
      });
      // Orphaned DLQ entries stop rendering against a sink that is gone.
      void queryClient.invalidateQueries({
        queryKey: ["mobile-audit-sink-dlq", tenantId],
      });
    },
  });
}

/** Start a historical range replay ({from_id, to_id} over audit ids). */
export function useStartSinkReplay() {
  const queryClient = useQueryClient();
  const { tenantId } = useOnlineQueryGate();
  return useMutation({
    mutationFn: ({ id, range }: { id: string; range: SinkReplayRange }) =>
      startAuditSinkReplay(id, range),
    onSuccess: (_job, { id }) => {
      void queryClient.invalidateQueries({
        queryKey: ["mobile-sink-replay-jobs", tenantId, id],
      });
    },
  });
}

/** Cancel a queued or running replay — the stopping half, shipped first. */
export function useCancelSinkReplay() {
  const queryClient = useQueryClient();
  const { tenantId } = useOnlineQueryGate();
  return useMutation({
    mutationFn: ({ id, jobId }: { id: string; jobId: string }) =>
      cancelAuditSinkReplayJob(id, jobId),
    onSuccess: (_res, { id }) => {
      void queryClient.invalidateQueries({
        queryKey: ["mobile-sink-replay-jobs", tenantId, id],
      });
    },
  });
}

export function useCancelMigration() {
  const queryClient = useQueryClient();
  const { tenantId } = useOnlineQueryGate();
  return useMutation({
    mutationFn: (jobId: string) => checkedApiResult(cancelMobileMigration(jobId)),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ["mobile-migrations", tenantId],
      });
    },
  });
}
