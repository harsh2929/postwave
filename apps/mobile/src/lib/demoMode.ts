/**
 * lib/demoMode.ts — "is this build allowed to fake its world?", as a pure
 * function over the environment.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────
 * The mobile app could not be walked screen-by-screen against a running
 * server, and the blocker was not the server. Sign-in latches itself shut:
 * `SECURE_KEY_CLEANUP_PENDING` is a DURABLE marker, and once it is set every
 * later sign-in is refused with `AuthSessionStateError: local_cleanup_pending`
 * -- a refusal caught by the very handler that re-asserts the marker. Measured
 * in-app on 2026-08-19:
 *
 *   [qa-diag] local commit failed: local_cleanup_pending |
 *   AuthSessionStateError: You are signed out, but secure local cleanup is
 *   incomplete.
 *
 * That is correct fail-closed behaviour for a real user on a real device. It
 * is also an absolute wall for QA, because the escape hatch ("Retry secure
 * cleanup") is a tap on a screen you can only reach by hand.
 *
 * Demo mode removes the KEYCHAIN from the loop rather than weakening the
 * latch: storage becomes an in-memory map, so there is no durable marker to
 * inherit and no platform write to fail. The auth logic, the latch, and the
 * fail-closed teardown are all still exercised exactly as shipped.
 *
 * ── WHY THE GATE IS A PURE FUNCTION OVER AN ARGUMENT ───────────────────────
 * This flag makes an app forget things it promised to remember. "Is this
 * production?" must therefore be answerable in a unit test rather than by
 * reading a call site and trusting it, and the profile arrives as a PARAMETER
 * so a caller cannot accidentally consult an ambient constant instead of the
 * value it was handed -- the exact bug `isSdkLocalHttpHost` shipped with.
 *
 * Deny-by-default in two independent ways: production refuses outright, and
 * the flag must be the exact string "1".
 *
 * No react-native imports — imported by node-run vitest.
 */

export interface DemoModeEnv {
  EXPO_PUBLIC_DEV_DEMO?: string | undefined;
}

/** Whether this build may substitute in-memory storage and demo data. */
export function demoModeEnabled(
  env: DemoModeEnv,
  buildProfile: string | undefined,
): boolean {
  // ALLOW-LIST, mirroring lib/devAutoSignIn. The earlier deny-list
  // (`!== "production"`) admitted `preview` — the profile distributed to
  // testers — and an unset profile, which lib/config folds to "development".
  // Demo mode substitutes in-memory storage and fabricated data; a tester
  // build that could be flipped into it by an environment variable was the
  // 2026-09 review's residual, closed here.
  if ((buildProfile ?? "").trim().toLowerCase() !== "development") return false;
  return (env.EXPO_PUBLIC_DEV_DEMO ?? "").trim() === "1";
}
