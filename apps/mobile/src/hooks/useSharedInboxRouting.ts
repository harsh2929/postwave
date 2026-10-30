/**
 * useSharedInboxRouting — the share-extension inbox and the Siri/App-Intent
 * destination, extracted from the root layout (SHELL#78) and given the
 * acknowledgement the queue was missing (NATIVE#47).
 *
 * On launch and on every foreground while authenticated we take ONE item the
 * iOS share extension stashed in the App Group: a shared Moosewave entity link
 * opens that entity, a bare email opens Subscribers pre-searched for it.
 * Generic URLs and arbitrary text are rejected by both the extension and the
 * storage helper. All of it no-ops until the share target ships in the build.
 *
 * Why one at a time: each item NAVIGATES, and firing three pushes back to back
 * would leave the user somewhere they didn't ask for with two screens of
 * history they never saw. But draining one and saying nothing stranded the
 * rest silently — there was no reason to ever foreground the app again. So the
 * remainder is now offered explicitly, with the toast's own action as the way
 * through it. The queue is bounded at 8, so the count is always small, always
 * exact, and `null` (could not read the App Group) says nothing at all rather
 * than claiming zero.
 */
import { useCallback, useEffect } from "react";
import { AppState } from "react-native";

import { useToast } from "@/components/Toast";
import { useNavigateToHref } from "@/hooks/useNavigateTo";
import { takePendingRoute } from "@/lib/pendingRoute";
import {
  actionForSharedItem,
  pendingSharedInboxCount,
  restoreSharedInboxItem,
  takeSharedInboxItem,
} from "@/lib/sharedInbox";
import {
  SHARED_INBOX_NEXT_LABEL,
  sharedInboxRemainingNotice,
} from "@/lib/shellNotices";
import { useAuthStore } from "@/store/auth";

/**
 * Navigate to the newest actionable item. False when none is left.
 *
 * `navigate` replaces rather than pushes when the item resolves to the screen
 * already on top (SHELL#70): sharing the same subscriber twice is exactly the
 * repeat that used to stack two identical screens.
 *
 * CONSUMED IS NOT DELIVERED (NATIVE#47). `takeSharedInboxItem` commits the
 * queue rewrite BEFORE it hands the item back — deliberately, so a storage
 * fault can never replay a share it already processed — which means every path
 * out of this loop that is not "navigated" destroys user-initiated content.
 * Two of them should: a malformed entry and a non-actionable one are exactly
 * what the App Group is supposed to shed. The third should not, and now
 * doesn't.
 */
function openNextSharedItem(navigate: (href: unknown) => boolean): boolean {
  // Skip malformed/non-actionable entries, but consume at most one real
  // action so older shares remain queued for later.
  for (;;) {
    const item = takeSharedInboxItem();
    if (!item) return false;
    const action = actionForSharedItem(item);
    if (!action) continue;
    if (!navigate(action.href)) {
      // An actionable item we could not open. Put it back at the newest end —
      // `restoreSharedInboxItem` re-validates it against the SAME parser and
      // does NOT extend its TTL, so a restore can only ever return a live item
      // to the queue and the fifteen-minute window still bounds how long it
      // can be retried.
      //
      // STOP rather than `continue`: the next `takeSharedInboxItem()` would
      // pop the very item just restored and spin. Returning false leaves it
      // for the next foreground, which is the same cadence the queue already
      // drains on.
      restoreSharedInboxItem(item);
      return false;
    }
    return true;
  }
}

export function useSharedInboxRouting(): void {
  const { toast } = useToast();
  const navigate = useNavigateToHref();
  const hydrated = useAuthStore((s) => s.hydrated);
  const canEnterApp = useAuthStore((s) => s.canEnterApp());
  const openNext = useCallback(
    () => openNextSharedItem(navigate),
    [navigate],
  );

  useEffect(() => {
    if (!hydrated || !canEnterApp) return;

    function announceRemaining(): void {
      const message = sharedInboxRemainingNotice(pendingSharedInboxCount());
      if (!message) return;
      toast({
        message,
        kind: "info",
        action: {
          label: SHARED_INBOX_NEXT_LABEL,
          onPress: () => {
            if (openNext()) announceRemaining();
          },
        },
      });
    }

    function flush(): void {
      // An App Intent (Siri Shortcut) destination takes priority — the user
      // explicitly asked to land there this launch.
      const pending = takePendingRoute();
      if (pending) {
        // "Open Moosewave approvals" twice in a row is the same screen; a Siri
        // shortcut is a destination, not a history entry.
        navigate(pending);
        return;
      }
      if (openNext()) announceRemaining();
    }

    flush();
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active") flush();
    });
    return () => sub.remove();
  }, [hydrated, canEnterApp, toast, navigate, openNext]);
}
