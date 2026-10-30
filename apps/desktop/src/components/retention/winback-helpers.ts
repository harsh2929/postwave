/**
 * winback-helpers — pure logic for the "Churn win-backs" card on the
 * Retention offers page (roadmap R13,
 * apps/api/internal/retention_offers/winback.go).
 *
 * Dormant package contract:
 *   - `churn_threshold` ∈ (0, 1]; PUT-ing 0 means "use the default
 *     (0.7)"; anything else out of range is a 400. The UI works in
 *     whole percent (1–100) and converts at the edge.
 *   - `churn_profiles_scored` is READ-ONLY. 0 → the predictive model
 *     hasn't run (or the tenant has no commerce-order signal) and the
 *     predictive scoring has not produced a row. It does not describe
 *     delivery readiness because the worker is not composed.
 */

import {
  RETENTION_WINBACK_RELEASE_HOLD_CODE,
  RETENTION_WINBACK_RELEASE_VERDICT,
} from "../../lib/retention-winback-release-status";

/** Threshold (0..1 fraction) → whole-percent input string ("0.7" → "70"). */
export function thresholdToPercentInput(threshold: number): string {
  if (!Number.isFinite(threshold) || threshold <= 0 || threshold > 1) {
    return "";
  }
  // Round to avoid 0.07 * 100 = 7.000000000000001 style artifacts.
  return String(Math.round(threshold * 10000) / 100);
}

export type PercentParse =
  | { ok: true; threshold: number }
  | { ok: false; error: string };

/**
 * Parse the whole-percent input back into the 0..1 fraction the PUT
 * body expects. Mirrors the server's (0, 1] validation so the user
 * gets the error before the round-trip.
 */
export function parsePercentInput(raw: string): PercentParse {
  const trimmed = raw.trim();
  if (trimmed === "") {
    return { ok: false, error: "Threshold is required (1–100%)." };
  }
  const pct = Number(trimmed);
  if (!Number.isFinite(pct)) {
    return { ok: false, error: "Threshold must be a number." };
  }
  if (pct <= 0 || pct > 100) {
    return { ok: false, error: "Threshold must be between 1% and 100%." };
  }
  // Round to 4 decimals on the fraction (2 decimals of percent) so we
  // never send float noise like 0.7000000000000001.
  return { ok: true, threshold: Math.round(pct * 100) / 10000 };
}

/**
 * Honest data-gap copy. Returns null when profiles ARE scored (no gap
 * to explain); otherwise the manifest-mandated explainer.
 */
export function winbackDataGapCopy(churnProfilesScored: number): string | null {
  if (churnProfilesScored > 0) return null;
  return `No churn-risk profiles are recorded as scored. This is scoring coverage only; automated delivery is ${RETENTION_WINBACK_RELEASE_VERDICT} (${RETENTION_WINBACK_RELEASE_HOLD_CODE}) regardless of the stored switch.`;
}

/** Status line under the toggle, derived from the GET payload. */
export function winbackStatusCopy(
  enabled: boolean,
  churnProfilesScored: number,
): string {
  if (!enabled) {
    return "Stored switch disabled. No runtime state is inferred.";
  }
  // Coerce a missing/non-finite count to 0 so the inert branch catches
  // it (undefined <= 0 is false, which would otherwise reach
  // .toLocaleString() on undefined and crash).
  const scored =
    typeof churnProfilesScored === "number" &&
    Number.isFinite(churnProfilesScored)
      ? churnProfilesScored
      : 0;
  if (scored <= 0) {
    return `Stored switch enabled; no churn-risk profiles are recorded as scored. Runtime delivery is ${RETENTION_WINBACK_RELEASE_VERDICT} (${RETENTION_WINBACK_RELEASE_HOLD_CODE}).`;
  }
  return `Stored switch enabled; ${scored.toLocaleString()} subscriber profile${
    scored === 1 ? "" : "s"
  } recorded as scored. Runtime delivery is ${RETENTION_WINBACK_RELEASE_VERDICT} (${RETENTION_WINBACK_RELEASE_HOLD_CODE}).`;
}
