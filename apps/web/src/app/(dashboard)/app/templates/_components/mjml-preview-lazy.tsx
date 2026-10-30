// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import dynamic from "next/dynamic";

import { Skeleton } from "@/components/ui/skeleton";

// The MJML multi-client simulation is the heaviest client module on the
// preview route. The boundary lives in a client component because
// next/dynamic inside the server page keeps the module in the eager graph;
// here it is a lazily loaded chunk behind the canvas silhouette.
const MjmlPreviewWithVars = dynamic(
  () => import("./mjml-preview-with-vars").then((m) => m.MjmlPreviewWithVars),
  {
    loading: () => (
      <div
        role="status"
        aria-label="Loading client preview"
        className="space-y-3"
      >
        <div className="flex flex-wrap items-center gap-2">
          <Skeleton className="h-9 w-28" />
          <Skeleton className="h-9 w-28" />
          <Skeleton className="h-9 w-20" />
        </div>
        <Skeleton className="h-[480px] w-full" />
      </div>
    ),
  },
);

export function MjmlPreviewLazy({
  mjml,
  variables,
}: {
  mjml: string;
  variables?: Array<Record<string, unknown>>;
}) {
  return <MjmlPreviewWithVars mjml={mjml} variables={variables} />;
}
