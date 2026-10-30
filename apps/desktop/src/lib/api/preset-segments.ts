import { apiRequest, type ApiResult } from "../api-client";

export interface PresetSegment {
  key: string;
  label: string;
  description: string;
  count: number;
}

export interface PresetSegmentSubscriber {
  id: string;
  email: string;
  created_at: string;
  status: string;
}

export const presetSegmentsApi = {
  /** GET /api/v1/preset-segments -> `{presets, count}`. */
  list(): Promise<ApiResult<{ presets: PresetSegment[]; count: number }>> {
    return apiRequest<{ presets: PresetSegment[]; count: number }>(
      "/api/v1/preset-segments",
    );
  },
  /** GET /api/v1/preset-segments/{key}/list?limit=&offset=. */
  subscribers(
    key: string,
    opts: { limit?: number; offset?: number } = {},
  ): Promise<
    ApiResult<{
      preset: string;
      label: string;
      subscribers: PresetSegmentSubscriber[];
      count: number;
      limit: number;
      offset: number;
    }>
  > {
    const params = new URLSearchParams();
    if (opts.limit != null) params.set("limit", String(opts.limit));
    if (opts.offset != null) params.set("offset", String(opts.offset));
    const qs = params.toString();
    return apiRequest<{
      preset: string;
      label: string;
      subscribers: PresetSegmentSubscriber[];
      count: number;
      limit: number;
      offset: number;
    }>(
      `/api/v1/preset-segments/${encodeURIComponent(key)}/list${qs ? `?${qs}` : ""}`,
    );
  },
};
