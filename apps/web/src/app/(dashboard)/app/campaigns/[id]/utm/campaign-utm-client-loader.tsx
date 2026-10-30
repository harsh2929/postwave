// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import dynamic from "next/dynamic";

const DeferredCampaignUtmClient = dynamic(
  () =>
    import("./campaign-utm-client").then((module) => module.CampaignUtmClient),
  {
    ssr: false,
    loading: () => <CampaignUtmLoading />,
  },
);

export function CampaignUtmClientLoader() {
  return <DeferredCampaignUtmClient />;
}

function CampaignUtmLoading() {
  return (
    <div
      className="mx-auto w-full max-w-6xl space-y-6 px-4 py-5 sm:px-6 sm:py-6 md:p-8"
      role="status"
      aria-busy="true"
      aria-live="polite"
    >
      <span className="sr-only">Loading UTM tracking for this campaign…</span>
      <div className="h-9 w-64 max-w-full animate-pulse rounded bg-muted motion-reduce:animate-none" />
      <div className="h-64 animate-pulse rounded-lg border bg-card motion-reduce:animate-none" />
    </div>
  );
}
