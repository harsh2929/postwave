/**
 * inactive-keys-helpers — pure logic for the Settings inactive-API-key
 * alert card (#23, GET /api/v1/inactive-keys).
 *
 * Severity comes from the server (warn | high | critical); the copy
 * here never invents usage data — `never_used` and
 * `days_since_last_use` are reported verbatim.
 */

import type { InactiveKeyAlert } from "../../lib/api/inactive-keys";

/** Badge tone per server-assigned severity. */
export function inactiveKeySeverityTone(severity: string): string {
  switch (severity) {
    case "critical":
      return "danger";
    case "high":
    case "warn":
      return "warning";
    default:
      return "";
  }
}

/** Honest per-key line: distinguishes never-used from gone-quiet. */
export function inactiveKeyCopy(
  k: Pick<InactiveKeyAlert, "never_used" | "days_since_last_use">,
): string {
  if (k.never_used) return "never used since creation";
  const d = k.days_since_last_use;
  return `unused for ${d} day${d === 1 ? "" : "s"}`;
}

const SEVERITY_RANK: Record<string, number> = {
  critical: 0,
  high: 1,
  warn: 2,
};

/** Critical first, then by idle days descending. */
export function sortInactiveKeys(keys: InactiveKeyAlert[]): InactiveKeyAlert[] {
  return [...keys].sort((a, b) => {
    const ra = SEVERITY_RANK[a.severity] ?? 3;
    const rb = SEVERITY_RANK[b.severity] ?? 3;
    if (ra !== rb) return ra - rb;
    return b.days_since_last_use - a.days_since_last_use;
  });
}

/** Card headline — count + threshold, no drama when the list is empty. */
export function inactiveKeysHeadline(
  count: number,
  thresholdDays: number,
): string {
  if (count === 0)
    return `All API keys have been used within the last ${thresholdDays} days.`;
  return `${count} API key${count === 1 ? "" : "s"} unused for ${thresholdDays}+ days.`;
}
