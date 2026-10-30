// SPDX-License-Identifier: AGPL-3.0-only

import type { FetchNextPageOptions } from "@tanstack/react-query";

import { getOnlineStatus, type OnlineStatus } from "./online-manager";

export interface InfiniteQueryPageAction {
  readonly isEnabled: boolean;
  readonly hasNextPage: boolean;
  readonly isFetching: boolean;
  readonly isFetchingNextPage: boolean;
  readonly fetchNextPage: (options?: FetchNextPageOptions) => Promise<unknown>;
}

const activePageRequests = new WeakSet<
  InfiniteQueryPageAction["fetchNextPage"]
>();

/**
 * TanStack's imperative fetchNextPage bypasses `enabled`. Keep every manual
 * continuation behind the live connectivity, authority, cursor, and in-flight
 * state that the control claims to represent.
 */
export function canLoadNextQueryPage(
  query: InfiniteQueryPageAction,
  authorityReady: boolean,
  online: OnlineStatus = getOnlineStatus(),
): boolean {
  return Boolean(
    online === "online" &&
    authorityReady &&
    query.isEnabled &&
    query.hasNextPage &&
    !query.isFetching &&
    !query.isFetchingNextPage &&
    !activePageRequests.has(query.fetchNextPage),
  );
}

/**
 * Returns false without touching transport when a live precondition is gone.
 * `cancelRefetch: false` also prevents a double activation from cancelling and
 * replacing the first page request before React can publish its busy state.
 */
export async function loadNextQueryPage(
  query: InfiniteQueryPageAction,
  authorityReady: boolean,
): Promise<boolean> {
  if (!canLoadNextQueryPage(query, authorityReady)) return false;
  const operation = query.fetchNextPage;
  activePageRequests.add(operation);
  try {
    await query.fetchNextPage({ cancelRefetch: false });
    return true;
  } finally {
    activePageRequests.delete(operation);
  }
}
