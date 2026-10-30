/**
 * D01#4: bridge the TanStack invalidation layer back to the seeded pages.
 *
 * Subscribers / Campaigns / Dashboard manage their own state via load() +
 * useState and only WRITE to the query cache (setQueryData — for the
 * persisted-IDB cold-boot paint). With no observer, `invalidateQueries()`
 * was a no-op, so the two things that ONLY signal through it were dead:
 *
 *   - the post-offline-REPLAY invalidation (invalidateQueriesForReplayed-
 *     Resources): a drain isn't a server SSE event, so nothing else told
 *     the list to refresh — it showed pre-replay data until manual reload;
 *   - the SSE AppCacheInvalidator for any key a page doesn't already have a
 *     direct event-bus reload for.
 *
 * This hook subscribes to the query cache and calls `reload()` whenever a
 * query whose key LEADS WITH `resourcePrefix` is invalidated. The qk.*
 * factories all lead with the resource string, matching the prefix the
 * invalidators pass (`invalidateQueries({ queryKey: [resource] })`).
 *
 * NOTE: the page must have a cache entry under that prefix (via setQueryData)
 * for invalidateQueries to match it and emit the event — so the seeding
 * write now has a genuine reader.
 */
import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";

export function useQueryInvalidationReload(
  resourcePrefix: string,
  reload: () => void,
): void {
  const queryClient = useQueryClient();
  // Keep the latest reload without re-subscribing on every render.
  const reloadRef = useRef(reload);
  reloadRef.current = reload;

  useEffect(() => {
    const cache = queryClient.getQueryCache();
    const unsubscribe = cache.subscribe((event) => {
      if (
        event.type === "updated" &&
        event.action.type === "invalidate" &&
        Array.isArray(event.query.queryKey) &&
        event.query.queryKey[0] === resourcePrefix
      ) {
        reloadRef.current();
      }
    });
    return unsubscribe;
  }, [queryClient, resourcePrefix]);
}
