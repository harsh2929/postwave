// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useReportWebVitals } from "next/web-vitals";

import { reportWebVitals, type WebVitalsMetric } from "@/lib/web-vitals";

/**
 * Mounts a Core Web Vitals reporter as a client island. The hook fires once
 * per metric (CLS, FCP, INP, LCP, TTFB plus Next.js-internal markers);
 * {@link reportWebVitals} keeps the web vitals and sends them as one batch
 * per page view, when the page is hidden or unloaded.
 *
 * Mount this once near the root of the application. Mounting it multiple
 * times will produce duplicate reports.
 */
export function WebVitalsReporter(): null {
  useReportWebVitals((metric: WebVitalsMetric) => {
    reportWebVitals(metric);
  });

  return null;
}
