// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import dynamic from "next/dynamic";

/**
 * The reporter is optional and has no render output. Keep its Next web-vitals
 * runtime out of every route's initial graph; PerformanceObserver supplies
 * buffered entries when the enabled island mounts after hydration.
 */
export const WebVitalsReporterLoader = dynamic(
  () =>
    import("@/components/seo/web-vitals").then((mod) => mod.WebVitalsReporter),
  { ssr: false, loading: () => null },
);
