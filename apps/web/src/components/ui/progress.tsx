// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import * as React from "react";
import * as ProgressPrimitive from "@radix-ui/react-progress";

import { cn } from "@/lib/utils";

export function normalizeProgressValue(
  value: number | null | undefined,
): number | null {
  if (value == null) return null;
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

type ProgressPrimitiveProps = React.ComponentPropsWithoutRef<
  typeof ProgressPrimitive.Root
>;

/** Progress is semantic, so every instance must explain what is progressing. */
type ProgressProps = Omit<
  ProgressPrimitiveProps,
  "aria-label" | "aria-labelledby"
> &
  (
    | { "aria-label": string; "aria-labelledby"?: never }
    | { "aria-label"?: never; "aria-labelledby": string }
  );

const Progress = React.forwardRef<
  React.ElementRef<typeof ProgressPrimitive.Root>,
  ProgressProps
>(({ className, value, ...props }, ref) => {
  const normalizedValue = normalizeProgressValue(value);

  return (
    <ProgressPrimitive.Root
      ref={ref}
      value={normalizedValue}
      data-slot="progress"
      className={cn(
        "relative h-2 w-full overflow-hidden rounded-full bg-mw-pink-soft ring-1 ring-mw-ink/10",
        className,
      )}
      {...props}
    >
      <ProgressPrimitive.Indicator
        data-slot="progress-indicator"
        className="h-full w-full flex-1 bg-mw-blue transition-transform"
        style={{
          transform: `translateX(-${100 - (normalizedValue ?? 0)}%)`,
        }}
      />
    </ProgressPrimitive.Root>
  );
});
Progress.displayName = ProgressPrimitive.Root.displayName;

export { Progress };
