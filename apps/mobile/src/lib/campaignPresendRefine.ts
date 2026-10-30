/**
 * lib/campaignPresendRefine.ts — the churn-risk gate before a send (SUB-067).
 *
 * Server contract (apps/api/internal/subscribers/presend_refine.go):
 *   POST   /campaigns/{id}/presend-refine  {churn_threshold, cooling_off_hours,
 *          dry_run} — preview (dry_run) or commit; write scope / editor.
 *   GET    /campaigns/{id}/presend-refine  — active exclusion set; viewer.
 *   DELETE /campaigns/{id}/presend-refine  — clear, force re-entry; editor.
 *
 * All three answer/consume PreSendRefineResult (subscribers/types.go:423).
 * Desktop mounts this in the SendChecklist (PreSendRefinePanel); the phone
 * form swaps the 40..100 slider for stepped threshold choices, which is the
 * same policy space without a drag interaction.
 */

export interface RefineSampleRow {
  id: string;
  email: string;
  churnScore: number;
  reason: string;
}

export interface PresendRefineReading {
  churnThreshold: number;
  coolingOffHours: number;
  excludedCount: number;
  coolingOffCount: number;
  coolingOffUntil: number | null;
  dryRun: boolean;
  sample: RefineSampleRow[];
}

/** Threshold choices; 80 mirrors DefaultChurnThreshold server-side. */
export const REFINE_THRESHOLD_OPTIONS: readonly number[] = [60, 70, 80, 90];
export const REFINE_DEFAULT_THRESHOLD = 80;
/** Sample rows shown inline — desktop shows the top 3 as well. */
export const REFINE_SAMPLE_SHOWN = 3;

export function readPresendRefine(
  data: unknown,
): PresendRefineReading | null {
  if (!data || typeof data !== "object") return null;
  const body = data as Record<string, unknown>;
  const num = (v: unknown): number =>
    typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0;
  const until =
    typeof body.cooling_off_until === "string" && body.cooling_off_until
      ? Date.parse(body.cooling_off_until)
      : NaN;
  const sampleRaw = Array.isArray(body.affected_subscribers_sample)
    ? body.affected_subscribers_sample
    : [];
  const sample: RefineSampleRow[] = [];
  for (const item of sampleRaw) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const email = typeof row.email === "string" ? row.email : "";
    if (!email) continue;
    sample.push({
      id: typeof row.subscriber_id === "string" ? row.subscriber_id : email,
      email,
      churnScore: num(row.churn_score),
      reason: typeof row.reason === "string" ? row.reason : "",
    });
  }
  return {
    churnThreshold: num(body.churn_threshold) || REFINE_DEFAULT_THRESHOLD,
    coolingOffHours: num(body.cooling_off_hours),
    excludedCount: num(body.excluded_count),
    coolingOffCount: num(body.cooling_off_count),
    coolingOffUntil: Number.isNaN(until) ? null : until,
    dryRun: body.dry_run === true,
    sample,
  };
}

/** One sentence stating what the refinement does / would do. */
export function refineSummary(reading: PresendRefineReading): string {
  const n = reading.excludedCount;
  const verb = reading.dryRun ? "would be held back" : "are held back";
  if (n === 0) {
    return reading.dryRun
      ? `No subscribers score ${reading.churnThreshold} or above, so this send would exclude nobody.`
      : "No churn-risk exclusions are active for this send.";
  }
  const hours = reading.coolingOffHours || 24;
  return `${n} likely-unsubscriber${n === 1 ? "" : "s"} (churn score ≥ ${reading.churnThreshold}) ${verb} for a ${hours}-hour cooling-off window.`;
}
