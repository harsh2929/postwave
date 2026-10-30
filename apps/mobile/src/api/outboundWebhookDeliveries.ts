/**
 * api/outboundWebhookDeliveries.ts — ONE endpoint's delivery history.
 *
 * The Webhooks screen's Deliveries segment is the global feed
 * (GET /outbound-webhooks/deliveries, api/outboundWebhooks.ts). It cannot
 * answer "show me only THIS receiver's recent attempts" without the operator
 * scanning event types by eye. Desktop answers it with a per-endpoint
 * slideover over
 *
 *   GET /api/v1/outbound-webhooks/{id}/deliveries?limit=50&cursor=
 *
 * (apps/api/internal/outbound_webhooks/handlers.go `Deliveries`; role admin
 * in routeauth/manifest.json). Keyset-paged: `next_cursor` is "" on the last
 * page. `limit` defaults to 50 and is clamped to 200 server-side
 * (internal/pagination DefaultLimit/MaxLimit), so the same bounds are
 * applied here rather than sending a value the server will silently trim.
 *
 * Its own module by the collision rule: a new item's API calls go in a new
 * file rather than growing api/outboundWebhooks.ts under another agent.
 */
import {
  parseOutboundDeliveryPage,
  type OutboundDeliveryPage,
} from "@/lib/outboundDeliveryPage";

import { rawRequest } from "./request";

/** The server's own page size; also desktop's DELIVERY_LIMIT. */
export const OUTBOUND_ENDPOINT_DELIVERIES_LIMIT = 50;
const SERVER_MAX_LIMIT = 200;

export async function listWebhookDeliveries(
  id: string,
  options?: { limit?: number | undefined; cursor?: string | undefined },
): Promise<OutboundDeliveryPage> {
  const params = new URLSearchParams();
  const limit = Math.min(
    Math.max(Math.trunc(options?.limit ?? OUTBOUND_ENDPOINT_DELIVERIES_LIMIT), 1),
    SERVER_MAX_LIMIT,
  );
  params.set("limit", String(limit));
  if (options?.cursor) params.set("cursor", options.cursor);
  const res = await rawRequest<unknown>(
    "GET",
    `/api/v1/outbound-webhooks/${encodeURIComponent(id)}/deliveries?${params.toString()}`,
  );
  if (res.error) {
    // 404 here means "webhook not found" — the sheet was opened on a row a
    // concurrent delete removed; the server's message says so.
    const err = new Error(
      res.error.message || "Couldn't load this endpoint's deliveries.",
    );
    Object.assign(err, { status: res.error.status });
    throw err;
  }
  return parseOutboundDeliveryPage(res.data);
}
