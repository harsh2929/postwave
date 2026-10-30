import { describe, expect, it } from "vitest";

import {
  filterMobileMigrations,
  isMobileMigrationDone,
  isMobileMigrationFailure,
  isMobileMigrationRunning,
  mobileMigrationPercent,
  mobileMigrationResourceProgress,
  mobileMigrationStatusCounts,
  shouldPollMobileMigrations,
} from "./migrationProgress";

describe("mobile migration progress", () => {
  it("recognizes every canonical lifecycle status", () => {
    for (const status of [
      "pending",
      "authenticating",
      "discovering",
      "dry_run",
      "awaiting_confirmation",
      "importing",
      "rolling_back",
    ] as const) {
      expect(isMobileMigrationRunning(status)).toBe(true);
    }
    expect(isMobileMigrationFailure("failed")).toBe(true);
    expect(isMobileMigrationDone("completed")).toBe(true);
    expect(isMobileMigrationDone("rolled_back")).toBe(true);
    expect(isMobileMigrationDone("committed")).toBe(false);
  });

  it("counts and filters jobs through the same canonical status groups", () => {
    const jobs = [
      { id: "pending", status: "pending" as const },
      { id: "active", status: "importing" as const },
      { id: "failed", status: "failed" as const },
      { id: "done", status: "completed" as const },
      { id: "rolled-back", status: "rolled_back" as const },
    ];

    expect(mobileMigrationStatusCounts(jobs)).toEqual({
      all: 5,
      running: 2,
      failed: 1,
      done: 2,
    });
    expect(filterMobileMigrations(jobs, "all")).toBe(jobs);
    expect(
      filterMobileMigrations(jobs, "running").map((job) => job.id),
    ).toEqual(["pending", "active"]);
    expect(filterMobileMigrations(jobs, "failed").map((job) => job.id)).toEqual(
      ["failed"],
    );
    expect(filterMobileMigrations(jobs, "done").map((job) => job.id)).toEqual([
      "done",
      "rolled-back",
    ]);
  });

  it("aggregates every canonical resource instead of using the first counter", () => {
    const progress = {
      subscribers_done: 100,
      subscribers_total: 100,
      segments_done: 2,
      segments_total: 10,
      automations_done: 1,
      automations_total: 5,
      paid_subs_done: 0,
      paid_subs_total: 2,
      archive_done: 4,
      archive_total: 20,
      templates_done: 3,
      templates_total: 6,
      source_archive_done: 5,
      source_archive_total: 10,
    };
    const rows = mobileMigrationResourceProgress(progress);
    expect(rows.map((row) => row.resource)).toEqual([
      "subscribers",
      "segments",
      "automations",
      "paid_subs",
      "archive",
      "templates",
      "source_archive",
    ]);
    expect(
      mobileMigrationPercent({
        id: "job_1",
        status: "importing",
        progress,
      }),
    ).toBe(75);
  });

  // GOVERNANCE#57. `mobileMigrationPercent` used to prefer `progress.percent`
  // and fall back to `progress.completed / progress.total`. The migration
  // service has never sent any of those three — canonical.MigrationProgress
  // (packages/migrate/canonical/types.go:347) is `<resource>_done` /
  // `<resource>_total` pairs only — so both branches were unreachable, and
  // they only compiled because the mobile-local type carried an index
  // signature. These pin the behaviour that is left.
  it("ignores a server-invented percentage and sums the real counters", () => {
    expect(
      mobileMigrationPercent({
        id: "job_percent",
        status: "importing",
        // A gateway that started sending `percent` must not be able to
        // contradict the counters the bar is actually drawn from.
        progress: {
          subscribers_done: 1,
          subscribers_total: 4,
        } as Record<string, number>,
      }),
    ).toBe(25);
  });

  it("reports absence as null, never as 0% done", () => {
    expect(mobileMigrationPercent({ id: "no-progress" })).toBeNull();
    expect(
      mobileMigrationPercent({ id: "empty-progress", progress: {} }),
    ).toBeNull();
    // Every counter present but zero-length: nothing has been measured yet,
    // which is not the same statement as "0% of the work is done".
    expect(
      mobileMigrationPercent({
        id: "zero-totals",
        progress: { subscribers_done: 0, subscribers_total: 0 },
      }),
    ).toBeNull();
  });

  it("labels Customer.io progress as frozen, archive, and rebuild evidence", () => {
    const rows = mobileMigrationResourceProgress(
      {
        segments_done: 2,
        segments_total: 2,
        automations_done: 3,
        automations_total: 3,
        archive_done: 4,
        archive_total: 4,
        source_archive_done: 5,
        source_archive_total: 5,
      },
      "customerio",
    );
    expect(rows.map((row) => row.label)).toEqual([
      "Frozen segment/topic snapshots",
      "Workflow rebuild records",
      "Sent email newsletter archive",
      "Workflow/channel/ecosystem evidence",
    ]);
  });

  it("polls only while at least one job is non-terminal", () => {
    expect(
      shouldPollMobileMigrations([
        { id: "done", status: "completed" },
        { id: "active", status: "rolling_back" },
      ]),
    ).toBe(true);
    expect(
      shouldPollMobileMigrations([
        { id: "done", status: "completed" },
        { id: "failed", status: "failed" },
      ]),
    ).toBe(false);
  });
});
