// SPDX-License-Identifier: AGPL-3.0-only
/**
 * lib/campaign-audience-api.ts — freezing a campaign's audience (parity row
 * campaigns-26, server apps/api/internal/campaigns/audience_freeze.go).
 *
 * WHAT FREEZING ACTUALLY DOES, because the word undersells it. The campaign's
 * segment is evaluated ONCE, the resulting membership is snapshotted into a
 * static freeze, and the campaign's audience_mode flips to `static`. From then
 * on the send goes to the snapshot, not to the segment: someone who joins the
 * segment tomorrow is not mailed, and someone who leaves it still is. There is
 * no unfreeze endpoint — this is a one-way change for this campaign, which is
 * why the UI puts it behind a confirm that names that consequence.
 *
 * IT SNAPSHOTS THE SAVED SEGMENT. The server reads `campaigns.segment_id`, so
 * an unsaved segment change in the editor is not what gets frozen. The caller
 * is responsible for saying so.
 *
 * THE SERVER REFUSES SOME CAMPAIGNS ON PURPOSE:
 *   422 freeze_requires_segment — a whole-audience campaign has no membership
 *       to snapshot (segment_static_freezes.source_segment_id is NOT NULL).
 *   422 segment_not_found       — the segment went away underneath the draft.
 *   409 edit_lease_held         — someone else holds the campaign's edit lease;
 *       freezing is an edit and is refused rather than raced.
 * Each of those arrives as an ApiError carrying the server's own sentence, and
 * every one of them is worth showing verbatim instead of "couldn't freeze".
 */
import { api } from "@/lib/api";

export interface AudienceFreezeResult {
  /** Members captured into the static snapshot. */
  frozen_members: number;
}

/**
 * Snapshot the campaign's current segment membership.
 *
 * Online-only and non-replayable: a freeze replayed from an offline queue
 * would snapshot a different population than the operator reviewed.
 */
export async function freezeCampaignAudience(
  campaignId: string,
  options: { signal?: AbortSignal } = {},
): Promise<AudienceFreezeResult> {
  const raw = await api.post<unknown>(
    `/api/v1/campaigns/${encodeURIComponent(campaignId)}/audience/freeze`,
    {},
    {
      idempotencyKey: null,
      requireOnline: true,
      maxAttempts: 1,
      signal: options.signal,
    },
  );
  const count = (raw as Record<string, unknown> | null)?.frozen_members;
  return {
    frozen_members:
      typeof count === "number" && Number.isFinite(count) ? count : 0,
  };
}
