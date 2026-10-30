// SPDX-License-Identifier: MIT
import { Resource } from "./_base.js";

/** A/B winner metric. */
export type WinnerMetric = "open_rate" | "click_rate" | "reply_rate";

/** One A/B variant of a campaign. */
export interface Variant {
  id?: string;
  campaign_id?: string;
  tenant_id?: string;
  variant_label: string;
  subject?: string;
  from_name?: string;
  body_mjml?: string;
  body_html?: string;
  weight: number;
  created_at?: string;
}

export interface VariantResult {
  variant_id: string;
  tenant_id?: string;
  recipients_count: number;
  delivered: number;
  opens: number;
  clicks: number;
  unsubscribes: number;
  complaints: number;
  winner: boolean;
  last_evaluated_at?: string | null;
}

export interface ABSettings {
  campaign_id: string;
  tenant_id?: string;
  winner_metric: WinnerMetric;
  evaluation_window_hours: number;
  winner_recipients_pct: number;
  winner_decided_at?: string | null;
  winning_variant_id?: string | null;
}

export interface ABView {
  settings: ABSettings;
  variants: Variant[];
  results: VariantResult[];
  winner_variant_id?: string | null;
}

export interface SetABSettingsInput {
  winner_metric: WinnerMetric;
  evaluation_window_hours: number;
  winner_recipients_pct: number;
}

/** Per-campaign A/B testing API. */
export class CampaignsABResource extends Resource {
  /** Replace/upsert the variant set for a campaign. */
  createVariants(campaignId: string, variants: Variant[]): Promise<Variant[]> {
    return this.client.request(
      "POST",
      `/api/v1/campaigns/${encodeURIComponent(campaignId)}/variants`,
      { body: variants },
    );
  }

  /** List variants for a campaign. */
  listVariants(campaignId: string): Promise<Variant[]> {
    return this.client.request(
      "GET",
      `/api/v1/campaigns/${encodeURIComponent(campaignId)}/variants`,
    );
  }

  /** Settings + variants + per-variant aggregate results. */
  getAB(campaignId: string): Promise<ABView> {
    return this.client.request(
      "GET",
      `/api/v1/campaigns/${encodeURIComponent(campaignId)}/ab`,
    );
  }

  /** Create or update the A/B settings row. */
  setABSettings(campaignId: string, input: SetABSettingsInput): Promise<ABSettings> {
    return this.client.request(
      "POST",
      `/api/v1/campaigns/${encodeURIComponent(campaignId)}/ab/settings`,
      { body: input },
    );
  }

  /** Force a winner-detection pass. Returns the updated view. */
  evaluateAB(campaignId: string): Promise<ABView> {
    return this.client.request(
      "POST",
      `/api/v1/campaigns/${encodeURIComponent(campaignId)}/ab/evaluate`,
    );
  }
}
