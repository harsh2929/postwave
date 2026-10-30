import type { MigrationJob, MigrationSource } from "../../lib/api-client";
import { isCancelledJob } from "./cancelledJob";
import {
  normalizeMigrationJob,
  parseMigrationTime,
} from "./migrations-surface-helpers";

const DAY_MS = 24 * 60 * 60 * 1_000;

/**
 * The migration service rejects cutover/source-reading actions for the five
 * long-running bridge adapters throughout their final fourteen days of saved
 * session retention. Keep this value equal to
 * `sourceBridgeNearExpiryWindow` in the migration service.
 */
export const MIGRATION_SOURCE_BRIDGE_REQUIRED_WINDOW_MS = 14 * DAY_MS;

const SOURCE_BRIDGE_SESSION_SOURCES: ReadonlySet<MigrationSource> = new Set([
  "activecampaign",
  "beehiiv",
  "hubspot",
  "klaviyo",
  "customerio",
]);

export type MigrationSourceSessionHealth =
  | {
      kind: "missing";
      blocksAction: true;
      expiresAt: null;
      message: string;
    }
  | {
      kind: "expired";
      blocksAction: true;
      expiresAt: string;
      message: string;
    }
  | {
      kind: "near_expiry";
      blocksAction: true;
      expiresAt: string;
      message: string;
    }
  | {
      kind: "healthy";
      blocksAction: false;
      expiresAt: string;
      message: string;
    };

export interface ExactMigrationJobIdentity {
  id: string;
  source: MigrationSource;
}

export type MigrationCommitPreflight =
  | {
      ok: true;
      job: MigrationJob;
      health: Extract<MigrationSourceSessionHealth, { kind: "healthy" }>;
    }
  | {
      ok: false;
      code: "migration_commit_preflight_unavailable";
      reason: string;
      job?: MigrationJob;
      health?: MigrationSourceSessionHealth;
    };

export type MigrationResumePreflight =
  | {
      ok: true;
      job: MigrationJob;
      health: Extract<MigrationSourceSessionHealth, { kind: "healthy" }>;
    }
  | {
      ok: false;
      code: "migration_resume_preflight_unavailable";
      reason: string;
      job?: MigrationJob;
      health?: MigrationSourceSessionHealth;
    };

export function isMigrationSourceBridgeSession(
  source: MigrationSource,
): boolean {
  return SOURCE_BRIDGE_SESSION_SOURCES.has(source);
}

/**
 * Derive one bounded, fail-closed state. Invalid clocks and malformed or
 * absent timestamps are deliberately indistinguishable from a missing saved
 * session: neither can authorize a mutation.
 */
export function migrationSourceSessionHealth(
  job: Pick<MigrationJob, "source" | "source_session_expires_at">,
  now = Date.now(),
): MigrationSourceSessionHealth {
  if (!Number.isFinite(now)) return missingSessionHealth();
  const expiresAt = parseMigrationTime(job.source_session_expires_at);
  if (expiresAt === null) return missingSessionHealth();
  const normalizedExpiry = new Date(expiresAt).toISOString();
  if (expiresAt <= now) {
    return {
      kind: "expired",
      blocksAction: true,
      expiresAt: normalizedExpiry,
      message:
        "The saved source authorization has expired. Reconnect this exact migration job and verify a fresh snapshot before continuing.",
    };
  }
  if (
    isMigrationSourceBridgeSession(job.source) &&
    expiresAt - now <= MIGRATION_SOURCE_BRIDGE_REQUIRED_WINDOW_MS
  ) {
    return {
      kind: "near_expiry",
      blocksAction: true,
      expiresAt: normalizedExpiry,
      message:
        "This bridge session is inside the server's required 14-day safety window. Reconnect this exact migration job and verify the refreshed expiry before continuing.",
    };
  }
  return {
    kind: "healthy",
    blocksAction: false,
    expiresAt: normalizedExpiry,
    message: "The exact job has a source session valid for this action.",
  };
}

function missingSessionHealth(): Extract<
  MigrationSourceSessionHealth,
  { kind: "missing" }
> {
  return {
    kind: "missing",
    blocksAction: true,
    expiresAt: null,
    message:
      "No verifiable saved source authorization is attached to this exact migration job. Reconnect and verify this job before continuing.",
  };
}

/** Strictly decode and bind a wire job to the requested job and source. */
export function decodeExactMigrationJob(
  value: unknown,
  expected: ExactMigrationJobIdentity,
): MigrationJob | null {
  const job = normalizeMigrationJob(value);
  return job && job.id === expected.id && job.source === expected.source
    ? job
    : null;
}

/**
 * Commit authority is the fresh server job, never the renderer's dry-run
 * card. Mailchimp additionally binds the approved audience set exactly after
 * applying the same trim/dedupe/sort normalization as the migration service.
 */
export function preflightMigrationCommit(
  value: unknown,
  expected: ExactMigrationJobIdentity,
  selectedAudienceIds: readonly string[],
  now = Date.now(),
): MigrationCommitPreflight {
  const job = decodeExactMigrationJob(value, expected);
  if (!job) {
    return commitPreflightFailure(
      "The exact migration job and source could not be verified from the fresh server snapshot.",
    );
  }
  if (job.status !== "awaiting_confirmation") {
    return commitPreflightFailure(
      "The fresh server job is no longer awaiting confirmation. Run and review a new dry-run before importing.",
      job,
    );
  }
  const health = migrationSourceSessionHealth(job, now);
  if (health.blocksAction) {
    return commitPreflightFailure(health.message, job, health);
  }
  if (job.source === "mailchimp") {
    const reviewed = canonicalAudienceScope(job.selected_audience_ids);
    const requested = canonicalAudienceScope(selectedAudienceIds);
    if (
      !reviewed ||
      !requested ||
      reviewed.length === 0 ||
      requested.length === 0 ||
      !sameStringArray(reviewed, requested)
    ) {
      return commitPreflightFailure(
        "The fresh Mailchimp job does not carry the exact audience scope approved by this dry-run. Prepare and review a new scoped dry-run.",
        job,
        health,
      );
    }
  }
  return { ok: true, job, health };
}

/** Resume only from a freshly decoded cancelled job with a healthy session. */
export function preflightMigrationResume(
  value: unknown,
  expected: ExactMigrationJobIdentity,
  now = Date.now(),
): MigrationResumePreflight {
  const job = decodeExactMigrationJob(value, expected);
  if (!job) {
    return resumePreflightFailure(
      "The exact migration job and source could not be verified from the fresh server snapshot.",
    );
  }
  if (!isCancelledJob(job)) {
    return resumePreflightFailure(
      "The fresh server job is no longer a cancelled migration that can resume from this checkpoint.",
      job,
    );
  }
  const health = migrationSourceSessionHealth(job, now);
  if (health.blocksAction) {
    return resumePreflightFailure(health.message, job, health);
  }
  return { ok: true, job, health };
}

function commitPreflightFailure(
  reason: string,
  job?: MigrationJob,
  health?: MigrationSourceSessionHealth,
): MigrationCommitPreflight {
  return {
    ok: false,
    code: "migration_commit_preflight_unavailable",
    reason,
    ...(job ? { job } : {}),
    ...(health ? { health } : {}),
  };
}

function resumePreflightFailure(
  reason: string,
  job?: MigrationJob,
  health?: MigrationSourceSessionHealth,
): MigrationResumePreflight {
  return {
    ok: false,
    code: "migration_resume_preflight_unavailable",
    reason,
    ...(job ? { job } : {}),
    ...(health ? { health } : {}),
  };
}

function canonicalAudienceScope(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > 1_000) return null;
  const seen = new Set<string>();
  for (const candidate of value) {
    if (typeof candidate !== "string") return null;
    const id = candidate.trim();
    if (!id || id.length > 512) return null;
    seen.add(id);
  }
  return Array.from(seen).sort();
}

function sameStringArray(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}
