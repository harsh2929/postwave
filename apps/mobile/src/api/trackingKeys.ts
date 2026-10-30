/**
 * api/trackingKeys.ts — the two admin routes behind the site-key panel.
 *
 *   GET    /api/v1/conversions/keys       → bare `[]TrackingKey`, never plaintext
 *   DELETE /api/v1/conversions/keys/{id}  → `{ "ok": true }`
 *
 * Handlers: apps/api/internal/conversions/conversions.go `AdminListKeys` (:933)
 * and `AdminRevokeKey` (:983). Both rows in routeauth/manifest.json are
 * `session_minimum_role: admin`, `review_status: reviewed`.
 *
 * `POST /api/v1/conversions/keys` (minting) is deliberately absent — see
 * lib/stoppingHalfPolicy. Its response carries the publishable key exactly
 * once and this platform has no capture-then-dismiss ceremony for it.
 *
 * Fails closed in both directions. The list handler always encodes an empty
 * register as `[]` (`out := []TrackingKey{}`), so a body that is not an array
 * is shape drift and must not be read as "no keys". A revoke the server did
 * not positively confirm is not a revoke.
 */
import { parseTrackingKeys, type TrackingKey } from "@/lib/trackingKeys";
import { WireShapeError } from "@/lib/wireShapeError";

import { rawRequest } from "./request";

const BASE = "/api/v1/conversions/keys";

/** Admin-only metadata register: id, label, public prefix, timestamps. */
export async function listTrackingKeys(): Promise<TrackingKey[]> {
  const res = await rawRequest<unknown>("GET", BASE);
  if (res.error) throw Object.assign(new Error(res.error.message), res.error);
  if (!Array.isArray(res.data)) {
    throw new WireShapeError(
      "site-key register",
      "The site-key register response was malformed.",
    );
  }
  return parseTrackingKeys(res.data);
}

/** Admin-only emergency revocation; the panel requires positive confirmation. */
export async function revokeTrackingKey(keyId: string): Promise<void> {
  const id = keyId.trim();
  if (!id) throw new Error("Site-key ID is required.");
  const res = await rawRequest<unknown>(
    "DELETE",
    `${BASE}/${encodeURIComponent(id)}`,
  );
  if (res.error) throw Object.assign(new Error(res.error.message), res.error);
  if (
    !res.data ||
    typeof res.data !== "object" ||
    (res.data as Record<string, unknown>).ok !== true
  ) {
    throw new Error("The server did not confirm site-key revocation.");
  }
}
