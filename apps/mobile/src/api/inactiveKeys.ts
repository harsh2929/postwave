/**
 * api/inactiveKeys.ts — one read of the dormant-credential report.
 *
 *   GET /api/v1/inactive-keys            (owner/admin; server default 90 days)
 *
 * READ-ONLY, ON PURPOSE. The server never auto-revokes and neither does this
 * module: the card lists what has gone quiet, and the operator revokes from
 * the roster on the same screen if they choose to. The threshold is left to
 * the server's default so the phone shows exactly the list desktop shows.
 *
 * UNWRAP BEFORE PARSING: `rawRequest` resolves to the {data,error} ENVELOPE;
 * a failure surfaces as a throw so a broken read can never render as "no
 * dormant keys". A 200 whose body is not the handler's object is a throw too
 * — the server answered and we could not read it, which is a fault to show,
 * not a silence to keep.
 */
import {
  InactiveKeysError,
  parseInactiveKeysPayload,
  type InactiveKeysPayload,
} from "@/lib/inactiveKeyAlerts";

import { rawRequest } from "./request";

export { InactiveKeysError, isInactiveKeysDenied } from "@/lib/inactiveKeyAlerts";

export const INACTIVE_KEYS_PATH = "/api/v1/inactive-keys";

export async function fetchInactiveKeys(): Promise<InactiveKeysPayload> {
  const res = await rawRequest<unknown>("GET", INACTIVE_KEYS_PATH);
  if (res.error) {
    throw new InactiveKeysError(res.error.status, res.error.message);
  }
  const payload = parseInactiveKeysPayload(res.data);
  if (payload === null) {
    throw new InactiveKeysError(0, "The server's answer could not be read.");
  }
  return payload;
}
