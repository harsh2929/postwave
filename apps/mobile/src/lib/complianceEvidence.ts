/**
 * lib/complianceEvidence.ts — the pure half of two evidence panels on the
 * Compliance screen: retention-sweep activity and EU AI Act Article 50
 * readiness.
 *
 * RETENTION. GET /api/v1/audit/retention-activity returns the rows the trim
 * worker actually deleted, each pinned to the Merkle root snapshot taken
 * BEFORE the delete (`before_root_hash`) so an external verifier can prove
 * the purge happened after a known tree state. An empty list is a legitimate
 * answer (fresh tenant, or sweeps suspended by a legal hold) and must never
 * render as an error.
 *
 * ARTICLE 50. The readiness card states only what this client can verify:
 *  - the Article 50(1) disclosure ships on every AI surface in this app
 *    (`AI_DISCLOSURE_TEXT` on SequenceDraftChrome / SequenceDraftReview /
 *    AskAnalyticsSection) — a build-time fact;
 *  - agent-actor audit events in the last 30 days — a live count from
 *    GET /api/v1/audit/stats, the same source desktop's panel reads;
 *  - the AIVS inspector bundle (tar.gz with manifest + signed event chain +
 *    verify.py) exists per AI session at
 *    GET /api/v1/audit/ai-session/{id}/aivs-bundle. On iOS this app FETCHES
 *    it (api/complianceEvidence.fetchAivsBundle): the AuditExportSheet
 *    doctrine forbids handing a session-streamed URL to the OS, so the card
 *    fetches the bytes through the authenticated session instead, writes
 *    them to the app cache (ExpoFileSystem is compiled into the build as a
 *    transitive of `expo`; hoisted per .npmrc public-hoist-pattern), and
 *    hands the FILE to the iOS share sheet. Android's core Share cannot
 *    attach a file and expo-sharing is not in the build, so Android keeps
 *    the honest web-admin handoff copy instead of a dead button.
 *
 * Import-free apart from lib/format so it runs under node vitest.
 */
import { plural } from "@/lib/format";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Mirrors handlers.AuditPurgeEvent (Go). */
export interface RetentionPurgeEvent {
  id: number;
  action: string;
  deletedIdRange: string;
  deletedCount: number;
  retentionDays: number;
  beforeRootHash: string;
  at: string;
}

export interface RetentionActivity {
  events: RetentionPurgeEvent[];
  totalPurgedLast30d: number;
}

/** Parse GET /api/v1/audit/retention-activity. Null = unusable payload. */
export function parseRetentionActivity(raw: unknown): RetentionActivity | null {
  if (!isRecord(raw) || !Array.isArray(raw.events)) return null;
  const events: RetentionPurgeEvent[] = [];
  for (const entry of raw.events) {
    if (!isRecord(entry)) continue;
    const id = typeof entry.id === "number" ? entry.id : NaN;
    if (!Number.isFinite(id)) continue;
    events.push({
      id,
      action: typeof entry.action === "string" ? entry.action : "",
      deletedIdRange:
        typeof entry.deleted_id_range === "string" ? entry.deleted_id_range : "",
      deletedCount:
        typeof entry.deleted_count === "number" && entry.deleted_count >= 0
          ? Math.trunc(entry.deleted_count)
          : 0,
      retentionDays:
        typeof entry.retention_days === "number" && entry.retention_days >= 0
          ? Math.trunc(entry.retention_days)
          : 0,
      beforeRootHash:
        typeof entry.before_root_hash === "string" ? entry.before_root_hash : "",
      at: typeof entry.at === "string" ? entry.at : "",
    });
  }
  const total = raw.total_purged_last_30d;
  return {
    events,
    totalPurgedLast30d:
      typeof total === "number" && Number.isFinite(total) && total >= 0
        ? Math.trunc(total)
        : 0,
  };
}

/** "3 sweeps · 12,400 rows purged in the last 30 days" */
export function retentionHeadline(activity: RetentionActivity): string {
  if (activity.events.length === 0) {
    return "No retention sweeps recorded";
  }
  return `${plural(activity.events.length, "sweep")} on record · ${plural(
    activity.totalPurgedLast30d,
    "row",
  )} purged in the last 30 days`;
}

/**
 * A root hash is 64 hex chars; a phone row shows enough to compare against
 * an inspector's copy without wrapping four lines.
 */
export function shortRootHash(hash: string): string {
  const trimmed = hash.trim();
  if (trimmed.length <= 16) return trimmed;
  return `${trimmed.slice(0, 8)}…${trimmed.slice(-8)}`;
}

export const RETENTION_EMPTY_COPY =
  "The retention trim worker has not purged anything for this workspace yet — a fresh tenant, retention windows still inside their limits, or sweeps suspended by an active legal hold. Absence of rows here is not absence of retention policy.";

/* ------------------------------------------------------------------ *
 * Article 50
 * ------------------------------------------------------------------ */

/** The stats window desktop's panel uses. */
export const ARTICLE50_WINDOW_DAYS = 30;

/**
 * The agent-event count from an AuditStats payload — reads the actor mix
 * rather than trusting totalEvents so an unfiltered response still answers
 * the agent question.
 */
export function agentEventCount(stats: {
  byActorType: readonly { label: string; count: number }[];
} | null): number | null {
  if (!stats) return null;
  const row = stats.byActorType.find((entry) => entry.label === "agent");
  return row ? row.count : 0;
}

/** The live line under the "agent activity logged" checklist row. */
export function agentActivityLine(count: number | null): string {
  if (count === null) return "Agent activity could not be counted right now.";
  if (count === 0) {
    return `No agent-actor events in the last ${ARTICLE50_WINDOW_DAYS} days.`;
  }
  return `${plural(count, "agent-actor event")} logged in the last ${ARTICLE50_WINDOW_DAYS} days.`;
}

export const ARTICLE50_DISCLOSURE_COPY =
  "Every AI surface in this app ships the Article 50(1) disclosure verbatim (sequence drafting, draft review, analytics questions).";

/**
 * The navigation path here is spelled in WORDS rather than with `pathLabel`'s
 * chevron, and that is deliberate: this is a module-level constant, so a
 * chevron would be resolved once when the module is first required — which
 * expo-router's route context does at startup, potentially before
 * `setLayoutDirection` publishes the platform's answer — and would then be
 * frozen pointing the wrong way for the whole session on an RTL device. Every
 * other `pathLabel` call site in the app is evaluated at render time, where
 * that cannot happen. "and then" needs no direction to be correct.
 */
export const AIVS_BUNDLE_HANDOFF_COPY =
  "The AIVS inspector bundle — a signed, offline-verifiable event chain per AI session — is generated by the server and collected from the web admin, under Compliance and then Article 50, where the file can be saved with a chain of custody. This screen is for confirming readiness, not for holding evidence bytes.";

/** iOS: the export is live. */
export const AIVS_BUNDLE_EXPORT_COPY =
  "A signed, offline-verifiable event chain exists per AI session. Paste a session id (from an agent audit row) to fetch the bundle through this session and hand the file to the share sheet.";

/* ------------------------------------------------------------------ *
 * AIVS bundle export (pure half — the fetch/write/share is elsewhere)
 * ------------------------------------------------------------------ */

/** Hard ceiling for bundle bytes held in phone memory before the write. */
export const AIVS_BUNDLE_MAX_BYTES = 32 * 1024 * 1024;

/**
 * Local refusal for the session-id field: the id is a path segment on a
 * viewer-scoped audit route, so anything that could not be a session id
 * (empty, slashes, whitespace, control characters) never leaves the phone.
 */
export function aivsSessionIdIssue(raw: string): string | null {
  const value = raw.trim();
  if (!value) {
    return "Paste the session id from an agent audit row first.";
  }
  if (value.length > 128) {
    return "That does not look like a session id.";
  }
  // eslint-disable-next-line no-control-regex
  if (/[\s/\\]/.test(value) || /[\u0000-\u001f\u007f]/.test(value)) {
    return "A session id never contains spaces or slashes.";
  }
  return null;
}

/**
 * The filename the share sheet presents. Prefers the server's
 * Content-Disposition name (sanitised — this string names a file inside the
 * app cache, so path characters are stripped, never trusted); falls back to
 * a deterministic name derived from the session id.
 */
export function aivsBundleFilename(
  sessionId: string,
  contentDisposition: string | null,
): string {
  const sanitize = (name: string) => name.replace(/[^A-Za-z0-9._-]/g, "_");
  const match = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(
    contentDisposition ?? "",
  );
  const fromHeader = match?.[1]?.trim() ?? "";
  if (fromHeader) {
    const cleaned = sanitize(fromHeader);
    if (cleaned && !cleaned.startsWith(".") && /[A-Za-z0-9]/.test(cleaned)) {
      return cleaned;
    }
  }
  const stem = sanitize(sessionId.trim());
  return `aivs-bundle-${stem || "session"}.tar.gz`;
}

/** Null when the byte count is exportable; otherwise the refusal sentence. */
export function aivsBundleSizeIssue(byteLength: number): string | null {
  if (byteLength <= 0) {
    return "The server returned an empty bundle.";
  }
  if (byteLength > AIVS_BUNDLE_MAX_BYTES) {
    return "This bundle is larger than the phone export cap (32 MB). Collect it from the web admin instead.";
  }
  return null;
}

/**
 * One sentence for a failed export. A 403 is a permission rule, never a
 * generic failure; `no_agent_events` is the server saying the id resolved
 * to a session with nothing to prove — desktop's panel words it the same way.
 */
export function aivsExportIssue(err: unknown): string {
  const tagged = err as {
    status?: number;
    code?: string;
    message?: string;
  } | null;
  if (tagged?.code === "no_agent_events") {
    return "No AI agent events found for this session id.";
  }
  if (tagged?.status === 403) {
    return "Your session may not read audit evidence — the bundle route needs the audit scopes. This is a permission rule, not an outage.";
  }
  return tagged?.message || "The bundle could not be fetched.";
}
