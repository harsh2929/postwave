/**
 * Sign-in (email + password) — primary auth surface.
 *
 * This file is a SHELL (MAP#53). It picks one of two full-screen states and
 * wires the three navigation destinations. Everything else lives one level
 * down, which is the same shape desktop uses (apps/desktop/src/pages/SignIn.tsx
 * over pages/sign-in/{useSignInController, SignInFormView}):
 *
 *   src/hooks/useSignInController.ts     state, network, focus, announcements
 *   src/lib/signInFlow.ts                the order the refusals fire in (pure)
 *   src/lib/signInForm.ts                per-field verdicts, button copy (pure)
 *   src/components/auth/SignInFormView   the credential form
 *   src/components/auth/MagicSentView    the "check your email" state
 *
 * Three pathways reach the app from here:
 *
 *   1. Email + password → POST /api/v1/auth/login. The backend sets a
 *      pw_session cookie; the controller then loads /me, persists the profile
 *      and routes onward. A `needs_workspace` answer renders a picker step
 *      inside the form before completing.
 *   2. Magic link → POST /api/v1/auth/magic-link/start. The backend always
 *      202s (no account enumeration), so the UI shows "check your email" and
 *      waits for `moosewave://auth/magic`.
 *   3. "I have an API key" → the legacy login screen.
 *
 * MFA is per-session, not pre-session: after a successful password verify an
 * enrolled user is routed to /(auth)/totp by destinationForSession.
 */
import { router, type Href } from "expo-router";
import { depositInAppOrigin } from "@/lib/inAppOriginHandoff";

import { MagicSentView } from "@/components/auth/MagicSentView";
import { SignInFormView } from "@/components/auth/SignInFormView";
import { useSignInController } from "@/hooks/useSignInController";

/** Per-route boundary (src/lib/routeErrorBoundary.consistency.test.ts). */
export { AppErrorBoundary as ErrorBoundary } from "@/components/AppErrorBoundary";

export default function SignIn() {
  const controller = useSignInController();

  if (controller.magicSent) {
    return (
      <MagicSentView
        email={controller.email.trim()}
        error={controller.error}
        busy={controller.busy}
        resendSeconds={controller.resendSeconds}
        onResend={controller.onSendMagicLink}
        onUseAnotherMethod={controller.onUseAnotherMethod}
        headingRef={controller.refs.magicHeading}
      />
    );
  }

  return (
    <SignInFormView
      controller={controller}
      onForgotPassword={() => router.push("/(auth)/forgot-password")}
      onCreateAccount={() => router.push("/(auth)/sign-up")}
      onUseAnotherDevice={() => {
        // Vouch for the origin in process memory before navigating: the
        // destination cannot otherwise tell this hand-off from a deep link
        // carrying an attacker's server, and on a first self-hosted setup the
        // URL the operator just typed is in no stored source yet.
        depositInAppOrigin(controller.baseUrl);
        router.push({
          pathname: "/(auth)/device-sign-in",
          params: { base_url: controller.baseUrl },
        } as unknown as Href);
      }}
      onUseApiKey={() => router.push("/(auth)/login")}
    />
  );
}
