/**
 * hooks/useIngestSecrets.ts — list and revoke conversion-ingest signing keys.
 *
 * Both routes are admin (reviewed). Issuing is deliberately absent: it returns the
 * plaintext secret exactly once, which needs a capture ceremony this screen does
 * not have — see lib/ingestSecrets for why revoking is a different question.
 */
import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";

import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { type IngestSecretPage } from "@/lib/ingestSecrets";
import { listIngestSecrets, revokeIngestSecret } from "@/api/ingestSecrets";
import { canAccessMinimumRole } from "@/lib/mobileRouteManifest";

const KEY = "ingest-secrets";

export function useIngestSecrets() {
  const gate = useOnlineQueryGate();
  return useInfiniteQuery({
    queryKey: [KEY, gate.tenantId],
    enabled:
      gate.enabled &&
      Boolean(gate.tenantId) &&
      canAccessMinimumRole("admin", gate.effectiveRole),
    staleTime: 60_000,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }): Promise<IngestSecretPage> =>
      listIngestSecrets(pageParam),
    getNextPageParam: (lastPage) => lastPage.nextCursor,
  });
}

export function useRevokeIngestSecret() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: revokeIngestSecret,
    onSettled: () => void queryClient.invalidateQueries({ queryKey: [KEY] }),
  });
}
