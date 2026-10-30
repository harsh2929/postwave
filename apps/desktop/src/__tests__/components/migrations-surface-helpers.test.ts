import { describe, expect, it } from "vitest";

import type { MigrationJob } from "../../lib/api-client";
import {
  formatMigrationRelativeTime,
  mergeMigrationJob,
  migrationOverallProgress,
  migrationRollbackEligibility,
  normalizeMigrationJob,
  normalizeMigrationProgressEvent,
  normalizeMigrationRollbackCandidate,
  normalizeMigrationJobs,
  parseMigrationJobsPayload,
  safeMigrationEvidenceText,
  safeMigrationFailure,
  safeMigrationOperationText,
} from "../../components/migration/migrations-surface-helpers";

function job(overrides: Partial<MigrationJob> = {}): MigrationJob {
  return {
    id: "job-verified-123",
    source: "beehiiv",
    status: "completed",
    started_at: "2026-07-16T08:00:00.000Z",
    completed_at: "2026-07-16T09:00:00.000Z",
    rollback_until: "2026-07-23T09:00:00.000Z",
    ...overrides,
  };
}

describe("migration surface helpers", () => {
  it("normalizes only complete known jobs, sorts a copy, and bounds progress", () => {
    const input = [
      job({ id: "older", started_at: "2026-07-15T08:00:00.000Z" }),
      { id: "missing-status", source: "csv" },
      job({
        id: "newer",
        started_at: "2026-07-16T08:00:00.000Z",
        progress: {
          subscribers_done: 150,
          subscribers_total: 100,
          segments_done: 3,
          segments_total: 5,
        },
      }),
      null,
    ];

    const normalized = normalizeMigrationJobs({ items: input });
    expect(normalized.map((item) => item.id)).toEqual(["newer", "older"]);
    expect(normalized[0]?.progress).toEqual({
      subscribers_done: 150,
      subscribers_total: 100,
      segments_done: 3,
      segments_total: 5,
    });
    expect((input[0] as MigrationJob).id).toBe("older");
    expect(migrationOverallProgress(normalized[0]?.progress, "csv")).toBeNull();
    expect(parseMigrationJobsPayload({ unknown: [] })).toMatchObject({
      ok: false,
      error: { code: "migration_jobs_invalid_envelope" },
    });
    expect(parseMigrationJobsPayload([job(), { source: "csv" }])).toMatchObject(
      {
        ok: false,
        error: { code: "migration_jobs_invalid_item" },
      },
    );
    expect(
      parseMigrationJobsPayload([
        job({ selected_audience_ids: ["audience-1", {} as string] }),
      ]),
    ).toMatchObject({
      ok: false,
      error: { code: "migration_jobs_invalid_item" },
    });
    expect(
      parseMigrationJobsPayload([job({ progress: { subscribers_done: -1 } })]),
    ).toMatchObject({
      ok: false,
      error: { code: "migration_jobs_invalid_item" },
    });
  });

  it("keeps Beehiiv rebuild and membership metadata out of runtime progress", () => {
    const progress = {
      subscribers_done: 50,
      subscribers_total: 100,
      automations_done: 10,
      automations_total: 10,
      paid_subs_done: 10,
      paid_subs_total: 10,
    };
    expect(migrationOverallProgress(progress, "beehiiv")).toBe(50);
    expect(migrationOverallProgress(progress, "activecampaign")).toBe(60);
    expect(migrationOverallProgress(progress, "mailchimp")).toBe(67);
  });

  it("formats future evidence as future and never invents a rollback deadline", () => {
    const now = Date.parse("2026-07-17T09:00:00.000Z");
    expect(formatMigrationRelativeTime("2026-07-19T09:00:00.000Z", now)).toBe(
      "in 2 days",
    );
    expect(
      migrationRollbackEligibility(
        job({ rollback_until: null, completed_at: "2026-07-16T09:00:00Z" }),
        true,
        now,
      ),
    ).toMatchObject({
      allowed: false,
      reason: "The server did not provide a verifiable rollback deadline.",
      deadline: null,
    });
    expect(migrationRollbackEligibility(job(), true, now)).toMatchObject({
      allowed: true,
    });
    expect(migrationRollbackEligibility(job(), false, now)).toMatchObject({
      allowed: false,
      reason: "Admin role required to roll back tenant data.",
    });
    expect(
      normalizeMigrationRollbackCandidate(job(), job(), now),
    ).toMatchObject({ id: "job-verified-123", status: "completed" });
    expect(
      normalizeMigrationRollbackCandidate(
        job({ rollback_until: "2026-07-17T08:59:59.000Z" }),
        job(),
        now,
      ),
    ).toBeNull();
    expect(
      normalizeMigrationRollbackCandidate(
        job({ id: "different-job" }),
        job(),
        now,
      ),
    ).toBeNull();
  });

  it("keeps the more advanced progress while accepting an authoritative status", () => {
    const current = job({
      status: "importing",
      progress: { subscribers_done: 80, subscribers_total: 100 },
    });
    const incoming = job({
      status: "rolling_back",
      progress: { subscribers_done: 40, subscribers_total: 100 },
    });
    expect(mergeMigrationJob(current, incoming)).toMatchObject({
      status: "rolling_back",
      progress: { subscribers_done: 80, subscribers_total: 100 },
    });
  });

  it("redacts provider evidence and returns bounded safe failures", () => {
    const evidence = safeMigrationEvidenceText(
      "Authorization: Bearer super-secret at https://provider.test/private/path",
    );
    expect(evidence).not.toContain("super-secret");
    expect(evidence).not.toContain("provider.test");

    const failure = safeMigrationFailure(
      {
        message: "postgres password=hunter2",
        kind: "network",
        code: "MIGRATION_TIMEOUT",
        requestId: "req-safe-1",
      },
      "Rollback",
    );
    expect(failure.message).toBe("Rollback could not be confirmed.");
    expect(failure.detail).toContain("MIGRATION_TIMEOUT");
    expect(failure.detail).toContain("req-safe-1");
    expect(failure.detail).not.toContain("hunter2");

    expect(
      normalizeMigrationJobs([
        job({ status: "failed", error: "provider token=raw-failure" }),
      ])[0]?.error,
    ).toBe("Migration failure detail withheld");
    expect(
      normalizeMigrationJobs([
        job({ status: "failed", error: "migration cancelled by operator" }),
      ])[0]?.error,
    ).toBe("migration cancelled by operator");

    expect(
      safeMigrationOperationText(
        new Error("Bearer raw-provider-secret"),
        "Cancellation",
      ),
    ).not.toContain("raw-provider-secret");
  });

  it("strictly decodes nested job evidence without retaining wire-only secrets", () => {
    const normalized = normalizeMigrationJob({
      ...job(),
      tenant_id: "tenant-must-not-reach-renderer",
      provider_secret: "must-not-reach-renderer",
      cursor: { provider_cursor: "cursor-secret" },
      verification_report: {
        subscribers_imported: 12,
        data_loss_estimate_pct: 0.5,
        custom_fields_mapped: [
          { source: "API key=secret", canonical: "company", type: "string" },
        ],
        subscriber_merge_conflicts: [
          {
            email: "person@example.test",
            source_ids: ["source-person-1"],
          },
        ],
      },
    });

    expect(normalized).toMatchObject({
      id: "job-verified-123",
      cursor: { provider_cursor: null },
      verification_report: {
        subscribers_imported: 12,
        data_loss_estimate_pct: 0.5,
        custom_fields_mapped: [
          {
            source: "API key=[redacted]",
            canonical: "company",
            type: "string",
          },
        ],
        subscriber_merge_conflicts: [{ email: "withheld" }],
      },
    });
    expect(normalized).not.toHaveProperty("tenant_id");
    expect(normalized).not.toHaveProperty("provider_secret");
    expect(JSON.stringify(normalized)).not.toContain("cursor-secret");
    expect(JSON.stringify(normalized)).not.toContain("person@example.test");

    expect(
      normalizeMigrationJob({
        ...job(),
        verification_report: {
          custom_fields_mapped: [{ source: "company", canonical: 42 }],
        },
      }),
    ).toBeNull();
    expect(
      normalizeMigrationJob({
        ...job(),
        verification_report: {
          resource_completeness: [
            {
              resource: "subscribers",
              label: "Subscribers",
              source_total: 12,
              imported: 12,
              supported: true,
              status: "nonsense",
            },
          ],
        },
      }),
    ).toBeNull();
    expect(
      normalizeMigrationJob({
        ...job(),
        verification_report: {
          resource_completeness: [
            {
              resource: "subscribers",
              label: "Subscribers",
              source_total: 12,
              imported: 12,
              supported: true,
              status: "imported_runtime",
            },
            {
              resource: "subscribers",
              label: "Subscribers duplicate",
              source_total: 12,
              imported: 12,
              supported: true,
              status: "imported_runtime",
            },
          ],
        },
      }),
    ).toBeNull();
    expect(
      normalizeMigrationJob({ ...job(), started_at: "July 16, 2026" }),
    ).toBeNull();
    expect(
      normalizeMigrationJob({
        ...job(),
        progress: { subscribers_done: 1.5, subscribers_total: 2 },
      }),
    ).toBeNull();
  });

  it("accepts only bounded, timestamped progress events", () => {
    expect(
      normalizeMigrationProgressEvent({
        resource: "subscribers",
        completed: 4,
        total: 10,
        current_step: "Bearer provider-secret",
        at: "2026-07-17T09:00:00.000Z",
        snapshot: { subscribers_done: 4, subscribers_total: 10 },
      }),
    ).toEqual({
      resource: "subscribers",
      completed: 4,
      total: 10,
      at: "2026-07-17T09:00:00.000Z",
      snapshot: { subscribers_done: 4, subscribers_total: 10 },
    });
    expect(
      normalizeMigrationProgressEvent({
        resource: "subscribers",
        completed: 11,
        total: 10,
        at: "invalid",
        snapshot: { subscribers_done: 11, subscribers_total: 10 },
      }),
    ).toBeNull();
    expect(
      normalizeMigrationProgressEvent({
        resource: "subscribers",
        completed: 1,
        total: 0,
        at: "2026-07-17T09:00:00.000Z",
        snapshot: { subscribers_done: 1, subscribers_total: 0 },
      }),
    ).toBeNull();
    expect(
      normalizeMigrationProgressEvent({
        resource: "subscribers",
        completed: 0.5,
        total: 10,
        at: "2026-07-17T09:00:00.000Z",
        snapshot: { subscribers_done: 0.5, subscribers_total: 10 },
      }),
    ).toBeNull();
    expect(
      normalizeMigrationProgressEvent({
        resource: "subscribers",
        completed: 1,
        total: 10,
        at: 1_768_000_000_000,
        snapshot: { subscribers_done: 1, subscribers_total: 10 },
      }),
    ).toBeNull();
  });
});
