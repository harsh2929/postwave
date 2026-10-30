/**
 * hooks/useCampaignFeedback.ts — the campaign review thread: read, post,
 * resolve.
 *
 * Mobile has had approvals (app/(tabs)/approvals/index.tsx) for a while, which means
 * a phone reviewer could approve or reject a send and never say WHY. This is
 * the other half: the sentence that turns a rejection into a fix.
 *
 * Both writes invalidate the list rather than patching it. The list is small
 * (a review thread, not a feed) and both endpoints return the mutated row
 * only — refetching is one cheap request and cannot drift, whereas splicing a
 * row into a cached array reproduces the server's partition rules in a second
 * place and gets them subtly wrong.
 *
 * The query is enabled only while the sheet is open, so a campaign screen does
 * not pay for a thread nobody asked to read.
 */
import { useCallback } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { rawRequest } from "@/api/request";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import {
  readFeedbackThread,
  type FeedbackListWire,
  type FeedbackThread,
} from "@/lib/campaignFeedback";

export interface CampaignFeedbackState {
  thread: FeedbackThread;
  loading: boolean;
  error: unknown;
  refetch: () => void;
  post: (body: string) => void;
  posting: boolean;
  postError: unknown;
  resolve: (feedbackId: string) => void;
  /** The comment currently being resolved, so only its row shows progress. */
  resolvingId: string | null;
  resolveError: unknown;
}

export function useCampaignFeedback(
  campaignId: string | undefined,
  options: { enabled: boolean },
): CampaignFeedbackState {
  const gate = useOnlineQueryGate();
  const queryClient = useQueryClient();
  const queryKey = ["campaign-feedback", gate.tenantId, campaignId];

  const q = useQuery({
    queryKey,
    enabled:
      options.enabled && gate.enabled && Boolean(gate.tenantId && campaignId),
    queryFn: async (): Promise<FeedbackThread> => {
      const res = await rawRequest<FeedbackListWire>(
        "GET",
        `/api/v1/campaigns/${encodeURIComponent(campaignId ?? "")}/feedback`,
      );
      if (res.error) throw res.error;
      return readFeedbackThread(res.data);
    },
  });

  // Not memoised: it is only ever read from a mutation's `onSuccess`, which
  // React Query re-reads from the latest options object on every settle. A
  // useCallback here would need the query key in its dependency list and would
  // buy nothing.
  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey });
  };

  const create = useMutation({
    mutationFn: async (body: string) => {
      const res = await rawRequest<unknown>(
        "POST",
        `/api/v1/campaigns/${encodeURIComponent(campaignId ?? "")}/feedback`,
        { body },
      );
      if (res.error) throw res.error;
      return res.data;
    },
    onSuccess: invalidate,
  });

  const resolveMutation = useMutation({
    mutationFn: async (feedbackId: string) => {
      const res = await rawRequest<unknown>(
        "POST",
        `/api/v1/campaigns/${encodeURIComponent(
          campaignId ?? "",
        )}/feedback/${encodeURIComponent(feedbackId)}/resolve`,
      );
      if (res.error) throw res.error;
      return res.data;
    },
    onSuccess: invalidate,
  });

  const post = useCallback((body: string) => create.mutate(body), [create]);
  const resolve = useCallback(
    (feedbackId: string) => resolveMutation.mutate(feedbackId),
    [resolveMutation],
  );
  const refetchQuery = q.refetch;
  const refetch = useCallback(() => void refetchQuery(), [refetchQuery]);

  return {
    thread: q.data ?? readFeedbackThread(null),
    loading: q.isLoading,
    error: q.error,
    refetch,
    post,
    posting: create.isPending,
    postError: create.error,
    resolve,
    resolvingId: resolveMutation.isPending
      ? (resolveMutation.variables ?? null)
      : null,
    resolveError: resolveMutation.error,
  };
}
