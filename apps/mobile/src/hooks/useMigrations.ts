/**
 * hooks/useMigrations.ts — every migration read on mobile: the job list, its
 * source catalogue, and the two per-job reports.
 *
 * The list used to live in `hooks/useOps.ts`, a residual "ops surface" module
 * that asked each remaining resource family to leave when its screen was next
 * touched. COMMERCE#60 emptied it; the list arrived here, so a screen that
 * wants migration jobs no longer transitively imports SCIM, agency and
 * audit-sink wire types.
 *
 * AUTHORIZATION. Every `/api/v1/migrations/*` path is proxied to the migration
 * service behind `apikeys.RequireScope(apikeys.ScopeAdmin)`
 * (apps/api/main.go:3878-3879). `ScopeAdmin` is not in the `readOnlyScopes`
 * allowlist (apps/api/internal/apikeys/middleware.go:332-337), so on the
 * session path it becomes a hard owner/admin ROLE check. That is the SAME gate
 * the job list already passes, so a session that can see a job can always read
 * its report — no extra affordance gating is needed here, and adding one would
 * hide a working button.
 *
 * BOTH QUERIES ARE OPENED BY A DISCLOSURE, never by the list. `enabled` carries
 * the open job id, so a portfolio of thirty jobs fires zero requests until an
 * operator asks about one — and `shouldReadRollbackStatus` keeps the second
 * one shut except for the two states where a rollback exists, because that
 * handler RECREATES a rollback worker for a job in `rolling_back`
 * (services/migration/internal/handlers/migration.go:3035-3042) and is
 * therefore not a free read.
 */
import { useQuery } from "@tanstack/react-query";

import {
  listMobileMigrationSources,
  listMobileMigrations,
  type MobileMigrationJob,
  type MobileMigrationSource,
} from "@/api/ops";
import {
  getMobileMailchimpParitySnapshot,
  type MobileMailchimpParitySnapshot,
} from "@/api/mobileParity";
import { rawRequest } from "@/api/request";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { shouldPollMobileMigrations } from "@/lib/migrationProgress";
import { opsTimestamp, unwrapMobileResult } from "@/lib/mobileOpsResult";
import {
  parseMigrationRollback,
  parseMigrationVerification,
  shouldReadRollbackStatus,
  type MigrationRollbackStatus,
  type MigrationVerification,
} from "@/lib/migrationVerification";

export type { MobileMigrationJob, MobileMigrationSource };

/**
 * Newest-activity key for the job list.
 *
 * This used to lead with `job.updated_at`, which the migration service has
 * never sent: `canonical.MigrationJob` (packages/migrate/canonical/types.go:330)
 * carries id/tenant_id/source/status/progress/cursor/started_at/completed_at/
 * rollback_until/source_session_expires_at/selected_audience_ids/
 * verification_report/error and nothing else. The branch only compiled because
 * the mobile-local job type carried an `[key: string]: unknown` index
 * signature; deriving the type from the SDK (GOVERNANCE#57) surfaced it.
 *
 * A RUNNING job therefore has no completion time and sorts by `started_at`,
 * which is the correct answer for it — the progress counters move, but nothing
 * on the wire timestamps that movement.
 */
function migrationLastTouch(job: MobileMigrationJob): number {
  return opsTimestamp(job.completed_at ?? job.started_at ?? "");
}

export function useMobileMigrations() {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: ["mobile-migrations", gate.tenantId],
    enabled: gate.enabled && Boolean(gate.tenantId),
    queryFn: async (): Promise<MobileMigrationJob[]> => {
      const rows = unwrapMobileResult(
        await listMobileMigrations(),
        "Migration jobs",
      );
      return [...rows].sort(
        (a, b) => migrationLastTouch(b) - migrationLastTouch(a),
      );
    },
    refetchInterval: (query) =>
      shouldPollMobileMigrations(query.state.data) ? 5_000 : false,
  });
}

export function useMobileMigrationSources() {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: ["mobile-migration-sources", gate.tenantId],
    enabled: gate.enabled && Boolean(gate.tenantId),
    queryFn: async (): Promise<MobileMigrationSource[]> => {
      const rows = unwrapMobileResult(
        await listMobileMigrationSources(),
        "Migration sources",
      );
      return [...rows].sort((a, b) => a.source.localeCompare(b.source));
    },
  });
}

/**
 * What already exists on the destination, for someone mid-migration.
 *
 * `getMobileMailchimpParitySnapshot` has existed complete since it was written
 * and was never rendered: exported from `api/mobileParity.ts`, re-exported
 * through `api/client.ts`, called by nothing. A re-export is not a consumer,
 * which is precisely why a grep for the symbol found two hits and the product
 * had zero.
 *
 * It belongs on this screen and not its own. The question it answers — "how
 * much of my Mailchimp setup is already here" — is only ever asked while
 * looking at a migration, and a separate tab for it would be a destination
 * nobody navigates to on purpose.
 *
 * Opened by the same online gate as the job list, and deliberately NOT polled:
 * it fans out to four compat endpoints, and a readiness count that moves every
 * thirty seconds invites re-reading rather than trusting it.
 */
export function useMobileMailchimpParity() {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: ["mobile-mailchimp-parity", gate.tenantId],
    enabled: gate.enabled && Boolean(gate.tenantId),
    staleTime: 5 * 60 * 1000,
    queryFn: async (): Promise<MobileMailchimpParitySnapshot> =>
      unwrapMobileResult(
        await getMobileMailchimpParitySnapshot(),
        "Mailchimp parity snapshot",
      ),
  });
}

/**
 * The verification report, or `null` when the server says there is not one yet.
 *
 * A 404 is NOT an error here: the handler answers 404 with "verification report
 * not yet available" whenever the job has not produced one
 * (services/migration/internal/handlers/migration.go:2910), which is the normal
 * answer for a job that is still importing. It resolves to `null` so the sheet
 * can render `verificationAbsenceCopy` instead of a red failure card for a job
 * that is working perfectly.
 */
export function useMigrationVerification(jobId: string | null) {
  const gate = useOnlineQueryGate();
  return useQuery<MigrationVerification | null>({
    queryKey: ["migration-verification", gate.tenantId, jobId],
    enabled: gate.enabled && Boolean(gate.tenantId && jobId),
    // A report is written once and never edited, so a cached one is as good as
    // a fresh one — but a job that had none a minute ago may have one now,
    // which is why a null result is not cached for long.
    staleTime: 30_000,
    retry: false,
    queryFn: async (): Promise<MigrationVerification | null> => {
      if (!jobId) return null;
      const res = await rawRequest<unknown>(
        "GET",
        `/api/v1/migrations/${encodeURIComponent(jobId)}/verification`,
      );
      if (res.error) {
        if (res.error.status === 404) return null;
        throw new Error(res.error.message || "Verification report failed");
      }
      return parseMigrationVerification(res.data);
    },
  });
}

/**
 * Rollback progress for a job that is being — or has been — rolled back.
 *
 * `enabled` is gated on the STATUS as well as the id, so the worker-recreating
 * handler is never called for a job that has no rollback.
 */
export function useMigrationRollback(
  jobId: string | null,
  status: string | undefined,
) {
  const gate = useOnlineQueryGate();
  const wanted = shouldReadRollbackStatus(status);
  return useQuery<MigrationRollbackStatus | null>({
    queryKey: ["migration-rollback", gate.tenantId, jobId],
    enabled: gate.enabled && Boolean(gate.tenantId && jobId) && wanted,
    retry: false,
    // A rollback in flight is the one thing on this sheet that moves.
    refetchInterval: (query) =>
      (query.state.data?.state ?? "").toLowerCase() === "completed"
        ? false
        : 5_000,
    queryFn: async (): Promise<MigrationRollbackStatus | null> => {
      if (!jobId) return null;
      const res = await rawRequest<unknown>(
        "GET",
        `/api/v1/migrations/${encodeURIComponent(jobId)}/rollback-status`,
      );
      if (res.error) {
        if (res.error.status === 404) return null;
        throw new Error(res.error.message || "Rollback status failed");
      }
      return parseMigrationRollback(res.data);
    },
  });
}
