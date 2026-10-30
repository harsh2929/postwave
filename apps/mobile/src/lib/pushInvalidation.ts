/**
 * lib/pushInvalidation.ts — which caches a delivered push dirties (NATIVE#64).
 *
 * Foreground pushes render a banner (`shouldShowBanner: true`) but had NO
 * invalidation path of their own: the in-app inbox only stayed in step because
 * the SSE stream carries `notification.created` in parallel. NATIVE#9/#10 show
 * that stream can be silently dead — producing a banner over an empty inbox.
 * Giving push its own invalidation makes the two independent.
 *
 * Pure so the payload grammar is unit-tested without expo-notifications.
 */
import { queryRootsForEvent } from "@/api/event-cache-invalidation";

/** The inbox feed root; always dirtied by any delivered notification. */
export const NOTIFICATION_FEED_ROOT = "notification-feed";

const MAX_EVENT_TYPE_CHARS = 128;

/**
 * Read the sender's `event_type` from a push payload. The backend sets exactly
 * `event_type` / `entity_id` at the top level (apps/api/internal/mobilepush);
 * nested bodies are ignored so a customer record can never drive invalidation.
 */
export function eventTypeFromPushData(data: unknown): string | null {
  if (!data || typeof data !== "object") return null;
  const top = data as Record<string, unknown>;
  const eventType = top.event_type;
  if (typeof eventType !== "string") return null;
  const trimmed = eventType.trim();
  if (!trimmed || trimmed.length > MAX_EVENT_TYPE_CHARS) return null;
  return trimmed;
}

/**
 * Query-key roots to invalidate for a delivered push. Always includes the
 * notification feed; adds the entity roots the event maps to via the shared
 * event→resource authority. De-duplicated, order-stable.
 */
export function queryRootsForPushData(data: unknown): string[] {
  const roots = [NOTIFICATION_FEED_ROOT];
  const eventType = eventTypeFromPushData(data);
  if (!eventType) return roots;
  for (const root of queryRootsForEvent(eventType)) {
    if (!roots.includes(root)) roots.push(root);
  }
  return roots;
}
