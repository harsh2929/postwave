/**
 * api/retentionOffers.ts — the four reads behind the save-offer funnel.
 *
 * ROUTES AND THEIR REAL GUARDS, read from the Go source. Three of them are
 * mounted by `retention_offers.Deps.MountRoutes`, and the
 * guard is NOT in that file — it is at the mount site:
 *
 *   main.go       retentionOfferDeps.MountRoutes(
 *                   r.With(apikeys.RequireExactTenantAdmin))
 *
 *   GET /api/v1/retention-offers                   exact owner/admin
 *   GET /api/v1/retention-offers/funnel            exact owner/admin
 *   GET /api/v1/retention-offers/winback-settings  exact owner/admin
 *   GET /api/v1/paywall/tiers                      owner/admin
 *
 * Reading handlers.go on its own would have said this surface is ungated; the
 * mount-site authority is binding and the client fails closed before request.
 *
 * THERE ARE NO WRITES HERE BECAUSE THE SERVER MOUNTS NONE. `Upsert`,
 * `Deactivate`, `LogEvent` and the three portal handlers exist in the package
 * and are registered on no router — the package header states the reason:
 * "Paid retention-offer mutations and portal acceptance remain unmounted until
 * a real Stripe adapter and reconciliation are certified." Offering an
 * authoring form here would be building a button that 404s.
 */
import {
  normalizePaywallTierNames,
  normalizeRetentionFunnel,
  normalizeRetentionOffers,
  normalizeWinbackSettings,
  type RetentionFunnelTile,
  type RetentionOffer,
  type WinbackSettings,
} from "@/lib/retentionOffers";

import { ApiRequestError } from "./apiRequestError";
import { rawRequest, type AIApiError } from "./request";

/** Keeps the HTTP status so the screen can tell a 403 from a 500. */
export class RetentionRequestError extends ApiRequestError {
  constructor(error: AIApiError, fallback: string) {
    super(error, fallback);
    this.name = "RetentionRequestError";
  }
}

async function retentionRequest<T>(
  path: string,
  label: string,
): Promise<T | null> {
  const res = await rawRequest<T>("GET", path, undefined);
  if (res.error) throw new RetentionRequestError(res.error, label);
  return res.data;
}

/** Every offer, active first — `Repo.ListOffers` orders by active DESC. */
export async function listRetentionOffers(
  expectedTenantId: string,
): Promise<RetentionOffer[]> {
  const raw = await retentionRequest<unknown>(
    "/api/v1/retention-offers",
    "Loading retention offers",
  );
  return normalizeRetentionOffers(raw, expectedTenantId);
}

/**
 * The shown → accepted → declined → expired rollup, one tile per offer.
 *
 * Deliberately a SEPARATE query from the offer list rather than a combined
 * fetch: the two reads fail independently, and the whole point of this screen
 * is that a funnel outage renders as "unknown" beside offers that still list
 * fine, instead of taking the offers down with it or — worse — printing zeros.
 */
export async function fetchRetentionFunnel(): Promise<RetentionFunnelTile[]> {
  const raw = await retentionRequest<unknown>(
    "/api/v1/retention-offers/funnel",
    "Loading the offer funnel",
  );
  return normalizeRetentionFunnel(raw);
}

/**
 * Churn-triggered win-back settings.
 *
 * `GetWinbackSettings` writes the struct directly with no
 * envelope, so the payload IS the settings object. A malformed 2xx body throws
 * `RetentionPayloadError`; it never resolves as disabled/default/zero settings.
 */
export async function fetchWinbackSettings(): Promise<WinbackSettings> {
  const raw = await retentionRequest<unknown>(
    "/api/v1/retention-offers/winback-settings",
    "Loading win-back settings",
  );
  return normalizeWinbackSettings(raw);
}

/**
 * Tier id → name, so a row can say "Founding member" instead of a UUID.
 *
 * A supporting read. Both funnel endpoints carry only `paywall_tier_id`, and
 * a raw UUID in a list row is unreadable on a phone. Same admin guard as the
 * rest of the surface, so it costs no extra permission.
 */
export async function fetchPaywallTierNames(): Promise<Record<string, string>> {
  const raw = await retentionRequest<unknown>(
    "/api/v1/paywall/tiers",
    "Loading paywall tiers",
  );
  return normalizePaywallTierNames(raw);
}
