// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { Check, Link2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { copyToClipboard } from "@/lib/clipboard";
import { cn } from "@/lib/utils";

/**
 * A small permalink / copy-link control for a deep-linkable heading (MKTC-011).
 * It is a real anchor (so it also works as a plain in-page link) that, on
 * click, copies the absolute URL of the on-page hash target to the clipboard
 * and shows a brief "copied" state.
 */
export function CopyLink({
  hash,
  label,
  className,
}: {
  /** The element id to link to (without the leading #). */
  hash: string;
  /** Accessible label, e.g. "Copy link to v0.4.0". */
  label: string;
  className?: string;
}): JSX.Element {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    },
    [],
  );

  async function onClick(
    e: React.MouseEvent<HTMLAnchorElement>,
  ): Promise<void> {
    const url = `${window.location.origin}${window.location.pathname}#${hash}`;
    // preventDefault only counts synchronously, so it has to happen here —
    // which means the "just let the anchor navigate" fallback this used to
    // claim was impossible: by the time the clipboard rejected, the default was
    // already cancelled and cannot be un-cancelled. On any surface without
    // clipboard access the icon then did nothing whatsoever. Navigate ourselves
    // instead, so the control always at least behaves like the link it is.
    e.preventDefault();
    const result = await copyToClipboard(url);
    if (result !== "copied") {
      window.location.hash = hash;
      return;
    }
    window.history.replaceState(null, "", `#${hash}`);
    setCopied(true);
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      setCopied(false);
      timerRef.current = null;
    }, 1500);
  }

  return (
    <a
      href={`#${hash}`}
      onClick={onClick}
      aria-label={label}
      className={cn(
        "inline-flex h-6 w-6 items-center justify-center rounded text-pw-muted-on-paper opacity-0 transition-opacity hover:text-pw-ember-600 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pw-ember-500 group-hover:opacity-100",
        className,
      )}
    >
      {copied ? (
        <Check aria-hidden className="h-3.5 w-3.5 text-emerald-500" />
      ) : (
        <Link2 aria-hidden className="h-3.5 w-3.5" />
      )}
    </a>
  );
}
