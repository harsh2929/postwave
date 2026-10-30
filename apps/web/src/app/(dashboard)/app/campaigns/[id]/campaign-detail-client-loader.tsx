// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import dynamic from "next/dynamic";

const DeferredCampaignDetailClient = dynamic(
  () =>
    import("./campaign-detail-client").then(
      (module) => module.CampaignDetailClient,
    ),
  {
    ssr: false,
    loading: () => <CampaignDetailLoading />,
  },
);

export function CampaignDetailClientLoader() {
  return <DeferredCampaignDetailClient />;
}

function CampaignDetailLoading() {
  return (
    <div
      className="mx-auto max-w-5xl space-y-6 p-4 sm:p-6 lg:p-8"
      role="status"
      aria-busy="true"
      aria-live="polite"
    >
      <span className="sr-only">
        Loading the campaign editor and verifying workspace access…
      </span>
      <div className="h-9 w-64 max-w-full animate-pulse rounded bg-muted motion-reduce:animate-none" />
      <div className="h-28 animate-pulse rounded-lg border bg-card motion-reduce:animate-none" />
      <div className="h-96 animate-pulse rounded-lg border bg-card motion-reduce:animate-none" />
    </div>
  );
}
