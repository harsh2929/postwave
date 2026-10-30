// SPDX-License-Identifier: AGPL-3.0-only
//
// SETC-010 — the landing page a copy-link team invitation points at
// (/accept-invite?token=…). The invitee sets a password; on success the
// session cookie is set and they land in the joined workspace.
"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState, type FormEvent } from "react";
import { toast } from "sonner";

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
import { ApiError } from "@/lib/api";
import { acceptInvite } from "@/lib/auth-api";
import { genericAuthErrorMessage } from "@/lib/auth-errors";
import { MIN_PASSWORD_LENGTH } from "@/lib/password-strength";

function AcceptInviteInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [token] = useState(() => searchParams.get("token") ?? "");

  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The invite token is a single-use bearer credential. Once it is held in
  // state, drop it from the URL so it stops living in the address bar, the
  // history entry and analytics' $current_url while the invitee picks a
  // password — same scrub /verify-email and /reset-password already do.
  useEffect(() => {
    if (token && typeof window !== "undefined") {
      // Do not wait for a same-route Next navigation before hiding this bearer
      // credential. Preserve Next's private history state and synchronously
      // replace only the address-bar URL once the token is captured in state.
      window.history.replaceState(window.history.state, "", "/accept-invite");
    }
  }, [token]);

  const mismatch = confirm.length > 0 && password !== confirm;

  if (!token) {
    return (
      <AuthShell skipLabel="invitation help">
        <Card>
          <CardHeader>
            <CardTitle as="h1">Invitation link required</CardTitle>
            <CardDescription>
              This page needs the secure, single-use link from your workspace
              invitation.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div
              role="status"
              className="rounded-xl border border-info/30 bg-info-subtle p-4 text-sm leading-6 text-info"
            >
              Ask a workspace admin to send a fresh invitation. If you already
              joined, sign in with the same email address.
            </div>
            <Button asChild className="min-h-11 w-full">
              <Link href="/login">Go to sign in</Link>
            </Button>
            <Button asChild variant="outline" className="min-h-11 w-full">
              <Link href="/">Back to Moosewave</Link>
            </Button>
          </CardContent>
        </Card>
      </AuthShell>
    );
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!token) {
      setError("This invitation link is missing its token.");
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
      await acceptInvite(token, password);
      toast.success("Welcome to the workspace!");
      router.push("/app");
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.status === 404) {
          setError(
            "This invitation is invalid, has already been used, or has expired. Ask an admin to send a new one.",
          );
          return;
        }
        if (err.status === 409) {
          setError(
            "This email is already a member of the workspace. Sign in instead.",
          );
          return;
        }
        if (err.status === 400) {
          setError(
            `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
          );
          return;
        }
        if (err.status === 429) {
          setError("Too many attempts; try again in a few minutes.");
          return;
        }
      }
      setError(genericAuthErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AuthShell
      skipLabel="accept your invitation"
      footer={
        <Link
          href="/login"
          className="font-medium text-foreground underline-offset-4 hover:underline"
        >
          Already have an account? Sign in
        </Link>
      }
    >
      <Card>
        <CardHeader>
          <CardTitle as="h1">Join the workspace</CardTitle>
          <CardDescription>
            Set a password to accept your invitation. You&apos;ll join with the
            role your admin assigned.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <form
            onSubmit={onSubmit}
            className="space-y-4"
            aria-busy={submitting || undefined}
          >
            <div className="space-y-1.5">
              <Label htmlFor="password">Password</Label>
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
            <Button
              type="submit"
              className="w-full"
              disabled={submitting || mismatch}
            >
              {submitting ? "Joining…" : "Join workspace"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </AuthShell>
  );
}

export default function AcceptInvitePage() {
  return (
    <Suspense fallback={null}>
      <AcceptInviteInner />
    </Suspense>
  );
}
