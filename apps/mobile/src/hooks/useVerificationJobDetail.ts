/**
 * useVerificationJobDetail — one job's status detail and its per-address page.
 *
 * Both reads run ONLY while the drill-in sheet is open (`jobId` set), so the
 * jobs list never fans out a request per row. The detail poll matches the
 * list's cadence while the job is live and stops the moment it is terminal —
 * a finished job's counts cannot change, and polling one is a battery cost
 * with no answer attached.
 */
import { useQuery } from "@tanstack/react-query";

import {
  fetchVerificationJobDetail,
  fetchVerificationJobResults,
} from "@/api/verificationJobDetail";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";

import type {
  VerificationJobDetail,
  VerificationJobResultItem,
} from "@/lib/verificationJobDetail";

export function useVerificationJobDetail(jobId: string) {
  const gate = useOnlineQueryGate();
  const id = jobId.trim();
  return useQuery({
    queryKey: ["verification-job-detail", gate.tenantId, id],
    enabled: gate.enabled && Boolean(gate.tenantId) && id.length > 0,
    staleTime: 5_000,
    refetchInterval: (query) =>
      query.state.data?.isTerminal === false ? 5_000 : false,
    queryFn: (): Promise<VerificationJobDetail> =>
      fetchVerificationJobDetail(id),
  });
}

export function useVerificationJobResults(input: {
  jobId: string;
  statuses: readonly string[];
  enabled: boolean;
  /** Grows one page at a time; the limit is part of the key, so each size is
   *  cached in its own right and "show more" cannot render a stale short page. */
  limit: number;
}) {
  const gate = useOnlineQueryGate();
  const id = input.jobId.trim();
  const statuses = Array.isArray(input.statuses) ? input.statuses : [];
  return useQuery({
    queryKey: [
      "verification-job-results",
      gate.tenantId,
      id,
      statuses.join(","),
      input.limit,
    ],
    enabled:
      input.enabled && gate.enabled && Boolean(gate.tenantId) && id.length > 0,
    staleTime: 10_000,
    queryFn: (): Promise<VerificationJobResultItem[]> =>
      fetchVerificationJobResults({ jobId: id, statuses, limit: input.limit }),
  });
}
