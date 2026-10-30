import type {
  MobileMigrationJob,
  MobileMigrationProgress,
  MobileMigrationStatus,
} from "../api/ops";

const RESOURCE_COUNTERS = [
  ["subscribers", "Subscribers"],
  ["segments", "Segments"],
  ["automations", "Automations"],
  ["paid_subs", "Paid subscriptions"],
  ["archive", "Campaign archive"],
  ["templates", "Templates"],
  ["source_archive", "Source archive"],
] as const;

export type MobileMigrationStatusFilter = "all" | "running" | "failed" | "done";

export interface MobileMigrationResourceProgress {
  resource: (typeof RESOURCE_COUNTERS)[number][0];
  label: string;
  done: number;
  total: number;
}

export function isMobileMigrationRunning(
  status: MobileMigrationStatus | string | undefined,
): boolean {
  return [
    "pending",
    "authenticating",
    "discovering",
    "dry_run",
    "awaiting_confirmation",
    "importing",
    "rolling_back",
  ].includes(String(status ?? "").toLowerCase());
}

export function isMobileMigrationFailure(
  status: MobileMigrationStatus | string | undefined,
): boolean {
  return String(status ?? "").toLowerCase() === "failed";
}

export function isMobileMigrationDone(
  status: MobileMigrationStatus | string | undefined,
): boolean {
  return ["completed", "rolled_back"].includes(
    String(status ?? "").toLowerCase(),
  );
}

export function mobileMigrationStatusCounts(
  jobs: readonly MobileMigrationJob[],
) {
  return {
    all: jobs.length,
    running: jobs.filter((job) => isMobileMigrationRunning(job.status)).length,
    failed: jobs.filter((job) => isMobileMigrationFailure(job.status)).length,
    done: jobs.filter((job) => isMobileMigrationDone(job.status)).length,
  };
}

export function filterMobileMigrations(
  jobs: readonly MobileMigrationJob[],
  filter: MobileMigrationStatusFilter,
): readonly MobileMigrationJob[] {
  if (filter === "all") return jobs;
  return jobs.filter((job) => {
    if (filter === "running") return isMobileMigrationRunning(job.status);
    if (filter === "failed") return isMobileMigrationFailure(job.status);
    return isMobileMigrationDone(job.status);
  });
}

export function mobileMigrationResourceProgress(
  progress: MobileMigrationProgress | null | undefined,
  source?: string | null,
): MobileMigrationResourceProgress[] {
  if (!progress) return [];
  return RESOURCE_COUNTERS.flatMap(([resource, label]) => {
    const done = numberish(progress[`${resource}_done`]);
    const total = numberish(progress[`${resource}_total`]);
    if (done == null && total == null) return [];
    if ((done ?? 0) === 0 && (total ?? 0) === 0) return [];
    return [
      {
        resource,
        label: migrationProgressLabel(resource, label, source),
        done: done ?? 0,
        total: total ?? 0,
      },
    ];
  });
}

function migrationProgressLabel(
  resource: (typeof RESOURCE_COUNTERS)[number][0],
  fallback: string,
  source?: string | null,
): string {
  if (String(source ?? "").toLowerCase() !== "customerio") return fallback;
  switch (resource) {
    case "segments":
      return "Frozen segment/topic snapshots";
    case "automations":
      return "Workflow rebuild records";
    case "archive":
      return "Sent email newsletter archive";
    case "source_archive":
      return "Workflow/channel/ecosystem evidence";
    default:
      return fallback;
  }
}

/**
 * Overall completion, summed across every per-resource counter the job
 * actually reports.
 *
 * There is no server-side percentage to prefer. This function used to lead
 * with `progress.percent` and fall back to `progress.completed / progress.total`
 * — three fields `canonical.MigrationProgress`
 * (packages/migrate/canonical/types.go:347) has never had; it is
 * `<resource>_done` / `<resource>_total` pairs and nothing else. Those branches
 * only compiled because the mobile-local progress type carried an
 * `[key: string]: unknown` index signature, and they were unreachable in
 * production: the first branch never fired, and the last was dead code behind
 * a resource sum that already returns for every real payload. Deriving the
 * type from the SDK (GOVERNANCE#57) turned all three into compile errors.
 *
 * Returns null — not 0 — when nothing is measurable, so the bar renders as
 * "no progress reported" rather than as "0% done".
 */
export function mobileMigrationPercent(job: MobileMigrationJob): number | null {
  const resources = mobileMigrationResourceProgress(job.progress);
  if (resources.length === 0) return null;
  const total = resources.reduce((sum, item) => sum + item.total, 0);
  if (total <= 0) return null;
  const done = resources.reduce(
    (sum, item) => sum + Math.min(item.done, item.total),
    0,
  );
  return clampPercent((done / total) * 100);
}

export function shouldPollMobileMigrations(
  jobs: MobileMigrationJob[] | undefined,
): boolean {
  return jobs?.some((job) => isMobileMigrationRunning(job.status)) ?? false;
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function numberish(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
