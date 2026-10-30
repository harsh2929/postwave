import { describe, expect, it } from "vitest";

import { toRecentMigration } from "@/lib/migration-recent";
import type { MigrationJob } from "@/lib/types";

function job(overrides: Partial<MigrationJob> = {}): MigrationJob {
  return {
    id: "job_1",
    tenant_id: "tenant_1",
    source: "mailchimp",
    status: "completed",
    progress: {
      subscribers_total: 10,
      subscribers_done: 5,
      segments_total: 0,
      segments_done: 0,
      automations_total: 0,
      automations_done: 0,
      archive_total: 0,
      archive_done: 0,
      paid_subs_total: 0,
      paid_subs_done: 0,
    },
    cursor: {},
    started_at: "2026-07-02T00:00:00.000Z",
    completed_at: "2026-07-02T00:30:00.000Z",
    rollback_until: null,
    verification_report: null,
    error: null,
    ...overrides,
  };
}

describe("toRecentMigration", () => {
  it("summarizes selected Mailchimp audience scope for recent migrations", () => {
    expect(
      toRecentMigration(job({ selected_audience_ids: ["aud_a", "aud_b"] }))
        .audienceScope,
    ).toBe("2 selected audiences");
  });

  it("omits audience scope when no selected audience metadata is present", () => {
    expect(toRecentMigration(job()).audienceScope).toBeNull();
  });

  it("uses template and source-archive counters in the list percentage", () => {
    expect(
      toRecentMigration(
        job({
          progress: {
            ...job().progress,
            subscribers_total: 10,
            subscribers_done: 10,
            templates_total: 10,
            templates_done: 0,
            source_archive_total: 20,
            source_archive_done: 0,
          },
        }),
      ).progress,
    ).toBe(25);
  });

  it("does not show Beehiiv rebuild and premium metadata inventory as unfinished runtime work", () => {
    expect(
      toRecentMigration(
        job({
          source: "beehiiv",
          progress: {
            subscribers_total: 10,
            subscribers_done: 10,
            segments_total: 2,
            segments_done: 2,
            automations_total: 4,
            automations_done: 0,
            paid_subs_total: 5,
            paid_subs_done: 0,
            archive_total: 3,
            archive_done: 3,
          },
        }),
      ).progress,
    ).toBe(100);
  });
});
