/**
 * hooks/useConnectionFamily.ts — list and act on one provider family.
 *
 * The list is ScopeReadReports (any role) while every verb is ScopeAdmin, so the
 * query runs for anyone and the PANEL decides whether to render controls. Seeing
 * that a write-back target is failing is useful to a viewer even when fixing it
 * is not theirs to do.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  fetchConnections,
  runConnectionVerb,
  type ConnectionFamily,
} from "@/api/connectionFamilies";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import type { ConnectionRow, ConnectionVerb } from "@/lib/connectionLifecycle";

const KEY = "connection-family";

export function useConnectionFamily(family: ConnectionFamily) {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: [KEY, family, gate.tenantId],
    enabled: gate.enabled && Boolean(gate.tenantId),
    staleTime: 30_000,
    queryFn: (): Promise<ConnectionRow[]> => fetchConnections(family),
  });
}

export function useRunConnectionVerb() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      family: ConnectionFamily;
      id: string;
      verb: ConnectionVerb;
    }): Promise<void> => runConnectionVerb(input),
    // onSettled, not onSuccess: a failure usually means the row moved, so the
    // status on screen is exactly what must not survive the error.
    onSettled: () => void queryClient.invalidateQueries({ queryKey: [KEY] }),
  });
}
