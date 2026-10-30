// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import dynamic from "next/dynamic";

import { TableSkeleton } from "@/components/dashboard/skeletons";
import type { FormListItem } from "@/lib/forms-types";

// The forms table client (sorting, row actions, confirm dialogs) is the bulk
// of the route's client JavaScript. The boundary lives in a client component
// because next/dynamic inside the server page keeps the module in the eager
// graph; here it is a lazily loaded chunk behind a table silhouette.
const FormsListClient = dynamic(
  () => import("./forms-list-client").then((m) => m.FormsListClient),
  {
    loading: () => (
      <div role="status" aria-label="Loading forms">
        <TableSkeleton rows={6} />
      </div>
    ),
  },
);

export function FormsListLazy({
  initialForms,
}: {
  initialForms: FormListItem[];
}) {
  return <FormsListClient initialForms={initialForms} />;
}
