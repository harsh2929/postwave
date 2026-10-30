// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import dynamic from "next/dynamic";

const InboundRoutesClient = dynamic(
  () =>
    import("./inbound-routes-client").then(
      (module) => module.InboundRoutesClient,
    ),
  {
    ssr: false,
    loading: () => (
      <div
        role="status"
        aria-busy="true"
        className="mx-auto min-h-48 max-w-6xl p-6 text-sm text-muted-foreground"
      >
        Loading protected inbound-route controls…
      </div>
    ),
  },
);

export default function InboundRoutesPage() {
  return <InboundRoutesClient />;
}
