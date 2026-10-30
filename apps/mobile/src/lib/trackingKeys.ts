/**
 * lib/trackingKeys.ts — the PUBLIC site keys that authenticate conversion
 * tracking events.
 *
 * `GET /api/v1/conversions/keys` and `DELETE /api/v1/conversions/keys/{id}`
 * (conversions.go:933/:983, both admin via
 * server/analytics_realtime_routes.go:121-123) had no mobile client. The
 * sibling panel already ports the exact verb for HMAC ingest-secrets and
 * states the doctrine this file inherits: ISSUING a credential returns the
 * plaintext exactly once and stays on a desk; REVOKING returns no secret and
 * is the thing you do the moment a key turns up somewhere it should not be.
 *
 * A leaked site key lets anyone forge conversion events from a browser — the
 * key ships inside the tenant's own storefront JavaScript, so "leaked" is its
 * resting state and revocation is the only control that exists. The window
 * between noticing and revoking is the whole risk, and it is rarely spent at
 * a desk.
 *
 * The list endpoint answers a BARE ARRAY (`[]TrackingKey`), not an `{items}`
 * envelope — unlike the ingest-secret list beside it. Never returns plaintext.
 *
 * Import-free of react-native, so it is node-tested.
 */

export interface TrackingKey {
  id: string;
  label: string;
  /** The key's public prefix — how a person matches a row to a snippet. */
  prefix: string;
  createdAt: string;
  revokedAt: string;
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function parseTrackingKeys(payload: unknown): TrackingKey[] {
  if (!Array.isArray(payload)) return [];
  const out: TrackingKey[] = [];
  for (const raw of payload) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const row = raw as Record<string, unknown>;
    const id = str(row.id);
    if (!id) continue;
    out.push({
      id,
      // The label is what a person recognises a key by under pressure; fall
      // back to the prefix (visible in the leaked snippet) before the bare id.
      label: str(row.label) || str(row.prefix) || id,
      prefix: str(row.prefix),
      createdAt: str(row.created_at),
      revokedAt: str(row.revoked_at),
    });
  }
  return out;
}

/** A key is live until it carries a revocation timestamp. */
export function trackingKeyIsActive(key: TrackingKey): boolean {
  return key.revokedAt === "";
}

/**
 * The confirmation before revoking. Names the consequence in both directions:
 * revoking stops forged events immediately AND stops the tenant's own site if
 * it still ships the key. Mentioning only the first would make this look free.
 */
export function trackingKeyRevokeCopy(key: TrackingKey): {
  title: string;
  body: string;
  confirmLabel: string;
} {
  return {
    title: `Revoke ${key.label}?`,
    body: "Conversion events sent with this site key stop being recorded immediately — including from your own pages if they still ship it. Revoking cannot be undone; issue a new key from the web admin.",
    confirmLabel: "Revoke key",
  };
}
