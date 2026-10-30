/**
 * useSessionRecovery — the three "catch up once we can" lifecycle effects the
 * root layout used to hold inline (SHELL#78):
 *
 *  1. Retry a push revocation that was recorded while offline. A sign-out that
 *     happened offline leaves only a possession-bound device revocation record
 *     (never a session/token), so this runs even while logged out: a shared
 *     phone must stop receiving the former account's notifications as soon as
 *     connectivity returns.
 *  2. Resume persisted offline mutations on the AUTHORIZATION transition, not
 *     just from the persister callback or the NetInfo reconnect callback —
 *     otherwise an ordinary online relaunch can leave edits paused forever.
 *  3. Re-validate a cached session whenever the app foregrounds, recovering
 *     the parse/5xx/unknown failures that deliberately fall back to the
 *     offline-cached state instead of leaving the shell stuck in `checking`.
 *
 * Behaviour is unchanged from the inline versions.
 */
import { useEffect } from "react";
import { AppState } from "react-native";

import { queryClient } from "@/lib/queryClient";
import { retryPendingPushRevocation } from "@/lib/push";
import { useAuthStore } from "@/store/auth";

export function useSessionRecovery(): void {
  const hydrated = useAuthStore((s) => s.hydrated);
  const canUseOnlineServices = useAuthStore((s) => s.canUseOnlineServices());
  const sessionValidation = useAuthStore((s) => s.sessionValidation);

  useEffect(() => {
    if (!hydrated) return;
    void retryPendingPushRevocation().catch(() => undefined);
  }, [hydrated]);

  useEffect(() => {
    if (!hydrated || !canUseOnlineServices) return;
    void queryClient.resumePausedMutations();
  }, [hydrated, canUseOnlineServices, sessionValidation]);

  useEffect(() => {
    if (!hydrated) return;
    const sub = AppState.addEventListener("change", (state) => {
      if (state !== "active") return;
      const auth = useAuthStore.getState();
      if (
        auth.mode === "session" &&
        auth.sessionValidation !== "validated_online"
      ) {
        void auth.revalidateSession();
      }
    });
    return () => sub.remove();
  }, [hydrated]);
}
