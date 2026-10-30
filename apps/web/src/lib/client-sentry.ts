// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import type {
  RedactableBreadcrumb,
  RedactableEvent,
} from "@postwave/telemetry";

type SentryClient = typeof import("@sentry/nextjs");

const DSN = (process.env.NEXT_PUBLIC_SENTRY_DSN_WEB ?? "").trim();

let clientPromise: Promise<SentryClient | null> | null = null;

/**
 * Load and initialize browser Sentry at most once.
 *
 * Keeping the SDK behind this boundary is intentional: @sentry/nextjs is a
 * large optional dependency and must not be part of every route's initial JS
 * graph when the deployment has no browser DSN. Error boundaries and router
 * transitions call this same loader, so an early error still starts capture
 * immediately and cannot race a second initialization.
 */
export function getClientSentry(): Promise<SentryClient | null> {
  if (!DSN) return Promise.resolve(null);
  if (clientPromise) return clientPromise;

  clientPromise = Promise.all([
    import("@sentry/nextjs"),
    import("@postwave/telemetry"),
  ]).then(([Sentry, { redactBreadcrumb, redactEvent }]) => {
    Sentry.init({
      dsn: DSN,
      environment:
        process.env.NEXT_PUBLIC_POSTWAVE_ENV ??
        process.env.NODE_ENV ??
        "production",
      release: process.env.NEXT_PUBLIC_POSTWAVE_RELEASE,
      tracesSampleRate: 0.1,
      sendDefaultPii: false,
      debug: false,
      beforeSend(event) {
        redactEvent(event as unknown as RedactableEvent);
        return event;
      },
      beforeBreadcrumb(breadcrumb) {
        redactBreadcrumb(breadcrumb as unknown as RedactableBreadcrumb);
        return breadcrumb;
      },
    });
    return Sentry;
  });

  return clientPromise;
}

/**
 * Begin optional telemetry after the first rendering opportunity. The timeout
 * prevents permanently deferring initialization on a busy page while keeping
 * SDK download/parse work away from first paint on normal browsers.
 */
export function warmClientSentry(): void {
  if (!DSN || typeof window === "undefined") return;

  const warm = () => {
    void getClientSentry().catch(() => {
      // Telemetry availability must never break the customer session.
    });
  };

  if (typeof window.requestIdleCallback === "function") {
    window.requestIdleCallback(warm, { timeout: 1_500 });
    return;
  }

  window.setTimeout(warm, 0);
}
