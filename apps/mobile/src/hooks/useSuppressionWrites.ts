/**
 * useSuppressionWrites — every suppression WRITE, on both channels.
 *
 * WHY THESE ARE TOGETHER, AND WHY THEY ARE NOT IN useSuppressionOps.ts.
 * The reads there are gated, cached and snapshot-backed; these four share the
 * opposite rule, and it is the rule worth keeping in one place:
 *
 *   A COMPLIANCE WRITE IS NEVER QUEUED FROM A STALE PHONE. Each one checks
 *   `isProbablyOnline()` first and rejects with copy the screen shows verbatim,
 *   rather than being persisted as an offline mutation to replay later against
 *   a suppression list that has moved on. None of them carries
 *   `offlineSafeMutationMeta`, and that absence is deliberate.
 *
 * The export is here for the same reason even though it reads: it is an
 * explicit operator action with a side effect on the phone (a share sheet
 * opens), so it is a mutation — caching it and re-running it on focus would be
 * wrong twice over.
 *
 * Split out of useSuppressionOps.ts when the paged list pushed that file past
 * the 450-line source budget — same idiom as api/eventBus.ts →
 * eventBusStream.ts / eventBusConnection.ts. The pure half (the refusal copy,
 * the cache keys these invalidate) is in lib/suppressionOpsContracts.ts so it
 * can be exercised in the node environment; this file is the React half.
 * Re-exported from useSuppressionOps.ts so call sites keep one import.
 *
 * Endpoints:
 *   POST   /api/v1/deliverability/suppressions            (admin)
 *   DELETE /api/v1/deliverability/suppressions/{email}    (admin)
 *   GET    /api/v1/suppressions/export?limit=              (streaming CSV)
 *   DELETE /api/v1/sms/suppressions/{id}                  (admin)
 *   POST   /api/v1/suppressions/mirror/{provider}          (admin)
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { getClient } from "@/api/sdkClient";
import { runSuppressionMirror } from "@/api/suppressionMirror";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { isProbablyOnline } from "@/lib/connectivity";
import { authorizeAndAddSmsSuppression } from "@/lib/smsSuppressionAdd";
import { MirrorOfflineError, type MirrorOutcome } from "@/lib/suppressionMirror";
import { authorizeAndRemoveSmsSuppression } from "@/lib/smsSuppressionRemoval";
import type { SmsSuppression } from "@/lib/suppressionContracts";
import { suppressionExportPath } from "@/lib/suppressionExport";
import {
  OfflineWriteRefusedError,
  SMS_SUPPRESSIONS_KEY_ROOT,
  SuppressionExportOfflineError,
  suppressionListKey,
} from "@/lib/suppressionOpsContracts";
import { useAuthStore } from "@/store/auth";

export function useAddSuppression() {
  const queryClient = useQueryClient();
  const gate = useOnlineQueryGate();
  return useMutation({
    mutationFn: async (input: { email: string; reason: string }) => {
      if (!isProbablyOnline()) throw new OfflineWriteRefusedError();
      const { client } = getClient();
      return await client.request<unknown>(
        "POST",
        "/api/v1/deliverability/suppressions",
        { body: { email: input.email.trim(), reason: input.reason } },
      );
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: suppressionListKey(gate),
      });
      void queryClient.invalidateQueries({
        queryKey: ["suppression-trend", gate.tenantId],
      });
    },
  });
}

export function useRemoveSuppression() {
  const queryClient = useQueryClient();
  const gate = useOnlineQueryGate();
  return useMutation({
    mutationFn: async (email: string) => {
      if (!isProbablyOnline()) throw new OfflineWriteRefusedError();
      const { client } = getClient();
      return await client.request<unknown>(
        "DELETE",
        `/api/v1/deliverability/suppressions/${encodeURIComponent(email.trim())}`,
      );
    },
    onSuccess: (_result, email) => {
      void queryClient.invalidateQueries({
        queryKey: suppressionListKey(gate),
      });
      void queryClient.invalidateQueries({
        queryKey: [
          "suppression-audit",
          gate.tenantId,
          email.trim().toLowerCase(),
        ],
      });
    },
  });
}

/**
 * The whole suppression list as CSV text, for the share sheet.
 *
 * `asText` is required: the endpoint answers `text/csv`, and the SDK's default
 * path would hand back an unparsed string only by accident of content-type
 * sniffing. Being explicit also keeps the 2 MiB `readTextLimited` ceiling in
 * play, which is the transfer bound that matters on cellular.
 */
export function useExportSuppressions() {
  return useMutation({
    mutationFn: async (limit: number): Promise<string> => {
      if (!isProbablyOnline()) throw new SuppressionExportOfflineError();
      const { client } = getClient();
      return await client.request<string>("GET", suppressionExportPath(limit), {
        asText: true,
      });
    },
  });
}

/**
 * Pull the recent suppression pages from an external ESP (admin).
 *
 * Online-only like every write here: replaying a queued mirror later would
 * import a provider window the operator was no longer looking at. The list
 * and trend caches are invalidated only when rows were actually imported —
 * a not-configured fold and an all-skipped run change nothing.
 */
export function useMirrorSuppressions() {
  const queryClient = useQueryClient();
  const gate = useOnlineQueryGate();
  return useMutation<MirrorOutcome, Error, string>({
    mutationFn: async (provider: string) => {
      if (!isProbablyOnline()) throw new MirrorOfflineError();
      return await runSuppressionMirror(provider);
    },
    onSuccess: (outcome) => {
      if (outcome.kind !== "imported" || outcome.result.imported === 0) return;
      void queryClient.invalidateQueries({
        queryKey: suppressionListKey(gate),
      });
      void queryClient.invalidateQueries({
        queryKey: ["suppression-trend", gate.tenantId],
      });
    },
  });
}

export function useRemoveSmsSuppression() {
  const queryClient = useQueryClient();
  const gate = useOnlineQueryGate();
  return useMutation({
    mutationFn: (row: SmsSuppression) =>
      removeSmsSuppressionWithAdminReauth(row, gate.tenantId),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: [SMS_SUPPRESSIONS_KEY_ROOT],
      });
    },
  });
}

export function useAddSmsSuppression() {
  const queryClient = useQueryClient();
  const gate = useOnlineQueryGate();
  return useMutation({
    mutationFn: (phone: string) =>
      addSmsSuppressionWithAdminReauth(phone, gate.tenantId),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: [SMS_SUPPRESSIONS_KEY_ROOT],
      });
    },
  });
}

/** Revalidate the exact session identity before the manual-hold POST. */
export async function addSmsSuppressionWithAdminReauth(
  phone: string,
  expectedTenantId: string | null,
): Promise<SmsSuppression> {
  return authorizeAndAddSmsSuppression(phone, expectedTenantId, {
    isOnline: isProbablyOnline,
    readAuth: useAuthStore.getState,
    addSuppression: async (canonicalPhone) => {
      const { client } = getClient();
      return await client.request<unknown>(
        "POST",
        "/api/v1/sms/suppressions",
        { body: { phone: canonicalPhone, reason: "manual" } },
      );
    },
  });
}

/** Revalidate the exact session identity before the irreversible DELETE. */
export async function removeSmsSuppressionWithAdminReauth(
  row: SmsSuppression,
  expectedTenantId: string | null,
): Promise<void> {
  return authorizeAndRemoveSmsSuppression(row, expectedTenantId, {
    isOnline: isProbablyOnline,
    readAuth: useAuthStore.getState,
    deleteSuppression: async (id) => {
      const { client } = getClient();
      return await client.request<unknown>(
        "DELETE",
        `/api/v1/sms/suppressions/${encodeURIComponent(id)}`,
      );
    },
  });
}
