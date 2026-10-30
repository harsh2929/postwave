// SPDX-License-Identifier: AGPL-3.0-only
//
// /verify-email?token=<...> — auto-POST /verify-email on mount. On success,
// shows confirmation; on failure, offers to send a fresh verification email
// (which requires being signed in, so we whoami() to gate that button).
"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";

import { ApiError } from "@/lib/api";
import { sendVerificationEmail, verifyEmail, whoami } from "@/lib/auth-api";
import { safeAuthTokenParam } from "@/lib/auth-token";
import { AuthShell } from "@/components/auth/auth-shell";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

type State =
  | { kind: "verifying" }
  | { kind: "ok" }
  | { kind: "error"; message: string };

export default function VerifyEmailPage() {
  return (
    <Suspense fallback={<VerifyEmailFallback />}>
      <VerifyEmailInner />
    </Suspense>
  );
}

function VerifyEmailFallback() {
  return (
    <AuthShell skipLabel="email verification">
      <Card>
        <CardContent className="p-6 text-sm text-muted-foreground">
          Loading…
        </CardContent>
      </Card>
    </AuthShell>
  );
}

function VerifyEmailInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [hadTokenParam] = useState(() => searchParams.has("token"));
  const [token] = useState(() => safeAuthTokenParam(searchParams.get("token")));

  const [state, setState] = useState<State>(
    token
      ? { kind: "verifying" }
      : { kind: "error", message: "Missing token." },
  );
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const [resending, setResending] = useState(false);
  const [resent, setResent] = useState(false);

  const ran = useRef(false);

  useEffect(() => {
    // Scrub every token-shaped query, including an empty or over-limit value
    // rejected by safeAuthTokenParam. Invalid bearer material is still secret
    // and must not remain in history, referrers, screenshots, or telemetry.
    if (hadTokenParam && typeof window !== "undefined") {
      router.replace("/verify-email", { scroll: false });
    }
  }, [hadTokenParam, router]);

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;

    void (async () => {
      // Determine sign-in state in parallel — needed for the failure path's
      // "request a new email" button.
      void whoami()
        .then(() => setSignedIn(true))
        .catch(() => setSignedIn(false));

      if (!token) return;

      try {
        await verifyEmail(token);
        setState({ kind: "ok" });
      } catch (err) {
        let message = "Link expired or invalid.";
        if (err instanceof ApiError && err.status === 429) {
          message = "Too many attempts; try again in a few minutes.";
        }
        setState({ kind: "error", message });
      }
    })();
  }, [token]);

  async function onResend() {
    setResending(true);
    try {
      await sendVerificationEmail();
      setResent(true);
    } catch {
      // Best-effort; the user can retry.
    } finally {
      setResending(false);
    }
  }

  return (
    <AuthShell skipLabel="email verification">
      <Card>
        <CardHeader>
          <CardTitle as="h1">
            {state.kind === "ok"
              ? "Email verified"
              : state.kind === "verifying"
                ? "Verifying…"
                : "Verification failed"}
          </CardTitle>
          <CardDescription>
            {state.kind === "ok"
              ? "Thanks for confirming your email address."
              : state.kind === "verifying"
                ? "Hang tight, we're confirming your email."
                : "We couldn't verify this link."}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {state.kind === "ok" && (
            <Button asChild className="w-full">
              <Link href="/app">Continue to Moosewave</Link>
            </Button>
          )}
          {state.kind === "verifying" && (
            <p
              className="flex items-center gap-2 text-sm text-muted-foreground"
              role="status"
              aria-busy="true"
            >
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              One moment…
            </p>
          )}
          {state.kind === "error" && (
            <>
              <p className="text-sm text-destructive" role="alert">
                {state.message}
              </p>
              {resent ? (
                <div
                  role="status"
                  className="rounded-md border bg-muted/30 p-4 text-sm"
                >
                  Sent. Check your inbox for a fresh verification email.
                </div>
              ) : signedIn ? (
                <Button
                  className="w-full"
                  onClick={() => void onResend()}
                  disabled={resending}
                >
                  {resending ? "Sending…" : "Request a new verification email"}
                </Button>
              ) : signedIn === false ? (
                <Button asChild className="w-full">
                  <Link href="/login">
                    Sign in to request a new verification email
                  </Link>
                </Button>
              ) : (
                <p className="text-xs text-muted-foreground">
                  Checking your session…
                </p>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </AuthShell>
  );
}
