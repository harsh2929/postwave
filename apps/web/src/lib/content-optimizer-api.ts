// SPDX-License-Identifier: AGPL-3.0-only
//
// Typed client for the campaign content-optimizer (CAMP-045). This is a
// DETERMINISTIC multi-armed-bandit allocation preview across a campaign's
// existing content variants — not an AI body rewriter. The preview handler
// auto-loads the campaign's control body + variants server-side, so a minimal
// body still returns a full allocation.

import { api } from "./api";

export interface ContentOptimizerPreviewInput {
  /** e.g. "open_rate" | "click_rate" — server default applies when omitted. */
  primary_metric?: string;
  /** 0..1 share of traffic reserved for exploration. */
  exploration_rate?: number;
  max_active_arms?: number;
}

export interface ArmAllocation {
  key: string;
  subject?: string;
  preview_text?: string;
  allocation_percent: number;
  exploration_percent: number;
  exploitation_percent: number;
  score: number;
  reason: string;
}

export interface ContentOptimizerPreview {
  campaign_id: string;
  method: string;
  primary_metric: string;
  exploration_rate: number;
  min_sample_per_arm: number;
  recommended_arms: ArmAllocation[];
  generated_at: string;
  run_id?: string;
}

/** Preview the allocation across a campaign's content variants (CAMP-045). */
export function previewContentOptimizer(
  campaignId: string,
  input: ContentOptimizerPreviewInput = {},
  options?: { signal?: AbortSignal },
): Promise<ContentOptimizerPreview> {
  return api.post<ContentOptimizerPreview>(
    `/api/v1/campaigns/${encodeURIComponent(campaignId)}/content-optimizer/preview`,
    input,
    options?.signal ? { signal: options.signal } : undefined,
  );
}
