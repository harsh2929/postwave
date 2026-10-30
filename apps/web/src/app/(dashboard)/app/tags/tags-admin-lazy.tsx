// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import dynamic from "next/dynamic";

import { TableSkeleton } from "@/components/dashboard/skeletons";

// The tag catalogue client is the entire page. The boundary lives in a client
// component because next/dynamic inside a server page keeps the module in the
// route's eager client graph; here it becomes a lazily loaded chunk (bundle
// budget) that streams in behind a table silhouette.
const TagsAdminClient = dynamic(
  () => import("./tags-admin-client").then((m) => m.TagsAdminClient),
  {
    loading: () => (
      <div
        role="status"
        aria-label="Loading tags"
        className="mx-auto max-w-6xl space-y-6 p-4 sm:p-6 lg:p-8"
      >
        <TableSkeleton rows={8} />
      </div>
    ),
  },
);

export function TagsAdminLazy() {
  return <TagsAdminClient />;
}
