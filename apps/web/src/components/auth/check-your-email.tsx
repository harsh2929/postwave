// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  RESEND_COOLDOWN_SECONDS,
  remainingCooldownSeconds,
} from "@/lib/resend-cooldown";

/**
 * Shared "check your email" confirmation for the forgot-password and magic-link
 * start flows (AUTH-010). Echoes the address the user typed (not a leak — they
 * entered it), offers a Resend with a visible cooldown, and a one-tap open-mail
 * shortcut for common providers.
 *
 * Anti-enumeration: the copy stays conditional ("If an account exists for …"),
 * so echoing the address never confirms whether it is registered.
 */
const WEBMAIL_PROVIDERS: { test: RegExp; label: string; url: string }[] = [
  {
    test: /@(?:gmail|googlemail)\.com$/i,
    label: "Open Gmail",
    url: "https://mail.google.com/mail/u/0/",
  },
  {
    test: /@(?:outlook|hotmail|live|msn)\.[a-z.]+$/i,
    label: "Open Outlook",
    url: "https://outlook.live.com/mail/0/",
  },
  {
    test: /@yahoo\.[a-z.]+$/i,
    label: "Open Yahoo Mail",
    url: "https://mail.yahoo.com/",
  },
  {
    test: /@(?:icloud|me|mac)\.com$/i,
    label: "Open iCloud Mail",
    url: "https://www.icloud.com/mail/",
  },
  {
    test: /@(?:proton|protonmail|pm)\.me$/i,
    label: "Open Proton Mail",
    url: "https://mail.proton.me/",
  },
];

function webmailShortcut(email: string) {
  const at = email.indexOf("@");
  if (at === -1) return null;
  return WEBMAIL_PROVIDERS.find((p) => p.test.test(email.trim())) ?? null;
}

export function CheckYourEmail({
  email,
  sentDescription,
  onResend,
}: {
  email: string;
  /** e.g. "a reset link is on the way." — completes "…, <sentDescription>". */
  sentDescription: string;
  /** Re-triggers the start endpoint. Should swallow errors (non-enumeration). */
  onResend: () => Promise<void>;
}) {
  const statusRef = useRef<HTMLDivElement>(null);
  // Seed a cooldown immediately — the first email was just sent on submit.
  const [endsAt, setEndsAt] = useState<number>(
    () => Date.now() + RESEND_COOLDOWN_SECONDS * 1000,
  );
  const [remaining, setRemaining] = useState(RESEND_COOLDOWN_SECONDS);
  const [resending, setResending] = useState(false);

  useEffect(() => {
    // The submitted form (including its focused submit button) is replaced by
    // this confirmation. Give keyboard and screen-reader users a deterministic
    // landing point instead of dropping focus back to <body>.
    statusRef.current?.focus();
  }, []);

  useEffect(() => {
    const tick = () =>
      setRemaining(remainingCooldownSeconds(Date.now(), endsAt));
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [endsAt]);

  async function handleResend() {
    setResending(true);
    try {
      await onResend();
    } finally {
      setResending(false);
      setEndsAt(Date.now() + RESEND_COOLDOWN_SECONDS * 1000);
    }
  }

  const shortcut = webmailShortcut(email);
  const cooling = remaining > 0;

  return (
    <div className="space-y-4">
      <div
        ref={statusRef}
        role="status"
        tabIndex={-1}
        className="space-y-1 rounded-md border bg-muted/30 p-4 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      >
        <p>
          If an account exists for{" "}
          <span className="font-medium text-foreground break-all">{email}</span>
          , {sentDescription}
        </p>
        <p className="text-xs text-muted-foreground">
          Check your inbox (and spam folder, just in case).
        </p>
      </div>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Button
          type="button"
          variant="outline"
          className="flex-1"
          onClick={() => void handleResend()}
          disabled={resending || cooling}
        >
          {resending
            ? "Resending…"
            : cooling
              ? `Resend in ${remaining}s`
              : "Resend email"}
        </Button>
        {shortcut ? (
          <Button asChild variant="ghost" className="flex-1">
            <a href={shortcut.url} target="_blank" rel="noopener noreferrer">
              {shortcut.label}
            </a>
          </Button>
        ) : null}
      </div>
    </div>
  );
}
