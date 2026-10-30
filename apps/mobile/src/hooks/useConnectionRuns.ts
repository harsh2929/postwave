/**
 * hooks/useConnectionRuns.ts — one provider-family row's recent runs.
 *
 * Enabled only while the row is expanded (`id` is null otherwise), so a panel
 * of twelve collapsed rows costs zero run requests. `staleTime: 0` for the
 * same reason useDestinationSyncJobs uses it: this history is opened precisely
 * to find out what broke, and a copy from the last time the row was opened is
 * exactly what must not be shown.
 *
 * The key is rooted under useConnectionFamily's "connection-family" ON
 * PURPOSE: useRunConnectionVerb invalidates that root after every verb, so a
 * run history that is open when the operator taps "Run now" refreshes with
 * the new run instead of stopping at the one that failed.
 */
import { useQuery } from "@tanstack/react-query";

import type { ConnectionFamily } from "@/api/connectionFamilies";
import { fetchConnectionRuns } from "@/api/connectionRuns";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import type { ConnectionRun } from "@/lib/connectionRuns";

export function connectionRunsQueryKey(
  family: ConnectionFamily,
  tenantId: string | null | undefined,
  id: string | null,
): readonly unknown[] {
  return ["connection-family", "runs", family, tenantId ?? null, id];
}

export function useConnectionRuns(family: ConnectionFamily, id: string | null) {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: connectionRunsQueryKey(family, gate.tenantId, id),
    enabled: gate.enabled && Boolean(gate.tenantId) && Boolean(id),
    staleTime: 0,
    queryFn: (): Promise<ConnectionRun[]> => fetchConnectionRuns(family, id!),
  });
}
