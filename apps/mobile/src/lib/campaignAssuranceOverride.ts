import type { CampaignAssuranceOverride } from "@postwave/sdk";

import { canAccessMinimumRole } from "@/lib/mobileRouteManifest";

export type MobileAssuranceOverrideAvailability =
  | "available"
  | "existing_receipt"
  | "offline_handoff"
  | "policy_blocked"
  | "role_handoff";

export function assuranceOverrideAvailability(input: {
  overridable: boolean;
  existingOverride: CampaignAssuranceOverride | undefined;
  effectiveRole: string | null;
  online: boolean;
}): MobileAssuranceOverrideAvailability {
  if (input.existingOverride) return "existing_receipt";
  if (!input.overridable) return "policy_blocked";
  if (!canAccessMinimumRole("admin", input.effectiveRole)) {
    return "role_handoff";
  }
  if (!input.online) return "offline_handoff";
  return "available";
}

/** The API accepts a trimmed, governed rationale of 10..2000 code points. */
export function normalizeAssuranceOverrideReason(reason: string): string {
  const normalized = reason.trim();
  const length = Array.from(normalized).length;
  if (length < 10 || length > 2_000) {
    throw new Error("Give a specific rationale of 10 to 2000 characters.");
  }
  return normalized;
}

export function latestAssuranceOverride(
  overrides: readonly CampaignAssuranceOverride[] | null | undefined,
  findingId: string,
): CampaignAssuranceOverride | undefined {
  if (!Array.isArray(overrides)) return undefined;
  return overrides
    .filter((override) => override.finding_id === findingId)
    .sort((left, right) => right.created_at.localeCompare(left.created_at))[0];
}
