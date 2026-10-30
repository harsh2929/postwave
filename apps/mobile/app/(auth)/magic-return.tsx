/**
 * Magic-link return.
 *
 * Reached through the signed v1 magic-link envelope. Mobile-audience links
 * resolve the device's pending state (and its bound API origin) before client
 * construction. Browser-audience links get an explicit unclaimed web fallback
 * and are never consumed natively.
 *
 * If the token is missing or the backend rejects it (expired, replay,
 * wrong tenant), we render an error and let the user start again.
 */
import * as Linking from "expo-linking";
import { router, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";

import { createAuthClient, redactAuthError } from "@/api/auth";
import {
  MagicReturnView,
  type MagicReturnViewState,
} from "@/components/auth/MagicReturnView";
import {
  authLinkProofFromRouteParams,
  browserAuthFallbackUrl,
  type AuthLinkProof,
} from "@/lib/authLinkContract";
import {
  magicLinkAuthErrorCode,
  magicLinkSessionErrorCode,
  trackMagicLinkHandled,
  type MagicLinkTelemetryErrorCode,
} from "@/lib/authFlowTelemetry";
import {
  consumeErrorMessage,
  magicLinkStateErrorMessage,
} from "@/lib/authErrorCopy";
import { LEGAL_URLS } from "@/lib/config";
import { haptics } from "@/lib/haptics";
import {
  clearPendingMagicLinkState,
  magicLinkEmailMatches,
  resolvePendingMagicLinkState,
} from "@/lib/magicLinkState";
import {
  destinationForSession,
  sessionProfileFromMe,
  useAuthStore,
} from "@/store/auth";

/** Per-route boundary (src/lib/routeErrorBoundary.consistency.test.ts). */
export { AppErrorBoundary as ErrorBoundary } from "@/components/AppErrorBoundary";

export default function MagicReturn() {
  const params = useLocalSearchParams<{
    token?: string;
    state?: string;
    link_version?: string;
    link_flow?: string;
    link_audience?: string;
    link_signature?: string;
    browser_fallback?: string;
  }>();
  const signInSession = useAuthStore((s) => s.signInSession);
  const cancelSession = useAuthStore((s) => s.cancelSession);
  const prepareForSessionAuthentication = useAuthStore(
    (s) => s.prepareForSessionAuthentication,
  );
  const consumedBaseUrlRef = useRef<string | null>(null);
  const terminalTelemetryRef = useRef(false);

  const [state, setState] = useState<MagicReturnViewState>("working");
  const [error, setError] = useState("");
  const [browserProof, setBrowserProof] = useState<AuthLinkProof | null>(null);

  const trackTerminal = useCallback(
    (
      outcome: "success" | "failure" | "cancelled",
      errorCode: MagicLinkTelemetryErrorCode,
    ): void => {
      if (terminalTelemetryRef.current) return;
      terminalTelemetryRef.current = true;
      trackMagicLinkHandled(outcome, errorCode);
    },
    [],
  );

  const discardConsumedSession = useCallback(
    async (baseUrl: string): Promise<void> => {
      await clearPendingMagicLinkState().catch(() => undefined);
      await cancelSession(baseUrl);
      consumedBaseUrlRef.current = null;
    },
    [cancelSession],
  );

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const proof = authLinkProofFromRouteParams({
        token: params.token,
        state: params.state,
        link_version: params.link_version,
        link_flow: params.link_flow,
        link_audience: params.link_audience,
        link_signature: params.link_signature,
      });
      if (!proof || proof.flow !== "magic") {
        trackTerminal(
          "failure",
          typeof params.token === "string" ? "missing_state" : "missing_token",
        );
        setError(
          "This sign-in link is incomplete or has an unsupported format. Request a new link.",
        );
        setState("fail");
        return;
      }
      // Browser-requested links are HMAC-bound to audience=web. Android
      // cannot filter app links by query, so show an explicit browser handoff
      // instead of silently failing local state verification.
      if (proof.audience === "web") {
        setBrowserProof(proof);
        setState("browser_fallback");
        return;
      }
      const pending = await resolvePendingMagicLinkState({
        state: proof.state ?? "",
      });
      if (cancelled) return;
      if (!pending.ok) {
        trackTerminal(
          "failure",
          magicLinkStateTelemetryErrorCode(pending.reason),
        );
        setError(magicLinkStateErrorMessage(pending.reason));
        setState("fail");
        return;
      }
      // Pending-state verification above selects the locally bound origin
      // before an auth client exists. Link fields never select an API server.
      const api = createAuthClient(pending.pending.baseUrl);
      try {
        await prepareForSessionAuthentication();
      } catch {
        if (cancelled) return;
        trackTerminal("failure", "session_cleanup_pending");
        setError(
          "A prior server sign-out must finish before this link can be used. Reconnect and try again.",
        );
        setState("fail");
        return;
      }
      const res = await api.magicLinkConsume(proof);
      if (cancelled) return;
      if (res.error) {
        let cleared = true;
        try {
          await clearPendingMagicLinkState();
        } catch {
          cleared = false;
        }
        trackTerminal(
          "failure",
          cleared
            ? magicLinkAuthErrorCode(res.error, "consume_rejected")
            : "local_persistence_failed",
        );
        setError(
          `${consumeErrorMessage(res.error)}${
            cleared
              ? ""
              : " Secure device cleanup is pending; unlock the device and try again."
          }`,
        );
        setState("fail");
        return;
      }
      consumedBaseUrlRef.current = api.baseUrl;
      const me = await api.getMe();
      if (cancelled) return;
      if (me.error || !me.data) {
        await discardConsumedSession(api.baseUrl);
        if (cancelled) return;
        trackTerminal(
          "failure",
          me.error
            ? magicLinkAuthErrorCode(me.error, "profile_load_failed")
            : "profile_load_failed",
        );
        setError(
          me.error ? consumeErrorMessage(me.error) : "Couldn't load profile",
        );
        setState("fail");
        return;
      }
      if (!magicLinkEmailMatches(pending.pending, me.data.email)) {
        await discardConsumedSession(api.baseUrl);
        if (cancelled) return;
        trackTerminal("failure", "account_mismatch");
        setError(
          "This sign-in link doesn't match the account that requested it. Request a new link on this device.",
        );
        setState("fail");
        return;
      }
      const profile = sessionProfileFromMe(me.data);
      try {
        await signInSession({
          baseUrl: api.baseUrl,
          profile,
        });
      } catch (err) {
        // signInSession rejects on an unusable /me profile (sanitize fail)
        // or a SecureStore write error. Without this guard the rejection is
        // unhandled, the screen stays on the "Completing sign-in…" spinner
        // forever, and the user has no way to recover. Surface it through
        // the existing fail-state UI ("Back to sign in") — matching the
        // try/catch around the same call in sign-in.tsx / sign-up.tsx.
        if (cancelled) return;
        await clearPendingMagicLinkState().catch(() => undefined);
        consumedBaseUrlRef.current = null;
        trackTerminal("failure", magicLinkSessionErrorCode(err));
        setError(
          redactAuthError(
            err instanceof Error ? err.message : "Sign-in failed",
          ),
        );
        setState("fail");
        return;
      }
      if (cancelled) return;
      await clearPendingMagicLinkState().catch(() => undefined);
      trackTerminal("success", "none");
      router.replace(destinationForSession(profile));
    })();
    return () => {
      cancelled = true;
    };
  }, [
    params.token,
    params.state,
    params.link_version,
    params.link_flow,
    params.link_audience,
    params.link_signature,
    params.browser_fallback,
    signInSession,
    prepareForSessionAuthentication,
    trackTerminal,
    discardConsumedSession,
  ]);

  async function continueInBrowser() {
    if (!browserProof) return;
    try {
      trackTerminal("cancelled", "none");
      await Linking.openURL(browserAuthFallbackUrl(browserProof));
    } catch {
      setError(
        "The browser could not be opened. Copy this email link into your browser or request a new link there.",
      );
      setState("fail");
    }
  }

  async function requestNewLink(): Promise<void> {
    haptics.tap();
    await clearPendingMagicLinkState().catch(() => undefined);
    await backToSignIn();
  }

  async function openSupport(): Promise<void> {
    try {
      await Linking.openURL(LEGAL_URLS.support);
    } catch {
      setError(
        "Support could not be opened. Visit moosewave.com/support from a browser.",
      );
    }
  }

  async function backToSignIn() {
    // Only tear down a session when THIS screen consumed the link and
    // established one. In every non-consumed terminal state (browser_fallback,
    // missing/invalid token, expired/mismatched pending state, consume
    // rejected) the ref is null — cancelling there would force-sign-out an
    // already-authenticated user who merely tapped a browser/expired link.
    // Match reset-confirm.tsx, whose Back just navigates.
    const consumedBaseUrl = consumedBaseUrlRef.current;
    if (consumedBaseUrl) {
      await cancelSession(consumedBaseUrl);
      consumedBaseUrlRef.current = null;
    }
    router.replace("/(auth)/sign-in");
  }

  return (
    <MagicReturnView
      state={state}
      error={error}
      onContinueInBrowser={() => void continueInBrowser()}
      onBack={() => void backToSignIn()}
      onRequestNewLink={
        state === "fail" ? () => void requestNewLink() : undefined
      }
      // No retry action: this screen clears the device's pending state on
      // every failure path, so a second attempt at the same link is
      // guaranteed to fail. Requesting a fresh link is the real recovery.
      onContactSupport={
        state === "fail" ? () => void openSupport() : undefined
      }
    />
  );
}

function magicLinkStateTelemetryErrorCode(
  reason: string,
): MagicLinkTelemetryErrorCode {
  if (reason === "storage_unavailable" || reason === "cleanup_failed") {
    return "local_persistence_failed";
  }
  return reason === "expired" ? "state_expired" : "state_mismatch";
}
