// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useEffect, useRef, useState } from "react";

import { copyToClipboard } from "@/lib/clipboard";
import { cn } from "@/lib/utils";

interface CopyButtonProps {
  value: string;
  label?: string;
  className?: string;
}

export function CopyButton({
  value,
  label = "Copy",
  className,
}: CopyButtonProps): JSX.Element {
  const [copied, setCopied] = useState<boolean>(false);
  const [failed, setFailed] = useState<boolean>(false);
  const resetTimerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (resetTimerRef.current !== null) {
        window.clearTimeout(resetTimerRef.current);
      }
    };
  }, []);

  async function onCopy(): Promise<void> {
    // copyToClipboard reports "unavailable" (insecure context) and
    // "error" (permission denied) instead of throwing, so a failed
    // write can surface to the reader rather than looking like a
    // mis-click. Previously the catch here just reset to idle.
    const outcome = await copyToClipboard(value);
    setFailed(outcome !== "copied");
    setCopied(outcome === "copied");
    if (resetTimerRef.current !== null) {
      window.clearTimeout(resetTimerRef.current);
    }
    resetTimerRef.current = window.setTimeout(() => {
      setCopied(false);
      setFailed(false);
      resetTimerRef.current = null;
    }, 1800);
  }

  return (
    <button
      type="button"
      onClick={onCopy}
      aria-live="polite"
      className={cn(
        "inline-flex items-center justify-center rounded-md bg-pw-ember-500 hover:bg-pw-ember-600 transition-colors text-white px-4 py-2 text-sm font-medium shadow-[0_2px_0_0_#7A081B] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pw-ember-500 focus-visible:ring-offset-2",
        className,
      )}
    >
      {copied ? "Copied" : failed ? "Copy failed" : label}
    </button>
  );
}
