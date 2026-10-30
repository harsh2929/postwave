/**
 * useSubscriberProfileActions — every write the subscriber profile can make,
 * with its toast/undo/haptic story attached.
 *
 * Extracted from app/(tabs)/subscribers/[id].tsx so the screen stays a view
 * and the behaviours that matter (what Unsubscribe actually writes, whether
 * an Undo is honest) live in one reviewable place.
 *
 * Two rules encoded here:
 *
 *  - Unsubscribe writes the ENGINE status `blocklisted`, via
 *    `uiStatusToEngine("unsubscribed")`. Mobile used to write `disabled`,
 *    which is a DIFFERENT engine state from the one desktop and web write
 *    for the same button — so the same person unsubscribed on two clients
 *    ended up in two states.
 *  - These actions are reversible, so they run immediately and offer Undo
 *    rather than a pre-emptive confirm. Suppress writes a suppression row
 *    AND blocklists, so its Undo reverts both.
 *  - RESUBSCRIBE IS NOT HERE ANY MORE. Re-enabling creates a marketing
 *    permission, and desktop routes it through a consent review that records
 *    evidence. The phone now does the same: the screen opens
 *    ConsentEvidenceSheet and submits via useSubscriberResubscribeConsent,
 *    so a bare `status:"enabled"` PATCH with no envelope cannot be issued
 *    from this profile.
 */
import { useCallback } from "react";

import { useToast } from "@/components/Toast";
import {
  nextTagsAfterAdd,
  nextTagsAfterRemove,
  useSetSubscriberStatus,
  useSuppressSubscriber,
  useUnsuppressSubscriber,
  useUpdateSubscriberTags,
} from "@/hooks/useSubscribers";
import {
  trackSubscriberStatusChanged,
  trackSubscriberSuppressed,
  trackSubscriberTagged,
} from "@/lib/audienceTelemetry";
import { haptics } from "@/lib/haptics";
import { uiStatusToEngine, type EngineStatus } from "@/lib/subscriberStatus";

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : "";
}

export interface SubscriberProfileActions {
  suppressPending: boolean;
  statusPending: boolean;
  tagsPending: boolean;
  onSuppress: () => void;
  onUnsubscribe: () => void;
  onRemoveTag: (tag: string) => void;
}

export function useSubscriberProfileActions({
  id,
  email,
  currentStatus,
  currentTags,
  canMutate,
}: {
  id: string | undefined;
  email: string | undefined;
  /** Engine status as currently displayed (timeline stats win over the row). */
  currentStatus: string | undefined;
  currentTags: readonly string[] | undefined;
  canMutate: boolean;
}): SubscriberProfileActions {
  const { toast } = useToast();
  const suppress = useSuppressSubscriber();
  const unsuppress = useUnsuppressSubscriber();
  const setStatus = useSetSubscriberStatus();
  const updateTags = useUpdateSubscriberTags();

  const previousStatus: EngineStatus =
    uiStatusToEngine(currentStatus) ?? "enabled";

  const onSuppress = useCallback(() => {
    if (!canMutate || !id || !email) return;
    haptics.warning();
    suppress.mutate(id, {
      onSuccess: () => {
        haptics.success();
        trackSubscriberSuppressed("profile", "suppressed");
        // The profile stays mounted — the invalidated timeline re-drives the
        // status pill — so there is a receipt AND an undo window. It used to
        // navigate away silently.
        toast({
          kind: "success",
          message: `Suppressed ${email}`,
          action: {
            label: "Undo",
            onPress: () =>
              unsuppress.mutate(
                { id, email, restoreStatus: previousStatus },
                {
                  onSuccess: () =>
                    trackSubscriberSuppressed("profile", "undone"),
                  onError: (e: unknown) =>
                    toast({
                      kind: "error",
                      message: `Couldn't undo. ${errorText(e)}`.trim(),
                    }),
                },
              ),
          },
        });
      },
      onError: (e: unknown) => {
        haptics.error();
        toast({
          kind: "error",
          message: `Couldn't suppress. ${errorText(e)}`.trim(),
        });
      },
    });
  }, [canMutate, email, id, previousStatus, suppress, toast, unsuppress]);

  const changeStatus = useCallback(
    (next: EngineStatus, verb: string, undoTo?: EngineStatus) => {
      if (!canMutate || !id) return;
      haptics.warning();
      setStatus.mutate(
        { id, status: next },
        {
          onSuccess: () => {
            haptics.success();
            trackSubscriberStatusChanged(next);
            toast({
              kind: "success",
              message: verb,
              ...(undoTo && undoTo !== next
                ? {
                    action: {
                      label: "Undo",
                      // An UNDO that fails must say so. `useSetSubscriberStatus`
                      // rolls its optimistic patch back on error and reports
                      // nothing, so without this the toast dismisses, the pill
                      // flicks back, and the operator walks away believing the
                      // subscriber was restored when the consent state on the
                      // server never moved.
                      onPress: () =>
                        setStatus.mutate(
                          { id, status: undoTo },
                          {
                            onError: (e: unknown) => {
                              haptics.error();
                              toast({
                                kind: "error",
                                message:
                                  `Couldn't undo. ${errorText(e)}`.trim(),
                              });
                            },
                          },
                        ),
                    },
                  }
                : {}),
            });
          },
          onError: (e: unknown) => {
            haptics.error();
            toast({
              kind: "error",
              message: `${verb} failed. ${errorText(e)}`.trim(),
            });
          },
        },
      );
    },
    [canMutate, id, setStatus, toast],
  );

  const onUnsubscribe = useCallback(() => {
    changeStatus(uiStatusToEngine("unsubscribed")!, "Unsubscribed", previousStatus);
  }, [changeStatus, previousStatus]);

  const onRemoveTag = useCallback(
    (tag: string) => {
      if (!canMutate || !id) return;
      const next = nextTagsAfterRemove(currentTags, tag);
      if (next == null) return;
      updateTags.mutate(
        { id, tags: next },
        {
          onSuccess: () => {
            haptics.success();
            trackSubscriberTagged("removed", "profile");
            toast({
              kind: "info",
              message: `Removed "${tag}"`,
              action: {
                label: "Undo",
                // Same rule as the status undo above: a failed restore is
                // otherwise completely silent, and the tag stays removed.
                onPress: () =>
                  updateTags.mutate(
                    { id, tags: nextTagsAfterAdd(next, tag) ?? next },
                    {
                      onError: (e: unknown) => {
                        haptics.error();
                        toast({
                          kind: "error",
                          message:
                            `Couldn't put that tag back. ${errorText(e)}`.trim(),
                        });
                      },
                    },
                  ),
              },
            });
          },
          onError: (e: unknown) => {
            haptics.error();
            toast({
              kind: "error",
              message: `Couldn't remove that tag. ${errorText(e)}`.trim(),
            });
          },
        },
      );
    },
    [canMutate, currentTags, id, toast, updateTags],
  );

  return {
    suppressPending: suppress.isPending,
    statusPending: setStatus.isPending,
    tagsPending: updateTags.isPending,
    onSuppress,
    onUnsubscribe,
    onRemoveTag,
  };
}
