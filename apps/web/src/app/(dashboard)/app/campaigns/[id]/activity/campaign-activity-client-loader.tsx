// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import dynamic from "next/dynamic";

const DeferredCampaignActivityClient = dynamic(
  () =>
    import("./campaign-activity-client").then(
      (module) => module.CampaignActivityClient,
    ),
  {
    ssr: false,
    loading: () => <CampaignActivityLoading />,
  },
);

export function CampaignActivityClientLoader() {
  return <DeferredCampaignActivityClient />;
}

function CampaignActivityLoading() {
  return (
    <div
      className="mx-auto w-full max-w-6xl space-y-6 px-4 py-5 sm:px-6 sm:py-6 md:p-8"
      role="status"
      aria-busy="true"
      aria-live="polite"
    >
      <span className="sr-only">Loading campaign activity and insights…</span>
      <div className="h-9 w-64 max-w-full animate-pulse rounded bg-muted motion-reduce:animate-none" />
      <div className="h-40 animate-pulse rounded-lg border bg-card motion-reduce:animate-none" />
      <div className="h-72 animate-pulse rounded-lg border bg-card motion-reduce:animate-none" />
    </div>
  );
}
