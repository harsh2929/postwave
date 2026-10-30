import {
  type OnboardingProgress,
  isOnboardingProgress,
} from "@postwave/onboarding-schema";

import { rawRequest, type AIApiResult } from "./request";

export interface MobileMailchimpParitySnapshot {
  planner_touchpoints: number;
  planner_tasks: number;
  channels: number;
  audience_dimensions: number;
  content_files: number;
  content_status: string;
}

function mobileArrayLength(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

function mobileRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export async function getMobileMailchimpParitySnapshot(): Promise<
  AIApiResult<MobileMailchimpParitySnapshot>
> {
  const [planner, audience, studio, channels] = await Promise.all([
    rawRequest<Record<string, unknown>>(
      "GET",
      "/api/mailchimp/3.0/campaign-manager/calendar",
    ),
    rawRequest<Record<string, unknown>>(
      "GET",
      "/api/mailchimp/3.0/audience/insights",
    ),
    rawRequest<Record<string, unknown>>(
      "GET",
      "/api/mailchimp/3.0/content-studio",
    ),
    rawRequest<Record<string, unknown>>(
      "GET",
      "/api/mailchimp/3.0/growth/channels",
    ),
  ]);
  const firstError =
    planner.error ?? audience.error ?? studio.error ?? channels.error;
  if (firstError) return { data: null, error: firstError };
  const plannerData = mobileRecord(planner.data);
  const audienceData = mobileRecord(audience.data);
  const studioData = mobileRecord(studio.data);
  const channelData = mobileRecord(channels.data);
  return {
    data: {
      planner_touchpoints: mobileArrayLength(plannerData.touchpoints),
      planner_tasks: mobileArrayLength(plannerData.tasks),
      channels: mobileArrayLength(channelData.channels),
      audience_dimensions: mobileArrayLength(audienceData.segment_dimensions),
      content_files: mobileArrayLength(studioData.files),
      content_status: String(studioData.status ?? "unknown"),
    },
    error: null,
  };
}

export async function getMobileOnboardingProgress(): Promise<
  AIApiResult<OnboardingProgress>
> {
  const res = await rawRequest<unknown>("GET", "/api/v1/onboarding-progress");
  if (res.error) return { data: null, error: res.error };
  if (!isOnboardingProgress(res.data)) {
    return {
      data: null,
      error: { status: 0, message: "Unexpected onboarding-progress shape" },
    };
  }
  return { data: res.data, error: null };
}

export interface SubscriberTimelineEvent {
  type: string;
  occurred_at: string;
  subject_id?: string;
  subject?: string;
  campaign_id?: string;
  detail?: Record<string, unknown>;
  source: string;
}
