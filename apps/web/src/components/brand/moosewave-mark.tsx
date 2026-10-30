// SPDX-License-Identifier: AGPL-3.0-only
import type { HTMLAttributes, SVGProps } from "react";

import { cn } from "@/lib/utils";

/**
 * The Moosewave mark used by the public design language.
 *
 * Keep the face cut-outs tied to `--mw-logo-cutout` so the same mark works on
 * paper, ink, and application surfaces without maintaining separate assets.
 */
export function MoosewaveMark({
  className,
  ...props
}: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 64 64"
      fill="currentColor"
      className={cn("shrink-0", className)}
      aria-hidden="true"
      focusable="false"
      shapeRendering="geometricPrecision"
      {...props}
    >
      <g fill="currentColor">
        <path d="M30 28C26 26 22 23 17 23 11 23 6 20 5 16L7 11 13 12 15 15 14 9 19 7 21 13 24 9 29 10 28 17 31 22 30 28ZM34 28C38 26 42 23 47 23 53 23 58 20 59 16L57 11 51 12 49 15 50 9 45 7 43 13 40 9 35 10 36 17 33 22 34 28Z" />
        <path d="M22 25Q32 18 42 25L41 37C40.5 43 38.5 48 36 51 34 53.5 30 53.5 28 51 25.5 48 23.5 43 23 37L22 25Z" />
        <path
          d="M24 37C27 33 30 33 32 36 34 39 37 39 40 35"
          fill="none"
          stroke="var(--mw-logo-cutout, #fffbee)"
          strokeWidth="3.2"
          strokeLinecap="round"
        />
        <circle cx="37" cy="38" r="3.6" fill="var(--mw-logo-cutout, #fffbee)" />
        <circle cx="37" cy="38" r="1.35" />
      </g>
    </svg>
  );
}

export function MoosewaveWordmark({
  className,
  markClassName,
  labelClassName,
  compact = false,
  ...props
}: Omit<HTMLAttributes<HTMLSpanElement>, "children"> & {
  markClassName?: string;
  labelClassName?: string;
  compact?: boolean;
}) {
  return (
    <span
      className={cn(
        "inline-flex min-w-0 items-center gap-2.5 text-mw-ink",
        className,
      )}
      {...props}
    >
      <MoosewaveMark
        className={cn("size-8", markClassName)}
        style={{ color: "var(--mw-red)" }}
      />
      {compact ? null : (
        <span
          className={cn(
            "truncate font-display font-normal uppercase leading-none",
            labelClassName,
          )}
          style={{ fontSize: "1.55rem", letterSpacing: "-0.02em" }}
        >
          Moosewave
        </span>
      )}
    </span>
  );
}
