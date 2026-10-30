// SPDX-License-Identifier: AGPL-3.0-only
//
// /reset-password?<signed-v1-envelope> collects a new password and confirms it
// via password-reset/confirm. Native-audience proofs are handed to the app;
// browser-audience proofs are consumed here.
"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState, type FormEvent } from "react";
import { toast } from "sonner";

import { ApiError } from "@/lib/api";
import { genericAuthErrorMessage } from "@/lib/auth-errors";
import { MIN_PASSWORD_LENGTH } from "@/lib/password-strength";
import { passwordResetConfirm } from "@/lib/auth-api";
import {
  hasAnyAuthLinkCredential,
  nativeAuthHandoffUrl,
  parseAuthLinkProof,
} from "@/lib/auth-link";
import { AuthShell } from "@/components/auth/auth-shell";
import { PasswordStrengthMeter } from "@/components/auth/password-strength-meter";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { PasswordInput } from "@/components/ui/password-input";

export default function ResetPasswordPage() {
  return (
    <Suspense fallback={<ResetPasswordFallback />}>
      <ResetPasswordInner />
    </Suspense>
  );
}

function ResetPasswordFallback() {
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

function ResetPasswordInner() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [proof] = useState(() => parseAuthLinkProof(searchParams, "reset"));
  const [hadCredential] = useState(() =>
    hasAnyAuthLinkCredential(searchParams),
  );

  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (hadCredential && typeof window !== "undefined") {
      // Preserve /browser-auth/reset during a native-to-browser handoff so
      // query scrubbing cannot bounce the request back into the installed app.
      router.replace(
        pathname === "/browser-auth/reset"
          ? "/browser-auth/reset"
          : "/reset-password",
        { scroll: false },
      );
    }
  }, [hadCredential, pathname, router]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!proof || proof.link_audience !== "web") {
      setError("This reset link is missing, altered, or unsupported.");
      return;
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
      return;
    }
    if (password !== confirm) {
      setError("Passwords do not match.");
      return;
    }
    setSubmitting(true);
    try {
      await passwordResetConfirm(proof, password);
      toast.success("Password updated; please sign in.");
      router.push("/login");
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.status === 400 || err.status === 410) {
          setError("This reset link is invalid or has expired.");
          return;
        }
        if (err.status === 429) {
          setError("Too many attempts; try again in a few minutes.");
          return;
        }
      }
      // 5xx / body-less / transport failures → friendly message (AUTH-011).
      setError(genericAuthErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  if (proof?.link_audience === "mobile") {
    const handoff = nativeAuthHandoffUrl(proof);
    return (
      <ResetLinkMessage
        title="Open this link in the Moosewave app"
        message="This reset link is bound to the device that requested it. If the app is unavailable, request a new browser reset link."
        nativeHandoff={handoff}
      />
    );
  }
  if (!proof) {
    return (
      <ResetLinkMessage
        title={hadCredential ? "Reset link didn’t work" : "Reset link required"}
        message={
          hadCredential
            ? "This link is incomplete, altered, or uses an unsupported format."
            : "Open the secure link from your reset email, or request a new browser reset link."
        }
      />
    );
  }

  // Inline match feedback: only once the confirm field has content, so no
  // premature error before it is touched (AUTH-019).
  const mismatch = confirm.length > 0 && confirm !== password;

  return (
    <AuthShell
      skipLabel="reset your password"
      footer={
        <Link
          href="/login"
          className="font-medium text-foreground underline-offset-4 hover:underline"
        >
          Back to sign in
        </Link>
      }
    >
      <Card>
        <CardHeader>
          <CardTitle as="h1">Choose a new password</CardTitle>
          <CardDescription>
            Pick something at least {MIN_PASSWORD_LENGTH} characters long.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <form
            onSubmit={onSubmit}
            className="space-y-4"
            aria-busy={submitting || undefined}
          >
            <div className="space-y-1.5">
              <Label htmlFor="password">New password</Label>
              <PasswordInput
                id="password"
                autoComplete="new-password"
                autoFocus
                required
                minLength={MIN_PASSWORD_LENGTH}
                aria-describedby="password-strength"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={submitting}
              />
              <PasswordStrengthMeter
                password={password}
                helperId="password-strength"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="confirm">Confirm password</Label>
              <PasswordInput
                id="confirm"
                autoComplete="new-password"
                required
                minLength={MIN_PASSWORD_LENGTH}
                aria-invalid={mismatch || undefined}
                aria-describedby={mismatch ? "confirm-mismatch" : undefined}
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                disabled={submitting}
              />
              {mismatch && (
                <p
                  id="confirm-mismatch"
                  className="text-xs text-destructive"
                  role="alert"
                >
                  Passwords do not match.
                </p>
              )}
            </div>
            {error && (
              <p className="text-sm text-destructive" role="alert">
                {error}
              </p>
            )}
            <Button type="submit" className="w-full" disabled={submitting}>
              {submitting ? "Updating…" : "Update password"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </AuthShell>
  );
}

function ResetLinkMessage({
  title,
  message,
  nativeHandoff,
}: {
  title: string;
  message: string;
  nativeHandoff?: string | null;
}) {
  return (
    <AuthShell skipLabel="reset your password">
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
            <Link href="/forgot-password">Request a browser reset link</Link>
          </Button>
        </CardContent>
      </Card>
    </AuthShell>
  );
}
