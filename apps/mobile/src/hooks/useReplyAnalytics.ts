/**
 * hooks/useReplyAnalytics.ts — cache identity and gating for the three
 * workspace reply-intelligence reads behind the Analytics screen's Replies
 * section. Transport lives in api/replyAnalytics, parsing in
 * lib/replyAnalytics; this file decides only WHEN to ask and HOW LONG to keep
 * the answer.
 *
 * Keyed on the screen's reporting window (`days`), because unlike cohorts or
 * benchmarks these endpoints DO accept it — passing the window here is a
 * control the server honours (parseDays, reply_analytics.go:325).
 *
 * Staleness matches the rest of the analytics reads: windows are computed
 * over days, so re-running three aggregates every time the user scrolls back
 * to the tab would cost the API far more than it would tell the user.
 */
import { useQuery } from "@tanstack/react-query";

import {
  fetchReplySummary,
  fetchReplyTimeseries,
  fetchReplyTopSenders,
} from "@/api/replyAnalytics";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import type {
  ReplyPoint,
  ReplySummary,
  ReplyTopSender,
} from "@/lib/replyAnalytics";

const STALE_MS = 5 * 60_000;

/** `null` after a load = the deployment has no reply subsystem. */
export function useReplySummary(days: number) {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: ["reply-summary", gate.tenantId, days],
    enabled: gate.enabled && Boolean(gate.tenantId),
    staleTime: STALE_MS,
    queryFn: (): Promise<ReplySummary | null> => fetchReplySummary(days),
  });
}

export function useReplyTimeseries(days: number) {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: ["reply-timeseries", gate.tenantId, days],
    enabled: gate.enabled && Boolean(gate.tenantId),
    staleTime: STALE_MS,
    queryFn: (): Promise<ReplyPoint[]> => fetchReplyTimeseries(days),
  });
}

export function useReplyTopSenders(days: number) {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: ["reply-top-senders", gate.tenantId, days],
    enabled: gate.enabled && Boolean(gate.tenantId),
    staleTime: STALE_MS,
    queryFn: (): Promise<ReplyTopSender[]> => fetchReplyTopSenders(days),
  });
}
