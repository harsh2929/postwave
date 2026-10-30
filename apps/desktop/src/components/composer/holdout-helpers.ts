/**
 * holdout-helpers — pure logic behind composer/HoldoutCard.
 *
 * Configuration-only helpers for HoldoutCard. Lift rendering lives in
 * CampaignMeasurementPanels and consumes the server's frozen powered result.
 */

/** Server bound: POST /campaigns/{id}/holdout rejects percent outside 0..50. */
export function clampHoldoutPercent(raw: number): number {
  if (!Number.isFinite(raw)) return 0;
  return Math.max(0, Math.min(50, Math.round(raw)));
}
