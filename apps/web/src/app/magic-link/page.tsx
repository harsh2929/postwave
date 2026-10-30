// SPDX-License-Identifier: AGPL-3.0-only
//
// /magic-link has two modes:
//   - No ?token= — entry form. POST /magic-link/start, then "check your email".
//   - With ?token= — auto-consume on mount. On success → /app.
"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState, type FormEvent } from "react";
import { Loader2 } from "lucide-react";

import { ApiError } from "@/lib/api";
import { magicLinkConsume, magicLinkStart } from "@/lib/auth-api";
import {
  hasAnyAuthLinkCredential,
  nativeAuthHandoffUrl,
  parseAuthLinkProof,
  type AuthLinkProof,
} from "@/lib/auth-link";
import { AuthShell } from "@/components/auth/auth-shell";
import { CheckYourEmail } from "@/components/auth/check-your-email";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export default function MagicLinkPage() {
  return (
    <Suspense fallback={<MagicLinkFallback />}>
      <MagicLinkInner />
    </Suspense>
  );
}

function MagicLinkFallback() {
  return (
    <AuthShell>
      <Card>
        <CardContent className="p-6 text-sm text-muted-foreground">
          Loading…
        </CardContent>
      </Card>
    </AuthShell>
  );
}

function MagicLinkInner() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [proof] = useState(() => parseAuthLinkProof(searchParams, "magic"));
  const [hadCredential] = useState(() =>
    hasAnyAuthLinkCredential(searchParams),
  );

  useEffect(() => {
    if (hadCredential && typeof window !== "undefined") {
      // Keep the unclaimed /browser-auth/magic route when the native app has
      // handed a web-audience link back to the browser. Redirecting that route
      // to /magic-link could re-enter app-link handling on some platforms.
      // This must not wait for a same-route Next navigation: a delayed RSC
      // response would leave the bearer proof in the address bar, history,
      // referrers, and client telemetry while it is being consumed. Preserve
      // Next's private history state while replacing only the visible URL.
      window.history.replaceState(
        window.history.state,
        "",
        pathname === "/browser-auth/magic"
          ? "/browser-auth/magic"
          : "/magic-link",
      );
    }
  }, [hadCredential, pathname]);

  if (proof?.link_audience === "mobile") {
    return <MobileAudienceRecovery proof={proof} />;
  }
  if (proof) {
    return <MagicLinkConsume proof={proof} />;
  }
  if (hadCredential) {
    return <InvalidMagicLink />;
  }
  return <MagicLinkStart />;
}

function MagicLinkStart() {
  const [email, setEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    try {
      // Backend returns 202 unconditionally for non-existence-leak parity.
      // Either way the success state is identical.
      await magicLinkStart(email).catch(() => undefined);
    } finally {
      setSubmitting(false);
      setSubmitted(true);
    }
  }

  return (
    <AuthShell
      skipLabel="magic link sign-in"
      footer={
        <Link
          href="/login"
          className="font-medium text-foreground underline-offset-4 hover:underline"
        >
          Back to sign in with password
        </Link>
      }
    >
      <Card>
        <CardHeader>
          <CardTitle as="h1">Sign in with a magic link</CardTitle>
          <CardDescription>
            We&apos;ll email you a one-tap sign-in link. No password needed.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {submitted ? (
            <CheckYourEmail
              email={email}
              sentDescription="a sign-in link is on the way."
              onResend={() =>
                magicLinkStart(email)
                  .then(() => undefined)
                  .catch(() => undefined)
              }
            />
          ) : (
            <form
              onSubmit={onSubmit}
              className="space-y-4"
              aria-busy={submitting || undefined}
            >
              <div className="space-y-1.5">
                <Label htmlFor="email">Email</Label>
                <Input
                  id="email"
                  type="email"
                  autoComplete="email"
                  autoFocus
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  disabled={submitting}
                />
              </div>
              <Button type="submit" className="w-full" disabled={submitting}>
                {submitting ? "Sending…" : "Send magic link"}
              </Button>
            </form>
          )}
        </CardContent>
      </Card>
    </AuthShell>
  );
}

function MagicLinkConsume({ proof }: { proof: AuthLinkProof }) {
  const router = useRouter();
  const [state, setState] = useState<
    { kind: "consuming" } | { kind: "ok" } | { kind: "error"; message: string }
  >({ kind: "consuming" });

  // Guard against React 18 strict-mode double-mount: tokens are single-use,
  // so consuming twice would always fail the second call.
  const consumed = useRef(false);

  useEffect(() => {
    if (consumed.current) return;
    consumed.current = true;
    void (async () => {
      try {
        await magicLinkConsume(proof);
        setState({ kind: "ok" });
        router.push("/app");
      } catch (err) {
        let message = "This sign-in link is invalid or has expired.";
        if (err instanceof ApiError && err.status === 429) {
          message = "Too many attempts; try again in a few minutes.";
        }
        setState({ kind: "error", message });
      }
    })();
  }, [proof, router]);

  return (
    <AuthShell skipLabel="magic link sign-in">
      <Card>
        <CardHeader>
          <CardTitle as="h1">Signing you in…</CardTitle>
          <CardDescription>
            We&apos;re verifying your magic link.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {state.kind === "consuming" && (
            <p
              className="flex items-center gap-2 text-sm text-muted-foreground"
              role="status"
              aria-busy="true"
            >
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              One moment, redirecting you to your workspace…
            </p>
          )}
          {state.kind === "ok" && (
            <p
              className="flex items-center gap-2 text-sm"
              role="status"
              aria-busy="true"
            >
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              Redirecting to your workspace…
            </p>
          )}
          {state.kind === "error" && (
            <>
              <p className="text-sm text-destructive" role="alert">
                {state.message}
              </p>
              <Button asChild className="w-full">
                <Link href="/magic-link">Request a new link</Link>
              </Button>
            </>
          )}
        </CardContent>
      </Card>
    </AuthShell>
  );
}

function MobileAudienceRecovery({ proof }: { proof: AuthLinkProof }) {
  const handoff = nativeAuthHandoffUrl(proof);
  return (
    <AuthLinkMessage
      title="Open this link in the Moosewave app"
      message="This link is bound to the device that requested it. If the app is unavailable, request a new browser sign-in link below."
      nativeHandoff={handoff}
    />
  );
}

function InvalidMagicLink() {
  return (
    <AuthLinkMessage
      title="Sign-in link didn’t work"
      message="This link is incomplete, altered, or uses an unsupported format."
    />
  );
}

function AuthLinkMessage({
  title,
  message,
  nativeHandoff,
}: {
  title: string;
  message: string;
  nativeHandoff?: string | null;
}) {
  return (
    <AuthShell skipLabel="magic link sign-in">
      <Card>
        <CardHeader>
          <CardTitle as="h1">{title}</CardTitle>
          <CardDescription>{message}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {nativeHandoff ? (
            <Button asChild className="w-full">
              <a href={nativeHandoff}>Open Moosewave</a>
            </Button>
          ) : null}
          <Button asChild className="w-full">
            <Link href="/magic-link">Request a browser link</Link>
          </Button>
        </CardContent>
      </Card>
    </AuthShell>
  );
}
