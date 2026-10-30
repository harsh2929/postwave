/**
 * lib/platformConfig.ts — the pure half of mobile's read-only view of four
 * workspace-platform surfaces that had NO mobile representation at all:
 * data region, feature flags, the signup firewall and identifier transforms.
 *
 * Desktop renders each as its own editable section (apps/desktop/src/pages/
 * Settings.tsx: RegionSection / FeatureFlagsSection / FirewallSection /
 * IdentifierTransformsSection). These are low-frequency configuration
 * surfaces, so the phone-appropriate answer is READ-ONLY visibility: a user
 * whose imports are silently having "+tag" stripped, or whose signups are
 * being fingerprint-gated, needs to be able to SEE that from the device in
 * their hand — not to change it there.
 *
 * Three of the four were later judged phone-shaped on conditions (docs/
 * mobile-desktop-parity-2026-08-28.md, settings P3); their edit halves live
 * in lib/featureFlagOverrides.ts, lib/firewallAdmin.ts and
 * lib/identifierTransformsEdit.ts, all built on the read shapes below.
 *
 * WIRE SHAPES, read off the Go handlers rather than a doc (none of the four
 * has a documented response schema in openapi.json):
 *
 *   GET /api/v1/tenant/region  → {data_region, deployment_region, matches}
 *     apps/api/internal/regions/handler.go:22 (regionResponse)
 *   GET /api/v1/feature-flags  → {flags: Flag[], count}
 *     apps/api/internal/feature_flags/feature_flags.go:62 (Flag) / :126 (List)
 *   GET /api/v1/firewall/settings → Settings (a FLAT object, not wrapped)
 *     apps/api/internal/firewall_attack_mode/firewall_attack_mode.go:100
 *   GET /api/v1/settings/identifier-transforms → IdentifierTransformConfig
 *     apps/api/internal/subscribers/types.go:50
 *
 * DELIBERATELY IMPORT-FREE — no react-native, no ./connectivity — so every
 * normalizer and label below is unit-testable in the node vitest environment,
 * for the same reason `approvalPolicy`, `chartScale` and `typeScale` are pure.
 */

export interface TenantRegion {
  /** Where this workspace's data lives. */
  dataRegion: string;
  /** Where the API instance answering this request runs. */
  deploymentRegion: string;
  /**
   * Server-computed equality. Trusted rather than recomputed: the server owns
   * the comparison precisely so two clients cannot disagree about it.
   */
  matches: boolean;
}

export interface FeatureFlagView {
  key: string;
  value: string;
  note: string;
  enabled: boolean;
  /**
   * True when the row is the PLATFORM default (`tenant_id IS NULL`), false
   * when this workspace has its own override. The list endpoint returns both,
   * ordered so the override precedes the default for a given key.
   */
  isDefault: boolean;
}

export interface FirewallSettingsView {
  attackModeEnabled: boolean;
  autoAttackMode: boolean;
  fingerprintRequired: boolean;
  attackModeThreshold: number;
  surgeMultiplier: number;
  surgeMinPerHour: number;
  /** Set only while an AUTOMATIC escalation is currently in force. */
  autoEnabledAt: string | null;
}

export interface IdentifierTransformsView {
  emailNormalizeDots: boolean;
  emailNormalizePlus: boolean;
  phoneE164Format: boolean;
  /** ISO 3166-1 alpha-2, or empty for "no default region". */
  phoneDefaultRegion: string;
}

function bool(value: unknown): boolean {
  return value === true;
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function int(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.trunc(value)
    : 0;
}

function nullableStr(value: unknown): string | null {
  const s = str(value);
  return s ? s : null;
}

export function normalizeRegion(payload: unknown): TenantRegion {
  const raw = (payload ?? {}) as Record<string, unknown>;
  return {
    dataRegion: str(raw.data_region),
    deploymentRegion: str(raw.deployment_region),
    matches: bool(raw.matches),
  };
}

/**
 * The flag list, collapsed to what a reader can act on.
 *
 * The endpoint returns platform defaults AND this workspace's overrides for
 * the same key (`WHERE tenant_id IS NULL OR tenant_id = $1`, ordered so the
 * override sorts first). Rendering both would show the same flag twice with
 * contradictory values, so the first row wins per key — which is the override
 * when one exists, exactly as the server's own ORDER BY intends.
 */
export function normalizeFeatureFlags(payload: unknown): FeatureFlagView[] {
  const raw = (payload ?? {}) as Record<string, unknown>;
  const rows = Array.isArray(raw.flags) ? raw.flags : [];
  const seen = new Set<string>();
  const out: FeatureFlagView[] = [];
  for (const row of rows) {
    const r = (row ?? {}) as Record<string, unknown>;
    const key = str(r.flag_key) || str(r.key);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({
      key,
      value: str(r.value),
      note: str(r.note),
      enabled: bool(r.enabled),
      isDefault: bool(r.is_default),
    });
  }
  return out;
}

export function normalizeFirewallSettings(
  payload: unknown,
): FirewallSettingsView {
  const raw = (payload ?? {}) as Record<string, unknown>;
  return {
    attackModeEnabled: bool(raw.attack_mode_enabled),
    autoAttackMode: bool(raw.auto_attack_mode),
    fingerprintRequired: bool(raw.fingerprint_required),
    attackModeThreshold: int(raw.attack_mode_threshold),
    surgeMultiplier: int(raw.surge_multiplier),
    surgeMinPerHour: int(raw.surge_min_per_hour),
    autoEnabledAt: nullableStr(raw.attack_mode_auto_enabled_at),
  };
}

export function normalizeIdentifierTransforms(
  payload: unknown,
): IdentifierTransformsView {
  const raw = (payload ?? {}) as Record<string, unknown>;
  return {
    emailNormalizeDots: bool(raw.email_normalize_dots),
    emailNormalizePlus: bool(raw.email_normalize_plus),
    phoneE164Format: bool(raw.phone_e164_format),
    phoneDefaultRegion: str(raw.phone_default_region).toUpperCase(),
  };
}

/** A region code the server has never populated reads as unknown, not blank. */
export function regionLabel(code: string): string {
  return code || "Unknown";
}

/**
 * The one sentence that matters about residency. `matches === false` is not an
 * error — a tenant can legitimately be served from a region other than where
 * its data rests — but it IS the thing a compliance-minded admin opened this
 * card to find out, so it is stated rather than left to be inferred from two
 * codes sitting next to each other.
 */
export function residencySummary(region: TenantRegion): string {
  if (!region.dataRegion) return "This workspace has no recorded data region.";
  if (region.matches) {
    return `Data and processing both stay in ${region.dataRegion}.`;
  }
  return `Data rests in ${region.dataRegion} but this request was served from ${
    regionLabel(region.deploymentRegion)
  }.`;
}

/** Attack mode, in the order the server applies it. */
export function firewallModeLabel(settings: FirewallSettingsView): string {
  if (settings.attackModeEnabled) {
    return settings.autoEnabledAt
      ? "On — escalated automatically"
      : "On — enabled by an admin";
  }
  return settings.autoAttackMode ? "Off — arms automatically" : "Off";
}

/**
 * The signup surge rule as prose. Both numbers are meaningless alone: the
 * multiplier is relative to a rolling baseline and the floor is what stops a
 * quiet workspace tripping on three signups.
 */
export function surgeRuleLabel(settings: FirewallSettingsView): string {
  if (!settings.autoAttackMode) return "Automatic escalation is off";
  if (settings.surgeMultiplier <= 0 && settings.surgeMinPerHour <= 0) {
    return "Automatic escalation is on, with no thresholds set";
  }
  return `Arms above ${settings.surgeMultiplier}× the usual rate, and never below ${settings.surgeMinPerHour} signups an hour`;
}

/**
 * Identifier transforms as the list of things actually happening to incoming
 * addresses. An empty list is stated in words rather than rendered as an empty
 * card, because "nothing is being rewritten" is itself the answer the reader
 * came for.
 */
export function identifierTransformSummary(
  cfg: IdentifierTransformsView,
): string[] {
  const out: string[] = [];
  if (cfg.emailNormalizeDots) out.push("Dots removed from email local-parts");
  if (cfg.emailNormalizePlus) out.push("“+tag” sub-addresses dropped");
  if (cfg.phoneE164Format) {
    out.push(
      cfg.phoneDefaultRegion
        ? `Phone numbers coerced to E.164, defaulting to ${cfg.phoneDefaultRegion}`
        : "Phone numbers coerced to E.164 (international numbers only)",
    );
  }
  return out;
}

/**
 * True when a surface is none of this user's business (403) or is not deployed
 * on this instance (404). Both mean "render nothing" — never an error banner
 * for something the reader was never entitled to see, and never a broken-
 * looking card on a self-hosted build that omits the module.
 *
 * A 501 is included because a deployment can mount the route and answer
 * "not implemented" for an unconfigured optional subsystem.
 */
export function isPlatformSurfaceHidden(status: number): boolean {
  return status === 403 || status === 404 || status === 501;
}
