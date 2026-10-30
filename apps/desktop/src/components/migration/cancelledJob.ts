/**
 * cancelledJob — classifier for the persisted form of an operator
 * cancel. Split out of MigrationErrorBanners.tsx so the node-
 * environment vitest suite can import it (the desktop tsconfig keeps
 * `jsx: preserve`, so .tsx modules can't be imported by tests).
 */

/**
 * True when a job is the persisted form of an operator cancel: the
 * server stores cancellation as status="failed" with an error like
 * "migration cancelled by operator". Only these jobs are accepted by
 * POST /migrations/{id}/resume (anything else 409s).
 */
export function isCancelledJob(job: {
  status?: string;
  error?: string | null;
}): boolean {
  return job.status === "failed" && /cancel/i.test(job.error ?? "");
}
