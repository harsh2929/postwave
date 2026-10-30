/**
 * lib/outboundWebhookForm.ts — the two pieces of create-form logic that were
 * silently wrong, pulled out of the component so they can be tested.
 *
 * 1. THE EVENT CATALOG HAD ALREADY DRIFTED. `OUTBOUND_WEBHOOK_EVENTS` in
 *    api/settings.ts claimed to mirror `AllowedEvents` in
 *    apps/api/internal/outbound_webhooks/outbound_webhooks.go and listed SEVEN
 *    entries; the Go array had NINE at the time. `subscriber.unsubscribed` and
 *    `list.subscriber.added` simply could not be subscribed to from a phone —
 *    no error, just a missing chip. The Go comment even says "Additions go
 *    here, the Zapier app, and the dashboard chip list — keep the three in
 *    sync"; mobile was an unlisted fourth copy that fell behind. The fix is
 *    two-part: the fallback below is corrected AND the form asks the server
 *    (GET /api/v1/outbound-webhooks/playground/events, which serves
 *    AllowedEvents verbatim) so the next addition needs no client release. The
 *    colocated contract test diffs the fallback against the Go source, so this
 *    cannot drift silently a second time.
 *
 * 2. ANY STRING WAS ACCEPTED AS A URL. `submit()` checked `!url.trim()` and
 *    nothing else, so "example.com/hooks" (no scheme) or "htp://…" made a
 *    round trip and came back as an opaque server error — or worse, created a
 *    webhook that never delivered. This is a FAST-FAIL, not a replacement for
 *    server validation: it rejects only what is definitely unusable and warns
 *    (never blocks) on things that are merely unwise, like plain http.
 */

/**
 * Complete 15-event local mirror of `AllowedEvents`
 * (apps/api/internal/outbound_webhooks/outbound_webhooks.go). Used only until
 * the server catalog loads, and as the offline/failed-request fallback.
 */
export const OUTBOUND_WEBHOOK_EVENT_FALLBACK: readonly string[] = [
  "campaign.sent",
  "subscriber.added",
  "subscriber.removed",
  "subscriber.unsubscribed",
  "approval.requested",
  "approval.decided",
  "audit.created",
  "bounce.received",
  // Added server-side without the client following — caught by the test that
  // reads AllowedEvents out of the Go source rather than restating it here.
  "list_health.degraded",
  "list.subscriber.added",
  // Transactional message outcomes, per RECIPIENT. Distinct from
  // `bounce.received`, which is about an ADDRESS and drives suppression: these
  // identify WHICH message failed, which is what a transactional sender needs.
  "email.bounced",
  "email.complained",
  "email.delivered",
  // Campaign Assurance gates dispatch, so a blocked run is something to react
  // to rather than discover when the campaign never sends. There is no success
  // topic: a run without complete evidence is incomplete, never green.
  "assurance.run.completed",
  "assurance.run.blocked",
];

/**
 * Read the event catalog out of whatever GET /playground/events returned.
 * The documented shape is `{events: [{event_type, sample_payload}]}`, but a
 * bare array of strings and a bare array of objects are both accepted so an
 * older or newer gateway cannot blank the chip list.
 */
export function parseEventCatalog(payload: unknown): string[] {
  const rows = Array.isArray(payload)
    ? payload
    : payload &&
        typeof payload === "object" &&
        Array.isArray((payload as { events?: unknown }).events)
      ? (payload as { events: unknown[] }).events
      : [];
  const out: string[] = [];
  for (const row of rows) {
    if (typeof row === "string") {
      const v = row.trim();
      if (v && !out.includes(v)) out.push(v);
      continue;
    }
    if (!row || typeof row !== "object") continue;
    const rec = row as Record<string, unknown>;
    const raw = rec.event_type ?? rec.event ?? rec.type;
    const v = typeof raw === "string" ? raw.trim() : "";
    if (v && !out.includes(v)) out.push(v);
  }
  return out;
}

/**
 * The catalog the chips render. The server is authoritative when it answered;
 * the fallback only fills in when it did not, so a failed request degrades to
 * "the events we shipped knowing about" rather than to no events at all.
 */
export function resolveEventCatalog(serverCatalog: unknown): string[] {
  const parsed = parseEventCatalog(serverCatalog);
  return parsed.length > 0 ? parsed : [...OUTBOUND_WEBHOOK_EVENT_FALLBACK];
}

export type WebhookUrlCheck =
  | { ok: true; url: string; warning?: string }
  | { ok: false; message: string };

/**
 * Validate a destination URL before spending a round trip on it.
 *
 * Rejects: empty, unparseable, and non-http(s) schemes (mailto:, javascript:,
 * a bare host with no scheme). Warns but ALLOWS: plain http, and loopback /
 * private hosts — both are legitimate against a tunnel during development, and
 * the server remains the authority on what it will actually accept.
 */
export function validateWebhookUrl(raw: string): WebhookUrlCheck {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) {
    return { ok: false, message: "Enter the destination URL." };
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return {
      ok: false,
      message: trimmed.includes("://")
        ? "That doesn't look like a valid URL."
        : "Include the scheme, e.g. https://example.com/webhooks.",
    };
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return {
      ok: false,
      message: "Webhooks can only be delivered over https:// or http://.",
    };
  }
  if (!parsed.hostname) {
    return { ok: false, message: "That URL is missing a host." };
  }
  if (parsed.protocol === "http:") {
    return {
      ok: true,
      url: trimmed,
      warning:
        "This URL is plain http — the signed payload will cross the network unencrypted.",
    };
  }
  if (isPrivateHost(parsed.hostname)) {
    return {
      ok: true,
      url: trimmed,
      warning:
        "That host is private to this network, so our servers may not be able to reach it.",
    };
  }
  return { ok: true, url: trimmed };
}

/** Loopback / RFC1918 / .local — reachable from a laptop, usually not from us. */
function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (h === "localhost" || h === "::1" || h.endsWith(".local")) return true;
  if (h === "127.0.0.1" || h.startsWith("127.")) return true;
  if (h.startsWith("10.") || h.startsWith("192.168.")) return true;
  const m = /^172\.(\d{1,3})\./.exec(h);
  if (m?.[1]) {
    const second = Number(m[1]);
    if (second >= 16 && second <= 31) return true;
  }
  return false;
}
