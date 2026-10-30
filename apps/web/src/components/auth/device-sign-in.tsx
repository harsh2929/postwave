// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import {
  Clock3,
  Laptop,
  RefreshCw,
  ShieldCheck,
  Smartphone,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { CopyTextButton } from "@/components/copy-text-button";
import { QrCode } from "@/components/qr-code";
import { Button } from "@/components/ui/button";
import {
  cancelDeviceLogin,
  confirmDeviceLogin,
  devicePollDecision,
  pollDeviceLogin,
  startDeviceLogin,
  type DeviceLoginStart,
} from "@/lib/device-login";

type DeviceSignInPhase =
  | "starting"
  | "waiting"
  | "network"
  | "denied"
  | "expired"
  | "error"
  | "success";

interface PublicGrantDetails {
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
}

export function DeviceSignIn({
  onBack,
  onComplete,
  remember = false,
}: {
  onBack: () => void;
  onComplete: () => void;
  remember?: boolean;
}) {
  const [attempt, setAttempt] = useState(0);
  const [phase, setPhase] = useState<DeviceSignInPhase>("starting");
  const [details, setDetails] = useState<PublicGrantDetails | null>(null);
  const [remainingSeconds, setRemainingSeconds] = useState(0);
  const [message, setMessage] = useState<string | null>(null);

  // The possession credential never enters render state or browser storage.
  // Clearing this ref makes an unmounted/cancelled flow unrecoverable locally.
  const deviceCodeRef = useRef<string | null>(null);
  const onCompleteRef = useRef(onComplete);
  useEffect(() => {
    onCompleteRef.current = onComplete;
  }, [onComplete]);

  useEffect(() => {
    let ended = false;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;
    let countdownTimer: ReturnType<typeof setInterval> | null = null;
    const controller = new AbortController();

    let expiresAt = 0;
    let pollInterval = 5;
    let networkFailures = 0;
    let confirmationRequired = false;

    function clearTimers() {
      if (pollTimer !== null) clearTimeout(pollTimer);
      if (countdownTimer !== null) clearInterval(countdownTimer);
      pollTimer = null;
      countdownTimer = null;
    }

    function end(nextPhase: DeviceSignInPhase, nextMessage?: string) {
      if (ended) return;
      ended = true;
      clearTimers();
      deviceCodeRef.current = null;
      setPhase(nextPhase);
      setMessage(nextMessage ?? null);
    }

    function schedulePoll(delaySeconds: number) {
      if (ended) return;
      const remainingMs = expiresAt - Date.now();
      if (remainingMs <= 0) {
        const code = deviceCodeRef.current;
        if (code) void cancelDeviceLogin(code).catch(() => undefined);
        end("expired");
        return;
      }
      pollTimer = setTimeout(
        () => void poll(),
        Math.min(delaySeconds * 1000, remainingMs),
      );
    }

    async function poll() {
      if (ended) return;
      const deviceCode = deviceCodeRef.current;
      if (!deviceCode || Date.now() >= expiresAt) {
        end("expired");
        return;
      }
      try {
        if (confirmationRequired) {
          await confirmDeviceLogin(deviceCode, { signal: controller.signal });
        } else {
          const issued = await pollDeviceLogin(deviceCode, {
            signal: controller.signal,
          });
          confirmationRequired = true;
          // Approval can land at the authorization deadline. The server gives
          // receipt confirmation its own narrow lease, so do not expire the
          // client between Set-Cookie and its round-trip proof.
          expiresAt = Math.max(
            expiresAt,
            Date.now() + issued.confirmation_expires_in * 1000,
          );
          await confirmDeviceLogin(deviceCode, { signal: controller.signal });
        }
        if (ended) return;
        end("success");
        onCompleteRef.current();
      } catch (error) {
        if (ended || controller.signal.aborted) return;
        const decision = devicePollDecision(
          error,
          pollInterval,
          networkFailures + 1,
        );
        if (decision.kind === "retry") {
          if (decision.status === "network") {
            networkFailures += 1;
            setPhase("network");
            setMessage(
              "Connection interrupted. Keep this page open; we'll retry automatically.",
            );
          } else {
            networkFailures = 0;
            setPhase("waiting");
            setMessage(null);
          }
          // RFC 8628 slow_down raises the base interval for every later poll;
          // transport backoff is temporary and must not rewrite that base.
          if (decision.raiseInterval) {
            pollInterval = Math.max(pollInterval, decision.delaySeconds);
          }
          schedulePoll(decision.delaySeconds);
          return;
        }
        if (decision.kind === "denied") {
          end("denied");
          return;
        }
        if (decision.kind === "expired") {
          await cancelDeviceLogin(deviceCode).catch(() => undefined);
          end("expired");
          return;
        }
        if (confirmationRequired) {
          // Confirmation is idempotent. A malformed/lost acknowledgement may
          // have activated the exact provisional session, so retain the code
          // and retry instead of abandoning an untracked session.
          networkFailures += 1;
          setPhase("network");
          setMessage(
            "Finishing this sign-in was interrupted. Keep this page open; we'll retry safely.",
          );
          schedulePoll(Math.min(30, pollInterval * 2 ** Math.min(3, networkFailures)));
          return;
        }
        // A browser applies Set-Cookie before JavaScript parses a 200 body.
        // Therefore a malformed/truncated exchange response may already have
        // installed a provisional session even though pollDeviceLogin threw.
        // Retain the exact capability and replay the poll; the server returns
        // the same cookie, never a second session. Expiry/unmount exact-cancels.
        networkFailures += 1;
        setPhase("network");
        setMessage(
          "The sign-in response was incomplete. Keep this page open; we'll retry safely.",
        );
        schedulePoll(Math.min(30, pollInterval * 2 ** Math.min(3, networkFailures)));
      }
    }

    async function begin() {
      setPhase("starting");
      setMessage(null);
      setDetails(null);
      setRemainingSeconds(0);
      deviceCodeRef.current = null;
      try {
        const started: DeviceLoginStart = await startDeviceLogin(
          window.location.origin,
          { signal: controller.signal, remember },
        );
        if (ended || controller.signal.aborted) return;
        deviceCodeRef.current = started.deviceCode;
        expiresAt = Date.now() + started.expiresIn * 1000;
        pollInterval = started.interval;
        setDetails({
          userCode: started.userCode,
          verificationUri: started.verificationUri,
          verificationUriComplete: started.verificationUriComplete,
        });
        setRemainingSeconds(started.expiresIn);
        setPhase("waiting");
        countdownTimer = setInterval(() => {
          if (ended) return;
          const remaining = Math.max(
            0,
            Math.ceil((expiresAt - Date.now()) / 1000),
          );
          setRemainingSeconds(remaining);
          if (remaining === 0) {
            const code = deviceCodeRef.current;
            if (code) void cancelDeviceLogin(code).catch(() => undefined);
            end("expired");
          }
        }, 1000);
        // RFC 8628 clients wait at least `interval` before the first poll.
        schedulePoll(pollInterval);
      } catch (error) {
        if (ended || controller.signal.aborted) return;
        end(
          "error",
          error instanceof Error
            ? error.message
            : "Could not start device sign-in.",
        );
      }
    }

    void begin();
    return () => {
      ended = true;
      clearTimers();
      const pendingDeviceCode = deviceCodeRef.current;
      deviceCodeRef.current = null;
      controller.abort();
      if (pendingDeviceCode) {
        // Best effort: expiry still closes the grant if navigation/offline
        // prevents the cancellation request from reaching the API.
        void cancelDeviceLogin(pendingDeviceCode).catch(() => undefined);
      }
    };
  }, [attempt, remember]);

  const retry = () => setAttempt((value) => value + 1);

  if (phase === "starting") {
    return (
      <div className="space-y-4" aria-live="polite">
        <div className="flex items-center justify-center rounded-lg border bg-muted/30 p-10">
          <RefreshCw
            className="size-6 animate-spin text-muted-foreground"
            aria-hidden
          />
          <span className="sr-only">Starting secure device sign-in…</span>
        </div>
        <Button type="button" variant="ghost" onClick={onBack}>
          Back to sign in
        </Button>
      </div>
    );
  }

  if (phase === "error" || phase === "expired" || phase === "denied") {
    const title =
      phase === "denied"
        ? "Sign-in request denied"
        : phase === "expired"
          ? "This code expired"
          : "Could not start device sign-in";
    const body =
      phase === "denied"
        ? "The signed-in device denied this request. No session was created."
        : phase === "expired"
          ? "For your security, device codes expire quickly. Start again for a new code."
          : (message ?? "Check your connection and try again.");
    return (
      <div className="space-y-4" role="alert">
        <div className="rounded-lg border p-4">
          <p className="font-medium">{title}</p>
          <p className="mt-1 text-sm text-muted-foreground">{body}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button type="button" onClick={retry}>
            Try again
          </Button>
          <Button type="button" variant="ghost" onClick={onBack}>
            Use another sign-in method
          </Button>
        </div>
      </div>
    );
  }

  if (phase === "success") {
    return (
      <div
        className="flex items-center gap-3 rounded-lg border border-emerald-500/40 bg-emerald-500/5 p-4"
        role="status"
      >
        <ShieldCheck className="size-5 text-emerald-600" aria-hidden />
        <div>
          <p className="font-medium">Approved</p>
          <p className="text-sm text-muted-foreground">Finishing sign-in…</p>
        </div>
      </div>
    );
  }

  if (!details) return null;

  return (
    <div className="space-y-5">
      <ol className="space-y-3 text-sm">
        <li className="flex gap-3">
          <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground">
            1
          </span>
          <span>
            On a phone or computer where you&apos;re already signed in to
            Moosewave, open the camera or Moosewave scanner.
          </span>
        </li>
        <li className="flex gap-3">
          <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground">
            2
          </span>
          <span>
            Scan this QR code, review this browser&apos;s details, then approve.
          </span>
        </li>
      </ol>

      <div className="flex justify-center rounded-lg border bg-white p-4">
        <QrCode
          value={details.verificationUriComplete}
          size={200}
          ariaLabel="QR code to approve this Moosewave browser sign-in"
          fallbackMessage="Couldn't render the QR code. Use the web address and code below."
        />
      </div>

      <div className="rounded-lg border bg-muted/20 p-4 text-center">
        <div className="flex items-center justify-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          <Laptop className="size-3.5" aria-hidden />
          Matching code
        </div>
        <code className="mt-2 block text-2xl font-semibold tracking-[0.22em] text-foreground">
          {details.userCode}
        </code>
        <p className="mt-2 text-xs text-muted-foreground">
          Approve only if the signed-in device shows this exact code.
        </p>
      </div>

      <details className="rounded-lg border px-4 py-3">
        <summary className="cursor-pointer text-sm font-medium">
          Can&apos;t scan the QR code?
        </summary>
        <div className="mt-3 space-y-3 text-sm text-muted-foreground">
          <p>
            On the signed-in device, open this address and enter the matching
            code above:
          </p>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded bg-muted px-2 py-1.5 text-xs text-foreground">
              {details.verificationUri}
            </code>
            <CopyTextButton
              value={details.verificationUri}
              label="Copy address"
              copiedLabel="Copied"
              toastOnCopy={false}
            />
          </div>
        </div>
      </details>

      <div
        className="flex items-center justify-between gap-3 text-xs text-muted-foreground"
        aria-live="polite"
      >
        <span className="inline-flex items-center gap-1.5">
          {phase === "network" ? (
            <RefreshCw className="size-3.5 animate-spin" aria-hidden />
          ) : (
            <Smartphone className="size-3.5" aria-hidden />
          )}
          {phase === "network" ? message : "Waiting for approval…"}
        </span>
        <span className="inline-flex shrink-0 items-center gap-1.5">
          <Clock3 className="size-3.5" aria-hidden />
          {formatCountdown(remainingSeconds)}
        </span>
      </div>

      <p className="text-xs text-muted-foreground">
        The code never signs in by itself. Review the device details before
        approving, and don&apos;t share the code or QR image with anyone.{" "}
        {remember
          ? "This browser requested a persistent session that you can revoke from Active devices."
          : "This browser session closes with the browser and expires server-side within 12 hours."}
      </p>

      <Button type="button" variant="ghost" onClick={onBack}>
        Use another sign-in method
      </Button>
    </div>
  );
}

function formatCountdown(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const minutesPart = Math.floor(seconds / 60);
  const secondsPart = String(seconds % 60).padStart(2, "0");
  return `${minutesPart}:${secondsPart}`;
}
