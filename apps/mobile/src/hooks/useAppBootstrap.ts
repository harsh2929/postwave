/**
 * useAppBootstrap — the one-time launch wiring the root layout must run BEFORE
 * it is allowed to paint: connectivity observation, auth hydration, telemetry
 * init.
 *
 * Extracted from `app/_layout.tsx` (SHELL#78 / NATIVE-V#3), which had grown to
 * nine independent lifecycle effects in one 617-line component. Behaviour is
 * unchanged — this is the same effect, verbatim, with its own name.
 *
 * It must stay OUTSIDE the launch gate: it is what makes `hydrated` become
 * true, so gating it on "the app is ready to render" would deadlock.
 */
import { useEffect } from "react";

import { configureMobileConnectivity } from "@/lib/connectivity";
import { initLocalization } from "@/lib/localization";
import {
  invalidatePrimaryDataOnReconnect,
  queryClient,
} from "@/lib/queryClient";
import { init as initTelemetry } from "@/lib/telemetry";
import { useAuthStore } from "@/store/auth";

export function useAppBootstrap(): void {
  const hydrate = useAuthStore((s) => s.hydrate);
  const revalidateSession = useAuthStore((s) => s.revalidateSession);

  useEffect(() => {
    // Locale FIRST, and synchronously: every formatter in lib/format.ts reads
    // a module-level locale, so anything formatted before this call would use
    // the engine default and then silently disagree with the same value
    // rendered a moment later. It is a native constant read, not I/O, so
    // there is nothing to await. (NATIVE#43 — `setFormatLocale` had no
    // callers at all until this line.)
    initLocalization();

    const cleanupConnectivity = configureMobileConnectivity({
      onOnline: () => {
        void (async () => {
          await revalidateSession();
          if (!useAuthStore.getState().canUseOnlineServices()) return;
          void queryClient.resumePausedMutations();
          // Targeted refetch on reconnect: only the primary, at-a-glance data
          // domains (dashboard / campaigns / subscribers / sequences / lists).
          // A blanket invalidateQueries() here stampeded the entire cache —
          // detail pages, audit, settings, ops — the instant the radio flipped
          // on; wasteful on cellular. Secondary screens refetch on their own
          // focus instead. See queryClient.ts.
          void invalidatePrimaryDataOnReconnect(queryClient);
        })();
      },
    });
    void hydrate();
    // Telemetry init runs in parallel with hydration; it's a no-op when
    // EXPO_PUBLIC_POSTHOG_KEY is unset.
    void initTelemetry();
    return cleanupConnectivity;
  }, [hydrate, revalidateSession]);
}
