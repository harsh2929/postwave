// SPDX-License-Identifier: AGPL-3.0-only
"use client";

/**
 * StepUpPrompt — the dialog a step-up challenge raises instead of a logout.
 *
 * Mounted once in the dashboard shell. It listens for `STEP_UP_PROMPT_EVENT`,
 * claims the prompt (see `StepUpPromptDetail.claim` — an unclaimed challenge
 * gives up immediately rather than hanging the request), takes a live
 * authenticator code, and reports back so the transport can retry the original
 * request.
 *
 * It shows the SERVER's sentence. `Requirement.Reason` is written for the
 * person and lives next to the policy it explains ("Confirm it's you before
 * exporting subscriber data."); re-deriving copy from the action id here would
 * be the second, drifting half of a rule that exists once on purpose. The
 * action id is shown alongside it, so what is being authorised is never left
 * implicit.
 *
 * The verb is `totpVerify`, not `totpChallenge` — see the note in lib/step-up.ts:
 * `/totp/challenge` returns `{already:true}` without refreshing
 * `mfa_satisfied_at` for a session that is MFA-satisfied but stale, which is
 * exactly this case.
 */

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { ShieldCheck } from "lucide-react";

import { ApiError } from "@/lib/api";
import { genericAuthErrorMessage } from "@/lib/auth-errors";
import { OTP_LENGTH, isOtpComplete, sanitizeOtp } from "@/lib/otp";
import { totpVerify } from "@/lib/auth-api";
import {
  STEP_UP_PROMPT_EVENT,
  formatStepUpAction,
  type StepUpChallenge,
  type StepUpPromptDetail,
} from "@/lib/step-up";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface OpenPrompt {
  challenge: StepUpChallenge;
  settle(proved: boolean): void;
}

export function StepUpPrompt({ onReady }: { onReady?: () => void } = {}) {
  const [prompt, setPrompt] = useState<OpenPrompt | null>(null);
  const [code, setCode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onChallenge = (event: Event): void => {
      const detail = (event as CustomEvent<StepUpPromptDetail>).detail;
      if (!detail || typeof detail.claim !== "function") return;
      if (!detail.claim()) return;
      setCode("");
      setError(null);
      setSubmitting(false);
      setPrompt({ challenge: detail.challenge, settle: detail.settle });
    };
    window.addEventListener(STEP_UP_PROMPT_EVENT, onChallenge);
    return () => window.removeEventListener(STEP_UP_PROMPT_EVENT, onChallenge);
  }, []);

  // The dashboard shell stays inert until this callback runs. This effect is
  // deliberately declared after the listener effect above: React runs passive
  // effects in declaration order, so reporting readiness means a challenge can
  // already be claimed synchronously, not merely that the dialog chunk loaded.
  useEffect(() => onReady?.(), [onReady]);

  // A prompt left unsettled is a request that never resolves. Unmounting mid
  // prompt (a route change, an error boundary) must therefore answer "no", not
  // silently drop the question.
  const promptRef = useRef<OpenPrompt | null>(null);
  promptRef.current = prompt;
  useEffect(() => {
    return () => promptRef.current?.settle(false);
  }, []);

  const dismiss = useCallback(() => {
    setPrompt((current) => {
      current?.settle(false);
      return null;
    });
  }, []);

  const submit = useCallback(async () => {
    if (!prompt) return;
    setError(null);
    setSubmitting(true);
    try {
      await totpVerify(code);
      // Clear before settling: settling lets the original request retry, and a
      // stale code left in the field would auto-submit again if a second
      // challenge arrives.
      setCode("");
      setPrompt(null);
      prompt.settle(true);
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.code === "not_enrolled") {
          setError(
            "This action needs two-factor authentication, which isn't set up on your account. Add an authenticator in Settings → Security, then try again.",
          );
          return;
        }
        if (err.status === 401 || err.status === 400) {
          setError("That code didn't work. Try again.");
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
  }, [code, prompt]);

  // Auto-submit on a complete code, matching the TOTP challenge page (AUTH-017)
  // so the two possession prompts in the product behave the same way.
  const autoSubmittedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!prompt) {
      autoSubmittedRef.current = null;
      return;
    }
    if (!isOtpComplete(code)) {
      autoSubmittedRef.current = null;
      return;
    }
    if (submitting || autoSubmittedRef.current === code) return;
    autoSubmittedRef.current = code;
    void submit();
  }, [code, prompt, submitting, submit]);

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    void submit();
  }

  if (!prompt) return null;
  const actionLabel = formatStepUpAction(prompt.challenge.action);
  return (
    <Dialog open onOpenChange={(next) => (next ? null : dismiss())}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-muted-foreground" aria-hidden />
            Confirm it&apos;s you
          </DialogTitle>
          <DialogDescription>{prompt.challenge.reason}</DialogDescription>
        </DialogHeader>
        {actionLabel ? (
          <p className="text-xs text-muted-foreground">
            Action:{" "}
            <span className="font-mono text-foreground">{actionLabel}</span>
          </p>
        ) : null}
        <form onSubmit={onSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="step-up-code">Authentication code</Label>
            <Input
              id="step-up-code"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              autoFocus
              pattern="[0-9]{6}"
              maxLength={OTP_LENGTH}
              required
              value={code}
              onChange={(e) => setCode(sanitizeOtp(e.target.value))}
              disabled={submitting}
              className="text-center text-lg tracking-[0.4em]"
            />
            <p className="text-xs text-muted-foreground">
              Enter the 6-digit code from your authenticator app. Recovery codes
              can&apos;t be used to confirm a sensitive action.
            </p>
          </div>
          {error && (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          )}
          <DialogFooter className="gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={dismiss}
              disabled={submitting}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={submitting}>
              {submitting ? "Confirming…" : "Confirm"}
            </Button>
          </DialogFooter>
        </form>
        <p className="text-xs text-muted-foreground">
          You&apos;re still signed in. This only confirms you&apos;re still here
          before a sensitive action.
        </p>
      </DialogContent>
    </Dialog>
  );
}
