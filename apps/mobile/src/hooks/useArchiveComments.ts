/**
 * hooks/useArchiveComments.ts — the moderation queue read, an issue-title
 * lookup, and the four moderation verbs.
 *
 * WHY THE QUEUE IS NOT SNAPSHOT-BACKED, unlike the archive index next to it.
 * A cached moderation queue is a list of decisions you cannot make. Worse, it
 * is a list of decisions somebody else may already have made from a desk: the
 * rows would look actionable, every tap would fail, and the screen would have
 * spent its credibility on a list it could not act on. The queue therefore
 * uses the plain online gate and says "you're offline" instead.
 *
 * WHY NOTHING IS OPTIMISTIC. Every verb changes what is on a PUBLIC page. An
 * optimistic row that flips to "Hidden" and then rolls back has, for that
 * moment, told an operator that a spam comment is off their published issue
 * when it is still live. The list refetches instead — one request, and the
 * state shown is the state that is.
 *
 * WHY NOTHING IS QUEUED OFFLINE. Same reason, one step further out: a hide
 * released from a queue two hours later is two hours of the comment being
 * public, with a success toast already shown. None of these mutations is
 * registered in lib/offlineMutationContract, so lib/offlineMutations never
 * sees them.
 *
 * WHY A DECISION INVALIDATES EVERY FILTER. Moderating moves a row BETWEEN
 * tabs. Invalidating only the active one leaves Hidden short by the row that
 * just arrived there — which is exactly the tab the operator checks next when
 * they want to undo.
 */
import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  deleteArchiveComment,
  fetchArchiveComments,
  moderateArchiveComment,
  setArchiveCommentPinned,
} from "@/api/archiveComments";
import { useArchiveIssues } from "@/hooks/useArchiveOps";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import type {
  ArchiveCommentFilter,
  ArchiveCommentPage,
  ArchiveCommentStatus,
} from "@/lib/archiveCommentQueue";

const COMMENTS_KEY = "archive-comments";

/**
 * Short, but not a poll. Comments arrive from readers at reader pace, and two
 * teammates clearing the same wave is a real collision — but this is not a
 * live conversation and a phone on cellular should not treat it as one.
 */
const QUEUE_STALE_MS = 30_000;

export function archiveCommentsQueryKey(
  tenantId: string | null | undefined,
  filter: ArchiveCommentFilter,
): readonly unknown[] {
  return [COMMENTS_KEY, tenantId ?? null, filter];
}

export function useArchiveCommentQueue(filter: ArchiveCommentFilter) {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: archiveCommentsQueryKey(gate.tenantId, filter),
    enabled: gate.enabled && Boolean(gate.tenantId),
    staleTime: QUEUE_STALE_MS,
    queryFn: (): Promise<ArchiveCommentPage> => fetchArchiveComments(filter),
  });
}

/**
 * campaignId → issue subject, built from the archive index the Archive tab
 * already loads (so this is usually a cache hit, not a second round trip).
 *
 * The moderation projection carries no title at all, and the index is paged —
 * so this map covers the issues that have been fetched and no others.
 * `hasIndex` lets the screen say "titles didn't load" rather than let a
 * truncated UUID pass as the whole truth.
 */
export function useArchiveIssueTitles(): {
  titles: Map<string, string>;
  hasIndex: boolean;
} {
  const issues = useArchiveIssues();
  const pages = issues.data?.pages;
  return useMemo(() => {
    const titles = new Map<string, string>();
    // Array.isArray, not `?? []`: these pages can be restored from the offline
    // vault, which type-casts what it stored without checking its shape, and a
    // `for…of` over a non-iterable throws inside a render.
    for (const page of Array.isArray(pages) ? pages : []) {
      for (const issue of Array.isArray(page?.items) ? page.items : []) {
        if (issue.campaignId && issue.subject) {
          titles.set(issue.campaignId, issue.subject);
        }
      }
    }
    return { titles, hasIndex: Array.isArray(pages) && pages.length > 0 };
  }, [pages]);
}

function useQueueInvalidator() {
  const gate = useOnlineQueryGate();
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: [COMMENTS_KEY, gate.tenantId] });
  };
}

export interface ModerateCommentInput {
  id: string;
  status: ArchiveCommentStatus;
}

export function useModerateArchiveComment() {
  const invalidate = useQueueInvalidator();
  return useMutation<void, Error, ModerateCommentInput>({
    mutationFn: ({ id, status }) => moderateArchiveComment(id, status),
    onSuccess: invalidate,
  });
}

export interface PinCommentInput {
  id: string;
  pinned: boolean;
}

export function usePinArchiveComment() {
  const invalidate = useQueueInvalidator();
  return useMutation<void, Error, PinCommentInput>({
    mutationFn: ({ id, pinned }) => setArchiveCommentPinned(id, pinned),
    onSuccess: invalidate,
  });
}

export function useDeleteArchiveComment() {
  const invalidate = useQueueInvalidator();
  return useMutation<void, Error, { id: string }>({
    mutationFn: ({ id }) => deleteArchiveComment(id),
    onSuccess: invalidate,
  });
}
