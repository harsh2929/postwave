// SPDX-License-Identifier: AGPL-3.0-only

export type WinnerMetric = "open_rate" | "click_rate" | "reply_rate";

export interface Variant {
  id?: string;
  campaign_id?: string;
  tenant_id?: string;
  variant_label: string;
  subject?: string;
  from_name?: string;
  from_email?: string;
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
	 sample_pct: number;
	 sample_evaluated_at?: string | null;
	 /** Child rollout campaign that sends the winner to the held-back
	     remainder; present once the scheduler creates it (CAMP-043). */
	 winner_rollout_campaign_id?: string | null;
	 bandit_strategy: "fixed" | "thompson" | "epsilon_greedy";
	 explore_floor: number;
	 recompute_interval_minutes: number;
	 last_recomputed_at?: string | null;
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
	 sample_pct: number;
	 bandit_strategy: "fixed" | "thompson" | "epsilon_greedy";
	 explore_floor: number;
	 recompute_interval_minutes: number;
}
