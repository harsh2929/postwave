/**
 * api/abSettings.ts — the A/B test's configuration surface.
 *
 * The SDK already carries `client.campaignsAB` (packages/sdk-ts/src/resources/
 * campaigns-ab.ts) with getAB / setABSettings / evaluateAB; mobile simply
 * never called any of them, so a phone could watch a test and never act on it.
 *
 * These are thin, typed wrappers rather than direct SDK calls at the call
 * sites so the mobile-side wire types (src/lib/abSettings.ts) stay the single
 * shape the screens read.
 */
import { getClient } from "@/api/client";
import type { ABSettingsPayload, ABSettingsWire } from "@/lib/abSettings";

export interface ABViewResponse {
  settings?: ABSettingsWire;
  variants?: { id?: string; variant_label?: string; weight?: number }[];
  results?: {
    variant_id: string;
    recipients_count?: number;
    delivered?: number;
    opens?: number;
    clicks?: number;
    winner?: boolean;
    last_evaluated_at?: string | null;
  }[];
  winner_variant_id?: string | null;
}

/** GET /api/v1/campaigns/{id}/ab */
export function getABView(campaignId: string): Promise<ABViewResponse> {
  const { client } = getClient();
  return client.request<ABViewResponse>(
    "GET",
    `/api/v1/campaigns/${encodeURIComponent(campaignId)}/ab`,
  );
}

/** POST /api/v1/campaigns/{id}/ab/settings */
export function setABSettings(
  campaignId: string,
  body: ABSettingsPayload,
): Promise<ABSettingsWire> {
  const { client } = getClient();
  return client.request<ABSettingsWire>(
    "POST",
    `/api/v1/campaigns/${encodeURIComponent(campaignId)}/ab/settings`,
    { body },
  );
}

/** POST /api/v1/campaigns/{id}/ab/evaluate — forces a winner-detection pass. */
export function evaluateAB(campaignId: string): Promise<ABViewResponse> {
  const { client } = getClient();
  return client.request<ABViewResponse>(
    "POST",
    `/api/v1/campaigns/${encodeURIComponent(campaignId)}/ab/evaluate`,
  );
}
