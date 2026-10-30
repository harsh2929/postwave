/**
 * lib/inboundEventPolicy.ts — the rules the SERVER enforces on a stored
 * inbound event, restated on the client so a refusal can be EXPLAINED
 * before it costs a round trip.
 *
 * The replay handler (apps/api/internal/inbound_webhooks/replay.go) rejects
 * two classes of event with a 422 and a machine code:
 *
 *   event_not_verified   — `ErrUnverifiedEvent`. A payload whose HMAC did not
 *                          verify is retained as evidence but may never be
 *                          re-fired, because replay RE-EXECUTES trigger
 *                          actions (sequence enrolment, tag writes). A forged
 *                          body must not be able to reach that code path.
 *   payload_not_retained — `ErrPayloadNotRetained`. Old rows predate body
 *                          retention, so there is literally nothing to send.
 *
 * A button that is live and then fails with a 422 teaches the operator
 * nothing. A button that is disabled with the reason beside it teaches them
 * the rule. Both branches are decided here, in a module free of React and of
 * every native import, so they can be unit-tested in a node environment.
 */

/** The two facts a replay verdict depends on. */
export interface InboundEventFacts {
  /** Did the stored HMAC verify when the event arrived? */
  signatureValid: boolean;
  /** Is the raw body still retained for this row? */
  bodyRetained: boolean;
}

export type ReplayVerdict =
  | { allowed: true }
  | { allowed: false; reason: string };

/**
 * Whether this event can be replayed, and — when it cannot — the sentence to
 * put beside the disabled control. Mirrors the server's own precedence:
 * signature first, retention second.
 */
export function replayVerdict(event: InboundEventFacts): ReplayVerdict {
  if (!event.signatureValid) {
    return {
      allowed: false,
      reason:
        "Signature verification failed for this event, so it can't be replayed — replaying re-runs your triggers, and a forged payload must never reach them.",
    };
  }
  if (!event.bodyRetained) {
    return {
      allowed: false,
      reason:
        "This event's payload is no longer retained, so there is nothing left to re-send.",
    };
  }
  return { allowed: true };
}

/**
 * A single-line preview of a JSON body for a list row.
 *
 * Returns null — never "" and never "{}" — when the body is absent, so the
 * caller renders an em-dash or omits the line instead of implying an empty
 * payload arrived. Whitespace (including the newlines a pretty-printed body
 * carries) is collapsed so one event is always one line.
 */
export function eventBodyPreview(body: string, max = 140): string | null {
  const collapsed = body.replace(/\s+/gu, " ").trim();
  if (!collapsed) return null;
  if (collapsed.length <= max) return collapsed;
  return `${collapsed.slice(0, Math.max(1, max - 1))}…`;
}

/**
 * Byte-ish size of a retained body, for the "is this the big one?" glance.
 * Returns null for an absent body so the row omits the line.
 */
export function eventBodyBytes(body: string): number | null {
  if (!body) return null;
  // Not exact for astral-plane input, but the row wants an order of
  // magnitude, and this needs no TextEncoder (absent in some RN engines).
  return body.length;
}

/**
 * The header worth showing on a phone. Upstream systems put their event type
 * in a vendor header (`X-GitHub-Event`, `X-Shopify-Topic`, `Stripe-Signature`
 * is NOT one) and that is the single most useful identifier in a feed of
 * otherwise identical rows. Case-insensitive because header casing is not
 * preserved consistently across proxies.
 *
 * Returns null when no known header is present — the caller then falls back
 * to the received-at time rather than inventing a type.
 */
const EVENT_TYPE_HEADERS = [
  "x-github-event",
  "x-shopify-topic",
  "x-event-type",
  "x-postwave-event",
  "x-webhook-event",
  "x-hook-event",
  "x-amz-sns-message-type",
];

export function eventTypeFromHeaders(
  headers: Record<string, string> | undefined,
): string | null {
  if (!headers) return null;
  const lowered = new Map<string, string>();
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === "string" && value.trim()) {
      lowered.set(key.toLowerCase(), value.trim());
    }
  }
  for (const candidate of EVENT_TYPE_HEADERS) {
    const hit = lowered.get(candidate);
    if (hit) return hit;
  }
  return null;
}

/**
 * How many of the most recent events failed signature verification.
 * `null` when there are no events at all — the difference between "nothing
 * has arrived" and "everything that arrived was fine" is the whole point of
 * opening this feed.
 */
export function invalidSignatureCount(
  events: readonly { signatureValid: boolean }[],
): number | null {
  if (events.length === 0) return null;
  return events.filter((event) => !event.signatureValid).length;
}
