/**
 * useSubscriberFederation — the SUB-023 identity-link list + link/unlink.
 * Writes are online-only (identity edits never queue) and settle by
 * invalidating this card's key — the links and the fresh subscriber_version
 * arrive together on the next read.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  createFederatedLink,
  deleteFederatedLink,
  listFederatedLinks,
} from "@/api/subscribersFederation";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { subscriberWriteKey, subscriberWriteQueue } from "@/lib/serialQueue";
import {
  parseFederationLinks,
  type FederationView,
} from "@/lib/subscriberFederation";

export function subscriberFederationKey(
  tenantId: string | null | undefined,
  subscriberId: string,
): readonly unknown[] {
  return ["subscriber-federation", tenantId ?? null, subscriberId];
}

export function useSubscriberFederation(
  subscriberId: string,
  enabled: boolean,
) {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: subscriberFederationKey(gate.tenantId, subscriberId),
    enabled: enabled && gate.enabled && Boolean(gate.tenantId && subscriberId),
    queryFn: async (): Promise<FederationView> =>
      parseFederationLinks(await listFederatedLinks(subscriberId)),
  });
}

export function useSubscriberFederationWrites(subscriberId: string) {
  const queryClient = useQueryClient();
  const { tenantId } = useOnlineQueryGate();

  const settle = () => {
    if (!tenantId) return;
    void queryClient.invalidateQueries({
      queryKey: subscriberFederationKey(tenantId, subscriberId),
    });
  };

  const link = useMutation({
    mutationFn: (input: { version: string; body: Record<string, string> }) =>
      subscriberWriteQueue(subscriberWriteKey(subscriberId), () =>
        createFederatedLink(subscriberId, input.version, input.body),
      ),
    onSettled: settle,
  });

  const unlink = useMutation({
    mutationFn: (input: { masterSubscriberId: string; version: string }) =>
      subscriberWriteQueue(subscriberWriteKey(subscriberId), () =>
        deleteFederatedLink(
          subscriberId,
          input.masterSubscriberId,
          input.version,
        ),
      ),
    onSettled: settle,
  });

  return { link, unlink };
}
