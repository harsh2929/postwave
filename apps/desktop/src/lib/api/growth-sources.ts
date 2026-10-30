import { apiRequest, type ApiResult } from "../api-client";

export interface GrowthSourceBucket {
  consent_source: string;
  source_platform: string;
  count: number;
}

export interface GrowthSourceSummaryResponse {
  window_days: number;
  since: string;
  sources: GrowthSourceBucket[];
  total_new_subs: number;
}

export interface GrowthSourceTimeseriesResponse {
  window_days: number;
  points: Array<{ date: string; consent_source: string; count: number }>;
}

export interface GrowthSourceQualityRow {
  consent_source: string;
  total_subscribers: number;
  engaged: number;
  bounced: number;
  complained: number;
  engagement_rate: number;
  bounce_rate: number;
  complaint_rate: number;
}

export interface GrowthSourceQualityResponse {
  window_days: number;
  sources: GrowthSourceQualityRow[];
}

export const growthSourcesApi = {
  /** GET /api/v1/growth-source/summary?days=. */
  summary(days?: number): Promise<ApiResult<GrowthSourceSummaryResponse>> {
    const qs = days != null ? `?days=${days}` : "";
    return apiRequest<GrowthSourceSummaryResponse>(
      `/api/v1/growth-source/summary${qs}`,
    );
  },
  /** GET /api/v1/growth-source/timeseries?days=. */
  timeseries(
    days?: number,
  ): Promise<ApiResult<GrowthSourceTimeseriesResponse>> {
    const qs = days != null ? `?days=${days}` : "";
    return apiRequest<GrowthSourceTimeseriesResponse>(
      `/api/v1/growth-source/timeseries${qs}`,
    );
  },
  /** GET /api/v1/growth-source/quality?days=. */
  quality(days?: number): Promise<ApiResult<GrowthSourceQualityResponse>> {
    const qs = days != null ? `?days=${days}` : "";
    return apiRequest<GrowthSourceQualityResponse>(
      `/api/v1/growth-source/quality${qs}`,
    );
  },
};
