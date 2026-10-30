// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import dynamic from "next/dynamic";

export const TelemetryProviderLoader = dynamic(
  () =>
    import("@/components/telemetry-provider").then(
      (mod) => mod.TelemetryProvider,
    ),
  { ssr: false },
);
