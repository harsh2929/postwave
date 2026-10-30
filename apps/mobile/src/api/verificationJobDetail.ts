/**
 * api/verificationJobDetail.ts — one bulk verification job, opened.
 *
 *   GET /api/v1/verification/jobs/{id}          (viewer)
 *   GET /api/v1/verification/jobs/{id}/results  (viewer)
 *
 * Both are read:subscribers — the caller is asking about their own audience —
 * so the drill-in is available to everyone who can see the jobs list. Neither
 * spends a credit; the money was committed when the job was created.
 *
 * The results page takes `limit`, `offset` and a comma-separated `status`
 * filter. Only canonical statuses are sent: the server answers an unknown one
 * with 422 invalid_status, and a filter silently dropped client-side would
 * turn "show me the failures" into "show me everything" without saying so.
 */
import { ApiRequestError } from "./apiRequestError";
import { rawRequest, type AIApiError } from "./request";

import {
  parseVerificationJobDetail,
  parseVerificationJobResults,
  VERIFICATION_RESULTS_MAX,
  VERIFICATION_RESULTS_PAGE_SIZE,
  VERIFICATION_STATUSES,
  type VerificationJobDetail,
  type VerificationJobResultItem,
} from "@/lib/verificationJobDetail";

export class VerificationJobDetailError extends ApiRequestError {
  constructor(error: AIApiError, fallback: string) {
    super(error, fallback);
    this.name = "VerificationJobDetailError";
  }
}

function jobPath(jobId: string): string {
  const id = jobId.trim();
  if (!id) throw new Error("verification job id is required");
  return `/api/v1/verification/jobs/${encodeURIComponent(id)}`;
}

export async function fetchVerificationJobDetail(
  jobId: string,
): Promise<VerificationJobDetail> {
  const res = await rawRequest<unknown>("GET", jobPath(jobId));
  if (res.error) {
    throw new VerificationJobDetailError(
      res.error,
      "Couldn't load this verification job.",
    );
  }
  return parseVerificationJobDetail(res.data);
}

export async function fetchVerificationJobResults(input: {
  jobId: string;
  statuses?: readonly string[];
  limit?: number;
  offset?: number;
}): Promise<VerificationJobResultItem[]> {
  const known = new Set<string>(VERIFICATION_STATUSES);
  const statuses = (
    Array.isArray(input.statuses) ? input.statuses : []
  ).filter((status) => known.has(status));
  if (
    Array.isArray(input.statuses) &&
    input.statuses.length > 0 &&
    statuses.length !== input.statuses.length
  ) {
    // Fail closed: a partially-applied filter would under-report failures.
    throw new Error("unknown verification status filter");
  }
  const params = new URLSearchParams();
  // Clamped to the server's OWN bounds, because exceeding them does not fail
  // loudly: JobResults silently resets a limit over 1000 to 100, so an
  // over-large ask would return FEWER rows than the one before it.
  const requested = input.limit ?? VERIFICATION_RESULTS_PAGE_SIZE;
  const limit =
    requested > VERIFICATION_RESULTS_MAX
      ? VERIFICATION_RESULTS_MAX
      : requested > 0
        ? requested
        : VERIFICATION_RESULTS_PAGE_SIZE;
  params.set("limit", String(limit));
  if (input.offset && input.offset > 0) {
    params.set("offset", String(input.offset));
  }
  if (statuses.length > 0) params.set("status", statuses.join(","));
  const res = await rawRequest<unknown>(
    "GET",
    `${jobPath(input.jobId)}/results?${params.toString()}`,
  );
  if (res.error) {
    throw new VerificationJobDetailError(
      res.error,
      "Couldn't load this job's per-address results.",
    );
  }
  return parseVerificationJobResults(res.data);
}
