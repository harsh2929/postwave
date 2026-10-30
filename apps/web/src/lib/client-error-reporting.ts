// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { getClientSentry } from "@/lib/client-sentry";

const EMAIL_RE = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;

export type ClientBoundaryError = Error & { digest?: string };

export function scrubClientError(input: ClientBoundaryError): Error {
  const cleaned = input.message?.replace(EMAIL_RE, "<email-redacted>") ?? "";
  const out = new Error(cleaned);
  out.name = input.name;
  out.stack = input.stack;
  if (input.digest) {
    (out as ClientBoundaryError).digest = input.digest;
  }
  return out;
}

export function captureClientBoundaryError(error: ClientBoundaryError): void {
  const scrubbed = scrubClientError(error);
  void getClientSentry()
    .then((Sentry) => {
      Sentry?.captureException(scrubbed);
    })
    .catch(() => {
      // Error reporting is best-effort and must never fail the boundary UI.
    });
  if (process.env.NODE_ENV !== "production") {
    console.error(error);
  }
}
