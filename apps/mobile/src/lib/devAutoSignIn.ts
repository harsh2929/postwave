/**
 * lib/devAutoSignIn.ts — "may this build sign itself in?", as a pure function
 * over the environment.
 *
 * A development build pointed at a LAN API is re-installed many times a day,
 * and each install lands on an empty sign-in form: server address, email,
 * password, retyped on a phone keyboard. This lets a DEV build carry those
 * three values and submit them once on first paint.
 *
 * ── WHY THE GATE IS A PURE FUNCTION ───────────────────────────────────────
 * This feature embeds a password in a JS bundle. That is acceptable for a
 * build that only ever points at a developer's own machine and is NEVER
 * acceptable in a shipped app, so "is this production?" must be answerable in
 * a unit test rather than by reading the call site and trusting it. The
 * profile arrives as a PARAMETER for exactly that reason — the sibling
 * `isSdkLocalHttpHost` read an ambient module constant instead of its own
 * argument and silently ignored the profile it was handed, which is the bug
 * this signature is shaped to prevent.
 *
 * The gate is deny-by-default in four independent ways: production refuses
 * outright, the flag must be explicitly "1", and all three values must be
 * present and non-blank. Any one of them missing yields null, and null means
 * the ordinary hand-typed form.
 */

import { BUILD_PROFILE } from "./config";

/** The three values a password sign-in needs, all present and non-blank. */
export interface DevAutoSignIn {
  baseUrl: string;
  email: string;
  password: string;
}

/**
 * The env keys this reads. Named explicitly because Expo's babel transform
 * inlines `process.env.EXPO_PUBLIC_*` AT EACH LITERAL REFERENCE — it does not
 * populate a `process.env` object. Passing `process.env` wholesale would hand
 * this function an empty object at runtime while every unit test passed, so
 * the binding below spells each key out and this type keeps that honest.
 */
export interface DevAutoSignInEnv {
  EXPO_PUBLIC_DEV_AUTOLOGIN?: string | undefined;
  EXPO_PUBLIC_API_URL?: string | undefined;
  EXPO_PUBLIC_DEV_EMAIL?: string | undefined;
  EXPO_PUBLIC_DEV_PASSWORD?: string | undefined;
}

/**
 * Resolve the auto sign-in credentials, or null to leave the form alone.
 *
 * `buildProfile` is the caller's profile, never an ambient constant.
 */
export function devAutoSignInCredentials(
  env: DevAutoSignInEnv,
  buildProfile: string,
): DevAutoSignIn | null {
  // ALLOWLIST, not a denylist. Refusing only "production" fails open twice
  // over: BUILD_PROFILE falls back to "development" when the variable is
  // unset, so a release bundled without it would be treated as a dev build;
  // and `preview` builds are DISTRIBUTED to testers, so a denylist would hand
  // them the credentials too. Only a profile that explicitly says
  // "development" may carry them.
  if (buildProfile.trim().toLowerCase() !== "development") return null;
  // Explicit opt-in only. An unset, empty, "0", "true" or "yes" value is off:
  // the flag is a switch someone turned on deliberately, not a truthiness
  // test that a stray value can trip.
  if ((env.EXPO_PUBLIC_DEV_AUTOLOGIN ?? "").trim() !== "1") return null;

  const baseUrl = (env.EXPO_PUBLIC_API_URL ?? "").trim();
  const email = (env.EXPO_PUBLIC_DEV_EMAIL ?? "").trim();
  // NOT trimmed: leading/trailing space can be part of a password, and
  // silently altering it would fail sign-in with a "wrong password" that is
  // this function's fault. Blankness is still rejected below.
  const password = env.EXPO_PUBLIC_DEV_PASSWORD ?? "";

  if (!baseUrl || !email || !password.trim()) return null;
  return { baseUrl, email, password };
}

/**
 * The resolved credentials for THIS build, or null.
 *
 * Each key is spelled out as its own literal `process.env.X` so the Expo
 * transform can inline it — see `DevAutoSignInEnv`.
 *
 * ── WHY THIS IS NOT GATED ON `__DEV__` ────────────────────────────────────
 * `__DEV__` is false in ANY Release build, including the Release build a
 * developer installs on a physical device — which is the only build that can
 * run without a Metro packager attached, and therefore the exact build this
 * feature exists for. Gating here on `__DEV__` would make auto sign-in dead on
 * arrival for its single use case.
 *
 * `__DEV__` is also the wrong question. "Is this a debug bundle?" is not "is
 * this shipping?": a non-production Release build is not a shipped app.
 *
 * ── WHY THE TEST IS ON THE RAW `process.env` LITERAL ──────────────────────
 * A runtime refusal CANNOT keep a secret out of a bundle, because babel has
 * already substituted it. This was reproduced, not assumed: exporting with a
 * production profile on a machine holding a populated `.env` emitted a bundle
 * with the password recoverable by `strings`, even though the runtime value
 * was null. Nulling a constant hides the value; it does not delete the string.
 *
 * So the condition below is written to be STATICALLY FOLDABLE. babel inlines
 * `process.env.EXPO_PUBLIC_BUILD_PROFILE` as a literal, the comparison folds
 * to a constant, and the minifier deletes the losing branch — taking the
 * credential literals with it. Comparing `BUILD_PROFILE` instead would defeat
 * this: it is the result of a `.toLowerCase()` CALL (config.ts), which no
 * minifier will fold.
 *
 * It is an allowlist (`=== "development"`) rather than a `!== "production"`
 * denylist so that an UNSET variable inlines to `undefined`, fails the
 * comparison, and deletes the credentials — fail-closed. A denylist would ship
 * them whenever the profile was merely forgotten or misspelled.
 *
 * `scripts/check-production-autologin.mjs` is the belt to this fold's braces,
 * covering the case where the build is somehow bundled without the transform.
 */
export const DEV_AUTO_SIGN_IN: DevAutoSignIn | null =
  process.env.EXPO_PUBLIC_BUILD_PROFILE === "development"
    ? devAutoSignInCredentials(
        {
          EXPO_PUBLIC_DEV_AUTOLOGIN: process.env.EXPO_PUBLIC_DEV_AUTOLOGIN,
          EXPO_PUBLIC_API_URL: process.env.EXPO_PUBLIC_API_URL,
          EXPO_PUBLIC_DEV_EMAIL: process.env.EXPO_PUBLIC_DEV_EMAIL,
          EXPO_PUBLIC_DEV_PASSWORD: process.env.EXPO_PUBLIC_DEV_PASSWORD,
        },
        BUILD_PROFILE,
      )
    : null;

/**
 * How long to wait for the connectivity probe before attempting anyway.
 *
 * NetInfo can report "not connected" for a moment after launch, and on a LAN
 * build the API may be reachable even when the OS believes there is no
 * INTERNET. Waiting forever for `online` would mean an auto sign-in that never
 * fires on exactly the network this feature exists to serve.
 */
export const AUTO_SIGN_IN_OFFLINE_GRACE_MS = 2500;

/**
 * Once-per-PROCESS latch.
 *
 * Deliberately module scope rather than a `useRef`: a ref is once per MOUNT,
 * and every sign-out in the app returns here by mounting a FRESH sign-in
 * screen. With a ref, signing out would immediately sign the developer back
 * in — an inescapable loop with no way to reach the form. Auto sign-in means
 * "on app launch", so the latch has to outlive the screen.
 */
let autoSignInClaimed = false;

/**
 * Claim the single auto sign-in attempt. Returns true exactly once per
 * process, and only when this build actually has credentials.
 */
export function claimAutoSignInAttempt(): boolean {
  if (autoSignInClaimed || !DEV_AUTO_SIGN_IN) return false;
  autoSignInClaimed = true;
  return true;
}

/** Test-only: reset the latch so each case starts from a fresh process. */
export function resetAutoSignInClaimForTest(): void {
  autoSignInClaimed = false;
}
