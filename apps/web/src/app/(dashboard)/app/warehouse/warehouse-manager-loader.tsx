// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import dynamic from "next/dynamic";

const DeferredWarehouseManager = dynamic(
  () => import("./warehouse-manager").then((module) => module.WarehouseManager),
  {
    ssr: false,
    loading: () => (
      <main
        className="mx-auto max-w-7xl space-y-6 p-4 sm:p-6 lg:p-8"
        aria-busy="true"
      >
        <header className="space-y-2">
          <h1 className="font-display text-2xl font-semibold tracking-tight sm:text-3xl">
            Data warehouse
          </h1>
          <p
            role="status"
            aria-live="polite"
            className="text-sm text-muted-foreground"
          >
            Loading warehouse connections and verifying access…
          </p>
        </header>
        <div className="h-32 animate-pulse rounded-xl border bg-card motion-reduce:animate-none" />
        <div className="h-80 animate-pulse rounded-xl border bg-card motion-reduce:animate-none" />
      </main>
    ),
  },
);

/** Warehouse providers and editor dialogs are a client-query control plane. */
export function WarehouseManagerLoader() {
  return <DeferredWarehouseManager />;
}
