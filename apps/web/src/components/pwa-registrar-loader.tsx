// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import dynamic from "next/dynamic";

export const PwaRegistrarLoader = dynamic(
  () =>
    import("@/components/pwa-registrar").then((mod) => mod.PwaRegistrar),
  { ssr: false },
);
