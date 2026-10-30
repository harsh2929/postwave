// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import dynamic from "next/dynamic";

const DeferredCampaignsClient = dynamic(
  () => import("./campaigns-client").then((module) => module.CampaignsClient),
  {
    ssr: false,
    loading: () => <CampaignsLoading />,
  },
);

export function CampaignsClientLoader() {
  return <DeferredCampaignsClient />;
}

function CampaignsLoading() {
  return (
    <div
      className="mx-auto max-w-6xl space-y-6 p-4 sm:p-6 lg:p-8"
      role="status"
      aria-busy="true"
      aria-live="polite"
    >
      <span className="sr-only">
        Loading campaigns and verifying workspace access…
      </span>
      <div className="h-9 w-48 animate-pulse rounded bg-muted motion-reduce:animate-none" />
      <div className="grid gap-4 sm:grid-cols-3">
        <div className="h-24 animate-pulse rounded-lg border bg-card motion-reduce:animate-none" />
        <div className="h-24 animate-pulse rounded-lg border bg-card motion-reduce:animate-none" />
        <div className="h-24 animate-pulse rounded-lg border bg-card motion-reduce:animate-none" />
      </div>
      <div className="h-96 animate-pulse rounded-lg border bg-card motion-reduce:animate-none" />
    </div>
  );
}
