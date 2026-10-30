// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import dynamic from "next/dynamic";

const DeferredCampaignABResultsClient = dynamic(
  () =>
    import("./campaign-ab-results-client").then(
      (module) => module.CampaignABResultsClient,
    ),
  {
    ssr: false,
    loading: () => <CampaignABResultsLoading />,
  },
);

export function CampaignABResultsClientLoader() {
  return <DeferredCampaignABResultsClient />;
}

function CampaignABResultsLoading() {
  return (
    <div
      className="mx-auto max-w-5xl space-y-6 p-4 sm:p-6 lg:p-8"
      role="status"
      aria-busy="true"
      aria-live="polite"
    >
      <span className="sr-only">Loading campaign experiment results…</span>
      <div className="h-9 w-64 max-w-full animate-pulse rounded bg-muted motion-reduce:animate-none" />
      <div className="h-12 animate-pulse rounded-lg bg-muted motion-reduce:animate-none" />
      <div className="h-80 animate-pulse rounded-lg border bg-card motion-reduce:animate-none" />
    </div>
  );
}
