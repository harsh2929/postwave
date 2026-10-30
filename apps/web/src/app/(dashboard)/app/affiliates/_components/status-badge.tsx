// SPDX-License-Identifier: AGPL-3.0-only
//
// Single source of truth for the affiliate status → badge-variant mapping.
// Previously duplicated verbatim in the list and detail pages (BILL-042); a
// mapping change now lands in one place.

import { Badge } from "@/components/ui/badge";
import type { AffiliateStatus } from "@/lib/affiliates-types";

export function AffiliateStatusBadge({ status }: { status: AffiliateStatus }) {
  const variant: "success" | "secondary" | "warning" | "destructive" =
    status === "approved"
      ? "success"
      : status === "pending"
        ? "warning"
        : status === "suspended"
          ? "secondary"
          : "destructive";
  return <Badge variant={variant}>{status}</Badge>;
}
