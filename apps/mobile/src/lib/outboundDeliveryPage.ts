/**
 * lib/outboundDeliveryPage.ts — one endpoint's delivery history, parsed and
 * summarised.
 *
 * GET /api/v1/outbound-webhooks/{id}/deliveries answers
 * `{deliveries: Delivery[], next_cursor: string}` (handlers.go Deliveries;
 * keyset-paged by internal/pagination with a default of 50 and a ceiling of
 * 200). The phone's global feed already normalises one `Delivery` row in
 * api/outboundWebhooks.ts; the same normaliser is carried here because the
 * per-endpoint page lives in its own module by the collision rule, and the
 * wire shape is the same Go struct (outbound_webhooks.go `Delivery`). Keep
 * the two in step.
 *
 * The sentences below are DESKTOP'S OWN
 * (components/OutboundWebhookDeliveriesSlideover.tsx `failureRollup`,
 * `replayUnavailableReason`) rendered verbatim, so the two clients agree on
 * what a receiver's history says.
 *
 * Import-free of react-native / expo so every rule here runs in node vitest.
 */
import type { OutboundDelivery } from "@/api/outboundWebhooks";
import { plural } from "@/lib/format";

export interface OutboundDeliveryPage {
  deliveries: OutboundDelivery[];
  /** Empty string when this is the last page — the server's own sentinel. */
  nextCursor: string;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function int(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

function optionalStr(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

/** Mirror of api/outboundWebhooks `normalizeDelivery` — see the module doc. */
export function normalizeOutboundDelivery(
  entry: unknown,
): OutboundDelivery | null {
  if (!entry || typeof entry !== "object") return null;
  const r = entry as Record<string, unknown>;
  const id = str(r.id);
  if (!id) return null;
  const code =
    typeof r.last_status_code === "number" ? r.last_status_code : undefined;
  return {
    id,
    webhook_id: str(r.webhook_id),
    event_type: str(r.event_type) || "unknown",
    attempt_count: int(r.attempt_count),
    status: str(r.status) || "pending",
    ...(optionalStr(r.next_attempt_at)
      ? { next_attempt_at: optionalStr(r.next_attempt_at) }
      : {}),
    ...(code !== undefined ? { last_status_code: code } : {}),
    ...(optionalStr(r.last_error) ? { last_error: optionalStr(r.last_error) } : {}),
    created_at: str(r.created_at),
    ...(optionalStr(r.delivered_at)
      ? { delivered_at: optionalStr(r.delivered_at) }
      : {}),
  };
}

/**
 * The page envelope, or a bare array, or anything else. `Array.isArray` on
 * both levels rather than `?? []`: a truthy non-array (an HTML fallback page,
 * a drifted envelope) must become an EMPTY page, not a crash inside the sheet.
 */
export function parseOutboundDeliveryPage(raw: unknown): OutboundDeliveryPage {
  const envelope =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : null;
  const list: unknown[] = Array.isArray(raw)
    ? raw
    : envelope && Array.isArray(envelope.deliveries)
      ? envelope.deliveries
      : [];
  const deliveries: OutboundDelivery[] = [];
  for (const entry of list) {
    const row = normalizeOutboundDelivery(entry);
    if (row) deliveries.push(row);
  }
  const nextCursor = envelope ? str(envelope.next_cursor) : "";
  return { deliveries, nextCursor };
}

/**
 * Flatten loaded pages into one list, dropping any id already shown.
 * Desktop refuses a page that repeats a delivery ("Moosewave returned
 * duplicate deliveries in one page"); a keyset cursor that moved under a
 * live feed can hand the phone the same row twice, and a FlatList with two
 * identical keys warns and misrenders.
 */
export function mergeDeliveryPages(
  pages: readonly OutboundDeliveryPage[],
): OutboundDelivery[] {
  const seen = new Set<string>();
  const out: OutboundDelivery[] = [];
  for (const page of pages) {
    const rows = Array.isArray(page?.deliveries) ? page.deliveries : [];
    for (const row of rows) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      out.push(row);
    }
  }
  return out;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Desktop's `failureRollup`, verbatim: exhausted deliveries created in the
 * trailing 24 hours OF THE LOADED ROWS. "Loaded" is in the sentence on
 * purpose — the count is bounded by the pages fetched, not the server.
 * Null when there are none, so the caller renders nothing rather than "0".
 */
export function terminalFailureRollup(
  deliveries: readonly OutboundDelivery[],
  now: number = Date.now(),
): string | null {
  const cutoff = now - DAY_MS;
  const failures = deliveries.filter((delivery) => {
    const created = Date.parse(delivery.created_at);
    return (
      Number.isFinite(created) &&
      created >= cutoff &&
      delivery.status === "exhausted"
    );
  }).length;
  return failures > 0
    ? `${failures} terminal failure${failures === 1 ? "" : "s"} in the loaded trailing 24-hour window.`
    : null;
}

/**
 * Desktop's `replayUnavailableReason`, restricted to the one fact the
 * phone's list contract carries. Desktop also refuses replay on
 * `url_status`, `auth_config_status` and `delivery_policy_status`; none of
 * those fields is in mobile's `OutboundWebhook`, so the server's own 409
 * message stands in for them at replay time rather than a guess here.
 */
export function replayUnavailableReason(webhook: {
  active: boolean;
}): string | null {
  return webhook.active
    ? null
    : "Activate this destination before replaying deliveries.";
}

/** The sheet's count line. Absence is not zero: an empty page says so. */
export function deliveriesSummaryLine(
  shown: number,
  hasMore: boolean,
): string {
  if (shown === 0) return "No deliveries recorded";
  const base = `${plural(shown, "delivery", "deliveries")} shown`;
  return hasMore ? `${base} · older exist` : base;
}
