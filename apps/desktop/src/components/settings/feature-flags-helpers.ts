/**
 * feature-flags-helpers — pure logic for the Settings "Feature flags"
 * admin section (#56).
 *
 * Wire facts (apps/api/internal/feature_flags): list returns tenant
 * rows + platform defaults flagged via `is_default`; DELETE removes
 * only the tenant override; resolve reports
 * `{key, value, source: tenant|default|missing}`.
 */

import type { FeatureFlag } from "../../lib/api-client";

/** Tenant overrides float above platform defaults; alpha by key inside. */
export function sortFlags(flags: FeatureFlag[]): FeatureFlag[] {
  return [...flags].sort((a, b) => {
    if (a.is_default !== b.is_default) return a.is_default ? 1 : -1;
    // A flag row can arrive without `key` — coerce so the sort never
    // crashes on `undefined.localeCompare`.
    return (a.key ?? "").localeCompare(b.key ?? "");
  });
}

export function flagSourceLabel(flag: Pick<FeatureFlag, "is_default">): string {
  return flag.is_default ? "Platform default" : "Tenant override";
}

/**
 * Light client-side key validation: backend is the source of truth,
 * this only catches the empty / whitespace cases that would otherwise
 * surface as a generic 400 toast. Returns an error message or null.
 */
export function validateFlagKey(key: string): string | null {
  const k = key.trim();
  if (k.length === 0) return "Flag key is required.";
  if (/\s/.test(k)) return "Flag key can't contain whitespace.";
  if (k.length > 128) return "Flag key is too long (max 128 characters).";
  return null;
}

/** Badge tone for the resolve-preview source. */
export function resolveSourceTone(source: string): string {
  switch (source) {
    case "tenant":
      return "success";
    case "default":
      return "";
    case "missing":
      return "warning";
    default:
      return "";
  }
}

/** Honest one-liner for the resolve preview — reports the source verbatim. */
export function resolveSourceCopy(res: {
  key: string;
  value: string;
  source: string;
}): string {
  switch (res.source) {
    case "tenant":
      return `"${res.key}" resolves to "${res.value}" from this workspace's override.`;
    case "default":
      return `"${res.key}" resolves to "${res.value}" from the platform default.`;
    case "missing":
      return `"${res.key}" is not set — no tenant override and no platform default.`;
    default:
      return `"${res.key}" resolved with unrecognized source "${res.source}".`;
  }
}
