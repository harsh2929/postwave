/**
 * useSubscriberTimeline — the subscriber detail's cursor-paginated timeline
 * read plus its derived projections, extracted verbatim from
 * app/(tabs)/subscribers/[id].tsx when that screen hit its function-size
 * budget. Behaviour is unchanged; the screen keeps paging POLICY (the
 * auto-page ceiling) and this hook owns the QUERY.
 *
 * Cursor-paginated with the API's opaque, composite event position so equal
 * timestamps cannot be skipped. The page param IS `pagination.next_cursor`
 * and is forwarded as `?cursor=` — see the note on timelinePath for why
 * `?before=` silently truncated the timeline.
 */
import { useMemo } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";

import type { SubscriberTimelineEvent } from "@/api/mobileParity";
import { fetchTimelinePage } from "@/api/subscriberTimeline";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { subscriberTimelineKey } from "@/lib/subscriberQueryKeys";

export function useSubscriberTimeline(id: string | undefined) {
  const onlineGate = useOnlineQueryGate();
  const timeline = useInfiniteQuery({
    queryKey: subscriberTimelineKey(onlineGate.tenantId, id),
    enabled: onlineGate.enabled && Boolean(onlineGate.tenantId && id),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => fetchTimelinePage(id!, pageParam),
    getNextPageParam: (last) => {
      if (!last.ok || !last.page?.pagination?.has_more) return undefined;
      return last.page.pagination.next_cursor || undefined;
    },
  });

  const firstPage = timeline.data?.pages[0];
  const unavailable = Boolean(firstPage?.unavailable);
  const timelineFailed = Boolean(
    firstPage && !firstPage.ok && !firstPage.unavailable,
  );
  const stats = firstPage?.page?.stats;
  const loadedPages = Array.isArray(timeline.data?.pages)
    ? timeline.data.pages.length
    : 0;

  const events = useMemo(() => {
    const rows: SubscriberTimelineEvent[] = [];
    for (const page of Array.isArray(timeline.data?.pages)
      ? timeline.data.pages
      : []) {
      if (page.page?.events?.length) rows.push(...page.page.events);
    }
    return rows;
  }, [timeline.data?.pages]);

  return { timeline, unavailable, timelineFailed, stats, loadedPages, events };
}
