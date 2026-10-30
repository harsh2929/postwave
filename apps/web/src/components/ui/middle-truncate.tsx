// SPDX-License-Identifier: AGPL-3.0-only

//
// A value that loses its MIDDLE when the column is too narrow, not its end.
//
// End-truncation (`truncate` on its own) is wrong for identifiers that share a
// prefix. A directory of verification addresses rendered every row as
// "verify-check…" at 1440 px: the rows were indistinguishable, and the full
// value was nowhere — not even in a tooltip. What tells those rows apart is the
// end (the unique suffix and the domain), so that is the part that must stay.
//
// No measuring and no JavaScript at render time: the head is the flexible half
// and gets the ellipsis, the tail never shrinks. With room, the two halves read
// as one string; without, the browser puts the ellipsis exactly between them.

import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * How many trailing characters are always kept. Long enough for a domain plus a
 * few characters of what precedes it, which is what distinguishes addresses
 * generated from one template.
 */
export const MIDDLE_TRUNCATE_TAIL = 14;

/** The two halves of `value`: everything before the kept tail, and the tail. */
export function splitForMiddleTruncation(
  value: string,
  tailLength: number = MIDDLE_TRUNCATE_TAIL,
): { head: string; tail: string } {
  const safeTail = Math.max(0, Math.trunc(tailLength));
  // A value that is all tail has nothing to truncate; keep it in one piece so
  // it can wrap or ellipsize normally rather than being pinned unshrinkable.
  if (safeTail === 0 || value.length <= safeTail) return { head: value, tail: "" };
  return {
    head: value.slice(0, value.length - safeTail),
    tail: value.slice(value.length - safeTail),
  };
}

export function MiddleTruncate({
  value,
  className,
  tailLength = MIDDLE_TRUNCATE_TAIL,
  children,
}: {
  value: string;
  className?: string;
  tailLength?: number;
  /** Rendered after the value, inside the same flex row (e.g. a badge). */
  children?: ReactNode;
}) {
  const { head, tail } = splitForMiddleTruncation(value, tailLength);
  return (
    <span className={cn("inline-flex min-w-0 max-w-full items-baseline", className)}>
      {/* The whole value stays available on hover and to assistive tech, which
          is what made the truncated column usable at all. */}
      <span className="inline-flex min-w-0 max-w-full items-baseline" title={value}>
        <span className="truncate">{head}</span>
        {tail ? <span className="shrink-0 whitespace-pre">{tail}</span> : null}
      </span>
      {children}
    </span>
  );
}
