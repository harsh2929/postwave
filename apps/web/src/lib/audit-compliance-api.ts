// SPDX-License-Identifier: AGPL-3.0-only
//
// Compliance-facing reads over the audit log: EU AI Act Article 50 evidence
// (agent activity + AIVS proof bundles) and the retention-purge ledger.
//
// Backend handlers:
//   apps/api/internal/handlers/audit.go        — Stats, AIVSBundle
//   apps/api/internal/handlers/audit_extras.go — ListRetentionActivity
//
// Kept out of audit-operations-api.ts on purpose: these three are read by the
// Compliance page, not by the audit console, and the bundle download is the
// only binary body web fetches from the audit surface.

import { fetchBlobAuthed, api, type AuthedBlobDownload } from "@/lib/api";

/** The trailing window the Article 50 readiness check reports on. */
export const AGENT_ACTIVITY_WINDOW_DAYS = 30;

/** The server's cap on `session_id` (handlers/audit.go AIVSBundle). */
export const MAX_AIVS_SESSION_ID_LENGTH = 128;

/** The server's own ceiling for `?limit=` on the retention ledger. */
export const MAX_RETENTION_ACTIVITY_LIMIT = 500;

export interface AgentAuditActivity {
  /** Agent-actor audit rows inside the requested window. */
  totalEvents: number;
  /** The window the answer describes — echoed back so the UI cannot mislabel it. */
  since: string;
}

export interface RetentionPurgeEvent {
  id: number;
  action: string;
  deletedIdRange: string;
  deletedCount: number;
  retentionDays: number;
  /**
   * Merkle root captured BEFORE the batch was deleted, so an external verifier
   * can prove the purge happened after a known tree state. Empty when the
   * sweeper ran before checkpointing existed for this tenant.
   */
  beforeRootHash: string;
  at: string;
}

export interface RetentionActivity {
  events: RetentionPurgeEvent[];
  /** Rows deleted across the trailing 30 days, summed server-side. */
  totalPurgedLast30d: number;
}

function record(value: unknown, subject: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${subject} response is malformed.`);
  }
  return value as Record<string, unknown>;
}

function count(value: unknown, subject: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${subject} is malformed.`);
  }
  return value;
}

function text(value: unknown, subject: string, max: number): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string" || value.length > max) {
    throw new Error(`${subject} is malformed.`);
  }
  return value;
}

/**
 * The start of the Article 50 reporting window, as an ISO instant.
 *
 * Floored to UTC midnight rather than "now minus 30 days" so the query key is
 * stable for the whole day: an unrounded `since` changes on every render, which
 * would make the cache key change on every render and refetch the count each
 * time the panel re-rendered.
 */
export function agentActivityWindowStart(now: Date): string {
  const midnightUTC = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
  );
  return new Date(
    midnightUTC - AGENT_ACTIVITY_WINDOW_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();
}

/**
 * How many agent-actor rows the tenant's audit log holds since `since`.
 *
 * Deliberately reads only `totalEvents` off a response that also carries actor
 * mix, top actions and a daily series: this panel answers one question, and
 * validating fields it never renders would make an unrelated server addition
 * fail the readiness check.
 */
export async function getAgentAuditActivity(
  since: string,
  options: { signal?: AbortSignal } = {},
): Promise<AgentAuditActivity> {
  const response = record(
    await api.get<unknown>(
      `/api/v1/audit/stats?actor_type=agent&since=${encodeURIComponent(since)}`,
      { signal: options.signal },
    ),
    "Agent activity",
  );
  return {
    totalEvents: count(response.totalEvents, "Agent activity total"),
    since,
  };
}

/**
 * The retention-purge ledger: one row per batch the audit trim worker deleted.
 *
 * An empty list is an ANSWER ("the sweeper has not deleted anything for this
 * tenant"), never an error — a fresh workspace legitimately has none.
 */
export async function listRetentionActivity(
  options: { limit?: number; signal?: AbortSignal } = {},
): Promise<RetentionActivity> {
  const limit = Math.min(
    MAX_RETENTION_ACTIVITY_LIMIT,
    Math.max(1, Math.floor(options.limit ?? 200)),
  );
  const response = record(
    await api.get<unknown>(
      `/api/v1/audit/retention-activity?limit=${limit}`,
      { signal: options.signal },
    ),
    "Retention activity",
  );
  const rows = response.events;
  if (!Array.isArray(rows) || rows.length > MAX_RETENTION_ACTIVITY_LIMIT) {
    throw new Error("Retention activity response is malformed.");
  }
  return {
    events: rows.map((row) => {
      const event = record(row, "Retention purge event");
      return {
        id: count(event.id, "Retention purge event id"),
        action: text(event.action, "Retention purge action", 128),
        deletedIdRange: text(
          event.deleted_id_range,
          "Retention purge id range",
          256,
        ),
        deletedCount: count(event.deleted_count, "Retention purge count"),
        retentionDays: count(event.retention_days, "Retention window"),
        beforeRootHash: text(
          event.before_root_hash,
          "Retention purge root hash",
          256,
        ),
        at: text(event.at, "Retention purge timestamp", 64),
      };
    }),
    totalPurgedLast30d: count(
      response.total_purged_last_30d,
      "Retention purge 30-day total",
    ),
  };
}

/**
 * Whether a pasted value can be sent as an AIVS `session_id`.
 *
 * Only the two conditions the server itself refuses with a 400 — empty and
 * over 128 characters. Everything else goes to the server so the reader sees
 * the server's own sentence rather than a guess made here.
 */
export function isSendableAIVSSessionId(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= MAX_AIVS_SESSION_ID_LENGTH;
}

/**
 * The signed AIVS proof bundle (.tar.gz) for one AI agent session.
 *
 * Returns the bytes plus the name to save them under. The server names the
 * file in `Content-Disposition`; the fallback is only used when a proxy strips
 * that header, because saving an evidence bundle as "download" would leave the
 * inspector unable to tell one session's proof from another's.
 */
export async function downloadAIVSBundle(
  sessionId: string,
  options: { signal?: AbortSignal } = {},
): Promise<AuthedBlobDownload & { filename: string }> {
  const trimmed = sessionId.trim();
  const result = await fetchBlobAuthed(
    `/api/v1/audit/ai-session/${encodeURIComponent(trimmed)}/aivs-bundle`,
    { accept: "application/gzip", signal: options.signal },
  );
  return {
    blob: result.blob,
    filename: result.filename ?? aivsFallbackFilename(trimmed),
  };
}

/**
 * The name to save a bundle under when the response carried no
 * `Content-Disposition`. Mirrors the server's own scheme (handlers/audit.go
 * `sessionFilenamePart`) so a stripped header does not change how the file is
 * named, and so two sessions never land on the same name.
 */
function aivsFallbackFilename(sessionId: string): string {
  const part = sessionId.replaceAll(/[^A-Za-z0-9_-]/gu, "_").slice(0, 48);
  return `postwave-aivs-${part}.tar.gz`;
}
