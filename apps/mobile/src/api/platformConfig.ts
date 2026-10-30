/**
 * api/platformConfig.ts — the four READ endpoints behind the Settings screen's
 * "Platform configuration" card.
 *
 * Every one of these was previously unreachable from the phone: grepping
 * apps/mobile for `feature-flags`, `tenant/region`, `firewall/settings` or
 * `identifier-transforms` returned zero hits, while desktop rendered a section
 * for each. See src/lib/platformConfig.ts for the wire shapes (read off the Go
 * handlers) and for why this is read-only.
 *
 * READS ONLY, DELIBERATELY. Three of the four have a write half, and each one
 * is workspace-wide and hazardous from a phone: a mis-tapped feature flag
 * changes what every colleague sees, PUT /firewall/settings can shut off
 * signups, and PATCH /identifier-transforms rewrites how every future import
 * is matched to existing subscribers. Those stay on the web admin.
 *
 * THE WRITES NOW EXIST, EACH IN ITS OWN MODULE (docs/mobile-desktop-parity-
 * 2026-08-28.md, settings P3): api/featureFlagOverrides.ts (validated form,
 * key fixed when editing, removal behind a confirm), api/firewallAdmin.ts
 * (only changed fields travel, arming behind a confirm) and
 * api/identifierTransformsEdit.ts (live preview of the unsaved draft, save
 * behind a confirm). This module stays reads-only so the card's four
 * independent reads keep one error policy.
 *
 * ERRORS ARE TYPED BY STATUS, not by message, because the caller's decision is
 * "hide this row" vs "show a failure" and only the status can answer it.
 */
import { rawRequest } from "./request";

import {
  normalizeFeatureFlags,
  normalizeFirewallSettings,
  normalizeIdentifierTransforms,
  normalizeRegion,
  type FeatureFlagView,
  type FirewallSettingsView,
  type IdentifierTransformsView,
  type TenantRegion,
} from "@/lib/platformConfig";

export class PlatformConfigError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message || "Couldn't load this workspace setting.");
    this.name = "PlatformConfigError";
    this.status = status;
  }
}

async function readOrThrow<T>(path: string, parse: (raw: unknown) => T) {
  const res = await rawRequest<unknown>("GET", path);
  if (res.error) throw new PlatformConfigError(res.error.status, res.error.message);
  return parse(res.data);
}

/** GET /api/v1/tenant/region — apps/api/internal/regions/handler.go */
export function getTenantRegion(): Promise<TenantRegion> {
  return readOrThrow("/api/v1/tenant/region", normalizeRegion);
}

/** GET /api/v1/feature-flags — read scope (feature_flags.go:87). */
export function getFeatureFlags(): Promise<FeatureFlagView[]> {
  return readOrThrow("/api/v1/feature-flags", normalizeFeatureFlags);
}

/** GET /api/v1/firewall/settings — read scope (firewall_attack_mode.go:567). */
export function getFirewallSettings(): Promise<FirewallSettingsView> {
  return readOrThrow("/api/v1/firewall/settings", normalizeFirewallSettings);
}

/**
 * GET /api/v1/settings/identifier-transforms — read scope
 * (subscribers/identifier_normalizer.go:382).
 */
export function getIdentifierTransforms(): Promise<IdentifierTransformsView> {
  return readOrThrow(
    "/api/v1/settings/identifier-transforms",
    normalizeIdentifierTransforms,
  );
}
