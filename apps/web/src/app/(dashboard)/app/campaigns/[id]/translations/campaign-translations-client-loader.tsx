// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import dynamic from "next/dynamic";

const DeferredCampaignTranslationsClient = dynamic(
  () =>
    import("./campaign-translations-client").then(
      (module) => module.CampaignTranslationsClient,
    ),
  {
    ssr: false,
    loading: () => <CampaignTranslationsLoading />,
  },
);

export function CampaignTranslationsClientLoader() {
  return <DeferredCampaignTranslationsClient />;
}

function CampaignTranslationsLoading() {
  return (
    <div
      className="mx-auto w-full max-w-6xl space-y-6 px-4 py-5 sm:px-6 sm:py-6 md:p-8"
      role="status"
      aria-busy="true"
      aria-live="polite"
    >
      <span className="sr-only">Loading campaign language variants…</span>
      <div className="h-9 w-64 max-w-full animate-pulse rounded bg-muted motion-reduce:animate-none" />
      <div className="h-24 animate-pulse rounded-lg bg-muted motion-reduce:animate-none" />
      <div className="h-64 animate-pulse rounded-lg border bg-card motion-reduce:animate-none" />
    </div>
  );
}
