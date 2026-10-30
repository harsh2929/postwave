// SPDX-License-Identifier: AGPL-3.0-only
//
// opsTenantApi.ts — the server-side proxy for per-tenant mutating actions (the
// send kill switch). Sibling to opsApi.ts (which proxies check-bound actions);
// same contract, different target shape. The browser never talks to the API
// directly — it POSTs here, and this forwards the operator's Cookie exactly as
// the board fetch does. Same session, same platform-operator gate, and the same
// relayed client address the check actions send (see opsApi.ts for why the IP
// allowlist depends on this console's egress being a registered trusted proxy).
// This file forwards and reports; the API decides whether it runs.
//
// The kill switch is idempotent by nature (SetPaused to the same value twice is
// a no-op), so — unlike the check actions — a retry after an ambiguous network
// failure is safe and needs no idempotency key: re-applying paused=true cannot
// double-charge anyone. The shared envelope lives in
// opsSecurity.forwardOpsMutation; this module supplies only the kill-switch
// specifics.

import {
  forwardOpsMutation,
  MAX_INCIDENT_BODY_BYTES,
  safeJSON,
} from "./opsSecurity";
import {
  hasOnlyKeys,
  isBoundedMultilineText,
  isCanonicalUUID,
  isRecord,
} from "./viewSchema";

// The tenant id is placed in the forwarded PATH, so it must be an exact
// canonical (lowercase, non-nil) UUID before it is ever concatenated into a
// URL — otherwise a crafted id could aim the operator's cookie elsewhere.
export function isTenantID(id: string): boolean {
  return isCanonicalUUID(id);
}

// normalizeKillSwitch keeps the console from inventing an outcome the API never
// reported: the response is accepted only if it is the exact applied shape.
export function normalizeKillSwitch(
  payload: unknown,
  expectedTenantID?: string,
  expectedPaused?: boolean,
): Record<string, unknown> | undefined {
  if (!isRecord(payload) || !hasOnlyKeys(payload, ["tenant_id", "paused", "status"])) {
    return undefined;
  }
  const value = payload;
  if (value.status !== "applied") return undefined;
  if (typeof value.paused !== "boolean") return undefined;
  if (!isTenantID(String(value.tenant_id ?? ""))) return undefined;
  if (expectedTenantID !== undefined && value.tenant_id !== expectedTenantID) return undefined;
  if (expectedPaused !== undefined && value.paused !== expectedPaused) return undefined;
  return { tenant_id: value.tenant_id, paused: value.paused, status: "applied" };
}

// forwardKillSwitch proxies one POST to
// /api/internal/ops/views/tenants/{id}/kill-switch. Response passed through with
// no laundering: a 500 stays a 500.
export function forwardKillSwitch(req: Request, tenantID: string): Promise<Response> {
  if (!isTenantID(tenantID)) {
    return Promise.resolve(safeJSON(400, "bad_tenant_id", "that is not a tenant id"));
  }
  return forwardOpsMutation<boolean>(req, {
    path: `/api/internal/ops/views/tenants/${encodeURIComponent(tenantID)}/kill-switch`,
    bodyLimit: MAX_INCIDENT_BODY_BYTES,
    unreachableMessage:
      "the ops service did not answer; the kill switch is idempotent, so retrying is safe",
    validate: (parsed) => {
      if (
        !isRecord(parsed) ||
        !hasOnlyKeys(parsed, ["paused", "reason"]) ||
        typeof parsed.paused !== "boolean" ||
        !isBoundedMultilineText(parsed.reason, 4096, 16384)
      ) {
        return null;
      }
      return { body: parsed, context: parsed.paused };
    },
    normalize: (payload, expectedPaused) =>
      normalizeKillSwitch(payload, tenantID, expectedPaused),
  });
}
