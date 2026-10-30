/**
 * lib/dashboardOfflineProjection.ts — what the dashboard is allowed to keep
 * on the device.
 *
 * A cold offline launch used to show six em-dashes: honest, and useless. The
 * fix is a cached projection — but the stats payload is NOT safe to cache
 * wholesale, so this module decides exactly what survives the trip to the
 * SecureStore vault.
 *
 * WHAT IS DROPPED, AND WHY IT IS DROPPED HERE RATHER THAN AT THE READER:
 *
 *  - `recent_audit` carries TEAMMATE IDENTITIES ("Ava deleted a segment").
 *    The dashboard already refuses to fire the /audit query for this reason
 *    (it would write names into the vault for a list the screen discards). A
 *    snapshot that re-imported them through the back door would undo that.
 *  - `inbox_health.state` is a human sentence, not a measurement, and it goes
 *    stale in a way a number does not: "Healthy" is a claim about NOW.
 *  - Anything the server adds later. This is an ALLOWLIST, not a blocklist:
 *    a field introduced by a gateway release cannot leak onto disk by default.
 *
 * WHAT SURVIVES: counts and the previous window — i.e. the inputs to the six
 * tiles, and nothing else. Rates are recomputed from those counts at read
 * time by the same pickers the online path uses, so a cached tile and a live
 * tile can never disagree about the arithmetic.
 *
 * Pure and import-free apart from the shared type, so the projection is
 * testable in the node environment (house rule 5).
 */
import type {
  DashboardPreviousWindow,
  DashboardStats,
} from "@/lib/dashboardStatsSchema";

/** Count fields the six tiles are computed from. Nothing else is stored. */
const SNAPSHOT_COUNT_FIELDS = [
  "subscribers_total",
  "subscribers_added_30d",
  "subscribers_unsubbed_30d",
  "unique_opens_30d",
  "unique_clicks_30d",
  "unique_bounces_30d",
  "unique_delivered_30d",
  "unique_sent_30d",
  "campaigns_sent_30d",
  "active_sequences_count",
] as const;

/** Previous-window fields — the same set, for the period-over-period deltas. */
const SNAPSHOT_PREVIOUS_FIELDS = [
  "subscribers_added",
  "subscribers_unsubbed",
  "campaigns_sent",
  "unique_opens",
  "unique_clicks",
  "unique_bounces",
  "unique_delivered",
  "unique_sent",
] as const;

function finiteCount(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

/**
 * Reduce a stats payload to the fields that may be written to the device.
 *
 * Returns null when nothing usable survived — the caller must then treat the
 * snapshot as absent rather than writing an empty husk that would later read
 * back as a successful load of a zero workspace.
 */
export function projectDashboardStatsForVault(
  stats: DashboardStats | undefined,
): DashboardStats | null {
  if (!stats) return null;
  const out: DashboardStats = {};
  let kept = 0;

  for (const field of SNAPSHOT_COUNT_FIELDS) {
    const value = finiteCount(stats[field]);
    if (value === null) continue;
    out[field] = value;
    kept += 1;
  }

  const previous = stats.previous;
  if (previous) {
    const previousOut: DashboardPreviousWindow = {};
    let keptPrevious = 0;
    for (const field of SNAPSHOT_PREVIOUS_FIELDS) {
      const value = finiteCount(previous[field]);
      if (value === null) continue;
      previousOut[field] = value;
      keptPrevious += 1;
    }
    if (keptPrevious > 0) out.previous = previousOut;
  }

  // The inbox-health SCORE is a number and survives; its `state` string is a
  // claim about the present tense and does not.
  const score = finiteCount(stats.inbox_health?.score);
  if (score !== null) {
    out.inbox_health = { score };
    kept += 1;
  }

  if (typeof stats.range === "string" && stats.range.length <= 8) {
    out.range = stats.range;
  }

  return kept > 0 ? out : null;
}

/**
 * Guard for what comes BACK off the device. A vault blob is not a server
 * response: it can be an older schema, or a payload written before a field was
 * dropped from the allowlist. Re-projecting on read means a rule tightened
 * today also applies to a snapshot written yesterday.
 */
export function readDashboardStatsSnapshot(
  raw: unknown,
): DashboardStats | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return null;
  }
  return projectDashboardStatsForVault(raw as DashboardStats);
}
