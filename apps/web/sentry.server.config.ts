// SPDX-License-Identifier: AGPL-3.0-only
//
// Sentry server (Node runtime) initialization.
//
// Loaded by Next.js via `register()` in src/instrumentation.ts when the
// runtime is `nodejs`. Reads SENTRY_DSN_WEB (NOT public) so the DSN
// stays out of the client bundle. Empty DSN ⇒ no-op.
//
// Redaction (events + breadcrumbs) is sourced from @postwave/telemetry —
// the same module the client and Go gateway use — so the rules can't
// drift. The previously-duplicated per-runtime redactor has been deleted.
import * as Sentry from "@sentry/nextjs";
import {
  redactBreadcrumb,
  redactEvent,
  type RedactableBreadcrumb,
  type RedactableEvent,
} from "@postwave/telemetry";

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
      // Package redactors mutate-and-return; cast through their structural
      // shapes and return Sentry's own type unchanged (see client config).
      redactEvent(event as unknown as RedactableEvent);
      return event;
    },
    beforeBreadcrumb(breadcrumb) {
      redactBreadcrumb(breadcrumb as unknown as RedactableBreadcrumb);
      return breadcrumb;
    },
  });
}
