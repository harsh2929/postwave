/**
 * api/conversionAttribution.ts — the conversion monitor's two reads.
 *
 * AUTHORIZATION, READ OFF BOTH GUARDS. Unusually for this app, both agree.
 *
 *  1. The per-route middleware. `conversions.Mount`
 *     (apps/api/internal/conversions/attribution.go:704-713) wraps both reads
 *     in `apikeys.RequireScope(apikeys.ScopeReadReports)`. `ScopeReadReports`
 *     IS in `readOnlyScopes` (apps/api/internal/apikeys/middleware.go:332-337),
 *     so `requireAdminRoleForScopes` returns false and the session path admits
 *     any authenticated role.
 *  2. `routeauth.Middleware`. Both rows —
 *     `GET /api/v1/conversions/attribution/campaigns` and `…/timeseries` —
 *     carry `"session_minimum_role": "viewer"` with
 *     `"policy_source": "openapi.x-required-scopes"` and
 *     `"review_status": "reviewed"`, i.e. a checked row rather than a
 *     fail-closed default.
 *
 * EFFECTIVE POLICY: viewer. Both guards say so and one of them has been
 * reviewed, so this screen is not role-gated at all — every signed-in member of
 * the workspace can read it.
 *
 * THREE ROUTES DELIBERATELY NOT CALLED FROM A PHONE:
 *   - GET /api/v1/conversions — the RAW conversion feed. Every row carries
 *     `subscriber_email` (conversions.go:126-141), which is why its guard is
 *     `RequireAllScopes(read:reports, read:subscribers)` rather than reports
 *     alone. A phone screen is glanceable from across a table and this app has
 *     no reason to stream a recipient-identified purchase log onto one; the
 *     aggregates below answer the operations question without it.
 *   - POST /api/v1/conversions/keys — MINTING the public site key. Creation
 *     returns the plaintext key exactly once (`CreateTrackingKeyResponse`),
 *     and a credential that can only be copied once must not first appear on
 *     a phone. Listing and REVOKING that key did port — see
 *     hooks/useTrackingKeys and components/conversions/TrackingKeysPanel —
 *     because revocation returns no secret and is exactly the verb performed
 *     away from a desk.
 *   - POST /api/v1/conversions/attribution/backfill — a WRITE that stamps
 *     `attributed_via` on historical rows, admin-scoped, and driven by
 *     repeated calls until `done`. A long idempotent loop is desk work; the
 *     screen instead states how many rows are still unclassified.
 */
import {
  normalizeAttributionTimeseries,
  normalizeCampaignAttribution,
  type AttributionTimeseries,
  type AttributionWindow,
  type CampaignAttribution,
} from "@/lib/conversionAttribution";

import { ApiRequestError } from "./apiRequestError";
import { rawRequest, type AIApiError } from "./request";

/** Keeps the HTTP status so the UI can tell a 403 from a 400 from a 500. */
export class ConversionRequestError extends ApiRequestError {
  constructor(error: AIApiError, fallback: string) {
    super(error, fallback);
    this.name = "ConversionRequestError";
  }
}

async function conversionRequest<T>(
  path: string,
  label: string,
): Promise<T | null> {
  const res = await rawRequest<T>("GET", path, undefined);
  if (res.error) throw new ConversionRequestError(res.error, label);
  return res.data;
}

/**
 * A 403 here is not the same statement as on an admin surface.
 *
 * Both routes are viewer-tier, so a refusal means the SESSION lost something
 * (an API-key token without `read:reports`, or a custom role the server
 * narrowed) rather than "this screen is for admins". The screen says exactly
 * that instead of inviting the reader to go and ask an owner for admin.
 */
export function isConversionAccessDenied(error: unknown): boolean {
  return error instanceof ConversionRequestError
    ? error.status === 403
    : typeof error === "object" &&
        error !== null &&
        (error as { status?: unknown }).status === 403;
}

export async function fetchCampaignAttribution(
  days: AttributionWindow,
): Promise<CampaignAttribution> {
  const raw = await conversionRequest<unknown>(
    `/api/v1/conversions/attribution/campaigns?days=${days}`,
    "Loading attributed revenue",
  );
  return normalizeCampaignAttribution(raw);
}

export async function fetchAttributionTimeseries(
  days: AttributionWindow,
): Promise<AttributionTimeseries> {
  const raw = await conversionRequest<unknown>(
    `/api/v1/conversions/attribution/timeseries?days=${days}`,
    "Loading the revenue trend",
  );
  return normalizeAttributionTimeseries(raw);
}
