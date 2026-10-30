// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { useEffect } from "react";
import { redactPath } from "@postwave/telemetry";

import { init, track } from "@/lib/telemetry";

/**
 * TelemetryProvider — initializes PostHog once and emits `page_viewed`
 * events on every Next.js route change. Mounted in the marketing
 * layout and the dashboard layout. Server-rendered HTML is unaffected
 * because everything runs inside useEffect.
 *
 * Pageview event fields are deliberately minimal:
 *   - path: pathname only (NEVER includes query strings — we strip
 *     them because campaign / coupon / referrer URLs can carry PII
 *     in the wild)
 *   - has_search: boolean indicating the user came in with a query
 *     string, useful for funnel analysis without leaking the values
 *
 * If you need to fork by search-param value (e.g. ?utm_source), add
 * an explicit allowlist here — DO NOT pass the raw search string.
 */
export function TelemetryProvider(): null {
  const pathname = usePathname();
  const searchParams = useSearchParams();

  useEffect(() => {
    if (!pathname || redactPath(pathname) !== pathname) return;
    void init();
  }, [pathname]);

  useEffect(() => {
    if (!pathname) return;
    const safePath = redactPath(pathname);
    // posthog-js attaches raw $current_url/$pathname defaults to every manual
    // capture. Suppress capture entirely on credential/PII-bearing routes;
    // redacting only our custom property would still leak those defaults.
    if (safePath !== pathname) return;
    track("page_viewed", {
      path: safePath,
      has_search: searchParams !== null && searchParams.toString() !== "",
    });
  }, [pathname, searchParams]);

  return null;
}
