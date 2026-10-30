/**
 * lib/eventCacheSync.ts
 *
 * Opens the realtime event-bus and invalidates TanStack Query caches
 * live, as server events arrive — the connected-session complement to the
 * targeted reconnect refetch in lib/queryClient.ts.
 *
 * Lifecycle ownership: the root layout (app/_layout.tsx) starts this once
 * the user is authenticated and tears it down on logout / unmount. This module
 * owns three things the transport deliberately does not:
 *
 *   1. FOCUS GATING (NATIVE#10). `connectEventBus` only consults
 *      `isProbablyOnline()`, which stays true while the app is backgrounded, so
 *      the socket and its reconnect timers used to survive into the background
 *      — burning radio on Android and suspending into a half-open socket on
 *      iOS. We reuse the AppState listener lib/connectivity.ts already bridges
 *      into TanStack's `focusManager` rather than installing a second one.
 *
 *   2. GAP RECOVERY (NATIVE#8). Every open runs a bounded walk of
 *      `/api/v1/events/replay` from the last cursor before live frames are
 *      dispatched, so the five-minute server close, a backgrounded phone, and a
 *      tunnel no longer silently drop events.
 *
 *   3. HEALTH PUBLICATION (NATIVE#38). The transport's status callback was
 *      previously discarded; it now feeds lib/eventBusStatus.ts so the UI can
 *      distinguish "live" from "frozen ten minutes ago". The watchdog's stall
 *      signal rides the same path (`onStall`), so the diagnostics screen's
 *      stall counter is fed by the failure it exists to report.
 *
 *   4. PRESENCE (SHELL-036). The server has broadcast `presence.update` on
 *      every subscribe/unsubscribe since the desktop avatar stack landed, and
 *      this connection has been incrementing that counter — unread — since it
 *      was written. Subscribing to the topic HERE rather than from a second
 *      socket keeps presence free on a phone; the frames are routed to
 *      lib/presenceStore and never reach the invalidator, which has no
 *      query-key root for them. Live and replayed frames share ONE routing
 *      function (`routeEvent`) so the replay-refusal rule is a real branch
 *      with an observable consequence rather than a second, untestable copy
 *      of the topic check. It is read by components/PresenceBar on
 *      app/(tabs)/dashboard.tsx.
 */
import { focusManager } from "@tanstack/react-query";

import {
  connectEventBus,
  type MobileEventBusDisconnect,
  type MobileEventBusEvent,
} from "@/api/eventBus";
import { runEventReplay } from "@/api/eventReplay";
import {
  createDebouncedInvalidator,
  EVENT_INVALIDATION_TOPICS,
  type InvalidatingClient,
} from "@/api/event-cache-invalidation";
import {
  noteEventBusEvent,
  noteEventBusPause,
  noteEventBusReplay,
  noteEventBusStall,
  resetEventBusHealth,
  setEventBusStatus,
} from "@/lib/eventBusStatus";
import {
  createFocusGatedStream,
  type FocusGate,
} from "@/lib/eventStreamLifecycle";
import { PRESENCE_TOPIC } from "@/lib/presence";
import {
  applyWorkspacePresence,
  resetWorkspacePresence,
} from "@/lib/presenceStore";

const focusGate: FocusGate = {
  isFocused: () => focusManager.isFocused(),
  subscribe: (listener) =>
    focusManager.subscribe((focused) => listener(focused !== false)),
};

/**
 * startEventCacheSync — subscribe to the mapped domains and invalidate the
 * matching query-key roots on each event. Returns a disconnect fn that aborts
 * the stream, cancels pending debounces, and stops reconnecting.
 *
 * Invalidations are run through a debounce (per query-key root) so a live send
 * — which fires a burst of `subscriber.engagement_updated` events, one per
 * open/click — coalesces into a single refetch per affected root instead of a
 * refetch storm on cellular.
 *
 * `topics` and `focus` are overridable for tests; production callers should
 * omit them.
 */
export function startEventCacheSync(
  client: InvalidatingClient,
  topics: readonly string[] = EVENT_INVALIDATION_TOPICS,
  focus: FocusGate = focusGate,
): MobileEventBusDisconnect {
  const debounced = createDebouncedInvalidator(client);
  // Per-process replay cursor. `null` means "not yet known": the first walk is
  // pure discovery (no dispatch), because a cold start has just fetched every
  // visible query and there is no server endpoint reporting the log head.
  let cursor: number | null = null;

  /**
   * The ONE place a frame is routed, live or replayed.
   *
   * The two paths used to carry their own copy of the presence check, and the
   * replay copy was unfalsifiable: `presence.update` maps to zero query-key
   * roots (`canonicalResourcesForEvent` returns []), so pushing a replayed
   * presence frame at the invalidator and dropping it were indistinguishable
   * from outside. Routing both paths through here makes `replayed` the only
   * difference between them, so the rule below has an observable consequence
   * — deleting it lets a historical viewer list overwrite the live one, and
   * the test says so.
   *
   * The rule: a REPLAYED presence frame is a historical viewer list. "Who is
   * here now" has no gap to recover, and the replay walk runs immediately
   * before the tail — i.e. AFTER the re-subscribe has already produced a fresh
   * snapshot — so applying it would let the stale list win.
   */
  const routeEvent = (event: MobileEventBusEvent, replayed: boolean): void => {
    if (event.topic === PRESENCE_TOPIC) {
      // Never the invalidator: presence has no query-key root.
      if (!replayed) applyWorkspacePresence(event.payload);
      return;
    }
    debounced.push(event);
  };

  const replayGap = async (): Promise<void> => {
    const result = await runEventReplay({
      cursor,
      onEvent: (event) => {
        routeEvent(event, true);
      },
    });
    cursor = result.cursor;
    noteEventBusReplay({
      cursor: result.cursor,
      events: result.dispatched,
      reason: result.discovery ? `discovery:${result.reason}` : result.reason,
    });
  };

  const stop = createFocusGatedStream({
    focus,
    onPause: () => {
      debounced.cancel();
      noteEventBusPause();
      setEventBusStatus("closed");
      // The socket is gone, so our own row has left every other client's
      // stack. Keeping a viewer list we can no longer receive updates for is
      // the "wrong all-clear" presence must never give.
      resetWorkspacePresence();
    },
    connect: () =>
      connectEventBus(
        // Presence rides the connection that is already open rather than a
        // second socket; see lib/presenceStore for why.
        [...topics, PRESENCE_TOPIC],
        (evt) => {
          noteEventBusEvent();
          routeEvent(evt, false);
        },
        (status) => {
          setEventBusStatus(status);
        },
        { onBeforeTail: replayGap, onStall: noteEventBusStall },
      ),
  });

  return () => {
    debounced.cancel();
    stop();
    resetEventBusHealth();
    resetWorkspacePresence();
  };
}
