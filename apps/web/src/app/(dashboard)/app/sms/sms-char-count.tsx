// SPDX-License-Identifier: AGPL-3.0-only

import { cn } from "@/lib/utils";

/**
 * Live remaining-character counter for the SMS/MMS composers. Counts by code
 * point (matching how maxLength truncates surrogate pairs is imperfect, but
 * `[...body]` is the correct visible-character count) and warns as the 1400
 * cap approaches so long messages aren't silently truncated (audit SMS-042).
 */
export function SmsCharCount({ body, max }: { body: string; max: number }) {
  const used = [...body].length;
  const remaining = max - used;
  const nearLimit = remaining <= 40;
  const atLimit = remaining <= 0;
  return (
    <span
      aria-live="polite"
      className={cn(
        "text-xs tabular-nums text-muted-foreground",
        nearLimit && "text-warning-emphasis",
        atLimit && "text-destructive",
      )}
    >
      {remaining.toLocaleString()} left
    </span>
  );
}
