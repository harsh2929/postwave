/**
 * hooks/useVerificationJobs.ts — watch a bulk verification, and stop it.
 *
 * List is `viewer` and cancel is `editor` (both reviewed), so the query runs for
 * anyone and the panel decides who gets the button. Polling is short while a job is
 * running: this is a spend meter, and a stale one is the reason somebody does not
 * hit Cancel.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { rawRequest } from "@/api/request";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import {
  parseVerificationJobs,
  verificationJobIsRunning,
  type VerificationJob,
} from "@/lib/verificationJobs";

const KEY = "verification-jobs";

export function useVerificationJobs() {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: [KEY, gate.tenantId],
    enabled: gate.enabled && Boolean(gate.tenantId),
    staleTime: 5_000,
    refetchInterval: (query) => {
      const rows = query.state.data;
      if (!Array.isArray(rows)) return false;
      return rows.some((row) => verificationJobIsRunning(row.status))
        ? 5_000
        : false;
    },
    queryFn: async (): Promise<VerificationJob[]> => {
      const res = await rawRequest<unknown>("GET", "/api/v1/verification/jobs");
      if (res.error) throw Object.assign(new Error(res.error.message), res.error);
      return parseVerificationJobs(res.data);
    },
  });
}

export function useCancelVerificationJob() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string): Promise<void> => {
      const jobId = id.trim();
      if (!jobId) throw new Error("verification job id is required");
      const res = await rawRequest<unknown>(
        "POST",
        `/api/v1/verification/jobs/${encodeURIComponent(jobId)}/cancel`,
        {},
      );
      if (res.error) throw Object.assign(new Error(res.error.message), res.error);
    },
    onSettled: () => void queryClient.invalidateQueries({ queryKey: [KEY] }),
  });
}
