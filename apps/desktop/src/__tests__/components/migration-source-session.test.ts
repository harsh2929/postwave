import { describe, expect, it } from "vitest";

import type { MigrationJob } from "../../lib/api-client";
import {
  MIGRATION_SOURCE_BRIDGE_REQUIRED_WINDOW_MS,
  decodeExactMigrationJob,
  migrationSourceSessionHealth,
  preflightMigrationCommit,
  preflightMigrationResume,
} from "../../components/migration/migration-source-session";

const NOW = Date.parse("2026-08-09T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1_000;

function job(overrides: Partial<MigrationJob> = {}): MigrationJob {
  return {
    id: "job-session-1",
    source: "beehiiv",
    status: "awaiting_confirmation",
    started_at: "2026-08-01T12:00:00.000Z",
    source_session_expires_at: new Date(NOW + 30 * DAY_MS).toISOString(),
    ...overrides,
  };
}

describe("migration source-session health", () => {
  it("fails closed for null, absent, malformed, and invalid-clock evidence", () => {
    expect(
      migrationSourceSessionHealth(
        job({ source_session_expires_at: null }),
        NOW,
      ),
    ).toMatchObject({ kind: "missing", blocksAction: true, expiresAt: null });
    expect(
      migrationSourceSessionHealth(
        job({ source_session_expires_at: undefined }),
        NOW,
      ),
    ).toMatchObject({ kind: "missing", blocksAction: true });
    expect(
      migrationSourceSessionHealth(
        job({ source_session_expires_at: "not-a-time" }),
        NOW,
      ),
    ).toMatchObject({ kind: "missing", blocksAction: true });
    expect(migrationSourceSessionHealth(job(), Number.NaN)).toMatchObject({
      kind: "missing",
      blocksAction: true,
    });
  });

  it("distinguishes expired, bridge near-expiry, and healthy sessions at the exact server boundary", () => {
    expect(
      migrationSourceSessionHealth(
        job({ source_session_expires_at: new Date(NOW).toISOString() }),
        NOW,
      ),
    ).toMatchObject({ kind: "expired", blocksAction: true });

    expect(
      migrationSourceSessionHealth(
        job({
          source_session_expires_at: new Date(
            NOW + MIGRATION_SOURCE_BRIDGE_REQUIRED_WINDOW_MS,
          ).toISOString(),
        }),
        NOW,
      ),
    ).toMatchObject({ kind: "near_expiry", blocksAction: true });

    expect(
      migrationSourceSessionHealth(
        job({
          source_session_expires_at: new Date(
            NOW + MIGRATION_SOURCE_BRIDGE_REQUIRED_WINDOW_MS + 1,
          ).toISOString(),
        }),
        NOW,
      ),
    ).toMatchObject({ kind: "healthy", blocksAction: false });

    expect(
      migrationSourceSessionHealth(
        job({
          source: "mailchimp",
          source_session_expires_at: new Date(NOW + 60_000).toISOString(),
        }),
        NOW,
      ),
    ).toMatchObject({ kind: "healthy", blocksAction: false });
  });

  it("moves from stale missing evidence to healthy only after a newly decoded exact job", () => {
    const expected = { id: "job-session-1", source: "beehiiv" } as const;
    const stale = decodeExactMigrationJob(
      job({ source_session_expires_at: null }),
      expected,
    );
    const fresh = decodeExactMigrationJob(job(), expected);

    expect(stale).not.toBeNull();
    expect(migrationSourceSessionHealth(stale!, NOW).kind).toBe("missing");
    expect(fresh).not.toBeNull();
    expect(migrationSourceSessionHealth(fresh!, NOW).kind).toBe("healthy");
  });
});

describe("exact migration mutation preflights", () => {
  it("rejects wrong job and wrong source snapshots before evaluating health", () => {
    expect(
      decodeExactMigrationJob(job({ id: "wrong-job" }), {
        id: "job-session-1",
        source: "beehiiv",
      }),
    ).toBeNull();
    expect(
      decodeExactMigrationJob(job({ source: "klaviyo" }), {
        id: "job-session-1",
        source: "beehiiv",
      }),
    ).toBeNull();
    expect(
      preflightMigrationCommit(
        job({ source: "klaviyo" }),
        { id: "job-session-1", source: "beehiiv" },
        [],
        NOW,
      ),
    ).toMatchObject({
      ok: false,
      code: "migration_commit_preflight_unavailable",
    });
  });

  it("requires awaiting-confirmation and exact normalized Mailchimp audience scope", () => {
    const mailchimp = job({
      source: "mailchimp",
      selected_audience_ids: ["aud-a", "aud-b"],
    });
    const expected = { id: mailchimp.id, source: "mailchimp" } as const;

    expect(
      preflightMigrationCommit(
        mailchimp,
        expected,
        [" aud-b ", "aud-a", "aud-a"],
        NOW,
      ),
    ).toMatchObject({ ok: true, job: { id: "job-session-1" } });
    expect(
      preflightMigrationCommit(
        { ...mailchimp, selected_audience_ids: undefined },
        expected,
        ["aud-a", "aud-b"],
        NOW,
      ),
    ).toMatchObject({
      ok: false,
      code: "migration_commit_preflight_unavailable",
    });
    expect(
      preflightMigrationCommit(mailchimp, expected, ["aud-a"], NOW),
    ).toMatchObject({
      ok: false,
      code: "migration_commit_preflight_unavailable",
    });
    expect(
      preflightMigrationCommit(
        { ...mailchimp, status: "importing" },
        expected,
        ["aud-a", "aud-b"],
        NOW,
      ),
    ).toMatchObject({
      ok: false,
      code: "migration_commit_preflight_unavailable",
    });
  });

  it("requires a fresh exact cancelled job and healthy session before resume", () => {
    const cancelled = job({
      status: "failed",
      error: "migration cancelled by operator",
    });
    expect(
      preflightMigrationResume(
        cancelled,
        { id: cancelled.id, source: cancelled.source },
        NOW,
      ),
    ).toMatchObject({ ok: true });
    expect(
      preflightMigrationResume(
        { ...cancelled, source_session_expires_at: null },
        { id: cancelled.id, source: cancelled.source },
        NOW,
      ),
    ).toMatchObject({
      ok: false,
      code: "migration_resume_preflight_unavailable",
      health: { kind: "missing" },
    });
    expect(
      preflightMigrationResume(
        { ...cancelled, status: "completed", error: null },
        { id: cancelled.id, source: cancelled.source },
        NOW,
      ),
    ).toMatchObject({
      ok: false,
      code: "migration_resume_preflight_unavailable",
    });
  });
});
