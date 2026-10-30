/**
 * notification-feed-sync — makes desktop's bell agree with the server feed.
 *
 * Desktop was the only client with a private notification store. Web
 * (`lib/notification-feed-api.ts`) and mobile (`api/notifications.ts`) both read
 * `GET /api/v1/notifications`; desktop kept an encrypted local vault and never
 * called the endpoint, so read/unread was three separate truths: marking
 * something read on a phone left it bold here, and "mark all read" here meant
 * nothing anywhere else.
 *
 * WHY SYNC RATHER THAN REPLACE
 *
 * The obvious move — render the server feed directly in the panel — throws away
 * things the server does not model and that are genuinely per-machine: whether
 * THIS Mac actually showed an OS banner, whether it was suppressed by quiet
 * hours, the archive state, the notification preferences. Those belong to the
 * vault. So the vault stays the render source and this module keeps the two
 * halves in agreement:
 *
 *   PULL  server-read entries become read locally (`applyServerReadState`)
 *   PUSH  locally-read entries the server has not seen are posted up
 *
 * Read state only ever moves toward READ. A sync that could un-read something
 * would let one device silently undo another's decision, and "it came back"
 * is exactly the bug that makes people stop trusting a synced inbox.
 *
 * The correlation and cutover rules are pure and unit-tested in
 * `notification-feed-reconcile.ts`; this file owns scheduling and identity.
 */

import { useEffect } from "react";

import {
  applyServerReadState,
  getNotificationCenterSnapshot,
  setNotificationReadPropagator,
  subscribeNotificationCenter,
  type NotificationCenterEntry,
} from "./notification-center";
import {
  fetchNotificationFeed,
  markFeedAllRead,
  markFeedRead,
} from "./notification-feed-api";
import {
  correlationKey,
  indexServerItems,
  readMarkersToPushUp,
  serverReadKeys,
  unifiedNotificationRows,
  type ServerFeedItem,
} from "./notification-feed-reconcile";
import {
  clearNotificationInbox,
  setNotificationInbox,
} from "./notification-inbox-store";
import { useEventSubscription } from "./event-bus";
import { setServerNotificationReadSink } from "./notification-navigation";

/**
 * Whether the vault OPEN that is currently in effect has been synced.
 *
 * Deliberately not a per-user key: the notification center does not expose its
 * identity, only an `identity` phase. What makes this correct is the
 * TRANSITION — `configureNotificationCenterIdentity` moves the snapshot through
 * a non-`ready` phase on every workspace switch and sign-out, and the
 * subscriber below clears this flag whenever it observes that. So each vault
 * open reconciles exactly once, and user B never inherits user A's "done".
 *
 * An earlier version stored the literal string `"ready"` in a variable named
 * `syncedIdentity` and claimed in its comment to be identity-keyed. It was not;
 * the comment described a guarantee the code did not provide.
 */
let syncedCurrentVaultOpen = false;

/**
 * Bumped every time the vault leaves `ready` (sign-out, workspace switch).
 *
 * A sync pass captures this before its first `await` and bails if it changed.
 * Without it, a pass that started as user A and resolved as user B published
 * A's decrypted titles into the store B's panel renders, and drove A's read
 * markers against B's vault. `clearNotificationInbox()` in the subscriber does
 * NOT cover that: it fires at the A→loading transition, which is BEFORE the
 * in-flight request resolves.
 */
let vaultOpenGeneration = 0;

export function resetNotificationFeedSyncForTests(): void {
  syncedCurrentVaultOpen = false;
  vaultOpenGeneration += 1;
  clearNotificationInbox();
  lastFeed = [];
  inFlight = null;
  rerunRequested = false;
}

/**
 * The most recent feed snapshot, so a per-row action does not have to re-read
 * 50 rows to resolve one id.
 */
let lastFeed: readonly ServerFeedItem[] = [];

/**
 * In-flight sync, so a fanout burst produces ONE feed read instead of one per
 * event. `notification.created` arrives once per notification per recipient; a
 * bulk send to a busy workspace would otherwise issue a full
 * `GET /api/v1/notifications?limit=50` for each, all racing each other's
 * `applyServerReadState`.
 */
let inFlight: Promise<void> | null = null;
let rerunRequested = false;

/**
 * One sync pass, coalesced. Safe to call repeatedly: the pull is idempotent
 * (read is monotonic) and the push skips anything the server already has read.
 * A call made while a pass is running joins it and schedules exactly one
 * trailing re-run, so the last event in a burst is never lost.
 */
export function syncNotificationFeed(): Promise<void> {
  if (inFlight) {
    rerunRequested = true;
    return inFlight;
  }
  inFlight = runSyncPass().finally(() => {
    inFlight = null;
    if (rerunRequested) {
      rerunRequested = false;
      void syncNotificationFeed();
    }
  });
  return inFlight;
}

async function runSyncPass(): Promise<void> {
  const generation = vaultOpenGeneration;
  const local = getNotificationCenterSnapshot();
  // The vault is identity-scoped and encrypted; before it opens there is
  // nothing to reconcile and no identity to key on.
  if (local.identity !== "ready") return;

  const result = await fetchNotificationFeed();
  // The identity may have changed while this request was in flight. Everything
  // below writes A's data into whatever vault is open NOW.
  if (generation !== vaultOpenGeneration) return;
  if (!result.ok) {
    // A failed READ must not render as an empty inbox — "you're all caught up"
    // is a lie when the request 500'd. Keep the rows we have and say so.
    // Re-read rather than reusing the pre-await snapshot, for the same reason.
    const current = getNotificationCenterSnapshot();
    if (current.identity !== "ready") return;
    setNotificationInbox({
      status: "error",
      rows: unifiedNotificationRows({
        server: lastFeed,
        local: current.entries,
      }),
    });
    return;
  }
  lastFeed = result.feed.items;

  // PULL: adopt read state other devices already set.
  const readKeys = serverReadKeys(result.feed.items);
  applyServerReadState((entry) => {
    const correlation = correlationKey.forLocal(entry);
    // Weak keys are refused: acting on one could mark an unrelated
    // notification read.
    return correlation?.strong === true && readKeys.has(correlation.key);
  });

  // PUSH: carry this machine's pre-existing read markers up, once. Without it,
  // the first launch after adopting the feed shows every already-read
  // notification as unread again.
  const ids = readMarkersToPushUp({
    server: result.feed.items,
    local: getNotificationCenterSnapshot().entries,
  });
  await Promise.all(ids.map((id) => markFeedRead(id)));
  if (generation !== vaultOpenGeneration) return;

  // Publish AFTER the push, so the rows reflect the reconciled state rather
  // than the pre-push one.
  publishInbox();
}

/**
 * Keep the vault in agreement with the server for the lifetime of the session.
 *
 * Runs when the vault opens (or changes identity) and again on every
 * `notification.created` fanout, which is the same SSE event web and mobile use
 * to make their bells realtime — desktop already subscribes to it via
 * `cache-invalidator.ts`.
 */
/** Recompute the rendered rows from the last feed plus current vault state. */
function publishInbox(): void {
  const local = getNotificationCenterSnapshot();
  if (local.identity !== "ready") return;
  setNotificationInbox({
    status: "synced",
    rows: unifiedNotificationRows({ server: lastFeed, local: local.entries }),
  });
}

export function useNotificationFeedSync(): void {
  useEffect(() => {
    // Local reads reach the server through the vault, not through the panel:
    // the propagation path needs the API client and would otherwise pull the
    // whole module graph into every component that renders a notification.
    setNotificationReadPropagator(notificationReadPropagator);
    setServerNotificationReadSink(
      (serverId) => void markServerRowRead(serverId),
    );
    return () => {
      setNotificationReadPropagator(null);
      setServerNotificationReadSink(null);
    };
  }, []);

  useEffect(() => {
    const run = (): void => {
      const local = getNotificationCenterSnapshot();
      if (local.identity !== "ready") return;
      if (syncedCurrentVaultOpen) return;
      syncedCurrentVaultOpen = true;
      void syncNotificationFeed();
    };
    run();
    return subscribeNotificationCenter(() => {
      const local = getNotificationCenterSnapshot();
      if (local.identity !== "ready") {
        // Vault closed or re-opening (sign-out / workspace switch): forget the
        // sync so the next identity reconciles its own state rather than
        // inheriting this one's. Also drop the cached feed, which belongs to
        // the identity that is going away.
        syncedCurrentVaultOpen = false;
        vaultOpenGeneration += 1;
        lastFeed = [];
        clearNotificationInbox();
        return;
      }
      run();
      // The vault owns delivery + archive, so a local change must re-render
      // the merged rows without another network read.
      publishInbox();
    });
  }, []);

  // A server-authored notification means the feed changed; re-pull so a read
  // performed elsewhere lands here without waiting for a restart.
  useEventSubscription("notification.*", () => {
    void syncNotificationFeed();
  });
}

/**
 * Carry a LOCAL read up to the server, so the same notification is not still
 * bold on the user's other devices.
 *
 * Both calls are fire-and-forget: the local vault has already recorded the read
 * and re-rendered, so a failed POST costs one out-of-sync row until the next
 * sync pass — never a visible error on an action the user has already seen
 * succeed.
 *
 * `one()` correlates the vault entry to its server row, because the vault's ids
 * are content-derived and the API only accepts server ids.
 */
export const notificationReadPropagator = {
  one(entry: NotificationCenterEntry): void {
    void propagateOne(entry);
  },
  all(): void {
    void (async () => {
      if (await markFeedAllRead()) {
        // Re-read so correlated and server-only rows lose their unread marker
        // too. Without this "Mark all read" cleared the vault, left every
        // cross-device row bold, and the button never went away.
        await syncNotificationFeed();
      }
    })();
  },
};

/**
 * Mark a SERVER row read. Server-only rows have no vault entry, so nothing else
 * in the read path can clear them — and they are the DOMINANT row type: only a
 * couple of the server's notification producers emit an entity-bearing URL, so
 * most rows correlate weakly and stay `source: "server"`.
 */
export async function markServerRowRead(serverId: string): Promise<void> {
  if (!serverId) return;
  if (await markFeedRead(serverId)) await syncNotificationFeed();
}

async function propagateOne(entry: NotificationCenterEntry): Promise<void> {
  {
    {
      const correlation = correlationKey.forLocal(entry);
      // A weak key collides by construction, so acting on it could mark a
      // notification the user never opened.
      if (!correlation?.strong) return;
      // Reuse the snapshot the sync pass already holds. Re-reading 50 rows on
      // every notification click was both wasteful and wrong: it silently
      // no-opped for anything outside the newest 50 while the vault keeps up
      // to 200 entries over 90 days.
      const match = indexServerItems(lastFeed).get(correlation.key);
      if (match) {
        // Present in the snapshot: mark it unless the server already has.
        if (!match.read_at) await markFeedRead(match.id);
        return;
      }
      // Not in the snapshot — refresh once, then look again. Anything still
      // absent is local-only (a desktop dashboard anomaly the server never
      // issued) and has no server row to mark.
      await syncNotificationFeed();
      const refreshed = indexServerItems(lastFeed).get(correlation.key);
      if (refreshed && !refreshed.read_at) await markFeedRead(refreshed.id);
    }
  }
}

/**
 * Invisible mount point. Rendered once inside the shell, next to the cache
 * invalidator; returns null and exists only to hold the subscription.
 */
export function NotificationFeedSync(): null {
  useNotificationFeedSync();
  return null;
}
