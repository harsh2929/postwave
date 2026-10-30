/**
 * segmentDecay — the segment decay radar's read + dismiss surface.
 *
 * The server has watched for segments quietly collapsing since
 * apps/api/internal/segments/decay.go, and web consumes all of it
 * (apps/web/src/lib/segments-api.ts). Mobile called none of it: a segment that
 * lost 80% of its members overnight was invisible on the one device an
 * operator has with them, and a dismissal could only be recorded on a desktop.
 *
 * Endpoints (MountDecayRoutes, apps/api/internal/segments/decay.go):
 *   GET  /api/v1/segments/{id}/decay-events?limit=&undismissed=  read:subscribers
 *   POST /api/v1/segments/{id}/decay-events/{event_id}/dismiss   write:subscribers
 *
 * The read is only `read:subscribers` — the same scope every other segment
 * read on this surface already holds — so nothing here needs a new gate.
 *
 * PARSING IS DEFENSIVE ON PURPOSE. `anomaly_kind` is a server vocabulary that
 * has grown once already (`definition_changed` arrived after the first three),
 * and the counts drive a sentence about how many people left an audience.
 * An unrecognised kind renders as itself rather than being dropped, and a
 * non-numeric count becomes null — "unknown", never a confident 0.
 */
import { getClient } from "@/api/sdkClient";

/** The kinds the server can emit today; anything else is passed through. */
export const DECAY_ANOMALY_KINDS = [
  "size_cliff",
  "zero_match",
  "everyone_match",
  "definition_changed",
] as const;

export type DecayAnomalyKind = (typeof DECAY_ANOMALY_KINDS)[number] | string;

export interface SegmentDecayEvent {
  id: string;
  segmentId: string;
  /** YYYY-MM-DD, the snapshot the anomaly was detected against. */
  snapshotDate: string;
  anomalyKind: DecayAnomalyKind;
  /** Sizes either side of the transition; null when the server omitted one. */
  priorCount: number | null;
  newCount: number | null;
  leaverCount: number | null;
  entrantCount: number | null;
  /** Server-authored explanation. Rendered VERBATIM when present. */
  narration: string;
  dismissedAt: string | null;
  createdAt: string | null;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function nullableStr(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function nullableNum(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function parseDecayEvent(raw: unknown): SegmentDecayEvent | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const row = raw as Record<string, unknown>;
  const id = row.id == null ? "" : String(row.id);
  if (!id) return null;
  return {
    id,
    segmentId: str(row.segment_id ?? row.segmentId),
    snapshotDate: str(row.snapshot_date ?? row.snapshotDate),
    anomalyKind: str(row.anomaly_kind ?? row.anomalyKind),
    priorCount: nullableNum(row.prior_count ?? row.priorCount),
    newCount: nullableNum(row.new_count ?? row.newCount),
    leaverCount: nullableNum(row.leaver_count ?? row.leaverCount),
    entrantCount: nullableNum(row.entrant_count ?? row.entrantCount),
    narration: str(row.narration),
    dismissedAt: nullableStr(row.dismissed_at ?? row.dismissedAt),
    createdAt: nullableStr(row.created_at ?? row.createdAt),
  };
}

/**
 * The handler writes `{items, total}`; a bare array is accepted too so a
 * future envelope change cannot silently blank the card (the segments list
 * read on this surface has already been bitten by exactly that mismatch).
 */
export function parseDecayEvents(res: unknown): SegmentDecayEvent[] {
  const rows = Array.isArray(res)
    ? res
    : Array.isArray((res as { items?: unknown[] } | undefined)?.items)
      ? (res as { items: unknown[] }).items
      : [];
  const out: SegmentDecayEvent[] = [];
  for (const raw of rows) {
    const parsed = parseDecayEvent(raw);
    if (parsed) out.push(parsed);
  }
  return out;
}

export const DECAY_EVENT_LIMIT = 20;

export async function fetchSegmentDecayEvents(
  segmentId: string,
  options: { undismissed?: boolean; limit?: number } = {},
): Promise<SegmentDecayEvent[]> {
  const { client } = getClient();
  const params = new URLSearchParams();
  params.set("limit", String(options.limit ?? DECAY_EVENT_LIMIT));
  if (options.undismissed) params.set("undismissed", "true");
  return parseDecayEvents(
    await client.request<unknown>(
      "GET",
      `/api/v1/segments/${encodeURIComponent(segmentId)}/decay-events?${params.toString()}`,
    ),
  );
}

/**
 * Mark one event handled. `write:subscribers` — editor and above.
 *
 * There is no un-dismiss route, which is why the caller confirms first.
 */
export async function dismissSegmentDecayEvent(
  segmentId: string,
  eventId: string,
): Promise<void> {
  const { client } = getClient();
  await client.request<unknown>(
    "POST",
    `/api/v1/segments/${encodeURIComponent(segmentId)}/decay-events/${encodeURIComponent(eventId)}/dismiss`,
  );
}
