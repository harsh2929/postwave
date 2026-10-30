// SPDX-License-Identifier: AGPL-3.0-only
//
// The client copy-chrome for docs code blocks — split out so the highlighting
// (CodeBlock) can stay a server component while this tiny island handles the
// clipboard interaction.
"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Copy, X } from "lucide-react";

import { copyToClipboard } from "@/lib/clipboard";

export type CopyState = "idle" | "copied" | "error";

/**
 * Accessible name for the copy control.
 *
 * The button's visible text already changes to "Copied" / "Copy failed", but a
 * static aria-label="Copy code" overrode it: aria-label wins over content in
 * the accessible-name computation, so a screen-reader user heard "Copy code"
 * before the click and "Copy code" after it, whether the write had succeeded
 * or been rejected. The failure state was surfaced visually — see the note
 * below about the bare `catch` this replaced — and then hidden again from the
 * readers least able to verify the clipboard themselves.
 *
 * Every other copy control in the app already resolves this some way: the
 * marketing ones carry an aria-live region, the dashboard ones raise a toast.
 */
export function copyButtonLabel(state: CopyState): string {
  if (state === "copied") return "Copied";
  if (state === "error")
    return "Copy failed — select the code and copy manually";
  return "Copy code";
}

export function CopyButton({ code }: { code: string }): JSX.Element {
  // Failure used to be swallowed by a bare `catch { /* noop */ }`: the button
  // stayed on "Copy" and the reader had no way to tell a failed write from a
  // mis-click. writeText rejects in insecure contexts and when the permission
  // is denied, so this is reachable, not theoretical — the same silent-failure
  // shape already fixed in embed-snippet and copy-link.
  const [state, setState] = useState<CopyState>("idle");
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (resetTimerRef.current !== null) clearTimeout(resetTimerRef.current);
    };
  }, []);

  const onCopy = async (): Promise<void> => {
    const result = await copyToClipboard(code);
    setState(result === "copied" ? "copied" : "error");
    if (resetTimerRef.current !== null) clearTimeout(resetTimerRef.current);
    resetTimerRef.current = setTimeout(() => {
      setState("idle");
      resetTimerRef.current = null;
    }, 1500);
  };

  const copied = state === "copied";
  const failed = state === "error";

  return (
    <button
      type="button"
      onClick={onCopy}
      aria-label={copyButtonLabel(state)}
      className="inline-flex min-h-11 shrink-0 items-center gap-1 rounded-md border border-zinc-700 bg-zinc-900 px-2.5 py-1 text-[11px] text-zinc-300 transition-colors hover:bg-zinc-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pw-ember-500 sm:min-h-9"
    >
      {copied ? (
        <Check className="h-3 w-3" aria-hidden="true" />
      ) : failed ? (
        <X className="h-3 w-3" aria-hidden="true" />
      ) : (
        <Copy className="h-3 w-3" aria-hidden="true" />
      )}
      {copied ? "Copied" : failed ? "Copy failed" : "Copy"}
      {/* The label alone re-announces only while the button holds focus. This
          carries the outcome for a reader who triggered the copy and moved on,
          matching CopyablePre. Present in the DOM from first render so the
          region is live before its content arrives. */}
      <span aria-live="polite" className="sr-only">
        {copied || failed ? copyButtonLabel(state) : ""}
      </span>
    </button>
  );
}
