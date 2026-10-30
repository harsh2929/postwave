// SPDX-License-Identifier: AGPL-3.0-only

import {
  SOURCE_LABELS,
  type MigrationJob,
  type MigrationStatus,
  type SourcePlatform,
} from "./types";
import { migrationProgressPercent } from "./migration-progress-percent";

export interface RecentMigration {
  id: string;
  source: string;
  sourcePlatform: SourcePlatform;
  /** Operator-supplied name (MIGR-037), null when unnamed. */
  label: string | null;
  audienceScope: string | null;
  /** Raw ISO start timestamp — the list renders relative time + hover (MIGR-031). */
  startedAt: string;
  status: MigrationStatus;
  progress: number;
}

export function toRecentMigration(job: MigrationJob): RecentMigration {
  return {
    id: job.id,
    source: SOURCE_LABELS[job.source],
    sourcePlatform: job.source,
    label: job.label?.trim() ? job.label.trim() : null,
    audienceScope:
      job.selected_audience_ids && job.selected_audience_ids.length > 0
        ? `${job.selected_audience_ids.length} selected audience${job.selected_audience_ids.length === 1 ? "" : "s"}`
        : null,
    startedAt: job.started_at,
    status: job.status,
    progress: migrationProgressPercent(job.progress, job.source),
  };
}
