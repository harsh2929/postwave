// SPDX-License-Identifier: AGPL-3.0-only
//
// Shared migration status → label/badge-variant mapping. Before this, the
// recent-migrations list (page.tsx) and the detail StatusBadge each had their
// own divergent map: the list rendered raw `rolled_back` in grey while the
// detail rendered "rolled back" in amber for the SAME job (MIGR-004). Both now
// route through here so status text and colour are identical everywhere.

import type { MigrationStatus } from "./types";

export type MigrationStatusVariant =
  | "success"
  | "destructive"
  | "warning"
  | "secondary";

/** Human label: underscores → spaces (`rolled_back` → "rolled back"). */
export function migrationStatusLabel(status: MigrationStatus): string {
  return status.replace(/_/g, " ");
}

/** Badge variant, consistent between the list and the detail page. */
export function migrationStatusVariant(
  status: MigrationStatus,
): MigrationStatusVariant {
  switch (status) {
    case "completed":
      return "success";
    case "failed":
      return "destructive";
    case "rolled_back":
      return "warning";
    default:
      return "secondary";
  }
}
