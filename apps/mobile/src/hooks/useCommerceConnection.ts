/**
 * hooks/useCommerceConnection.ts — TanStack layer for the two store-connection
 * writes. Parsing and policy live in lib/commerceConnection (pure, tested).
 *
 * Neither mutation is optimistic. Pause answers with the row the server now
 * holds and Disconnect answers with what the server actually cleaned up; in
 * both cases the invalidation is what makes the list tell the truth, and a
 * card flipped ahead of the response would be asserting an outcome it has
 * not received.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";

import {
  disconnectCommerceStore,
  pauseCommerceStore,
} from "@/api/commerceConnection";
import type { DisconnectOutcome } from "@/lib/commerceConnection";
import type { CommerceStore } from "@/lib/commerceRollup";

/** The list key `useCommerceStores` uses, minus the tenant segment. */
const STORES_KEY = ["commerce", "stores"] as const;

export function usePauseCommerceStore() {
  const client = useQueryClient();
  return useMutation<CommerceStore | null, unknown, string>({
    mutationFn: (integrationId: string) => pauseCommerceStore(integrationId),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: STORES_KEY });
    },
  });
}

export function useDisconnectCommerceStore() {
  const client = useQueryClient();
  return useMutation<DisconnectOutcome, unknown, string>({
    mutationFn: (integrationId: string) =>
      disconnectCommerceStore(integrationId),
    // Only the list: a disconnect changes the row's status, and the server
    // keeps every imported customer, product and order (handlers.go:424), so
    // the analytics, orders and recovery caches for the store stay true.
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: STORES_KEY });
    },
  });
}
