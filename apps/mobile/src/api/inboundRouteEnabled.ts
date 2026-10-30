/**
 * api/inboundRouteEnabled.ts — the projected off switch's transport.
 *
 * One PATCH, one payload (lib/inboundRouteEnabledPayload), answering 204 with
 * no body (routes.go `UpdateRoute` → `w.WriteHeader(http.StatusNoContent)`),
 * so there is nothing to parse and nothing the client learns that it did not
 * already know — which is what makes projecting the row honest
 * (lib/inboundRouteOptimistic.ts).
 *
 * ROLE. PATCH /api/v1/inbound-routes/{id} is `session_minimum_role: admin` in
 * the routeauth manifest and `RequireScope(ScopeAdmin)` at the mount
 * (routes.go:227) — the same floor as every read on this screen, so the
 * control is only ever rendered inside the screen's owner/admin branch.
 *
 * WHY A SIBLING OF api/inboundRoutes.setInboundRouteEnabled EXISTS. That
 * transport echoes the route's wire-verbatim actions array, which the
 * committed handler tolerates; the handler as it stands in the working tree
 * refuses any non-empty actions array without a CAS token (409
 * `route_changed`) and would strip stored webhook HMAC secrets if one were
 * supplied. The payload sent here is lossless under both revisions — the lib
 * header carries the SQL reading — and the mobile row has no `updated_at` to
 * offer a CAS token anyway. The optimistic hook injects THIS function.
 *
 * Errors keep the HTTP status via InboundRouteRequestError so the rollback
 * sentence can carry the server's words and the screen can still tell a 403
 * (role) from a 404 (rule gone) from a 409 (changed under us) from a 5xx.
 */
import { inboundRouteEnabledPayload } from "@/lib/inboundRouteEnabledPayload";
import type { InboundRoute } from "@/lib/inboundRoutes";

import { InboundRouteRequestError } from "./inboundRoutes";
import { rawRequest } from "./request";

/**
 * Switch one rule off or on. Takes the whole route, not an id, because the
 * payload must echo the row's priority and matchers — callers always toggle
 * from a freshly listed row.
 */
export async function patchInboundRouteEnabled(
  route: InboundRoute,
  enabled: boolean,
): Promise<void> {
  const id = (route.id ?? "").trim();
  if (!id) throw new Error("A rule id is required to switch it.");
  const res = await rawRequest<unknown>(
    "PATCH",
    `/api/v1/inbound-routes/${encodeURIComponent(id)}`,
    inboundRouteEnabledPayload(route, enabled),
  );
  if (res.error) {
    throw new InboundRouteRequestError(
      res.error,
      enabled ? "Switching the rule on" : "Switching the rule off",
    );
  }
}
