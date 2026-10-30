// SPDX-License-Identifier: AGPL-3.0-only

import type { SourcePlatform } from "./types";

export interface MigrationProgressCounters {
  subscribers_total?: number;
  subscribers_done?: number;
  segments_total?: number;
  segments_done?: number;
  automations_total?: number;
  automations_done?: number;
  archive_total?: number;
  archive_done?: number;
  paid_subs_total?: number;
  paid_subs_done?: number;
  templates_total?: number;
  templates_done?: number;
  source_archive_total?: number;
  source_archive_done?: number;
}

const COUNTER_PAIRS = [
  ["subscribers_total", "subscribers_done"],
  ["segments_total", "segments_done"],
  ["automations_total", "automations_done"],
  ["archive_total", "archive_done"],
  ["paid_subs_total", "paid_subs_done"],
  ["templates_total", "templates_done"],
  ["source_archive_total", "source_archive_done"],
] as const;

export function migrationProgressPercent(
  progress: MigrationProgressCounters | null | undefined,
  source?: SourcePlatform,
): number {
  if (!progress) return 0;
  let total = 0;
  let done = 0;
  for (const [totalKey, doneKey] of COUNTER_PAIRS) {
    if (
      (source === "beehiiv" &&
        (totalKey === "automations_total" || totalKey === "paid_subs_total")) ||
      (source === "klaviyo" && totalKey === "automations_total")
    ) {
      // These are rebuild/metadata discovery inventory, not runtime stages
      // that increment their corresponding *_done counters.
      continue;
    }
    total += finiteCounter(progress[totalKey]);
    done += finiteCounter(progress[doneKey]);
  }
  if (total <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((done / total) * 100)));
}

function finiteCounter(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, value)
    : 0;
}
