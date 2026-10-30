/**
 * QueryStates — one place that decides which of the five states a data-backed
 * screen is in, and renders the right thing for it.
 *
 * Every list screen in the app reimplements this ladder, and they do not agree.
 * Auditing them turned up all of these variants:
 *   - `isLoading ? <ActivityIndicator/> : rows.length ? <List/> : <EmptyState/>`
 *     — which renders "Nothing here yet" for a FAILED fetch, telling the user
 *     their data is gone when the request merely errored;
 *   - screens that check `isError` but not the offline case, so an airplane-mode
 *     user gets "Something went wrong" instead of "you're offline";
 *   - screens that show a spinner on every background refetch, so pull-to-
 *     refresh blanks the content the user was reading.
 *
 * The correct order — and the one enforced here:
 *
 *   1. ERROR wins over empty. A failed load is never "nothing here".
 *   2. OFFLINE-with-no-cache is its own state, distinct from an error: nothing
 *      is broken, the device just cannot reach the server. That is either a
 *      closed gate, or a first fetch TanStack PAUSED for want of a connection
 *      (`isPending && isPaused`) — the gate is auth state, not reachability,
 *      so a validated session that lost signal keeps it open.
 *   3. FIRST LOAD shows a skeleton. Background refetch does NOT — content the
 *      user is already reading must not be replaced by a placeholder.
 *   4. EMPTY only when the fetch genuinely succeeded and returned nothing.
 *   5. Otherwise: the content.
 *
 * Usage:
 *   <QueryStates
 *     query={tags}
 *     isEmpty={rows.length === 0}
 *     gate={gate}
 *     empty={{ title: "No tags yet", description: "..." }}
 *     skeleton={<SkeletonList rows={6} />}
 *   >
 *     {rows.map(...)}
 *   </QueryStates>
 */
import type { ReactNode } from "react";
import { View } from "react-native";

import type { EmptyStateContent } from "@postwave/onboarding-schema";

import { EmptyState } from "@/components/EmptyState";
import { ErrorState } from "@/components/ErrorState";
import { SkeletonList } from "@/components/Skeleton";
import type { OnlineQueryGate } from "@/hooks/useOnlineQueryGate";

/**
 * The slice of a TanStack query this component needs. Declared structurally
 * rather than importing `UseQueryResult` so callers can pass a hand-rolled
 * object (several screens compose two queries into one state). A hand-rolled
 * object must forward `isPending` and `isPaused`: without them a paused first
 * fetch reads as a genuine empty (src/lib/offlineEmptyStateGate.test.ts).
 */
export interface QueryLike {
  isError: boolean;
  isLoading: boolean;
  /** True while ANY fetch is in flight, including background refetches. */
  isFetching?: boolean;
  /** True once the query has produced data at least once. */
  isSuccess?: boolean;
  /** True until the query has produced data or an error (TanStack v5). */
  isPending?: boolean;
  /** True while a fetch is held back because the device has no connection. */
  isPaused?: boolean;
  error?: unknown;
  refetch?: () => unknown;
}

const OFFLINE_NOTHING_CACHED =
  "You're offline and this hasn't been cached yet. It'll load when you reconnect.";

/**
 * A first fetch TanStack PAUSED for want of a connection: nothing has ever
 * arrived (`isPending`) and nothing is in flight (`isPaused`). v5's isLoading
 * is `isPending && isFetching`, so this state is neither loading nor failed,
 * and a screen that checks only those two claims a zero the server never
 * gave — in its empty copy, and in any counter above it. Screens that derive
 * their own header counts treat this as unknown, exactly like a closed gate.
 */
export function isPausedFirstFetch(
  query: Pick<QueryLike, "isPending" | "isPaused">,
): boolean {
  return query.isPending === true && query.isPaused === true;
}

/**
 * Empty copy is deliberately a discriminated union: a caller either keeps the
 * compact, local title/description/action grammar or opts into the complete
 * shared rich-empty-state model. Mixing both would be misleading because
 * EmptyState intentionally ignores the bare fields whenever `content` exists.
 */
export type QueryEmptyState =
  | {
      content: EmptyStateContent;
      title?: never;
      description?: never;
      cta?: never;
    }
  | {
      content?: undefined;
      title: string;
      description?: string;
      cta?: { label: string; onPress: () => void };
    };

export interface QueryStatesProps {
  query: QueryLike;
  /** Whether the (successfully loaded) result set is empty. */
  isEmpty: boolean;
  children: ReactNode;
  /** Online/auth gate — lets the offline case render its own message. */
  gate?: Pick<OnlineQueryGate, "enabled"> | undefined;
  empty?: QueryEmptyState | undefined;
  /** Override the default skeleton with one shaped like this screen. */
  skeleton?: ReactNode;
  /** Message for the offline-and-nothing-cached case. */
  offlineMessage?: string;
}

export function QueryStates({
  query,
  isEmpty,
  children,
  gate,
  empty,
  skeleton,
  offlineMessage,
}: QueryStatesProps) {
  // 1. An error is never an empty state.
  if (query.isError) {
    return (
      <ErrorState
        error={query.error}
        {...(query.refetch ? { onRetry: () => void query.refetch?.() } : {})}
      />
    );
  }

  // 2. Offline with nothing cached is its own message: nothing is broken.
  //    A paused FIRST fetch counts: it is pending, not loading (v5's isLoading
  //    is isPending && isFetching), so it would otherwise fall through to the
  //    empty copy and claim a zero the server never gave.
  const gateClosed = gate !== undefined && !gate.enabled;
  if ((gateClosed || isPausedFirstFetch(query)) && isEmpty) {
    return <ErrorState message={offlineMessage ?? OFFLINE_NOTHING_CACHED} />;
  }

  // 3. Skeleton on FIRST load only. `isLoading` is already "pending and has
  //    never resolved" in TanStack v5, so a background refetch keeps content.
  if (query.isLoading && isEmpty) {
    return <View>{skeleton ?? <SkeletonList rows={5} />}</View>;
  }

  // 4. Genuinely nothing to show.
  if (isEmpty) {
    if (empty?.content) {
      return <EmptyState content={empty.content} />;
    }
    return (
      <EmptyState
        title={empty?.title ?? "Nothing here yet"}
        {...(empty?.description ? { description: empty.description } : {})}
        {...(empty?.cta ? { cta: empty.cta } : {})}
      />
    );
  }

  return <>{children}</>;
}
