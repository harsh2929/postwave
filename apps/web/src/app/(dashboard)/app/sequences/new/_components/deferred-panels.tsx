// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import dynamic from "next/dynamic";

import { Skeleton } from "@/components/ui/skeleton";
import type { SequenceTemplate } from "@/lib/voice-types";

// The brief generator and the template starters sit below the builder canvas
// on the new-sequence route. Their boundaries live in this client component
// because a next/dynamic call inside the server page keeps both modules in the
// eager route graph; here each is a lazily loaded chunk behind a silhouette of
// the panel it replaces, so the page's initial JavaScript carries only the
// canvas the operator lands on.

const LazyAiBriefPanel = dynamic(
  () => import("./ai-brief-panel").then((m) => m.AiBriefPanel),
  {
    loading: () => (
      <div
        role="status"
        aria-label="Loading brief generator"
        className="space-y-4 rounded-lg border p-4"
      >
        <Skeleton className="h-4 w-16" />
        <Skeleton className="h-24 w-full" />
        <div className="flex flex-wrap gap-2">
          <Skeleton className="h-8 w-40" />
          <Skeleton className="h-8 w-36" />
        </div>
        <Skeleton className="h-9 w-40" />
      </div>
    ),
  },
);

const LazyTemplatePicker = dynamic(
  () => import("./template-picker").then((m) => m.TemplatePickerClient),
  {
    loading: () => (
      <div
        role="status"
        aria-label="Loading template starters"
        className="space-y-4"
      >
        <Skeleton className="h-10 w-full max-w-md" />
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Skeleton className="h-36 w-full rounded-lg" />
          <Skeleton className="h-36 w-full rounded-lg" />
          <Skeleton className="h-36 w-full rounded-lg" />
        </div>
      </div>
    ),
  },
);

export function DeferredAiBriefPanel() {
  return <LazyAiBriefPanel />;
}

export function DeferredTemplatePicker({
  templates,
  loadError = null,
}: {
  templates: SequenceTemplate[];
  loadError?: string | null;
}) {
  return <LazyTemplatePicker templates={templates} loadError={loadError} />;
}
