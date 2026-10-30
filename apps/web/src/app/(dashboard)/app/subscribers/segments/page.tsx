// SPDX-License-Identifier: AGPL-3.0-only
//
// Saved-segments list. The RSC fetches the tenant's segments server-side (so a
// backend failure is caught by error.tsx and the initial paint is data-ready)
// and hands them to the interactive client list, which owns search, sort,
// pagination, recompute, row actions, and bulk operations.

import { SegmentsList } from "./segments-list";
import { listSegments } from "@/lib/segments-api";

export const dynamic = "force-dynamic";

export default async function SegmentsPage() {
  const segments = await listSegments();
  return <SegmentsList initialSegments={segments} />;
}
