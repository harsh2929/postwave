// SPDX-License-Identifier: AGPL-3.0-only
//
// Sentry edge-runtime initialization.
//
// Loaded by Next.js via `register()` in src/instrumentation.ts when the
// runtime is `edge`. The edge runtime is a constrained V8 worker
// environment — Node-specific Sentry integrations (the OnUncaught
// handlers, fs-based source maps) are unavailable here, but the same
// Sentry.init API works against the platform's `fetch`.
//
// Reads SENTRY_DSN_WEB. Empty DSN ⇒ no-op.
import * as Sentry from "@sentry/nextjs";
import { redactEvent, type RedactableEvent } from "@postwave/telemetry";

const DSN = (process.env.SENTRY_DSN_WEB ?? "").trim();

if (DSN) {
  Sentry.init({
    dsn: DSN,
    environment:
      process.env.POSTWAVE_ENV ?? process.env.NODE_ENV ?? "production",
    release: process.env.POSTWAVE_RELEASE,
    tracesSampleRate: 0.1,
    sendDefaultPii: false,
    debug: false,
    beforeSend(event) {
      redactEvent(event as unknown as RedactableEvent);
      return event;
    },
  });
}
