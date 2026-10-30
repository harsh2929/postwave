/**
 * firewall-helpers — pure logic for the Settings "Form firewall"
 * security section (#48 firewall attack mode).
 *
 * Wire facts (apps/api/internal/firewall_attack_mode):
 *   - PUT /firewall/settings is a partial update (pointer fields);
 *     server validates threshold 0..100, surge_multiplier 2..100,
 *     surge_min_per_hour 1..100000.
 *   - events carry action ∈ accepted | rejected | observed.
 *   - POST /firewall/detect (admin) → {flipped}.
 */

import type {
  FirewallSettings,
  FirewallSettingsInput,
  FirewallStats,
} from "../../lib/api-client";

/** The editable subset of FirewallSettings the section drafts. */
export type FirewallDraft = Pick<
  FirewallSettings,
  | "attack_mode_enabled"
  | "auto_attack_mode"
  | "fingerprint_required"
  | "attack_mode_threshold"
  | "surge_multiplier"
  | "surge_min_per_hour"
>;

/**
 * Diff draft vs server snapshot into the partial PUT body.
 * Returns null when nothing changed (drives the dirty flag).
 */
export function firewallPatch(
  server: FirewallDraft,
  draft: FirewallDraft,
): FirewallSettingsInput | null {
  const p: FirewallSettingsInput = {};
  if (draft.attack_mode_enabled !== server.attack_mode_enabled)
    p.attack_mode_enabled = draft.attack_mode_enabled;
  if (draft.auto_attack_mode !== server.auto_attack_mode)
    p.auto_attack_mode = draft.auto_attack_mode;
  if (draft.fingerprint_required !== server.fingerprint_required)
    p.fingerprint_required = draft.fingerprint_required;
  if (draft.attack_mode_threshold !== server.attack_mode_threshold)
    p.attack_mode_threshold = draft.attack_mode_threshold;
  if (draft.surge_multiplier !== server.surge_multiplier)
    p.surge_multiplier = draft.surge_multiplier;
  if (draft.surge_min_per_hour !== server.surge_min_per_hour)
    p.surge_min_per_hour = draft.surge_min_per_hour;
  return Object.keys(p).length > 0 ? p : null;
}

/**
 * Mirror of the server-side bounds so obvious typos fail with a field
 * message instead of a generic 400. Returns an error string or null.
 */
export function validateFirewallDraft(d: FirewallDraft): string | null {
  if (
    !Number.isInteger(d.attack_mode_threshold) ||
    d.attack_mode_threshold < 0 ||
    d.attack_mode_threshold > 100
  )
    return "Risk threshold must be a whole number between 0 and 100.";
  if (
    !Number.isInteger(d.surge_multiplier) ||
    d.surge_multiplier < 2 ||
    d.surge_multiplier > 100
  )
    return "Surge multiplier must be a whole number between 2 and 100.";
  if (
    !Number.isInteger(d.surge_min_per_hour) ||
    d.surge_min_per_hour < 1 ||
    d.surge_min_per_hour > 100000
  )
    return "Surge minimum per hour must be a whole number between 1 and 100,000.";
  return null;
}

/** Badge tone per firewall event action. */
export function firewallActionTone(action: string): string {
  switch (action) {
    case "rejected":
      return "danger";
    case "observed":
      return "warning";
    case "accepted":
      return "success";
    default:
      return "";
  }
}

/** Accepted / rejected / observed counters for one time window. */
export interface FirewallWindowCounts {
  accepted: number;
  rejected: number;
  observed: number;
}

/**
 * Normalise one stats window to numeric counts. The /stats response can
 * come back empty or partial (a freshly-provisioned tenant has no rows,
 * so the server may omit `last_24h` / `last_7d` entirely). Read every
 * counter defensively so a missing window renders as zeros instead of
 * white-screening on `undefined.rejected`.
 */
export function firewallWindowCounts(
  window: Partial<FirewallWindowCounts> | null | undefined,
): FirewallWindowCounts {
  return {
    accepted: window?.accepted ?? 0,
    rejected: window?.rejected ?? 0,
    observed: window?.observed ?? 0,
  };
}

/** Both windows normalised — drives the stat cards without nil reads. */
export function firewallStatCounts(
  stats: Partial<FirewallStats> | null | undefined,
): { last24h: FirewallWindowCounts; last7d: FirewallWindowCounts } {
  return {
    last24h: firewallWindowCounts(stats?.last_24h),
    last7d: firewallWindowCounts(stats?.last_7d),
  };
}

/**
 * Verbatim report of POST /detect's `{flipped}` — no embellishment.
 * flipped=true means the sweep just auto-enabled attack mode.
 */
export function surgeResultCopy(flipped: boolean): string {
  return flipped
    ? "Surge detected — attack mode was enabled by this check."
    : "No surge detected — settings unchanged.";
}
