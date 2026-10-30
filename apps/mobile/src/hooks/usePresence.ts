/**
 * hooks/usePresence.ts — "who else is here", for React.
 *
 * Two scopes, two costs:
 *
 *   useWorkspacePresence()  — free. It reads lib/presenceStore, which is fed
 *     by the ONE connection lib/eventCacheSync already holds open. No socket,
 *     no query, no poll. Safe to mount anywhere, including on a tab bar.
 *
 *   useEntityPresence(ref)  — opens a SECOND, `?entity=`-scoped subscription
 *     for as long as it is mounted, because that is how the server learns this
 *     connection is viewing that record (apps/api/internal/events/handler.go
 *     reads `?entity=` off the subscription itself; there is no separate
 *     "join" call). That is a real radio cost on a phone, so mount it on a
 *     detail screen and nowhere else, and pass a falsy ref to stay off.
 *
 * Neither is a react-query hook and neither takes `useOnlineQueryGate`: there
 * is no cache to poison and no request to gate. The transport already refuses
 * to dial while offline (`isProbablyOnline`) and reconnects on its own.
 *
 * ── WHAT IS MOUNTED, AND WHAT IS NOT ──────────────────────────────────────
 * `useWorkspacePresence` is live: components/PresenceBar renders it on
 * app/(tabs)/dashboard.tsx.
 *
 * `useEntityPresence` is REACHED (PresenceBar calls it on every render) but is
 * never handed a ref in production, so the `?entity=` subscription never
 * opens. That is a decision, not an oversight, and it is recorded here rather
 * than left for the next reader to rediscover:
 *
 *   - Workspace scope is free — it rides the socket eventCacheSync already
 *     holds. Record scope is a SECOND socket, held for as long as a detail
 *     screen is open, with its own stream-token mint on every reconnect. On a
 *     phone that is a real radio cost.
 *   - What it would buy is small: presence is advisory and is never a lock, so
 *     the record-scoped list would not change what a user is allowed to do —
 *     only warn them. Desktop and web can afford that warning; a phone paying
 *     a second connection for it is a worse trade.
 *   - So workspace scope is the right FIRST step. The entity path stays built
 *     and unit-tested (lib/presence.presenceEntityRefFor + this hook) so that
 *     wiring a detail screen later is a one-prop change rather than a rewrite,
 *     and `presenceEntityRefFor` is the ref grammar to use when that happens.
 */
import { useEffect, useMemo, useState } from "react";

import { connectEventBus } from "@/api/eventBus";
import {
  EMPTY_PRESENCE,
  excludeSelf,
  parsePresencePayload,
  presenceEntityRef,
  PRESENCE_ENTITY_TOPIC,
  type PresenceSnapshot,
} from "@/lib/presence";
import { useWorkspacePresence as useWorkspacePresenceStore } from "@/lib/presenceStore";
import { useAuthStore } from "@/store/auth";

/**
 * Presence across the whole workspace, with our own connection removed.
 *
 * Self-exclusion matters more on mobile than anywhere else: the server counts
 * CONNECTIONS, and the phone is always one of them, so an unfiltered chip
 * would read "1 other here" on a workspace where nobody else is signed in.
 */
export function useWorkspacePresence(): PresenceSnapshot {
  const snapshot = useWorkspacePresenceStore();
  const selfUserId = useAuthStore((s) => s.session?.userId ?? null);
  return useMemo(
    () => excludeSelf(snapshot, selfUserId),
    [snapshot, selfUserId],
  );
}

/**
 * Presence for ONE record, e.g. `presenceEntityRefFor("campaign", id)`.
 *
 * A falsy ref disconnects and reports empty, so a screen can call this before
 * its data has loaded without a conditional hook.
 *
 * Gap recovery is deliberately NOT requested (`onBeforeTail` is omitted): a
 * replayed presence frame is a historical viewer list that would land on top
 * of the fresh snapshot the re-subscribe just produced. Web documents the same
 * trap for the same reason.
 */
export function useEntityPresence(
  entityRef: string | null | undefined,
): PresenceSnapshot {
  const [snapshot, setSnapshot] = useState<PresenceSnapshot>(EMPTY_PRESENCE);
  const selfUserId = useAuthStore((s) => s.session?.userId ?? null);

  useEffect(() => {
    if (!entityRef) {
      setSnapshot(EMPTY_PRESENCE);
      return;
    }
    // Clear on ref change: the previous record's viewers are not this one's,
    // and showing them until the first frame arrives is a lie with a latency.
    setSnapshot(EMPTY_PRESENCE);
    const stop = connectEventBus(
      [PRESENCE_ENTITY_TOPIC],
      (evt) => {
        if (evt.topic !== PRESENCE_ENTITY_TOPIC) return;
        // The topic is shared by every record in the tenant; the payload's
        // entity_ref is what makes it ours.
        if (presenceEntityRef(evt.payload) !== entityRef) return;
        const next = parsePresencePayload(evt.payload);
        if (next) setSnapshot(next);
      },
      undefined,
      { entity: entityRef },
    );
    return () => {
      stop();
      setSnapshot(EMPTY_PRESENCE);
    };
  }, [entityRef]);

  return useMemo(
    () => excludeSelf(snapshot, selfUserId),
    [snapshot, selfUserId],
  );
}
