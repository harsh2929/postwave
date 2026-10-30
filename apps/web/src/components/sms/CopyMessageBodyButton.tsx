// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Per-bubble "Copy message body" control (desktop
// components/sms/MessageBubble.tsx:229-233). Client-only: copies exactly the
// retained body the server returned — never the omitted-body placeholder — and
// makes a refused clipboard write visible instead of swallowing it.

import { useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";

import { copyToClipboard, type ClipboardResult } from "@/lib/clipboard";

export function CopySmsMessageBodyButton({
  body,
  bodyOmittedReason,
  tone = "muted",
}: {
  body: string;
  /** When set the server withheld the body; there is nothing to copy. */
  bodyOmittedReason?: string;
  /** "inverse" for text on a primary-coloured (outbound) bubble. */
  tone?: "muted" | "inverse";
}) {
  const [result, setResult] = useState<ClipboardResult | null>(null);
  const [copying, setCopying] = useState(false);
  const busy = useRef(false);
  const reset = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (reset.current !== null) window.clearTimeout(reset.current);
    },
    [],
  );

  if (bodyOmittedReason || body.length === 0) return null;

  const onCopy = async () => {
    if (busy.current) return;
    busy.current = true;
    setCopying(true);
    try {
      const outcome = await copyToClipboard(body);
      setResult(outcome);
      if (reset.current !== null) window.clearTimeout(reset.current);
      if (outcome === "copied") {
        reset.current = window.setTimeout(() => setResult(null), 2_000);
      }
    } finally {
      busy.current = false;
      setCopying(false);
    }
  };

  const toneClass =
    tone === "inverse"
      ? "text-primary-foreground/80 hover:opacity-80"
      : "text-muted-foreground hover:text-foreground";
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <button
        type="button"
        className={`inline-flex min-h-11 min-w-11 items-center justify-center gap-1 rounded px-1 text-[11px] underline-offset-2 hover:underline sm:min-h-6 sm:min-w-6 ${toneClass}`}
        aria-label={
          result === "copied" ? "Message body copied" : "Copy message body"
        }
        aria-busy={copying || undefined}
        disabled={copying}
        onClick={() => void onCopy()}
      >
        {result === "copied" ? (
          <Check className="h-3.5 w-3.5" aria-hidden />
        ) : (
          <Copy className="h-3.5 w-3.5" aria-hidden />
        )}
        <span aria-hidden>{result === "copied" ? "Copied" : "Copy"}</span>
      </button>
      <span role="status" className="text-[11px]">
        {result === "error"
          ? "Copy failed: the browser refused clipboard access. Select the text to copy it."
          : result === "unavailable"
            ? "Clipboard is unavailable here. Select the text to copy it."
            : ""}
      </span>
    </span>
  );
}
