import { describe, expect, it } from "vitest";

import type { MigrationJob, MigrationStatus } from "../../lib/api-client";
import {
  canAdvanceMigrationStatus,
  mergeMigrationJob,
} from "../../components/migration/migrations-surface-helpers";

function job(
  status: MigrationStatus,
  overrides: Partial<MigrationJob> = {},
): MigrationJob {
  return {
    id: "job-state-1",
    source: "beehiiv",
    status,
    progress: { subscribers_done: 10, subscribers_total: 10 },
    ...overrides,
  };
}

describe("migration lifecycle fallback reducer", () => {
  it("rejects ordinary backward snapshots", () => {
    expect(canAdvanceMigrationStatus("importing", "discovering")).toBe(false);
    expect(canAdvanceMigrationStatus("awaiting_confirmation", "dry_run")).toBe(
      false,
    );
    expect(canAdvanceMigrationStatus("completed", "importing")).toBe(false);
    expect(canAdvanceMigrationStatus("rolled_back", "completed")).toBe(false);
  });

  it("retains explicit rollback and cancelled-resume generations", () => {
    expect(canAdvanceMigrationStatus("completed", "rolling_back")).toBe(true);
    expect(canAdvanceMigrationStatus("rolling_back", "rolled_back")).toBe(true);
    expect(
      canAdvanceMigrationStatus(
        "failed",
        "importing",
        "migration cancelled by operator",
      ),
    ).toBe(true);
    expect(
      canAdvanceMigrationStatus("failed", "importing", "provider failure"),
    ).toBe(false);
  });

  it("does not let stale traffic regress terminal state, cursor, error, or progress", () => {
    const current = job("completed", {
      completed_at: "2026-08-09T10:00:00.000Z",
      cursor: { provider_cursor: "terminal" },
      error: null,
      verification_report: { subscribers_imported: 10 },
    });
    const stale = job("importing", {
      progress: { subscribers_done: 7, subscribers_total: 10 },
      cursor: { provider_cursor: "stale" },
      error: "stale provider body",
      completed_at: null,
      verification_report: null,
    });

    expect(mergeMigrationJob(current, stale)).toMatchObject({
      status: "completed",
      progress: { subscribers_done: 10, subscribers_total: 10 },
      cursor: { provider_cursor: "terminal" },
      error: null,
      completed_at: "2026-08-09T10:00:00.000Z",
      verification_report: { subscribers_imported: 10 },
    });
  });

  it("accepts a verified rollback generation after completion", () => {
    expect(
      mergeMigrationJob(
        job("completed"),
        job("rolling_back", {
          progress: { subscribers_done: 10, subscribers_total: 10 },
        }),
      ).status,
    ).toBe("rolling_back");
  });
});
