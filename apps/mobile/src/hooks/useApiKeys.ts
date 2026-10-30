/**
 * hooks/useApiKeys.ts — the workspace API-key list plus revoke.
 *
 * Online-only and never queued. A revoke that sits in an offline queue is worse
 * than no revoke at all: the operator believes a leaked key is dead while it is
 * still authenticating requests. If the device cannot reach the server, the
 * honest answer is "this hasn't happened yet".
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { listApiKeys, revokeApiKey, type ApiKeySummary } from "@/api/apiKeys";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";

export type { ApiKeySummary } from "@/api/apiKeys";

const KEY = "api-keys";

export function useApiKeys() {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: [KEY, gate.tenantId],
    enabled: gate.enabled && Boolean(gate.tenantId),
    staleTime: 30_000,
    queryFn: (): Promise<ApiKeySummary[]> => listApiKeys(),
  });
}

export function useRevokeApiKey() {
  const gate = useOnlineQueryGate();
  const qc = useQueryClient();
  return useMutation<void, Error, string>({
    mutationFn: (id: string) => revokeApiKey(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: [KEY, gate.tenantId] });
    },
  });
}
