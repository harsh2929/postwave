// SPDX-License-Identifier: AGPL-3.0-only
import { cn } from "@/lib/utils";

function Skeleton({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        // Directional shimmer sweep (a moving shine band) instead of a flat
        // pulse. The global prefers-reduced-motion guard stops the sweep and
        // leaves a calm static block for users who opt out.
        "relative overflow-hidden rounded-md bg-muted/70",
        "before:absolute before:inset-0 before:-translate-x-full before:animate-pw-shimmer before:bg-gradient-to-r before:from-transparent before:via-white/60 before:to-transparent dark:before:via-white/10",
        className,
      )}
      {...props}
    />
  );
}

export { Skeleton };
