/**
 * api/inboundRoutes.ts — the inbound-routing monitor's three reads.
 *
 * AUTHORIZATION, READ OFF BOTH GUARDS — AND THIS IS THE SECOND SURFACE IN THIS
 * APP WHERE THEY DISAGREE, IN THE DANGEROUS DIRECTION.
 *
 *  1. The per-route middleware. `MountRouteAdminRoutes`
 *     (apps/api/internal/inbound_email/routes.go:80-89) applies
 *     `apikeys.RequireScope(apikeys.ScopeAdmin)` to ALL EIGHT routes —
 *     including the two reads this screen makes, `GET /{id}/matches` (:87) and
 *     `GET /matches/{match_id}/runs` (:88). `ScopeAdmin` is not in
 *     `readOnlyScopes` (apps/api/internal/apikeys/middleware.go:332-337), so
 *     the session path runs `sessionRoleAllowsScopes` (:300-318) and admits
 *     owner and admin only.
 *  2. `routeauth.Middleware`. Its rows disagree WITHIN the same family:
 *     `GET /api/v1/inbound-routes` is `admin` with
 *     `policy_source: openapi.x-required-scopes` / `review_status: reviewed`,
 *     but `GET /api/v1/inbound-routes/{id}/matches` and
 *     `GET /api/v1/inbound-routes/matches/{match_id}/runs` are both `viewer`
 *     with `policy_source: safe-default:read` /
 *     `review_status: fail_closed_default` — auto-generated from the verb and
 *     never checked against the handler.
 *
 * EFFECTIVE POLICY: owner/admin on every one of the three. The two unreviewed
 * `viewer` rows are wrong in the permissive direction, and a screen built on
 * them would have let a member request a page that can only ever answer 403.
 *
 * WHAT THIS MEANS FOR THE FINDING THAT ASKED FOR THIS SCREEN. It reasoned that
 * rule AUTHORING is keyboard work while "did mail actually route" is the
 * phone-shaped half — and the second half is true as a product statement but
 * does NOT buy a lower role floor here, because the read is admin-gated too.
 * The screen is therefore owner/admin, and says so.
 *
 * FOUR ROUTES DELIBERATELY NOT CALLED FROM A PHONE: POST (create), DELETE,
 * POST /reorder and POST /preview. Create and delete are rule authoring over
 * glob grammar; reorder is a drag gesture over a priority list; preview is a
 * dry-run matcher that wants a full test message typed in. All are
 * pointer-and-keyboard work and all stay on the web admin.
 *
 * PATCH is reached for exactly ONE payload: the enabled toggle
 * (`setInboundRouteEnabled`). That is the stopping half of this capability —
 * a rule misfiring at 02:00 can be watched here, and the same screen must be
 * able to stop it (lib/stoppingHalfPolicy). Full editing over PATCH stays on
 * the web admin; the toggle payload's field echo is a server-shape
 * requirement, explained in lib/inboundRouteToggle.ts.
 */
import { inboundRouteTogglePayload } from "@/lib/inboundRouteToggle";
import {
  normalizeInboundActionRuns,
  normalizeInboundMatches,
  normalizeInboundRoutes,
  type InboundActionRun,
  type InboundRoute,
  type InboundRouteMatch,
} from "@/lib/inboundRoutes";

import { ApiRequestError } from "./apiRequestError";
import { rawRequest, type AIApiError } from "./request";

/**
 * How many matches one glance reads.
 *
 * The handler defaults to 50 and accepts 1..500 (routes.go:853-859). 50 is kept
 * deliberately: the screen states the window beside the rule's LIFETIME
 * `match_count`, and a bigger page would only move where the same disclosure is
 * needed.
 */
export const INBOUND_MATCHES_PAGE_SIZE = 50;

/** Keeps the HTTP status so the UI can tell a 403 from a 404 from a 500. */
export class InboundRouteRequestError extends ApiRequestError {
  constructor(error: AIApiError, fallback: string) {
    super(error, fallback);
    this.name = "InboundRouteRequestError";
  }
}

async function inboundRequest<T>(path: string, label: string): Promise<T | null> {
  const res = await rawRequest<T>("GET", path, undefined);
  if (res.error) throw new InboundRouteRequestError(res.error, label);
  return res.data;
}

/** True for "your role cannot see this" from either guard. */
export function isInboundRoleDenied(error: unknown): boolean {
  return error instanceof InboundRouteRequestError
    ? error.status === 403
    : typeof error === "object" &&
        error !== null &&
        (error as { status?: unknown }).status === 403;
}

export async function listInboundRoutes(): Promise<InboundRoute[]> {
  const raw = await inboundRequest<unknown>(
    "/api/v1/inbound-routes",
    "Loading routing rules",
  );
  return normalizeInboundRoutes(raw);
}

export async function listInboundRouteMatches(
  routeId: string,
  limit: number = INBOUND_MATCHES_PAGE_SIZE,
): Promise<InboundRouteMatch[]> {
  const id = (routeId ?? "").trim();
  if (!id) throw new Error("A rule id is required to read its matches.");
  const raw = await inboundRequest<unknown>(
    `/api/v1/inbound-routes/${encodeURIComponent(id)}/matches?limit=${limit}`,
    "Loading matches",
  );
  return normalizeInboundMatches(raw);
}

/**
 * Switch one rule off or on — the single PATCH payload mobile sends.
 *
 * Takes the whole route rather than an id because the payload must ECHO the
 * fields the server's partial-PATCH SQL would otherwise zero (priority, both
 * raw-assigned matchers, and the actions array — whose omission writes JSON
 * null, not "keep") — see lib/inboundRouteToggle.ts for the SQL reading.
 * Callers therefore always toggle from a freshly listed row.
 */
export async function setInboundRouteEnabled(
  route: InboundRoute,
  enabled: boolean,
): Promise<void> {
  const id = (route.id ?? "").trim();
  if (!id) throw new Error("A rule id is required to switch it.");
  const res = await rawRequest<unknown>(
    "PATCH",
    `/api/v1/inbound-routes/${encodeURIComponent(id)}`,
    inboundRouteTogglePayload(route, enabled),
  );
  if (res.error) {
    throw new InboundRouteRequestError(
      res.error,
      enabled ? "Switching the rule on" : "Switching the rule off",
    );
  }
}

export async function listInboundActionRuns(
  matchId: number,
): Promise<InboundActionRun[]> {
  if (!Number.isFinite(matchId) || matchId <= 0) {
    throw new Error("A match id is required to read its action runs.");
  }
  const raw = await inboundRequest<unknown>(
    `/api/v1/inbound-routes/matches/${Math.trunc(matchId)}/runs`,
    "Loading action runs",
  );
  return normalizeInboundActionRuns(raw);
}
