/**
 * api/bestTimeSchedule.ts — the two send-time-optimisation writes.
 *
 * Both endpoints take the identical body (see bestTimeRequestBody); the only
 * difference is that `/preview` never persists. Keeping them in one module
 * makes it impossible to let the two bodies drift, which is the exact failure
 * desktop shipped once (preview honoured `strategy`, commit dropped it).
 */
import { rawRequest, type AIApiResult } from "./request";

import type {
  BestTimeScheduleCommit,
  BestTimeSchedulePreview,
} from "@/lib/bestTimeSchedule";

function encode(campaignId: string): string {
  return encodeURIComponent(campaignId);
}

/** POST …/schedule-by-best-time/preview — read-only dry run. */
export async function previewBestTimeSchedule(
  campaignId: string,
  body: Record<string, unknown>,
): Promise<AIApiResult<BestTimeSchedulePreview>> {
  return rawRequest<BestTimeSchedulePreview>(
    "POST",
    `/api/v1/campaigns/${encode(campaignId)}/schedule-by-best-time/preview`,
    body,
  );
}

/** POST …/schedule-by-best-time — writes campaign_recipient_send_at. */
export async function commitBestTimeSchedule(
  campaignId: string,
  body: Record<string, unknown>,
): Promise<AIApiResult<BestTimeScheduleCommit>> {
  return rawRequest<BestTimeScheduleCommit>(
    "POST",
    `/api/v1/campaigns/${encode(campaignId)}/schedule-by-best-time`,
    body,
  );
}
