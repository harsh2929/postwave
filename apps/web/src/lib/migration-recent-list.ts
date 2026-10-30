// SPDX-License-Identifier: AGPL-3.0-only
//
// Pure list logic for the recent-migrations table: status filtering, sorting,
// pagination, the "is this row still live?" test that drives polling, the
// "Continue" deep-link into the wizard for half-finished jobs (MIGR-021), and
// the local dismiss ledger that hides stale/abandoned jobs from the list
// (MIGR-024 — dismiss is client-local; there is no server delete endpoint).

import type { Route } from "next";
import type { RecentMigration } from "./migration-recent";
import { isTerminal, type MigrationStatus } from "./types";

// ─── Status filter ─────────────────────────────────────────────────────────

export type MigrationStatusFilter = "all" | "active" | MigrationStatus;

export const MIGRATION_STATUS_FILTERS: {
  value: MigrationStatusFilter;
  label: string;
}[] = [
  { value: "all", label: "All statuses" },
  { value: "active", label: "In progress" },
  { value: "completed", label: "Completed" },
  { value: "failed", label: "Failed" },
  { value: "rolled_back", label: "Rolled back" },
];

/** Non-terminal jobs are still moving and should drive live polling. */
export function isActiveStatus(status: MigrationStatus): boolean {
  return !isTerminal(status);
}

export function hasActiveRows(rows: RecentMigration[]): boolean {
  return rows.some((r) => isActiveStatus(r.status));
}

export function filterByStatus(
  rows: RecentMigration[],
  filter: MigrationStatusFilter,
): RecentMigration[] {
  if (filter === "all") return rows;
  if (filter === "active") return rows.filter((r) => isActiveStatus(r.status));
  return rows.filter((r) => r.status === filter);
}

// ─── Free-text search ───────────────────────────────────────────────────────

/**
 * Case-insensitive match on job id, source (label and platform key), the
 * operator's name for the job, and status (raw and human, so both
 * "rolled_back" and "rolled back" find it). Blank query → every row.
 */
export function searchRecent(
  rows: RecentMigration[],
  query: string,
): RecentMigration[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return rows;
  return rows.filter((r) =>
    [
      r.id,
      r.source,
      r.sourcePlatform,
      r.label ?? "",
      r.status,
      r.status.replace(/_/g, " "),
    ].some((value) => value.toLowerCase().includes(needle)),
  );
}

// ─── Page size ──────────────────────────────────────────────────────────────

export const MIGRATION_PAGE_SIZES = [10, 25, 50, 100] as const;
export type MigrationPageSize = (typeof MIGRATION_PAGE_SIZES)[number];

/** Accept only an offered page size; anything else falls back to the first. */
export function parseMigrationPageSize(value: unknown): MigrationPageSize {
  const n = typeof value === "string" ? Number(value) : value;
  return (MIGRATION_PAGE_SIZES as readonly unknown[]).includes(n)
    ? (n as MigrationPageSize)
    : MIGRATION_PAGE_SIZES[0];
}

// ─── Sort ──────────────────────────────────────────────────────────────────

export type MigrationSortKey = "started" | "source" | "status" | "progress";
export type SortDir = "asc" | "desc";

export function sortRecent(
  rows: RecentMigration[],
  key: MigrationSortKey,
  dir: SortDir,
): RecentMigration[] {
  const factor = dir === "asc" ? 1 : -1;
  const copy = [...rows];
  copy.sort((a, b) => {
    let cmp = 0;
    switch (key) {
      case "started":
        cmp =
          new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime();
        break;
      case "source":
        cmp = a.source.localeCompare(b.source);
        break;
      case "status":
        cmp = a.status.localeCompare(b.status);
        break;
      case "progress":
        cmp = a.progress - b.progress;
        break;
    }
    // Stable tie-break on id so equal keys keep a deterministic order.
    if (cmp === 0) cmp = a.id.localeCompare(b.id);
    return cmp * factor;
  });
  return copy;
}

// ─── Pagination ──────────────────────────────────────────────────────────────

export function pageCount(total: number, pageSize: number): number {
  if (pageSize <= 0) return 1;
  return Math.max(1, Math.ceil(total / pageSize));
}

/** Clamp a requested page into range, then slice. */
export function paginate<T>(
  rows: T[],
  page: number,
  pageSize: number,
): { items: T[]; page: number; pages: number } {
  const pages = pageCount(rows.length, pageSize);
  const clamped = Math.min(Math.max(1, page), pages);
  const start = (clamped - 1) * pageSize;
  return { items: rows.slice(start, start + pageSize), page: clamped, pages };
}

// ─── Continue / resume deep-link (MIGR-021) ─────────────────────────────────

export interface ContinueTarget {
  href: Route;
  label: string;
}

/**
 * A half-finished job (connected but not yet dry-run, or a completed dry-run
 * awaiting commit) can re-enter the wizard at the right step via the existing
 * `?job_id&step` params. Live/terminal jobs return null (the row's "View" link
 * into the detail page is the right destination for those).
 */
export function continueTarget(row: RecentMigration): ContinueTarget | null {
  const base = `/app/migrations/new/${row.sourcePlatform}?job_id=${encodeURIComponent(row.id)}`;
  if (row.status === "awaiting_confirmation") {
    return { href: `${base}&step=discover` as Route, label: "Continue" };
  }
  if (row.status === "dry_run") {
    return { href: `${base}&step=review` as Route, label: "Continue" };
  }
  return null;
}

// ─── Local dismiss ledger (MIGR-024) ────────────────────────────────────────
//
// There is no backend delete/archive endpoint, so "dismiss" hides a job from
// this browser's list only. Terminal or abandoned jobs are the only ones we
// allow hiding; an in-flight import must stay visible.

const DISMISS_KEY_PREFIX = "postwave.web.migration-dismissed.v1:";

export function isDismissable(status: MigrationStatus): boolean {
  return (
    status === "failed" ||
    status === "rolled_back" ||
    status === "awaiting_confirmation"
  );
}

function dismissKey(tenantId: string): string {
  return `${DISMISS_KEY_PREFIX}${tenantId || "anon"}`;
}

export function readDismissed(tenantId: string): Set<string> {
  try {
    const raw = window.localStorage.getItem(dismissKey(tenantId));
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? new Set(parsed.filter((v): v is string => typeof v === "string"))
      : new Set();
  } catch {
    return new Set();
  }
}

export function writeDismissed(tenantId: string, ids: Set<string>): void {
  try {
    window.localStorage.setItem(
      dismissKey(tenantId),
      JSON.stringify(Array.from(ids)),
    );
  } catch {
    /* ignore quota / unavailable storage */
  }
}
