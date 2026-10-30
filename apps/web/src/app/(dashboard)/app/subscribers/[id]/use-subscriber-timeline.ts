// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useCallback, useMemo } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";

import { apiErrorMessage } from "@/lib/api";
import { loadNextQueryPage } from "@/lib/infinite-query-action";
import {
  getSubscriberTimeline,
  type SubscriberTimelineCategory,
  type SubscriberTimeline,
} from "@/lib/subscriber-timeline-api";
import { qk, STALE, type RoleKey } from "@/lib/query-keys";

import {
  createTimelineAttemptGate,
  mergeTimelinePages,
  nextTimelineCursor,
} from "./subscriber-detail-helpers";

export const SUBSCRIBER_TIMELINE_PAGE_SIZE = 50;

export function useSubscriberTimeline({
  enabled,
  id,
  role,
  tenantId,
  category,
}: {
  enabled: boolean;
  id: string;
  role: RoleKey;
  tenantId: string;
  category: SubscriberTimelineCategory;
}) {
  const timelineKey = useMemo(
    () =>
      [
        ...qk.subscriber(tenantId, role, id),
        "timeline",
        { limit: SUBSCRIBER_TIMELINE_PAGE_SIZE, category },
      ] as const,
    [category, id, role, tenantId],
  );
  const attemptGate = useMemo(createTimelineAttemptGate, []);
  const timelineQuery = useInfiniteQuery({
    queryKey: timelineKey,
    queryFn: ({ pageParam, signal }) =>
      getSubscriberTimeline(id, {
        cursor: pageParam,
        limit: SUBSCRIBER_TIMELINE_PAGE_SIZE,
        category,
        signal,
      }),
    enabled,
    // This surface owns explicit, context-preserving retry controls for both
    // the initial page and pagination. The shared client retries queries by
    // default; allowing that here can turn one Load more activation into a
    // second cursor request and silently skip the visible recovery state.
    retry: false,
    staleTime: STALE.detail,
    initialPageParam: undefined as string | undefined,
    getNextPageParam: nextTimelineCursor,
  });
  const timeline = useMemo<SubscriberTimeline | null>(
    () => mergeTimelinePages(timelineQuery.data?.pages),
    [timelineQuery.data],
  );
  const lastPage = timelineQuery.data?.pages?.at(-1);
  const missingNextCursor = Boolean(
    lastPage?.pagination.has_more && !lastPage.pagination.next_cursor?.trim(),
  );
  const loadMoreError = missingNextCursor
    ? timelineQuery.isRefetchError
      ? apiErrorMessage(
          timelineQuery.error,
          "Could not refresh the timeline cursor.",
        )
      : "More activity is available, but the timeline response did not include its next-page cursor."
    : timelineQuery.isFetchNextPageError
      ? apiErrorMessage(
          timelineQuery.error,
          "Could not load more timeline events.",
        )
      : null;
  const hasMore = Boolean(timelineQuery.hasNextPage || missingNextCursor);
  const loadingMore =
    timelineQuery.isFetchingNextPage ||
    (missingNextCursor && timelineQuery.isRefetching);

  const loadMore = useCallback(async (): Promise<void> => {
    if (!hasMore || loadingMore) return;
    const lastPage = timelineQuery.data?.pages?.at(-1);
    if (!lastPage) return;
    const cursor = nextTimelineCursor(lastPage);
    const release = attemptGate.begin(
      JSON.stringify([
        "timeline-page",
        id,
        category,
        cursor ?? "missing-cursor",
      ]),
    );
    if (!release) return;
    try {
      if (cursor) {
        // A synchronous gate handles same-tick activation; this option is the
        // second layer that keeps TanStack from cancelling/restarting a page.
        await loadNextQueryPage(timelineQuery, enabled);
      } else {
        // `has_more` without a cursor is a recoverable response-contract
        // failure: refresh the loaded pages instead of issuing `cursor=` or
        // silently hiding older activity.
        await timelineQuery.refetch({ cancelRefetch: false });
      }
    } catch {
      // The keyed observer exposes this through `isFetchNextPageError`.
    } finally {
      release();
    }
  }, [attemptGate, category, enabled, hasMore, id, loadingMore, timelineQuery]);

  return {
    hasMore,
    loadMore,
    loadMoreError,
    loadingMore,
    timeline,
    timelineKey,
    timelineQuery,
  };
}
