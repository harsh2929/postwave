// SPDX-License-Identifier: AGPL-3.0-only
//
// In-product "how to sign inbound requests" reference (INTG-028). The ingest
// endpoint requires an HMAC-SHA256 signature over `{timestamp}.{body}` plus a
// timestamp within a ±5 minute replay window (see the Go Ingest handler). Users
// who get a secret with no signing guidance fail silently at ingest, so we
// document the exact header names, scheme, and window right where the secret is
// revealed. Content is static; nothing here echoes the secret itself.
"use client";

import { useId, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";

export function InboundSigningHelp() {
  const panelId = useId();
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-3 rounded-md border border-border bg-background/60">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={panelId}
        className="flex min-h-11 w-full items-center gap-1.5 rounded-sm px-3 py-2 text-left text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring sm:min-h-9"
      >
        {open ? (
          <ChevronDown className="h-4 w-4 shrink-0" aria-hidden />
        ) : (
          <ChevronRight className="h-4 w-4 shrink-0" aria-hidden />
        )}
        How to sign requests
      </button>
      {open ? (
        <div
          id={panelId}
          className="space-y-2 border-t border-border px-3 py-3 text-xs text-muted-foreground"
        >
          <p>
            Each POST to the ingest URL must include these headers, or it is
            rejected with 401:
          </p>
          <ul className="ml-4 list-disc space-y-1">
            <li>
              <code className="break-all rounded bg-muted px-1">
                X-Postwave-Timestamp
              </code>{" "}
              — current Unix time in seconds. Must be within{" "}
              <strong>±5 minutes</strong> of server time (replay protection).
            </li>
            <li>
              <code className="break-all rounded bg-muted px-1">
                X-Postwave-Signature
              </code>{" "}
              — hex HMAC-SHA256 of{" "}
              <code className="rounded bg-muted px-1">
                {"{timestamp}.{raw_body}"}
              </code>{" "}
              keyed by the signing secret above.
            </li>
            <li>
              A stable per-event id header (e.g.{" "}
              <code className="rounded bg-muted px-1">X-Postwave-Event-Id</code>
              ) for idempotency — duplicates are ack&apos;d without re-firing.
            </li>
          </ul>
          <pre
            tabIndex={0}
            role="group"
            aria-label="Signature verification example"
            className="overflow-x-auto rounded bg-muted p-2 leading-relaxed text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {`ts=$(date +%s)
sig=$(printf '%s.%s' "$ts" "$body" \\
  | openssl dgst -sha256 -hmac "$SECRET" | awk '{print $2}')
curl -X POST "$INGEST_URL" \\
  -H "X-Postwave-Timestamp: $ts" \\
  -H "X-Postwave-Signature: $sig" \\
  -H "Content-Type: application/json" \\
  --data "$body"`}
          </pre>
        </div>
      ) : null}
    </div>
  );
}
