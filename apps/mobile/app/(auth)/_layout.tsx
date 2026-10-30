/**
 * (auth) group layout.
 *
 * Stack-based: the user navigates between sign-in / sign-up / forgot-
 * password / TOTP screens via push.
 *
 * New session-auth screens live next to the legacy login.tsx so the
 * "I have an API key" fallback continues to work — paired devices /
 * automation users never see the email screens.
 *
 * Redirect policy lives in lib/authLayoutPolicy.ts. MFA normally owns this
 * navigator until enrollment/challenge finishes, while link-driven recovery
 * screens (magic return, password reset, email verification) stay reachable.
 * Authenticated users otherwise leave this group for the dashboard. Keeping
 * the ordering in one pure function prevents a higher-priority MFA redirect
 * from stealing a one-time link flow.
 */
import { Redirect, Stack, usePathname } from "expo-router";

import { authLayoutRedirect } from "@/lib/authLayoutPolicy";
import { useMotion } from "@/lib/motion";
import { useTheme } from "@/lib/theme";
import { useAuthStore } from "@/store/auth";

export default function AuthLayout() {
  const isAuthed = useAuthStore((s) => s.canEnterApp());
  const mfaGate = useAuthStore((s) => s.mfaGate());
  const { t } = useTheme();
  const { reduceMotion } = useMotion();
  const path = usePathname();
  const redirect = authLayoutRedirect({ path, isAuthed, mfaGate });
  if (redirect) return <Redirect href={redirect} />;

  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: t.bg },
        animation: reduceMotion ? "none" : "slide_from_right",
      }}
    />
  );
}
