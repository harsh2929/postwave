// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import dynamic from "next/dynamic";

// The client plus its Deliveries row action (outbound-webhook-deliveries.tsx
// fills the client's `rowActionSlot`).
const OutboundWebhooksClient = dynamic(
  () =>
    import("./outbound-webhook-deliveries").then(
      (module) => module.OutboundWebhooksWithDeliveries,
    ),
  {
    ssr: false,
    loading: () => (
      <div
        role="status"
        aria-busy="true"
        className="mx-auto min-h-48 max-w-6xl p-6 text-sm text-muted-foreground"
      >
        Loading protected outbound-destination controls…
      </div>
    ),
  },
);

export default function OutboundWebhooksPage() {
  return <OutboundWebhooksClient />;
}
