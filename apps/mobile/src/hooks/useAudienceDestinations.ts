/**
 * hooks/useAudienceDestinations.ts — list and stop audience destinations.
 *
 * Mirrors useConnectionFamily's split deliberately: the list is
 * ScopeReadReports (any role) and every mutation is admin, so the query runs
 * for anyone and the SECTION decides whether to render controls. A viewer
 * seeing that a destination stopped syncing is useful even when fixing it is
 * not theirs to do.
 *
 * `onSettled` rather than `onSuccess` for the same reason as its sibling: when
 * a status change fails, the row on screen is precisely what must not survive
 * the error.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  disconnectDestination,
  fetchDestinationJobDiagnostics,
  fetchDestinationJobs,
  fetchDestinationPreview,
  fetchDestinations,
  setDestinationStatus,
  syncDestinationNow,
} from "@/api/audienceDestinations";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import type {
  DestinationPreview,
  DestinationSyncNowResult,
  JobDiagnostics,
} from "@/lib/audienceDestinationActions";
import type {
  AudienceDestination,
  DestinationSyncJob,
} from "@/lib/audienceDestinationRows";

const KEY = "audience-destinations";
const JOBS_KEY = "audience-destination-jobs";

export function destinationJobsQueryKey(
  tenantId: string | null | undefined,
  destinationId: string | null,
): readonly unknown[] {
  return [JOBS_KEY, tenantId ?? null, destinationId];
}

export function useAudienceDestinations() {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: [KEY, gate.tenantId],
    enabled: gate.enabled && Boolean(gate.tenantId),
    staleTime: 30_000,
    queryFn: (): Promise<AudienceDestination[]> => fetchDestinations(),
  });
}

/**
 * One destination's recent sync jobs.
 *
 * `staleTime: 0`, for the same reason `useAudienceSyncRuns` uses it: this
 * history is opened precisely to find out what broke, and the list behind it is
 * allowed to be half a minute old. The server caps the read at 25 rows
 * (`ListSyncJobs(..., 25)`) and offers no cursor, so there is no page to fetch.
 *
 * Read-only and viewer-floored — `GET /{id}/jobs` is `ScopeReadReports`
 * (handlers.go:69-70), the same floor as the list — so a viewer who can see a
 * destination stopped syncing can also see the failure that stopped it.
 */
export function useDestinationSyncJobs(destinationId: string | null) {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: destinationJobsQueryKey(gate.tenantId, destinationId),
    enabled: gate.enabled && Boolean(gate.tenantId) && Boolean(destinationId),
    staleTime: 0,
    queryFn: (): Promise<DestinationSyncJob[]> =>
      fetchDestinationJobs(destinationId!),
  });
}

export function useSetDestinationStatus() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      id: string;
      status: "active" | "paused";
    }): Promise<void> => setDestinationStatus(input.id, input.status),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: [KEY] }),
  });
}

export function useDisconnectDestination() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string): Promise<void> => disconnectDestination(id),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: [KEY] }),
  });
}

/**
 * Push a destination's audience now.
 *
 * ONLINE-ONLY BY CONSTRUCTION, for the same reason run-now on an audience sync
 * is: this delivers real subscriber records to a third party, and a queued
 * mutation released hours later would push an audience at a moment nobody
 * chose. It is never registered in the offline mutation contract.
 *
 * `onSettled` invalidates BOTH caches the run rewrote — the destination row
 * (status + last_synced_at moved) and that destination's job history (a new
 * job row closed) — whichever way the run went. A client-side timeout leaves a
 * run genuinely in flight server-side, so the failure path needs the refresh
 * at least as much as the success path.
 */
export function useSyncDestinationNow() {
  const gate = useOnlineQueryGate();
  const queryClient = useQueryClient();
  return useMutation<
    DestinationSyncNowResult,
    Error,
    { id: string; idempotencyKey: string }
  >({
    mutationFn: ({ id, idempotencyKey }) =>
      syncDestinationNow(id, idempotencyKey),
    onSettled: (_result, _error, variables) => {
      void queryClient.invalidateQueries({ queryKey: [KEY] });
      void queryClient.invalidateQueries({
        queryKey: destinationJobsQueryKey(gate.tenantId, variables.id),
      });
    },
  });
}

/**
 * Membership preview — press-driven, never prefetched. Resolving the source
 * audience is a real server-side walk of the list/segment plus the consent
 * firewall, so it runs only when the reader asks the question (`requested`).
 * Viewer-floored: `GET /{id}/preview` is ScopeReadReports (handlers.go:77-78).
 */
export function useDestinationPreview(
  destinationId: string | null,
  requested: boolean,
) {
  const gate = useOnlineQueryGate();
  return useQuery<DestinationPreview>({
    queryKey: [
      "audience-destination-preview",
      gate.tenantId,
      destinationId,
    ],
    enabled:
      gate.enabled &&
      Boolean(gate.tenantId) &&
      Boolean(destinationId) &&
      requested,
    // Consent and suppression state move under it; a re-open re-asks.
    staleTime: 0,
    queryFn: () => fetchDestinationPreview(destinationId!),
  });
}

/**
 * One job's provider-side diagnostics — fetched only for the job the reader
 * tapped. `staleTime` is long because the answer describes a CLOSED job: the
 * provider's verdict on a finished request does not change under the sheet.
 */
export function useDestinationJobDiagnostics(
  destinationId: string | null,
  jobId: string | null,
) {
  const gate = useOnlineQueryGate();
  return useQuery<JobDiagnostics>({
    queryKey: [
      "audience-destination-job-diagnostics",
      gate.tenantId,
      destinationId,
      jobId,
    ],
    enabled:
      gate.enabled &&
      Boolean(gate.tenantId) &&
      Boolean(destinationId) &&
      Boolean(jobId),
    staleTime: 600_000,
    // A refusal (409 diagnostics_unavailable, 409 not_supported) is a fact
    // about the job, not a transient failure — retrying cannot change it.
    retry: false,
    queryFn: () => fetchDestinationJobDiagnostics(destinationId!, jobId!),
  });
}
