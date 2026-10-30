/**
 * api/auditSinks.ts — transport for the audit-sink ADMIN verbs mobile gained
 * after the health/remediation pass: disable/enable, delete, and historical
 * range replays.
 *
 * The read half (list, DLQ) stays in api/ops.ts over the SDK; these five are
 * wrapped over `rawRequest` so the transport seam is node-testable with the
 * `{data,error}` envelope mocked (the audienceDestinations idiom). Routes read
 * off `apps/api/internal/auditsink/admin.go::MountAdminRoutes`:
 *
 *   PATCH  /api/v1/audit-sinks/{id}                       cfgGate  (admin + audit:configure_sinks)
 *   DELETE /api/v1/audit-sinks/{id}                       cfgGate
 *   POST   /api/v1/audit-sinks/{id}/replay                execGate (admin + audit:execute_actions) → 202 job
 *   GET    /api/v1/audit-sinks/{id}/replay-jobs           readGate → {jobs, count, nextCursor?}
 *   POST   /api/v1/audit-sinks/{id}/replay-jobs/{job_id}/cancel  execGate → {cancelled}
 *
 * Parsing lives in lib/auditSinkReplay; this module is URLs and envelopes.
 */
import {
  parseSinkReplayJob,
  parseSinkReplayJobPage,
  type SinkReplayJob,
  type SinkReplayJobPage,
  type SinkReplayRange,
} from "@/lib/auditSinkReplay";

import { checkedApiResult, rawRequest } from "./request";

export const AUDIT_SINKS_PATH = "/api/v1/audit-sinks";

export function auditSinkPath(id: string): string {
  return `${AUDIT_SINKS_PATH}/${encodeURIComponent(id)}`;
}

/**
 * Disable or re-enable delivery. Only `{enabled}` is sent — the PATCH handler
 * applies fields independently, and `config`/`credentials` must never
 * round-trip through a client that cannot read them.
 */
export async function setAuditSinkEnabled(
  id: string,
  enabled: boolean,
): Promise<void> {
  await checkedApiResult(
    rawRequest<unknown>("PATCH", auditSinkPath(id), { enabled }),
  );
}

/**
 * Delete the sink. The server drops the row outright (no soft-delete), so the
 * confirm upstream is typed: its credentials and delivery history go with it.
 */
export async function deleteAuditSink(id: string): Promise<void> {
  await checkedApiResult(rawRequest<unknown>("DELETE", auditSinkPath(id)));
}

/** Start a range replay. 202 with the created job. */
export async function startAuditSinkReplay(
  id: string,
  range: SinkReplayRange,
): Promise<SinkReplayJob | null> {
  const res = await checkedApiResult(
    rawRequest<unknown>("POST", `${auditSinkPath(id)}/replay`, {
      from_id: range.fromId,
      to_id: range.toId,
    }),
  );
  return parseSinkReplayJob(res.data);
}

export async function fetchAuditSinkReplayJobs(
  id: string,
): Promise<SinkReplayJobPage> {
  const res = await checkedApiResult(
    rawRequest<unknown>("GET", `${auditSinkPath(id)}/replay-jobs`),
  );
  return parseSinkReplayJobPage(res.data);
}

/**
 * Cancel a queued or running replay — the stopping half, shipped first per
 * lib/stoppingHalfPolicy. The server answers 409 for a job that is already
 * finished; the caller renders that as the rule it is.
 */
export async function cancelAuditSinkReplayJob(
  id: string,
  jobId: string,
): Promise<void> {
  await checkedApiResult(
    rawRequest<unknown>(
      "POST",
      `${auditSinkPath(id)}/replay-jobs/${encodeURIComponent(jobId)}/cancel`,
    ),
  );
}
