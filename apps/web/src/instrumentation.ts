// SPDX-License-Identifier: AGPL-3.0-only
//
// Next.js 15+ instrumentation hook (the standard replacement for the
// `_app.js`-era Sentry init). Next runs `register()` exactly once per
// runtime (nodejs / edge), letting us delegate per runtime to the
// matching sentry.*.config.ts. The browser entrypoint is wired
// separately in instrumentation-client.ts (Next.js convention).
//
// This file must live in src/, beside middleware.ts. Next looks for the hook
// in the directory that holds the app directory (join(appDir, "..")), and the
// app directory is src/app. For a long time it sat in apps/web/ instead, where
// the build never found it: register() never ran, so server and edge errors
// never reached Sentry however the DSN was set.
//
// `onRequestError` re-exports `@sentry/nextjs`'s captureRequestError
// so the App Router routes server errors into Sentry. When the DSN
// is unset that capture is a no-op (Sentry.init never ran), matching
// the rest of the surfaces' graceful-dormant behaviour.
import type { Instrumentation } from "next";

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("../sentry.server.config");
  }
  if (process.env.NEXT_RUNTIME === "edge") {
    await import("../sentry.edge.config");
  }
}

// Lazily resolved so the Sentry import doesn't run until Next actually
// dispatches a request error. When SENTRY_DSN_WEB is unset, captureRequestError
// is still callable but its capture path no-ops because Sentry.init never ran.
export const onRequestError: Instrumentation.onRequestError = async (
  err,
  request,
  context,
) => {
  const { captureRequestError } = await import("@sentry/nextjs");
  captureRequestError(err, request, context);
};
