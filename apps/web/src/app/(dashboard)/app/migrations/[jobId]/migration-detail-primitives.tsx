// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { Badge } from "@/components/ui/badge";
import {
  migrationStatusLabel,
  migrationStatusVariant,
} from "@/lib/migration-status";
import type { MigrationJob } from "@/lib/types";

export function StatusBadge({ status }: { status: MigrationJob["status"] }) {
  return (
    <Badge variant={migrationStatusVariant(status)}>
      {migrationStatusLabel(status)}
    </Badge>
  );
}

export function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md border p-4">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 text-2xl font-semibold">{value.toLocaleString()}</p>
    </div>
  );
}
