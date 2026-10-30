/**
 * lib/signOutFlow.ts — ONE sign-out path.
 *
 * The app shipped two. `app/(tabs)/more.tsx` had an in-flight guard, a
 * "Signing out…" busy label, and the copy "Your local credentials will be
 * cleared. Any active session will be revoked." `app/(tabs)/settings.tsx` had
 * no guard, no busy label, and different copy that branched on auth mode — so a
 * double-tap there could start two `unregisterPushThenSignOut` flows racing on
 * SecureStore and the push-revocation journal. Two divergent implementations of
 * the most consequential action in the product.
 *
 * This module owns the decision half (copy, guard, ordering) and takes the
 * effectful half as dependencies, so it is unit-testable in the node
 * environment and every caller — More, Settings, and the command palette —
 * behaves identically.
 */

export type SignOutMode = "api_key" | "session" | null;

export interface SignOutConfirmRequest {
  title: string;
  message: string;
  confirmLabel: string;
  destructive: true;
}

export type SignOutOutcome =
  | "signed-out"
  /**
   * Local state was cleared and the user WAS navigated to sign-in, but part of
   * the teardown threw — typically the push-registration revocation, which
   * means the server may still consider this device deliverable. Callers should
   * say so rather than claiming a clean sign-out.
   */
  | "signed-out-degraded"
  | "cancelled"
  | "already-running";

export interface SignOutFlowDeps {
  mode: SignOutMode;
  /** Presents the confirmation; resolves true when the user commits. */
  confirm: (request: SignOutConfirmRequest) => Promise<boolean>;
  /** Revokes push then clears the local session (lib/push + store/auth). */
  performSignOut: () => Promise<void>;
  /** Called with true when the flow commits and false when it settles. */
  onBusyChange?: (busy: boolean) => void;
  /** Navigates to the sign-in screen. Runs even when teardown throws. */
  navigateToSignIn: () => void;
}

/**
 * Copy for the confirmation. Session mode revokes server-side state as well as
 * local, and saying so is the difference between "I'll just sign out on this
 * phone" and "I've locked out the laptop I left at the office".
 */
export function signOutCopy(mode: SignOutMode): SignOutConfirmRequest {
  return {
    title: "Sign out?",
    message:
      mode === "session"
        ? "Your local credentials will be cleared and the active session will be revoked on the server."
        : "Your API key will be removed from this device.",
    confirmLabel: "Sign out",
    destructive: true,
  };
}

// Module-level so two SCREENS (not just two taps on one screen) can't both
// start a teardown. The guard has to outlive any single component.
let inFlight = false;

/** Test seam — resets the module-level guard. */
export function resetSignOutGuard(): void {
  inFlight = false;
}

/** True while a sign-out is committing. Screens use it to disable their row. */
export function isSigningOut(): boolean {
  return inFlight;
}

/**
 * Confirm, then tear down.
 *
 * Ordering matters and is the reason this is shared: the push registration must
 * be revoked BEFORE the session is cleared (revocation needs the session), and
 * navigation must happen even if revocation fails — otherwise a network blip
 * leaves the user signed out locally but still sitting on an authenticated
 * screen.
 *
 * This NEVER rejects. Every call site is a fire-and-forget `onPress` handler,
 * and a rejecting promise there is an unobserved rejection (a red-box warning
 * in dev, a Sentry event in production) for a case the flow has already
 * handled. A failed teardown is reported as `signed-out-degraded` instead, so
 * the caller can tell the truth without having to write a catch.
 */
export async function confirmAndSignOut(
  deps: SignOutFlowDeps,
): Promise<SignOutOutcome> {
  if (inFlight) return "already-running";
  const confirmed = await deps.confirm(signOutCopy(deps.mode));
  if (!confirmed) return "cancelled";
  // The guard is only taken AFTER confirmation: a cancelled dialog must leave
  // the action available, and holding it across the (indefinite) confirmation
  // wait would deadlock the button if the user backgrounded the app.
  return runSignOut(deps);
}

/**
 * The teardown half, without the confirmation.
 *
 * For call sites that have ALREADY confirmed by other means — the account
 * deletion card's two paths both sign out from inside an Alert the user has
 * just answered, and asking "Sign out?" a second time there would be absurd.
 * Those paths previously called `unregisterPushThenSignOut` directly, which
 * meant they took no guard at all: a sign-out started from Settings and one
 * started from the deletion card could run concurrently over the same
 * SecureStore keys and push-revocation journal — precisely the race this
 * module exists to prevent.
 *
 * Never rejects; see `confirmAndSignOut`.
 */
export async function runSignOut(
  deps: Omit<SignOutFlowDeps, "confirm" | "mode">,
): Promise<SignOutOutcome> {
  if (inFlight) return "already-running";
  inFlight = true;
  deps.onBusyChange?.(true);
  let degraded = false;
  try {
    await deps.performSignOut();
  } catch {
    degraded = true;
  } finally {
    inFlight = false;
    deps.onBusyChange?.(false);
    deps.navigateToSignIn();
  }
  return degraded ? "signed-out-degraded" : "signed-out";
}
