/**
 * useDeliverabilityProviders — the ESP evidence connections.
 *
 * The list is a viewer read; create / activate / deactivate / remove are
 * admin-scoped server-side and ONLINE-ONLY here — they carry secret-adjacent
 * configuration, and a replayed connection change lands on an integration
 * state nobody is watching.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  createProviderConnection,
  deleteProviderConnection,
  fetchProviderConnections,
  setProviderConnection,
  type ProviderConnection,
  type ProviderUpsertInput,
} from "@/api/deliverabilityProviders";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";

const KEY = "deliverability-providers";

export function useProviderConnections() {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: [KEY, gate.tenantId],
    enabled: gate.enabled && Boolean(gate.tenantId),
    staleTime: 5 * 60_000,
    queryFn: (): Promise<ProviderConnection[]> => fetchProviderConnections(),
  });
}

function useInvalidateProviders() {
  const gate = useOnlineQueryGate();
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: [KEY, gate.tenantId] });
  };
}

export function useCreateProviderConnection() {
  const invalidate = useInvalidateProviders();
  return useMutation<ProviderConnection, Error, ProviderUpsertInput>({
    mutationFn: (input) => createProviderConnection(input),
    // The POST is an upsert keyed by provider; a blind retry that follows a
    // lost response would still be idempotent, but a retry after a validation
    // failure just repeats the refusal — keep it single-shot.
    retry: false,
    onSuccess: invalidate,
  });
}

export function useSetProviderConnection() {
  const invalidate = useInvalidateProviders();
  return useMutation<
    ProviderConnection,
    Error,
    { connection: ProviderConnection; patch: { active?: boolean; displayName?: string } }
  >({
    mutationFn: ({ connection, patch }) => setProviderConnection(connection, patch),
    onSuccess: invalidate,
  });
}

export function useDeleteProviderConnection() {
  const invalidate = useInvalidateProviders();
  return useMutation<void, Error, string>({
    mutationFn: (id) => deleteProviderConnection(id),
    // Settled, not success: a 404 means the row is already gone, so our copy
    // of the list is stale either way.
    onSettled: invalidate,
  });
}
