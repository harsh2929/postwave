/**
 * hooks/useReviews.ts — the queue read, the detail read, and the three
 * moderation verbs.
 *
 * WHY THE DETAIL READ EXISTS AS A SEPARATE QUERY. `Repo.ListReviews` selects
 * the review columns only; `Repo.GetReview` additionally runs `listRepliesTx`.
 * So "has this already been answered?" is unanswerable from the list, and the
 * reply sheet has to fetch the single review before it can show the thread.
 * Rendering the list row's `replies: null` as "no replies yet" would be a
 * fabricated fact.
 *
 * WHY NOTHING IS OPTIMISTIC. Approving publishes a stranger's words to a public
 * storefront and recomputes a product's average rating. An optimistic row that
 * flips to "Published" and then rolls back has, for that moment, told the
 * operator that something is live on their store when it is not. The queue
 * refetches instead — one request, and the state shown is the state that is.
 *
 * WHY NOTHING IS QUEUED OFFLINE. Moderation is a judgement about content that
 * may itself change (a review can be edited upstream by the provider
 * integrations in apps/api/internal/review_integrations), and a public reply
 * released from a queue hours later lands with no context. Both mutations are
 * online-only by construction: they are never registered in
 * lib/offlineMutationContract, so the queue in lib/offlineMutations never sees
 * them.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  fetchReview,
  fetchReviews,
  moderateReview,
  replyToReview,
  setReviewFeatured,
} from "@/api/reviews";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import type {
  MobileReview,
  MobileReviewReply,
  ReviewQueueFilter,
} from "@/lib/reviewQueue";

const REVIEWS_KEY = "reviews";
const REVIEW_DETAIL_KEY = "review-detail";

/**
 * Moderation decisions arrive from teammates and from provider ingest, so a
 * stale queue can hand two people the same review. Short, but not a poll:
 * a moderation queue is not a live conversation.
 */
const QUEUE_STALE_MS = 30_000;

export function reviewsQueryKey(
  tenantId: string | null | undefined,
  filter: ReviewQueueFilter,
): readonly unknown[] {
  return [REVIEWS_KEY, tenantId ?? null, filter];
}

export function useReviewQueue(filter: ReviewQueueFilter) {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: reviewsQueryKey(gate.tenantId, filter),
    enabled: gate.enabled && Boolean(gate.tenantId),
    staleTime: QUEUE_STALE_MS,
    queryFn: (): Promise<MobileReview[]> => fetchReviews(filter),
  });
}

/**
 * The single-review read, used by the detail sheet. `staleTime: 0` because the
 * sheet is opened immediately before a public, irreversible action — the whole
 * point of opening it is that what you are reading is current.
 */
export function useReviewDetail(id: string | null) {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: [REVIEW_DETAIL_KEY, gate.tenantId, id ?? null],
    enabled: gate.enabled && Boolean(gate.tenantId) && Boolean(id),
    staleTime: 0,
    queryFn: (): Promise<MobileReview | null> => fetchReview(id!),
  });
}

export interface ModerationInput {
  id: string;
  decision: "approve" | "reject";
}

export function useModerateReview() {
  const gate = useOnlineQueryGate();
  const qc = useQueryClient();
  return useMutation<MobileReview | null, Error, ModerationInput>({
    mutationFn: ({ id, decision }) => moderateReview(id, decision),
    onSuccess: (_result, variables) => {
      // A decision moves the row BETWEEN filters, so every filter's cache is
      // now wrong — invalidating only the active one leaves "Published" short
      // by the row that just arrived there.
      void qc.invalidateQueries({ queryKey: [REVIEWS_KEY, gate.tenantId] });
      void qc.invalidateQueries({
        queryKey: [REVIEW_DETAIL_KEY, gate.tenantId, variables.id],
      });
    },
  });
}

/**
 * The merchandising flag. Same shape as moderation: not optimistic (the row
 * decorates a public storefront) and never queued offline. The api function
 * round-trips the raw record because the PATCH replaces every column.
 */
export function useSetReviewFeatured() {
  const gate = useOnlineQueryGate();
  const qc = useQueryClient();
  return useMutation<
    MobileReview | null,
    Error,
    { id: string; featured: boolean }
  >({
    mutationFn: ({ id, featured }) => setReviewFeatured(id, featured),
    onSuccess: (_result, variables) => {
      // The list rows render the flag too, so both reads refresh.
      void qc.invalidateQueries({ queryKey: [REVIEWS_KEY, gate.tenantId] });
      void qc.invalidateQueries({
        queryKey: [REVIEW_DETAIL_KEY, gate.tenantId, variables.id],
      });
    },
  });
}

export interface ReplyInput {
  id: string;
  body: string;
}

export function useReplyToReview() {
  const gate = useOnlineQueryGate();
  const qc = useQueryClient();
  return useMutation<MobileReviewReply | null, Error, ReplyInput>({
    mutationFn: ({ id, body }) => replyToReview(id, body),
    onSuccess: (_result, variables) => {
      // Only the detail read carries replies, so only it needs refreshing —
      // the list rows are unchanged by a reply.
      void qc.invalidateQueries({
        queryKey: [REVIEW_DETAIL_KEY, gate.tenantId, variables.id],
      });
    },
  });
}
