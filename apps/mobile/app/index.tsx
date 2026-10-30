/**
 * Root index — pure router. Sends the user to the auth flow or the
 * tab navigator based on whether SecureStore had credentials.
 *
 * Default unauthed destination is the email sign-in screen. Power
 * users / automation accounts reach the API-key flow via the "I have
 * an API key" link at the bottom of sign-in.
 *
 * ── THE LANDING PREFERENCE (LOVE#51) ───────────────────────────────────────
 * The authed branch used to be a hardcoded `/(tabs)/dashboard`, so an operator
 * whose job is the approvals queue opened the app somewhere else every single
 * time. This is the one place that choice can be honoured: expo-router only
 * reads `unstable_settings.initialRouteName` from a LAYOUT module, and
 * `app/(tabs)/_layout.tsx` pins it to `dashboard` — which is correct and must
 * stay, because it is also what synthesises a parent for a notification that
 * deep-links straight into a detail route.
 *
 * Two properties this had to have:
 *
 *  - EXACTLY ONE NAVIGATION. Redirecting to Dashboard and then again to the
 *    stored choice once AsyncStorage answers would flash the wrong tab and
 *    leave a bogus entry behind it, so the render is HELD until the read
 *    lands — one or two frames of the app background, no navigation.
 *  - THE HOLD IS BOUNDED. `lib/startupGate` exists because this app already
 *    shipped a launch path that could wait forever on a store that never
 *    answered. A landing preference is not worth reintroducing that: if the
 *    read has not resolved inside the watchdog, we proceed to the default. The
 *    budget is short because this is one AsyncStorage key, not a Keychain
 *    unlock.
 *
 * The stored value is re-validated against the CURRENT role on every launch
 * (`resolveLandingRoute`), so an admin who chose Approvals and was later
 * demoted lands on Dashboard rather than on a permission notice.
 */
import { Redirect } from "expo-router";
import { useEffect, useState } from "react";

import { useDisplayPreferences } from "@/hooks/useDisplayPreferences";
import { resolveLandingRoute } from "@/lib/displayPreferences";
import { canAccessMinimumRole } from "@/lib/mobileRouteManifest";
import { useAuthStore } from "@/store/auth";

/** Per-route boundary (src/lib/routeErrorBoundary.consistency.test.ts). */
export { AppErrorBoundary as ErrorBoundary } from "@/components/AppErrorBoundary";

/**
 * How long the root may render nothing while the landing preference loads.
 * One AsyncStorage key on a warm process; anything past this is a fault, and
 * a fault must not be able to hold the app on a blank root.
 */
export const LANDING_READ_WATCHDOG_MS = 400;

export default function Index() {
  const isAuthed = useAuthStore((s) => s.canEnterApp());
  const mfaGate = useAuthStore((s) => s.mfaGate());
  const mode = useAuthStore((s) => s.mode);
  const effectiveRole = useAuthStore(
    (s) => s.session?.effectiveRole ?? s.session?.role ?? null,
  );
  const { landing, hydrated } = useDisplayPreferences();
  const [watchdogElapsed, setWatchdogElapsed] = useState(false);

  useEffect(() => {
    if (hydrated) return;
    const timer = setTimeout(
      () => setWatchdogElapsed(true),
      LANDING_READ_WATCHDOG_MS,
    );
    return () => clearTimeout(timer);
  }, [hydrated]);

  if (mfaGate === "enrollment") return <Redirect href="/(auth)/mfa-enroll" />;
  if (mfaGate === "challenge") return <Redirect href="/(auth)/totp" />;
  // The hold below sits AFTER this: a signed-out user must never wait on a
  // preference read to reach the screen they can act from.
  if (!isAuthed) return <Redirect href="/(auth)/sign-in" />;
  if (!hydrated && !watchdogElapsed) return null;

  return (
    <Redirect
      href={resolveLandingRoute(
        landing,
        canAccessMinimumRole("admin", effectiveRole, mode),
      )}
    />
  );
}
