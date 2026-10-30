// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import dynamic from "next/dynamic";

const DeferredPiiFindingsClient = dynamic(
  () =>
    import("./pii-findings-client").then((module) => module.PiiFindingsClient),
  {
    ssr: false,
    loading: () => (
      <div
        className="mx-auto max-w-6xl space-y-5 p-4 sm:p-6 lg:p-8"
        role="status"
        aria-busy="true"
        aria-live="polite"
      >
        <span className="sr-only">
          Loading privacy findings and verifying access…
        </span>
        <div className="h-9 w-72 max-w-full animate-pulse rounded-md bg-muted motion-reduce:animate-none" />
        <div className="h-28 animate-pulse rounded-xl border bg-card motion-reduce:animate-none" />
        <div className="h-80 animate-pulse rounded-xl border bg-card motion-reduce:animate-none" />
      </div>
    ),
  },
);

/**
 * Shadow-PII is an admin-only client query surface. Its strict Zod contracts
 * and review dialogs are intentionally loaded after hydration so visitors who
 * have not yet passed the in-component authority check do not pay for or run
 * that sensitive data client in the initial route graph.
 */
export function PiiFindingsClientLoader() {
  return <DeferredPiiFindingsClient />;
}
