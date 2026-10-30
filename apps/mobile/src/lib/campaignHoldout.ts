/**
 * lib/campaignHoldout.ts — configure the measurement BEFORE the send.
 *
 * Mobile read the lift (useCampaignInsight "holdoutLift") and its empty state
 * literally said "Set one up on the web app". The setup half:
 *
 *   POST   /api/v1/campaigns/{id}/holdout  {percent 0..50, ...} → holdout row
 *   DELETE /api/v1/campaigns/{id}/holdout  → removes it
 *
 * ROLE: the handler binds ScopeAdmin for POST/DELETE (holdout.go:103-106), so
 * on the session path only owner/admin can write — the card gates on
 * `canAdmin`, matching desktop HoldoutCard's own prop note, and an editor is
 * never offered a button that can only 403.
 *
 * ONLINE-ONLY: the write partitions a future send's audience for measurement;
 * replaying a stale queued config over one someone else set meanwhile would
 * silently change what an experiment measures.
 */

export const HOLDOUT_PERCENT_OPTIONS: readonly number[] = [5, 10, 20];

/** Mirrors the server rule: percent must be 0..50 (holdout.go Create). */
export function clampHoldoutPercent(raw: number): number {
  if (!Number.isFinite(raw)) return 0;
  return Math.max(0, Math.min(50, raw));
}

export interface HoldoutReading {
  percent: number;
  heldOutCount: number;
  sentCount: number;
  outcomeMetric: string;
  decided: boolean;
}

export function readHoldout(data: unknown): HoldoutReading | null {
  if (!data || typeof data !== "object") return null;
  const body = data as Record<string, unknown>;
  if (typeof body.percent !== "number" || !Number.isFinite(body.percent)) {
    return null;
  }
  const num = (v: unknown): number =>
    typeof v === "number" && v >= 0 ? v : 0;
  return {
    percent: body.percent,
    heldOutCount: num(body.held_out_count),
    sentCount: num(body.sent_count),
    outcomeMetric:
      typeof body.outcome_metric === "string" ? body.outcome_metric : "",
    decided:
      typeof body.decided_at === "string" && body.decided_at.trim() !== "",
  };
}

export function holdoutSummary(reading: HoldoutReading | null): string {
  if (!reading) {
    return "No holdout is configured. Set one before the send to measure what this campaign actually causes.";
  }
  if (reading.decided) {
    return `A ${reading.percent}% holdout was applied at send time — see Incremental lift in Insights for the result.`;
  }
  return `${reading.percent}% of the audience will be held out at send time to measure ${reading.outcomeMetric || "engagement"} lift.`;
}
