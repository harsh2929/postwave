/**
 * useTransferCenter — every export, import and share this phone knows about,
 * as one list with actions (parity register, shell-crosscutting "unified
 * transfer center"; desktop anchor components/TransferCenter.tsx over
 * lib/file-transfer-history.ts).
 *
 * Mobile has no file journal to read, so the list is ASSEMBLED from the
 * server jobs the app already polls plus this session's share-sheet
 * hand-offs (lib/transferCenter), each mapped through its own domain's
 * state rules. The three server reads keep the SAME query keys their home
 * screens use, so this section never doubles a request and a job that
 * finishes while Settings is open is finished here too.
 *
 * Roles, per the manifest and the recorded policies:
 *   GET  /api/v1/exports               admin (route-contract)
 *   POST /api/v1/exports               admin
 *   GET  /api/v1/audit/export-jobs     viewer
 *   GET  /api/v1/subscriber-imports    admin in fact (lib/subscriberImportVerbs
 *                                      documents the manifest's "viewer" as wrong)
 *   POST /api/v1/subscriber-imports/{id}/cancel  editor per manifest, but
 *                                      the family is admin-wrapped; the access
 *                                      policy's canWrite decides.
 */
import { useIsFocused } from "expo-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Linking } from "react-native";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { listTenantExports, requestTenantExport } from "@/api/exports";
import { useAuditExportJobs } from "@/hooks/useAuditExport";
import { useIsOnline } from "@/hooks/useIsOnline";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import {
  useCancelSubscriberImport,
  useSubscriberImports,
} from "@/hooks/useSubscriberImports";
import { useTransferScope } from "@/hooks/useTrackedShare";
import type { AuditExportJob } from "@/lib/auditExport";
import { exportDownloadState, type TenantExportRow } from "@/lib/exportRows";
import { isOpenableDownloadUrl } from "@/lib/exportRows";
import { canAccessMinimumRole } from "@/lib/mobileRouteManifest";
import type { SubscriberImportJob } from "@/lib/subscriberImportJobs";
import { subscriberImportAccess } from "@/lib/subscriberImportVerbs";
import {
  aggregateTransfers,
  clearFinishedTransfers,
  listLocalTransfers,
  runLocalTransferRetry,
  subscribeTransferCenter,
  transferCounts,
  transferHistoryHiddenBefore,
  transferSummary,
  type TransferCounts,
  type TransferRow,
} from "@/lib/transferCenter";
import { useAuthStore } from "@/store/auth";

export interface TransferCenterModel {
  rows: TransferRow[];
  counts: TransferCounts;
  summary: string;
  /** True until the first read of every list this session may read. */
  loading: boolean;
  /** The first failed server read, as its own sentence; null when all landed. */
  error: string | null;
  online: boolean;
  /** Which server lists this identity may read. */
  access: { exports: boolean; imports: boolean; audit: boolean };
  /** Why a list is withheld, when one is. */
  notice: string | null;
  cancelImport: (id: string) => void;
  retryExport: () => Promise<boolean>;
  retryLocal: (id: string) => Promise<boolean>;
  open: (url: string) => Promise<boolean>;
  clearHistory: () => void;
  refresh: () => Promise<void>;
  busy: boolean;
}

export const TRANSFERS_ADMIN_NOTICE =
  "Workspace exports and subscriber imports are admin-only, so only audit exports and this phone's shares are listed.";

/** Newest → the row the worker is closest to finishing, for the pending watch. */
function pendingExportId(rows: readonly TenantExportRow[]): string {
  return (
    [...rows]
      .reverse()
      .find((row) => exportDownloadState(row).kind === "pending")?.id ?? ""
  );
}

export function useTransferCenter(): TransferCenterModel {
  const gate = useOnlineQueryGate();
  const mode = useAuthStore((s) => s.mode);
  const online = useIsOnline();
  const focused = useIsFocused();
  const queryClient = useQueryClient();
  const scope = useTransferScope();
  const isAdmin = canAccessMinimumRole("admin", gate.effectiveRole, mode);
  const importAccess = subscriberImportAccess({ isAdmin, mode, online });
  const canReadExports = gate.enabled && Boolean(gate.tenantId) && isAdmin;

  const exports = useQuery({
    queryKey: ["tenant-exports", gate.tenantId],
    enabled: gate.enabled && Boolean(gate.tenantId) && isAdmin,
    queryFn: async (): Promise<TenantExportRow[]> => {
      const res = await listTenantExports();
      if (res.error) {
        throw Object.assign(new Error(res.error.message), res.error);
      }
      const rows = res.data?.exports;
      return Array.isArray(rows) ? rows : [];
    },
    staleTime: 30_000,
    // Re-read only while a bundle is still building; a finished list is quiet.
    refetchInterval: (query) => {
      const rows = query.state.data;
      return Array.isArray(rows) && pendingExportId(rows) ? 8_000 : false;
    },
    refetchIntervalInBackground: false,
  });
  const audit = useAuditExportJobs(true);
  const imports = useSubscriberImports({
    canRead: importAccess.canRead,
    focused,
  });
  const cancel = useCancelSubscriberImport();

  // The local registry has no snapshot identity, so it is versioned here and
  // re-read inside the memo rather than through useSyncExternalStore.
  const [version, setVersion] = useState(0);
  useEffect(
    () => subscribeTransferCenter(() => setVersion((v) => v + 1)),
    [],
  );

  const tenantRows: TenantExportRow[] = Array.isArray(exports.data)
    ? exports.data
    : [];
  const auditRows: AuditExportJob[] = Array.isArray(audit.data)
    ? audit.data
    : [];
  const importPage = imports.data;
  const importRows: SubscriberImportJob[] =
    importPage && Array.isArray(importPage.jobs) ? importPage.jobs : [];

  const rows = useMemo(
    () =>
      aggregateTransfers({
        scope,
        local: listLocalTransfers(scope),
        tenantExports: tenantRows,
        auditJobs: auditRows,
        importJobs: importRows,
        hiddenBefore: transferHistoryHiddenBefore(),
        can: {
          cancelImports: importAccess.canWrite,
          retryExports: canReadExports && online,
        },
      }),
    // `version` is the registry's change counter; the row lists are fresh
    // references only when their queries produced new data.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [scope, tenantRows, auditRows, importRows, importAccess.canWrite, canReadExports, online, version],
  );
  const counts = useMemo(() => transferCounts(rows), [rows]);

  const loading =
    (canReadExports && exports.isLoading) ||
    (gate.enabled && audit.isLoading) ||
    (importAccess.canRead && imports.isLoading);
  const failed = [exports, audit, imports].find((query) => query.isError);
  const error = failed
    ? failed.error instanceof Error && failed.error.message.trim()
      ? failed.error.message
      : "One of the transfer lists could not be read."
    : null;

  const cancelImport = useCallback(
    (id: string) => {
      if (!importAccess.canWrite) return;
      cancel.mutate(id);
    },
    [cancel, importAccess.canWrite],
  );

  const retryExport = useCallback(async () => {
    if (!canReadExports || !online) return false;
    const res = await requestTenantExport();
    if (res.error) return false;
    void queryClient.invalidateQueries({
      queryKey: ["tenant-exports", gate.tenantId],
    });
    return true;
  }, [canReadExports, online, queryClient, gate.tenantId]);

  const open = useCallback(async (url: string) => {
    if (!isOpenableDownloadUrl(url)) return false;
    try {
      if (!(await Linking.canOpenURL(url))) return false;
      await Linking.openURL(url);
      return true;
    } catch {
      return false;
    }
  }, []);

  const refresh = useCallback(async () => {
    await Promise.all([
      canReadExports ? exports.refetch() : Promise.resolve(),
      audit.refetch(),
      importAccess.canRead ? imports.refetch() : Promise.resolve(),
    ]);
  }, [audit, canReadExports, exports, importAccess.canRead, imports]);

  return {
    rows,
    counts,
    summary: transferSummary(counts),
    loading,
    error,
    online,
    access: {
      exports: canReadExports,
      imports: importAccess.canRead,
      audit: gate.enabled,
    },
    notice: isAdmin ? importAccess.notice : TRANSFERS_ADMIN_NOTICE,
    cancelImport,
    retryExport,
    retryLocal: runLocalTransferRetry,
    open,
    clearHistory: () => clearFinishedTransfers(),
    refresh,
    busy: cancel.isPending,
  };
}
