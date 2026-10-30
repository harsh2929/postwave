/**
 * The pure logic behind CampaignActivityFeed.
 *
 * Extracted from the component for one reason: its test file re-implemented
 * `payloadCampaignId` as a "mirror" copy and asserted against THAT. A mirror
 * test certifies the mirror. The production function could have been deleted
 * outright and the suite would have stayed green, which is the same defect the
 * feed itself had — a back-fill nobody exercised.
 *
 * Anything here is imported by the component and by the test. There is no
 * second copy.
 */

/** Cap on the in-memory ring buffer. Older events drop off. */
export const RING_CAP = 20;

export interface FeedEntry {
  /** Stable client-side key for React. Unique per rendered row. */
  key: string;
  topic: string;
  at: string;
  actor: string;
  description: string;
  /**
   * Identity of the underlying EVENT, for cross-source de-duplication.
   *
   * Distinct from `key`, which only has to be unique per row: two renderings
   * of the same happening (one from the live bus, one from the back-fill)
   * carry different keys by construction and must still collapse to one row.
   *
   * See `dedupeKeyForAuditRow` for why the two sources cannot be matched.
   */
  dedupeKey: string;
}

/** A row as returned by `api.listAudit` and narrowed by `pickAuditRows`. */
export interface AuditRowLike {
  id: string | number;
  action: string;
  at: string;
  actorLabel?: string | null;
  actorType?: string | null;
}

export function asString(v: unknown): string {
  if (typeof v === "string") return v;
  if (v == null) return "";
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return "";
}

/**
 * Pull the campaign id off an event payload. Different emitters use different
 * field names — `id` for campaign.* events, `campaign_id` for approvals,
 * `resource_id` (when resource_type=campaign) for audits.
 */
export function payloadCampaignId(
  topic: string,
  payload: Record<string, unknown> | undefined,
): string | null {
  if (!payload) return null;
  const direct = asString(payload.id);
  const camp = asString(payload.campaign_id);
  const resType = asString(payload.resource_type).toLowerCase();
  const resId = asString(payload.resource_id);

  if (topic.startsWith("campaign.") && direct) return direct;
  if (topic.startsWith("approval.")) {
    // Approval payloads can carry either resource_id or campaign_id.
    if (camp) return camp;
    if (resType === "campaign" && resId) return resId;
  }
  if (topic === "audit.created") {
    if (resType === "campaign" && resId) return resId;
  }
  // Defensive fallbacks.
  return camp || (resType === "campaign" ? resId : "") || null;
}

/**
 * The de-duplication identity of a back-filled audit row.
 *
 * The row id — unique per row, so it CANNOT collapse two distinct happenings.
 * That matters more than it sounds: `audit_log.at` defaults to `now()`, which
 * in Postgres is TRANSACTION START time, so every audit row written by one
 * request carries a byte-identical timestamp. Any identity built from
 * (action, at) merges them, and a real event vanishes from the panel with
 * nothing to show it was ever there.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO: match a back-filled row against the same
 * happening delivered live on the bus. It cannot — and neither could the code
 * before it, which is worth stating precisely because that code claimed to.
 *
 *   - The old key was `${topic}:${at}`, and the two sources spell the topic
 *     differently: `audit.created` live, `audit.<action>` back-filled. The
 *     de-duplication the merge's comment described had never once fired.
 *   - Keying on (action, at) instead removes that blocker and lands on a
 *     second: the stored `at` comes from the DATABASE clock at transaction
 *     start (infra/migrations/0002_audit_log.sql), while the bus event's `at`
 *     is stamped from the GO process clock at publish time
 *     (apps/api/internal/events/bus.go), a moment later. Two clocks, two
 *     instants, rendered to sub-second ISO — they do not compare equal, so that
 *     key is inert too.
 *
 * Cross-source de-duplication needs a shared identifier, and one already
 * exists: `db.Audit` computes a stable `eventID` and passes it to the
 * TRANSACTIONAL emitter (apps/api/internal/db/audit.go:313). The realtime hook
 * beside it takes only (tenant, action, resourceType, resourceID) and drops it.
 * Publishing that id on the event — and returning it from the audit list
 * endpoint — is the change that makes this real. Until then the mid-flight race
 * shows one duplicated row in a collapsible panel, which is the honest cost of
 * not pretending otherwise.
 */
export function dedupeKeyForAuditRow(id: string | number): string {
  return `audit-row:${String(id)}`;
}

/**
 * The de-duplication identity of a live bus event.
 *
 * Topic and instant — unique enough WITHIN the live stream, which per the note
 * above is the only place this key is ever compared.
 */
export function dedupeKeyForEvent(topic: string, at: string): string {
  return `${topic}:${at}`;
}

/**
 * Map audit rows from the back-fill request onto feed entries.
 *
 * Generic over the row so the caller's fuller `AuditRow` reaches `describeRow`
 * intact. Narrowing to `AuditRowLike` here would hand `prettyAction` a row
 * stripped of the fields it renders from — the helper only needs four of them,
 * but the describer needs the whole thing.
 */
export function auditRowsToEntries<R extends AuditRowLike>(
  rows: R[],
  describeRow: (row: R) => string,
): FeedEntry[] {
  return rows.map((row, i) => ({
    key: `audit:${String(row.id)}:${i}`,
    topic: `audit.${row.action}`,
    at: row.at,
    actor: row.actorLabel ?? row.actorType ?? "system",
    description: describeRow(row),
    dedupeKey: dedupeKeyForAuditRow(row.id),
  }));
}

/**
 * Merge back-filled history into whatever the live bus has already shown.
 *
 * Newest-first, de-duplicated on event identity, capped. The live entries win
 * ties: they are already on screen, and replacing a row the user is looking at
 * with an identical one is a visible flicker for no gain.
 */
export function mergeBackfillEntries(
  live: FeedEntry[],
  backfilled: FeedEntry[],
): FeedEntry[] {
  const seen = new Set(live.map((e) => e.dedupeKey));
  const merged = [...live];
  for (const e of backfilled) {
    if (seen.has(e.dedupeKey)) continue;
    seen.add(e.dedupeKey);
    merged.push(e);
  }
  merged.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  if (merged.length > RING_CAP) merged.length = RING_CAP;
  return merged;
}
