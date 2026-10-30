// SPDX-License-Identifier: AGPL-3.0-only
//
// Shown when middleware/dashboard notices the session lacks `mfa_satisfied`
// but the account has TOTP enrolled. The user enters their 6-digit code (or
// a recovery code via the toggle) → POST /totp/challenge.
"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState, type FormEvent } from "react";
import { Download } from "lucide-react";

import { ApiError } from "@/lib/api";
import { genericAuthErrorMessage } from "@/lib/auth-errors";
import { OTP_LENGTH, isOtpComplete, sanitizeOtp } from "@/lib/otp";
import { downloadTextFile } from "@/lib/download";
import {
  totpChallenge,
  totpEnroll,
  totpVerify,
  whoami,
  type TotpEnrollResponse,
} from "@/lib/auth-api";
import { safeNextPath } from "@/lib/safe-navigation";
import { asRoute } from "@/lib/typed-routes";
import { AuthShell } from "@/components/auth/auth-shell";
import { CopyTextButton } from "@/components/copy-text-button";
import { QrCode } from "@/components/qr-code";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const RECOVERY_FILENAME = "postwave-recovery-codes.txt";

function recoveryFileBody(codes: string[]): string {
  return [
    "Moosewave recovery codes",
    "Keep these somewhere safe. Each code can be used once.",
    "",
    ...codes,
  ].join("\n");
}

export default function TotpChallengePage() {
  return (
    <Suspense fallback={<TotpChallengeFallback />}>
      <TotpChallengeInner />
    </Suspense>
  );
}

function TotpChallengeFallback() {
  return (
    <AuthShell skipLabel="two-factor authentication">
      <Card>
        <CardContent className="p-6 text-sm text-muted-foreground">
          Loading…
        </CardContent>
      </Card>
    </AuthShell>
  );
}

function TotpChallengeInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  // Device-grant approval can require source-session step-up. Preserve only
  // that exact same-origin consent route in addition to the normal /app tree.
  const next = safeNextPath(searchParams.get("next"), {
    extraPrefixes: ["/cli/auth"],
  });

  const [gate, setGate] = useState<
    "loading" | "enroll" | "setup" | "challenge"
  >("loading");
  const [enrollment, setEnrollment] = useState<TotpEnrollResponse | null>(null);
  const [mode, setMode] = useState<"code" | "recovery">("code");
  const [code, setCode] = useState("");
  const [recovery, setRecovery] = useState("");
  const [ackSaved, setAckSaved] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const codeInputRef = useRef<HTMLInputElement>(null);
  const recoveryInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let active = true;
    void whoami()
      .then((me) => {
        if (!active) return;
        if (!me.mfa_required || me.mfa_satisfied) {
          router.replace(asRoute(next));
          router.refresh();
          return;
        }
        setGate(me.totp_enabled ? "challenge" : "enroll");
      })
      .catch(() => {
        if (!active) return;
        // Never surface the raw ApiError string (e.g. "GET /api/v1/auth/me
        // failed: 401 …"). Fall through to the challenge form so a user with a
        // real authenticator can still proceed (AUTH-011).
        setError(
          "We couldn't load your two-factor status. Enter your code to continue, or try again.",
        );
        setGate("challenge");
      });
    return () => {
      active = false;
    };
  }, [next, router]);

  useEffect(() => {
    if (gate !== "challenge") return;
    if (mode === "code") {
      codeInputRef.current?.focus();
    } else {
      recoveryInputRef.current?.focus();
    }
  }, [gate, mode]);

  async function performSubmit() {
    setError(null);
    setSubmitting(true);
    try {
      if (gate === "setup") {
        await totpVerify(code);
      } else if (mode === "code") {
        await totpChallenge({ code });
      } else {
        await totpChallenge({ recovery_code: recovery });
      }
      router.push(asRoute(next));
      router.refresh();
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.status === 401 || err.status === 400) {
          setError(
            mode === "code" || gate === "setup"
              ? "That code didn't work. Try again."
              : "That recovery code didn't work.",
          );
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

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    void performSubmit();
  }

  // Auto-submit the moment a full 6-digit code is entered on the challenge
  // (AUTH-017). Only in the challenge (not the setup step, which gates verify
  // behind the "saved my recovery codes" acknowledgment). Guarded so it fires
  // once per completed code and never while a request is in flight.
  const autoSubmittedRef = useRef<string | null>(null);
  useEffect(() => {
    if (gate !== "challenge" || mode !== "code") return;
    if (!isOtpComplete(code)) {
      autoSubmittedRef.current = null;
      return;
    }
    if (submitting || autoSubmittedRef.current === code) return;
    autoSubmittedRef.current = code;
    void performSubmit();
    // performSubmit intentionally omitted — it closes over the same state the
    // deps already track; including it would re-run every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code, gate, mode, submitting]);

  async function startEnrollment() {
    setError(null);
    setSubmitting(true);
    try {
      const data = await totpEnroll();
      setEnrollment(data);
      setGate("setup");
    } catch (err) {
      setError(genericAuthErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AuthShell skipLabel="two-factor authentication">
      <Card>
        <CardHeader>
          <CardTitle as="h1">Two-factor authentication</CardTitle>
          <CardDescription>
            {gate === "loading"
              ? "Checking your authentication status…"
              : gate === "enroll"
                ? "Your workspace requires two-factor authentication. Set it up to continue."
                : gate === "setup"
                  ? "Add Moosewave to your authenticator, save the recovery codes, then verify a code."
                  : mode === "code"
                    ? "Enter the 6-digit code from your authenticator app."
                    : "Enter one of your saved recovery codes."}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {gate === "loading" && (
            <p className="text-sm text-muted-foreground">Loading…</p>
          )}
          {gate === "enroll" && (
            <div className="space-y-4" aria-busy={submitting || undefined}>
              <p className="text-sm text-muted-foreground">
                You must enroll an authenticator before the dashboard can be
                opened.
              </p>
              {error && (
                <p className="text-sm text-destructive" role="alert">
                  {error}
                </p>
              )}
              <Button
                type="button"
                className="w-full"
                disabled={submitting}
                onClick={() => void startEnrollment()}
              >
                {submitting ? "Starting…" : "Set up two-factor authentication"}
              </Button>
            </div>
          )}
          {gate === "setup" && enrollment && (
            <div className="space-y-4">
              <div className="space-y-2">
                <Label>Scan with your authenticator</Label>
                <div className="flex justify-center rounded-md border bg-background p-4">
                  <QrCode value={enrollment.otpauth_uri} size={168} />
                </div>
              </div>
              <div className="space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                  <Label>Setup URI</Label>
                  <CopyTextButton
                    value={enrollment.otpauth_uri}
                    label="Copy URI"
                  />
                </div>
                <code className="block break-all rounded-md border bg-muted/50 p-2 text-xs">
                  {enrollment.otpauth_uri}
                </code>
                <p className="text-xs text-muted-foreground">
                  Can&apos;t scan? Paste this otpauth:// URI into your
                  authenticator instead.
                </p>
              </div>
              <div className="space-y-1.5">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <Label>Recovery codes</Label>
                  <div className="grid grid-cols-2 gap-2 sm:flex">
                    <CopyTextButton
                      value={enrollment.recovery_codes.join("\n")}
                      label="Copy all"
                      className="w-full sm:w-auto"
                    />
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="w-full sm:w-auto"
                      onClick={() =>
                        downloadTextFile(
                          RECOVERY_FILENAME,
                          recoveryFileBody(enrollment.recovery_codes),
                        )
                      }
                    >
                      <Download className="h-3.5 w-3.5" />
                      Download
                    </Button>
                  </div>
                </div>
                <div className="grid min-w-0 grid-cols-1 gap-1 rounded-md border bg-muted/30 p-3 min-[360px]:grid-cols-2">
                  {enrollment.recovery_codes.map((recoveryCode) => (
                    <code
                      key={recoveryCode}
                      className="min-w-0 break-all text-xs"
                    >
                      {recoveryCode}
                    </code>
                  ))}
                </div>
                <p className="text-xs text-muted-foreground">
                  Save these now; they are only shown once.
                </p>
                <label className="flex min-h-11 items-start gap-2 pt-1 text-sm">
                  <Checkbox
                    checked={ackSaved}
                    onChange={(e) => setAckSaved(e.target.checked)}
                    disabled={submitting}
                    className="mt-0.5"
                  />
                  <span>I have saved my recovery codes.</span>
                </label>
              </div>
            </div>
          )}
          {(gate === "challenge" || gate === "setup") && (
            <form
              onSubmit={onSubmit}
              className="space-y-4"
              aria-busy={submitting || undefined}
            >
              {mode === "code" || gate === "setup" ? (
                <div className="space-y-1.5">
                  <Label htmlFor="code">Authentication code</Label>
                  <Input
                    ref={codeInputRef}
                    id="code"
                    type="text"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    autoFocus={gate === "challenge"}
                    pattern="[0-9]{6}"
                    maxLength={OTP_LENGTH}
                    required
                    value={code}
                    onChange={(e) => setCode(sanitizeOtp(e.target.value))}
                    disabled={submitting}
                    className="text-center text-lg tracking-[0.4em]"
                  />
                </div>
              ) : (
                <div className="space-y-1.5">
                  <Label htmlFor="recovery">Recovery code</Label>
                  <Input
                    ref={recoveryInputRef}
                    id="recovery"
                    type="text"
                    autoComplete="off"
                    autoFocus
                    required
                    value={recovery}
                    onChange={(e) => setRecovery(e.target.value)}
                    disabled={submitting}
                  />
                </div>
              )}
              {error && (
                <p className="text-sm text-destructive" role="alert">
                  {error}
                </p>
              )}
              <Button
                type="submit"
                className="w-full"
                disabled={submitting || (gate === "setup" && !ackSaved)}
              >
                {submitting ? "Verifying…" : "Verify"}
              </Button>
            </form>
          )}
          {gate === "challenge" && (
            <div className="text-center text-sm">
              <Button
                type="button"
                variant="link"
                className="min-h-11 whitespace-normal text-muted-foreground hover:text-foreground"
                onClick={() => {
                  setError(null);
                  if (mode === "code") {
                    setCode("");
                    autoSubmittedRef.current = "";
                  } else {
                    setRecovery("");
                  }
                  setMode(mode === "code" ? "recovery" : "code");
                }}
              >
                {mode === "code"
                  ? "Use a recovery code instead"
                  : "Use your authenticator app instead"}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </AuthShell>
  );
}

// safeNextPath imported from @/lib/safe-navigation — see audit
// finding (frontend nav): the two private copies had drifted and
// neither was test-covered. The TOTP page deliberately does NOT
// pass extraPrefixes because once you reach TOTP challenge you've
// already authenticated; the next path must be a dashboard route.
