/**
 * MagicLinkReturn — completion screen reached via the deep-link
 * `moosewave://auth/magic?<signed-v1-envelope>`. Calls /magic-link/consume which
 * sets the session cookie, then routes into the main app.
 *
 * v2: uses the shared AuthShell with the "magic-return" illustration
 * (brass key on envelope). Three states: working (spinner) → ok
 * (checkmark, brief pause then auto-route) → fail (error + retry).
 */

import { type ReactElement, useEffect, useRef, useState } from "react";

import { AuthShell } from "../components/AuthShell";
import { apiAuth, rememberSession } from "../lib/api-client";
import type { DesktopAuthLinkProof } from "../lib/auth-link-contract";
import {
  classifyAuthLinkApiError,
  type AuthLinkRecoveryReason,
} from "../lib/auth-link-recovery";
import { AUTH_ASSETS } from "../lib/authAssets";
import { AuthLinkRecovery } from "./AuthLinkRecovery";

interface Props {
  proof: DesktopAuthLinkProof;
  onSignedIn: () => void;
  onRequestNewLink: () => void;
  onCancel: () => void;
}

export function MagicLinkReturn({
  proof,
  onSignedIn,
  onRequestNewLink,
  onCancel,
}: Props): ReactElement {
  const [state, setState] = useState<
    | { kind: "working" }
    | { kind: "ok" }
    | { kind: "fail"; reason: AuthLinkRecoveryReason }
  >({ kind: "working" });
  const [attempt, setAttempt] = useState(0);
  const redirectTimerRef = useRef<number | null>(null);
  const lastAttemptRef = useRef(-1);
  const mountedRef = useRef(false);

  useEffect(() => {
    // StrictMode double-mounts: ranRef gates the consume call to
    // exactly one run (tokens are single-use), while mountedRef is
    // re-armed on every effect run so that single run keeps delivering
    // results to the live instance — the first mount's cleanup must
    // not strand it on the spinner.
    mountedRef.current = true;
    if (lastAttemptRef.current !== attempt) {
      lastAttemptRef.current = attempt;
      void (async () => {
        const res = await apiAuth.magicLinkConsume(proof);
        if (!mountedRef.current) return;
        if (res.error) {
          setState({
            kind: "fail",
            reason: classifyAuthLinkApiError(res.error),
          });
          return;
        }
        const me = await apiAuth.getAuthMe();
        if (!mountedRef.current) return;
        if (me.error) {
          setState({
            kind: "fail",
            reason: classifyAuthLinkApiError(me.error),
          });
          return;
        }
        rememberSession(me.data);
        setState({ kind: "ok" });
        redirectTimerRef.current = window.setTimeout(() => {
          if (mountedRef.current) onSignedIn();
        }, 500);
      })();
    }
    return () => {
      mountedRef.current = false;
      if (redirectTimerRef.current !== null) {
        window.clearTimeout(redirectTimerRef.current);
        redirectTimerRef.current = null;
      }
    };
  }, [attempt, proof, onSignedIn]);

  if (state.kind === "fail") {
    return (
      <AuthLinkRecovery
        flow="magic"
        reason={state.reason}
        onRequestNewLink={onRequestNewLink}
        onUseAnotherMethod={onCancel}
        onRetry={
          state.reason === "temporary_failure"
            ? () => {
                setState({ kind: "working" });
                setAttempt((value) => value + 1);
              }
            : undefined
        }
      />
    );
  }

  const isOk = state.kind === "ok";

  return (
    <AuthShell
      tone={isOk ? "mint" : "blush"}
      illustration={AUTH_ASSETS.magicReturn}
      asideEyebrow={isOk ? "Welcome back" : "Verifying"}
      asideHeadline={isOk ? "You're in." : "Just a moment."}
      asideSub={
        isOk
          ? "Loading your workspace — picking up where you left off."
          : "We're checking your sign-in link with the server. This usually takes a second or two."
      }
      heading={isOk ? "Signed in" : "Completing sign-in…"}
      headingSub={
        isOk ? "Loading your workspace…" : "Verifying your magic link."
      }
    >
      <div className="auth-state-card">
        {isOk ? (
          <div className="auth-state-icon" aria-hidden="true">
            <svg
              width="28"
              height="28"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M5 12l4 4 10-10" />
            </svg>
          </div>
        ) : (
          <div className="auth-spinner" aria-hidden="true" />
        )}
      </div>
    </AuthShell>
  );
}
