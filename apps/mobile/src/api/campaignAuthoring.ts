/**
 * api/campaignAuthoring.ts — the ONLINE-ONLY campaign authoring writes.
 *
 * The identity sheet's field diff rides the offline outbox
 * (lib/offlineMutations executeCampaignUpdate); everything here deliberately
 * does not:
 *
 *   - `patchCampaignAuthoring` carries writes whose bodies are built from the
 *     freshest server state the client holds — the delivery_settings FULL
 *     REPLACE for a sender change (see lib/campaignSenderEdit), the
 *     audience_mode flip, the goal fields. Replaying any of these from a
 *     queue hours later would overwrite whatever changed in the meantime.
 *   - `freezeCampaignAudience` mints a snapshot of the membership NOW —
 *     a time-anchored act that must never replay at a different time.
 *
 * Both routes re-verified in the routeauth manifest 2026-08-28:
 *   PATCH /api/v1/campaigns/{id}                 editor
 *   POST  /api/v1/campaigns/{id}/audience/freeze editor
 */
import { rawRequest, type AIApiResult } from "./request";

export async function patchCampaignAuthoring(
  campaignId: string,
  body: Record<string, unknown>,
): Promise<AIApiResult<unknown>> {
  return rawRequest<unknown>(
    "PATCH",
    `/api/v1/campaigns/${encodeURIComponent(campaignId)}`,
    body,
  );
}

/** POST /api/v1/campaigns/{id}/audience/freeze → {ok, frozen_members}. */
export async function freezeCampaignAudience(
  campaignId: string,
): Promise<AIApiResult<unknown>> {
  return rawRequest<unknown>(
    "POST",
    `/api/v1/campaigns/${encodeURIComponent(campaignId)}/audience/freeze`,
  );
}
