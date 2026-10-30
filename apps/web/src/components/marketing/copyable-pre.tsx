// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { Check, Copy, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { copyToClipboard } from "@/lib/clipboard";
import { cn } from "@/lib/utils";

interface CopyablePreProps {
  /** The exact text copied to the clipboard. */
  value: string;
  /** Optional accessible label for the region (e.g. "Claude Code install"). */
  label?: string;
  className?: string;
  /** Extra classes for the inner <code>. */
  codeClassName?: string;
}

/**
 * A <pre> code block with a one-click copy affordance and "Copied" feedback
 * (MKTP-007). Used for install commands and snippets on /mcp and
 * /migrate-anywhere. The block renders server-side too, so no-JS visitors still
 * see the full snippet — only the copy button needs the client.
 */
export function CopyablePre({
  value,
  label,
  className,
  codeClassName,
}: CopyablePreProps): JSX.Element {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  const timerRef = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    },
    [],
  );

  async function onCopy(): Promise<void> {
    // copyToClipboard reports "unavailable" (insecure context) and
    // "error" (permission denied) instead of throwing, so a failed
    // write can surface to the reader rather than looking like a
    // mis-click. Previously the catch here just reset to idle.
    const outcome = await copyToClipboard(value);
    setFailed(outcome !== "copied");
    setCopied(outcome === "copied");
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      setCopied(false);
      setFailed(false);
      timerRef.current = null;
    }, 1800);
  }

  return (
    <div
      className={cn(
        "group relative min-w-0 w-full max-w-full [contain:inline-size]",
        className,
      )}
    >
      {/* A horizontally scrollable region has to be focusable, or a
          keyboard-only visitor cannot scroll it at all (WCAG 2.1.1) — and
          these overflow: the Claude Code install command and the JSON client
          configs are both wider than the block. role="group" rather than
          "region" so a page with five snippets does not gain five landmarks,
          and it is what lets aria-label name the block when it takes focus. */}
      <pre
        tabIndex={0}
        role="group"
        aria-label={label ? `${label} snippet` : "Code snippet"}
        className="w-full max-w-full overflow-x-auto rounded-md bg-pw-ink px-5 py-4 pr-16 text-sm text-pw-paper [contain:inline-size] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pw-ember-500"
      >
        <code className={codeClassName}>{value}</code>
      </pre>
      <button
        type="button"
        onClick={onCopy}
        aria-label={
          copied
            ? "Copied"
            : failed
              ? "Copy failed"
              : label
                ? `Copy ${label}`
                : "Copy to clipboard"
        }
        className="absolute right-1.5 top-1.5 inline-flex h-11 w-11 items-center justify-center rounded-md border border-pw-line/40 bg-pw-ink/60 text-pw-paper transition-colors hover:bg-pw-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pw-ember-500"
      >
        {copied ? (
          <Check aria-hidden className="h-4 w-4 text-emerald-400" />
        ) : failed ? (
          <X aria-hidden className="h-4 w-4 text-amber-400" />
        ) : (
          <Copy aria-hidden className="h-4 w-4" />
        )}
        <span aria-live="polite" className="sr-only">
          {copied
            ? "Copied to clipboard"
            : failed
              ? "Copy failed — select the text and copy manually"
              : ""}
        </span>
      </button>
    </div>
  );
}
