// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import dynamic from "next/dynamic";

const DeferredCampaignABClient = dynamic(
  () =>
    import("./campaign-ab-client").then(
      (module) => module.CampaignABClient,
    ),
  {
    ssr: false,
    loading: () => <CampaignABLoading />,
  },
);

export function CampaignABClientLoader() {
  return <DeferredCampaignABClient />;
}

function CampaignABLoading() {
  return (
    <div
      className="mx-auto max-w-5xl space-y-6 p-4 sm:p-6 lg:p-8"
      role="status"
      aria-busy="true"
      aria-live="polite"
    >
      <span className="sr-only">
        Loading campaign experiment settings and results…
      </span>
      <div className="h-9 w-72 max-w-full animate-pulse rounded bg-muted motion-reduce:animate-none" />
      <div className="h-12 animate-pulse rounded-lg bg-muted motion-reduce:animate-none" />
      <div className="h-96 animate-pulse rounded-lg border bg-card motion-reduce:animate-none" />
    </div>
  );
}
