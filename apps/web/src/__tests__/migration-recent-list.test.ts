import { describe, expect, it } from "vitest";

import type { RecentMigration } from "@/lib/migration-recent";
import {
  continueTarget,
  filterByStatus,
  hasActiveRows,
  isActiveStatus,
  isDismissable,
  paginate,
  pageCount,
  sortRecent,
} from "@/lib/migration-recent-list";
import type { MigrationStatus, SourcePlatform } from "@/lib/types";

function row(overrides: Partial<RecentMigration> = {}): RecentMigration {
  return {
    id: "job_1",
    source: "Mailchimp",
    sourcePlatform: "mailchimp" as SourcePlatform,
    label: null,
    audienceScope: null,
    startedAt: "2026-07-02T00:00:00.000Z",
    status: "completed" as MigrationStatus,
    progress: 100,
    ...overrides,
  };
}

describe("recent-migrations list logic (MIGR-019/021/024/031)", () => {
  it("treats non-terminal statuses as active (drives polling)", () => {
    expect(isActiveStatus("importing")).toBe(true);
    expect(isActiveStatus("awaiting_confirmation")).toBe(true);
    expect(isActiveStatus("completed")).toBe(false);
    expect(isActiveStatus("rolled_back")).toBe(false);
  });

  it("hasActiveRows detects any live row", () => {
    expect(hasActiveRows([row(), row({ id: "b", status: "importing" })])).toBe(
      true,
    );
    expect(hasActiveRows([row(), row({ id: "b", status: "failed" })])).toBe(
      false,
    );
  });

  it("filters by status, with an 'active' bucket", () => {
    const rows = [
      row({ id: "a", status: "completed" }),
      row({ id: "b", status: "importing" }),
      row({ id: "c", status: "failed" }),
    ];
    expect(filterByStatus(rows, "all")).toHaveLength(3);
    expect(filterByStatus(rows, "active").map((r) => r.id)).toEqual(["b"]);
    expect(filterByStatus(rows, "failed").map((r) => r.id)).toEqual(["c"]);
  });

  it("sorts by started time in both directions, stable on id", () => {
    const rows = [
      row({ id: "a", startedAt: "2026-07-01T00:00:00.000Z" }),
      row({ id: "b", startedAt: "2026-07-03T00:00:00.000Z" }),
      row({ id: "c", startedAt: "2026-07-02T00:00:00.000Z" }),
    ];
    expect(sortRecent(rows, "started", "desc").map((r) => r.id)).toEqual([
      "b",
      "c",
      "a",
    ]);
    expect(sortRecent(rows, "started", "asc").map((r) => r.id)).toEqual([
      "a",
      "c",
      "b",
    ]);
  });

  it("paginates and clamps out-of-range pages", () => {
    const rows = Array.from({ length: 25 }, (_, i) => row({ id: `j${i}` }));
    const p1 = paginate(rows, 1, 10);
    expect(p1.items).toHaveLength(10);
    expect(p1.pages).toBe(3);
    const p9 = paginate(rows, 9, 10);
    expect(p9.page).toBe(3);
    expect(p9.items).toHaveLength(5);
    expect(pageCount(0, 10)).toBe(1);
  });

  it("offers Continue into the wizard only for resumable statuses", () => {
    expect(continueTarget(row({ status: "awaiting_confirmation" }))?.href).toBe(
      "/app/migrations/new/mailchimp?job_id=job_1&step=discover",
    );
    expect(continueTarget(row({ status: "dry_run" }))?.href).toBe(
      "/app/migrations/new/mailchimp?job_id=job_1&step=review",
    );
    expect(continueTarget(row({ status: "importing" }))).toBeNull();
    expect(continueTarget(row({ status: "completed" }))).toBeNull();
  });

  it("only allows dismissing terminal/abandoned jobs", () => {
    expect(isDismissable("failed")).toBe(true);
    expect(isDismissable("rolled_back")).toBe(true);
    expect(isDismissable("awaiting_confirmation")).toBe(true);
    expect(isDismissable("importing")).toBe(false);
    expect(isDismissable("completed")).toBe(false);
  });
});
