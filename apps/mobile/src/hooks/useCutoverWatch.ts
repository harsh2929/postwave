/**
 * hooks/useCutoverWatch.ts — the post-cutover watch reads (GOVERNANCE#53).
 *
 * See lib/cutoverWatch.ts for where these endpoints live and why 404/503 are
 * states rather than failures. Authorization is identical to the rest of the
 * migrations family — `apikeys.RequireScope(apikeys.ScopeAdmin)` on the
 * gateway proxy (apps/api/main.go:3878-3879) — so a session that can open a
 * job's detail sheet can always read its watch, and gating the section behind
 * an extra affordance check would hide a working surface.
 *
 * BOTH QUERIES ARE OPENED BY A DISCLOSURE. `enabled` carries the open job id
 * and a `completed`-only status gate: `source_events.go:752` refuses the
 * review route for any other status, and starting a monitor is a web-app
 * action, so a job that is still importing has nothing to show and would
 * only burn a request per row of a thirty-job list.
 *
 * POLLING. The server side of this loop ticks on the monitor's own
 * `interval_seconds` (3600 by default), so polling fast would be theatre.
 * Sixty seconds is the compromise: it is fast enough that a reader watching a
 * cutover sees a new check land without touching anything, and slow enough
 * that leaving the sheet open on a desk is free. Nothing here drives a
 * pull-to-refresh spinner (LOVE#15) — the sheet has no RefreshControl.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  getMobileShadowMonitor,
  getMobileSourceEvents,
  reopenMobileSourceEventReview,
} from "@/api/ops";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import {
  parseShadowWatch,
  parseSourceEventWatch,
  type ShadowWatch,
  type SourceEventWatch,
} from "@/lib/cutoverWatch";

/**
 * A watch read resolves to `null` for the two answers that are not faults, and
 * throws for everything else so the section renders an error state rather than
 * an empty one (house rule 8).
 *
 *   404 — no monitor was ever started for this job.
 *   503 — this deployment's job store is not monitor-capable.
 */
function absentOrThrow(
  error: { status: number; message: string },
  label: string,
): null {
  if (error.status === 404 || error.status === 503) return null;
  throw new Error(error.message || `${label} failed`);
}

/** Only a completed import can have a live cutover watch. */
export function shouldReadCutoverWatch(
  status: string | null | undefined,
): boolean {
  return String(status ?? "").toLowerCase() === "completed";
}

export function useShadowWatch(jobId: string | null, status?: string) {
  const gate = useOnlineQueryGate();
  const wanted = shouldReadCutoverWatch(status);
  return useQuery<ShadowWatch | null>({
    queryKey: ["migration-shadow-watch", gate.tenantId, jobId],
    enabled: gate.enabled && Boolean(gate.tenantId && jobId) && wanted,
    retry: false,
    refetchInterval: 60_000,
    queryFn: async (): Promise<ShadowWatch | null> => {
      if (!jobId) return null;
      const res = await getMobileShadowMonitor(jobId);
      if (res.error) return absentOrThrow(res.error, "Shadow monitor");
      return parseShadowWatch(res.data);
    },
  });
}

export function useSourceEventWatch(jobId: string | null, status?: string) {
  const gate = useOnlineQueryGate();
  const wanted = shouldReadCutoverWatch(status);
  return useQuery<SourceEventWatch | null>({
    queryKey: ["migration-source-events", gate.tenantId, jobId],
    enabled: gate.enabled && Boolean(gate.tenantId && jobId) && wanted,
    retry: false,
    refetchInterval: 60_000,
    queryFn: async (): Promise<SourceEventWatch | null> => {
      if (!jobId) return null;
      const res = await getMobileSourceEvents(jobId);
      if (res.error) return absentOrThrow(res.error, "Source events");
      return parseSourceEventWatch(res.data);
    },
  });
}

/**
 * Re-open a source-event sign-off. The `reviewed` direction is deliberately
 * absent — see `reopenUnavailableReason` in lib/cutoverWatch.ts for why a
 * phone must not author a compliance record.
 *
 * NOT queued offline: the server refuses the write outright for a job whose
 * status has moved on, so a replay hours later could apply against state the
 * operator never saw. It is online-only and says so at the call site.
 */
export function useReopenSourceEventReview(jobId: string | null) {
  const queryClient = useQueryClient();
  const { tenantId } = useOnlineQueryGate();
  return useMutation({
    mutationFn: async (eventId: string) => {
      if (!jobId) throw new Error("No migration job is open.");
      const res = await reopenMobileSourceEventReview(jobId, eventId);
      if (res.error) {
        throw new Error(res.error.message || "Could not re-open the review");
      }
      return res.data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ["migration-source-events", tenantId, jobId],
      });
    },
  });
}
