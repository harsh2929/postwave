/**
 * useGoogleSignIn — the mobile Google round-trip, start to session.
 *
 * The grammar lives in lib/oauthStart.ts (pure, unit-tested); this hook owns
 * the parts that need a device: SecureStore for the device-bound nonce, the OS
 * auth session, and the hand-off to /(auth)/magic-return.
 *
 * SEQUENCE
 *   1. Validate the origin the user is actually pointed at. A self-hosted
 *      operator can retype the API URL on this screen, and an OAuth start URL
 *      built from an unvalidated field is a browser open we do not control.
 *   2. `prepareForSessionAuthentication()` — the same guard the password and
 *      magic-link paths run. A previous session that has not finished its
 *      server-side revocation must not be overlapped by a new one.
 *   3. Mint the pending state (createPendingOAuthLinkState) BEFORE the browser
 *      opens, because the nonce is what the server signs into the callback.
 *   4. Pre-flight the /start URL so a deployment without Google fails in-app
 *      instead of rendering our JSON error inside a browser sheet.
 *   5. `openAuthSessionAsync` with the exact redirect the server sanitizer
 *      admits, so the sheet closes itself on the callback.
 *   6. Forward the returned envelope to magic-return, which does the consume.
 *
 * EVERY EXIT CLEANS UP. A pending state left in SecureStore after a failed or
 * abandoned attempt is not merely litter: it is a live one-time nonce, and the
 * next legitimate magic-link request on this device would overwrite it anyway
 * — but a stale one that survives until its TTL keeps a signed envelope
 * consumable. Each failure path clears it.
 */
import { router } from "expo-router";
import { useCallback, useRef, useState } from "react";
import * as WebBrowser from "expo-web-browser";

import { probeOAuthStart } from "@/api/authOAuth";
import { OFFLINE_COPY, oauthFailureMessage } from "@/lib/authErrorCopy";
import { trackSignInCompleted } from "@/lib/authFlowTelemetry";
import { validateApiBaseUrl } from "@/lib/config";
import { haptics } from "@/lib/haptics";
import {
  clearPendingMagicLinkState,
  createPendingOAuthLinkState,
} from "@/lib/magicLinkState";
import {
  buildOAuthStartUrl,
  OAUTH_RETURN_URL,
  oauthReturnRouteParams,
} from "@/lib/oauthStart";

export interface GoogleSignInInput {
  /** The raw base-URL field value; validated here, never trusted. */
  baseUrl: string;
  online: boolean;
  /** Runs the store's pre-authentication guard; rejects when it cannot. */
  prepare: () => Promise<void>;
  /** Reports a failure to the screen's keyed error surface. */
  onError: (message: string) => void;
  /** Reports a base-URL failure, which must also reveal the collapsed field. */
  onBaseUrlError: (message: string) => void;
}

export interface GoogleSignIn {
  busy: boolean;
  /**
   * False once the server has told us this deployment has no Google provider.
   * The button hides rather than staying as a permanent dead end.
   */
  available: boolean;
  start: () => void;
}

export function useGoogleSignIn(input: GoogleSignInInput): GoogleSignIn {
  const [busy, setBusy] = useState(false);
  const [available, setAvailable] = useState(true);
  const inFlight = useRef(false);
  const inputRef = useRef(input);
  inputRef.current = input;

  const start = useCallback((): void => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    void runGoogleSignIn(inputRef.current, setAvailable)
      .catch(() => {
        // Last-resort net: every expected failure is already typed above, so
        // reaching here means the browser module itself threw.
        inputRef.current.onError(oauthFailureMessage("invalid_return"));
      })
      .finally(() => {
        inFlight.current = false;
        setBusy(false);
      });
  }, []);

  return { busy, available, start };
}

async function runGoogleSignIn(
  input: GoogleSignInInput,
  setAvailable: (next: boolean) => void,
): Promise<void> {
  const fail = (
    message: string,
    code: "offline" | "provider_disabled" | "user_cancelled" | "unknown",
  ): void => {
    trackSignInCompleted("failure", "oauth_google", code);
    input.onError(message);
  };

  if (!input.online) {
    fail(OFFLINE_COPY, "offline");
    return;
  }
  const validBaseUrl = validateApiBaseUrl(input.baseUrl);
  if (!validBaseUrl.ok) {
    trackSignInCompleted("failure", "oauth_google", "invalid_input");
    input.onBaseUrlError(validBaseUrl.message);
    return;
  }
  try {
    await input.prepare();
  } catch {
    fail(
      "A prior sign-out must finish before signing in with Google. Reconnect and try again.",
      "unknown",
    );
    return;
  }

  // Minting the nonce touches SecureStore, which fails on a device that is
  // locked or out of keychain space. That is not a network problem and must
  // not be reported as one — the user's fix is to unlock the device.
  let startUrl: string;
  try {
    const pending = await createPendingOAuthLinkState({
      baseUrl: validBaseUrl.url,
    });
    startUrl = buildOAuthStartUrl({
      baseUrl: validBaseUrl.url,
      provider: "google",
      state: pending.state,
    });
  } catch {
    fail(
      "This device couldn't securely start a Google sign-in. Unlock the device and try again.",
      "unknown",
    );
    return;
  }

  const probe = await probeOAuthStart(startUrl);
  if (!probe.ok) {
    await clearPendingMagicLinkState().catch(() => undefined);
    if (probe.reason === "provider_disabled") setAvailable(false);
    fail(
      oauthFailureMessage(probe.reason),
      probe.reason === "provider_disabled" ? "provider_disabled" : "unknown",
    );
    return;
  }

  const result = await WebBrowser.openAuthSessionAsync(
    startUrl,
    OAUTH_RETURN_URL,
  );
  if (result.type !== "success") {
    // Cancel and dismiss are indistinguishable from the 409
    // identity_link_required the server renders inside the browser, so the
    // copy names the precondition instead of guessing at the cause.
    await clearPendingMagicLinkState().catch(() => undefined);
    fail(oauthFailureMessage("unlinked"), "user_cancelled");
    return;
  }
  const params = oauthReturnRouteParams(result.url);
  if (!params) {
    await clearPendingMagicLinkState().catch(() => undefined);
    fail(oauthFailureMessage("invalid_return"), "unknown");
    return;
  }
  // A neutral "received", not a success: the token still has to be consumed,
  // and a success buzz followed by a rejection is worse than no buzz at all.
  haptics.tap();
  // magic-return owns the consume, the /me load, the profile persist and the
  // destination. Success telemetry is emitted there, once, so a completed
  // OAuth sign-in is not double-counted.
  router.replace({ pathname: "/(auth)/magic-return", params });
}
