// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { Check } from "lucide-react";

import { MIN_PASSWORD_LENGTH, evaluatePassword } from "@/lib/password-strength";
import { cn } from "@/lib/utils";

/**
 * Live password strength + length feedback (AUTH-004). Reused by signup and
 * reset-password so the length requirement reflects met/unmet as the user
 * types — no longer a submit-only block error. Advisory only; submit stays
 * validated server-side.
 */
export function PasswordStrengthMeter({
  password,
  helperId,
}: {
  password: string;
  /** id so the field can reference this via aria-describedby. */
  helperId?: string;
}) {
  const empty = password.length === 0;
  const { lengthMet, score, label, percent } = evaluatePassword(password);

  const barColor =
    score >= 4
      ? "bg-success"
      : score >= 3
        ? "bg-success/80"
        : score >= 2
          ? "bg-warning-emphasis"
          : "bg-destructive";

  return (
    <div className="space-y-1.5">
      <div
        className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
        role="presentation"
      >
        <div
          className={cn(
            "h-full rounded-full transition-[width,background-color] duration-200 ease-pw-out",
            empty ? "bg-transparent" : barColor,
          )}
          style={{ width: empty ? "0%" : `${Math.max(percent, 8)}%` }}
        />
      </div>
      <p
        id={helperId}
        aria-live="polite"
        className={cn(
          "flex items-center gap-1 text-xs",
          lengthMet ? "text-success" : "text-muted-foreground",
        )}
      >
        {lengthMet ? (
          <Check className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        ) : null}
        {empty
          ? `At least ${MIN_PASSWORD_LENGTH} characters.`
          : lengthMet
            ? `Strength: ${label}`
            : `At least ${MIN_PASSWORD_LENGTH} characters (${password.length}/${MIN_PASSWORD_LENGTH}).`}
      </p>
    </div>
  );
}
