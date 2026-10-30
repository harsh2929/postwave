// SPDX-License-Identifier: AGPL-3.0-only
//
// Sentry client (browser) initialization entrypoint.
//
// Next.js loads this file as the browser instrumentation entrypoint. Reads
// NEXT_PUBLIC_SENTRY_DSN_WEB so the DSN is inlined into the browser bundle at
// build time. The optional SDK is loaded after first paint (or immediately for
// an early error/router transition) and is absent from initial route chunks.
//
// Redaction is sourced from @postwave/telemetry so the scrub rules can't drift
// from the Go gateway / desktop / mobile. NOTE: web was MISSING breadcrumb
// redaction — `beforeBreadcrumb` is wired so fetch/navigation breadcrumb URLs
// get the same secret/PII query scrub as the event itself.
import {
  getClientSentry,
  warmClientSentry,
} from "@/lib/client-sentry";

type RouterTransitionArguments = Parameters<
  (typeof import("@sentry/nextjs"))["captureRouterTransitionStart"]
>;

export function onRouterTransitionStart(
  ...args: RouterTransitionArguments
): void {
  void getClientSentry()
    .then((Sentry) => {
      Sentry?.captureRouterTransitionStart(...args);
    })
    .catch(() => {
      // Optional telemetry must not block navigation.
    });
}

warmClientSentry();
