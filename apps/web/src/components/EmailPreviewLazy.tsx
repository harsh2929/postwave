// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import dynamic from "next/dynamic";
import type { ComponentProps } from "react";

import { Skeleton } from "@/components/ui/skeleton";

// The MJML preview is only needed once a template's body is on screen. This
// boundary lives in a client component because a next/dynamic call inside the
// server template page keeps the preview in the eager route graph as the
// bundle budget counts it.
const LazyEmailPreview = dynamic(
  () => import("@/components/EmailPreview").then((m) => m.EmailPreview),
  {
    loading: () => (
      <div role="status" aria-label="Loading email preview">
        <Skeleton className="h-72 w-full rounded-lg" />
      </div>
    ),
  },
);

export function EmailPreviewLazy(
  props: ComponentProps<typeof LazyEmailPreview>,
) {
  return <LazyEmailPreview {...props} />;
}
