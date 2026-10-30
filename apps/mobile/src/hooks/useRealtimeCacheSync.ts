/**
 * useRealtimeCacheSync — live cache invalidation while authenticated.
 *
 * Opens the realtime event bus and invalidates the matching TanStack Query
 * roots as server events arrive (campaign.* / subscriber.* / approval.*). This
 * is the connected-session complement to the targeted reconnect refetch in
 * `useAppBootstrap`: a teammate's change shows up without the local user
 * pulling to refresh.
 *
 * `startEventCacheSync` reuses the connectivity/AppState wiring (it pauses and
 * reconnects with the radio) and handles its own backoff, so this hook owns
 * only the start/stop lifecycle. Gated on auth because the stream-token
 * endpoint needs credentials.
 *
 * Extracted from `app/_layout.tsx` (SHELL#78); behaviour unchanged.
 */
import { useEffect } from "react";

import { startEventCacheSync } from "@/lib/eventCacheSync";
import { queryClient } from "@/lib/queryClient";
import { useAuthStore } from "@/store/auth";

export function useRealtimeCacheSync(): void {
  const hydrated = useAuthStore((s) => s.hydrated);
  const canUseOnlineServices = useAuthStore((s) => s.canUseOnlineServices());

  // ONE dependency, not two.
  //
  // `hydrated` and `canUseOnlineServices` both flip during startup and not
  // necessarily in the same render, so a two-dep effect ran, tore down, and
  // ran again -- opening a SECOND event-bus connection while the first was
  // still minting its stream token. Measured on a simulator: two mints 89ms
  // apart at launch.
  //
  // The loser of that race is what produced a 401 beside every healthy stream
  // (14 x 200 against 7 x 401 in one session), and because a failed connect
  // sets the status, the header chip read RECONNECTING while a stream was held
  // open the whole time.
  //
  // Collapsing to a single derived boolean means the effect runs exactly once,
  // on the transition into "ready".
  const ready = hydrated && canUseOnlineServices;

  useEffect(() => {
    if (!ready) return;
    const disconnect = startEventCacheSync(queryClient);
    return disconnect;
  }, [ready]);
}
