// SPDX-License-Identifier: AGPL-3.0-only
//
// Status pill. Ops status is life-or-death scannable, so it reads as a tinted
// pill with a dot, not bare colored text — and never relies on color alone (the
// label carries the meaning too).
import type { ReactNode } from "react";

export type BadgeVariant = "red" | "amber" | "green" | "info" | "neutral";

export default function Badge({
  variant = "neutral",
  muted = false,
  children,
}: {
  variant?: BadgeVariant;
  muted?: boolean;
  children: ReactNode;
}) {
  const className = [
    "badge",
    variant !== "neutral" ? `badge--${variant}` : "",
    muted ? "badge--muted" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return <span className={className}>{children}</span>;
}
