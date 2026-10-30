/**
 * lib/campaignActivity.ts — the campaign's own audit trail, read for humans.
 *
 * The detail screen answered "what is this campaign" and "how did it do" and
 * never "who touched it, and when". Every mutating campaign route already
 * writes an audit row with resource_type "campaign" and the campaign id
 * (apps/api/internal/campaigns/psto.go:123, sto_reschedule.go:146, and the
 * shared audit middleware), and GET /api/v1/audit accepts BOTH
 * `resource_type` and `resource_id` as filters
 * (apps/api/internal/handlers/audit.go:117-118, SQL params $6 and $10).
 *
 * "Who rescheduled this, and when?" is a question that gets asked on a phone
 * far more often than at a desk.
 */
import { relativeTime, dateTime } from "@/lib/format";

/**
 * The query key for one campaign's activity feed.
 *
 * ROOT "audit" IS THE LIVE WIRE, not a naming nicety. The event-bus
 * invalidator (api/event-cache-invalidation.ts MOBILE_RESOURCE_ROOTS) maps
 * `audit.created` — the event every mutating campaign route emits a row for —
 * onto the literal query-key root "audit", and TanStack invalidates by prefix.
 * Keying this feed under that root is what makes the open activity card
 * append a teammate's reschedule LIVE instead of going stale until the next
 * pull-to-refresh (desktop's CampaignActivityFeed subscribes to the same
 * topics). The second element keeps it disjoint from useAudit()'s
 * snapshot-backed vault keys.
 */
export function campaignActivityQueryKey(
  tenantId: string | null | undefined,
  campaignId: string | undefined,
): readonly unknown[] {
  return ["audit", "campaign-activity", tenantId, campaignId];
}

export interface CampaignActivityWireRow {
  id?: number;
  action?: string;
  actorType?: string;
  actorLabel?: string | null;
  at?: string;
  redactedFields?: string[];
}

export interface CampaignActivityRow {
  key: string;
  /** "Scheduled", "Sent test", "Updated" — never the raw dotted action. */
  label: string;
  actor: string;
  relative: string;
  absolute: string;
  /** Non-null when the row's metadata was masked by the redactor. */
  redactedNote: string | null;
}

/**
 * Human label for a dotted audit action. Unknown actions degrade to a
 * readable phrase rather than leaking `campaign.queue.filled` at someone.
 */
export function activityLabel(action: string | undefined): string {
  const raw = (action ?? "").trim();
  if (!raw) return "Changed";
  const known: Record<string, string> = {
    "campaign.created": "Created",
    "campaign.updated": "Updated",
    "campaign.deleted": "Deleted",
    "campaign.queued": "Queued to send",
    "campaign.sent": "Sent",
    "campaign.paused": "Paused",
    "campaign.resumed": "Resumed",
    "campaign.cancelled": "Cancelled",
    "campaign.scheduled": "Scheduled",
    "campaign.scheduled.personalized": "Scheduled per recipient",
    "campaign.test_sent": "Test sent",
    "campaign.cloned": "Duplicated",
  };
  const hit = known[raw];
  if (hit) return hit;
  const tail = raw.split(".").slice(1).join(" ") || raw;
  const words = tail.replace(/[_-]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Who did it, in one short phrase. */
export function activityActor(row: CampaignActivityWireRow): string {
  const label = (row.actorLabel ?? "").trim();
  if (label) return label;
  const type = (row.actorType ?? "").trim().toLowerCase();
  if (type === "system" || type === "cron") return "Moosewave";
  if (type === "api_key") return "An API key";
  if (type === "agent") return "An agent";
  return "Someone";
}

export function readCampaignActivity(
  raw: unknown,
  limit = 12,
): CampaignActivityRow[] {
  const rows = Array.isArray((raw as { rows?: unknown })?.rows)
    ? ((raw as { rows: CampaignActivityWireRow[] }).rows)
    : Array.isArray(raw)
      ? (raw as CampaignActivityWireRow[])
      : [];
  const out: CampaignActivityRow[] = [];
  for (const [i, row] of rows.entries()) {
    if (!row || typeof row !== "object") continue;
    const at = typeof row.at === "string" ? row.at : "";
    const redacted = Array.isArray(row.redactedFields)
      ? row.redactedFields.length
      : 0;
    out.push({
      key: String(row.id ?? `${at}-${i}`),
      label: activityLabel(row.action),
      actor: activityActor(row),
      relative: at ? relativeTime(at) : "",
      absolute: at ? dateTime(at) : "",
      // A masked value read as truth is a compliance failure — say when the
      // row you are reading has been redacted.
      redactedNote:
        redacted > 0
          ? `${redacted} field${redacted === 1 ? "" : "s"} redacted`
          : null,
    });
    if (out.length >= limit) break;
  }
  return out;
}
