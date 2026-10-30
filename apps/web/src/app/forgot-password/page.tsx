// SPDX-License-Identifier: AGPL-3.0-only
//
// Forgot-password entry. Always shows the same "If an account exists…"
// confirmation regardless of whether the address actually exists — backend
// already returns 202 unconditionally for the same reason. Both layers agree
// not to leak existence.
"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";

import { passwordResetStart } from "@/lib/auth-api";
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

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    try {
      // Intentionally swallow errors — the UX is identical regardless of the
      // underlying response so we don't leak whether the email is registered.
      await passwordResetStart(email).catch(() => undefined);
    } finally {
      setSubmitting(false);
      setSubmitted(true);
    }
  }

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
          <CardTitle as="h1">Reset your password</CardTitle>
          <CardDescription>
            Enter your email and we&apos;ll send you a link to reset your
            password.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {submitted ? (
            <CheckYourEmail
              email={email}
              sentDescription="a reset link is on the way."
              onResend={() =>
                passwordResetStart(email)
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
                {submitting ? "Sending…" : "Send reset link"}
              </Button>
            </form>
          )}
        </CardContent>
      </Card>
    </AuthShell>
  );
}
