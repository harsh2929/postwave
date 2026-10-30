/**
 * useScheduledReports — the read + the two writes the phone slice needs.
 *
 *   GET   /api/v1/scheduled-reports              list
 *   PATCH /api/v1/scheduled-reports/{id}         { enabled } — pause / resume
 *   POST  /api/v1/scheduled-reports/{id}/send-now fire one off
 *
 * AUTHORIZATION, READ FROM THE HANDLER RATHER THAN THE MANIFEST. All five
 * routes are mounted behind `apikeys.RequireScope(apikeys.ScopeAdmin)`
 * (scheduled_reports.go MountRoutes). `RequireScope` is NOT a no-op for
 * dashboard sessions any more (apikeys/middleware.go): on a session-cookie
 * request an admin-tier scope is enforced as a ROLE check, so owner|admin
 * pass and editor|viewer get a 403. On an API-key session the key itself must
 * carry `admin`. The section models both — see ScheduledReportsSection.
 *
 * NOT OFFLINE-QUEUEABLE, DELIBERATELY. Both writes are time-sensitive
 * statements about when mail goes out: replaying a queued "send now" hours
 * later mails a digest nobody asked for at that moment, and replaying a
 * queued pause after the run already fired is a pause that did nothing while
 * reporting success. They are online-only, and the section says so rather
 * than failing with a raw network error.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { getClient } from "@/api/sdkClient";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import {
  parseScheduledReports,
  type ScheduledReportRow,
} from "@/lib/scheduledReports";

export const SCHEDULED_REPORTS_KEY = "scheduled-reports";

function reportsKey(
  tenantId: string | null,
  userId: string | null,
): readonly unknown[] {
  return [SCHEDULED_REPORTS_KEY, tenantId, userId];
}

/**
 * `enabled` takes the caller's gate AND the standard online/tenant gate: the
 * section is admin-only, and a viewer must not spend a request to be told 403.
 */
export function useScheduledReports(allowed: boolean) {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: reportsKey(gate.tenantId, gate.userId),
    enabled: gate.enabled && Boolean(gate.tenantId) && allowed,
    queryFn: async (): Promise<ScheduledReportRow[]> => {
      const { client } = getClient();
      const res = await client.request<unknown>(
        "GET",
        "/api/v1/scheduled-reports",
      );
      return parseScheduledReports(res);
    },
  });
}

export function useSetScheduledReportEnabled() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { id: string; enabled: boolean }) => {
      const { client } = getClient();
      return client.request<unknown>(
        "PATCH",
        `/api/v1/scheduled-reports/${encodeURIComponent(input.id)}`,
        { body: { enabled: input.enabled } },
      );
    },
    onSettled: () => {
      void queryClient.invalidateQueries({
        queryKey: [SCHEDULED_REPORTS_KEY],
      });
    },
  });
}

export function useSendScheduledReportNow() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { client } = getClient();
      // The handler REQUIRES exactly one Idempotency-Key header and 400s
      // without it (`idempotency_key_required`). The SDK auto-mints one for
      // POST and reuses it across its own retries, so a dropped response
      // cannot turn one tap into two digests.
      return client.request<unknown>(
        "POST",
        `/api/v1/scheduled-reports/${encodeURIComponent(id)}/send-now`,
        { body: {} },
      );
    },
    // A manual run becomes the report's `latest_run_*`, so the list is stale
    // the moment this returns.
    onSettled: () => {
      void queryClient.invalidateQueries({
        queryKey: [SCHEDULED_REPORTS_KEY],
      });
    },
  });
}
