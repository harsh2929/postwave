import { apiRequest, type ApiResult } from "../api-client";

export interface InactiveKeyAlert {
  id: string;
  label: string;
  prefix: string;
  actor_type: string;
  created_at: string;
  last_used_at?: string | null;
  days_since_last_use: number;
  never_used: boolean;
  /** 'warn' | 'high' | 'critical' */
  severity: string;
}

export const inactiveKeysApi = {
  /** GET /api/v1/inactive-keys?days= (admin) -> `{threshold_days, keys, count}`. */
  list(thresholdDays?: number): Promise<
    ApiResult<{
      threshold_days: number;
      keys: InactiveKeyAlert[];
      count: number;
    }>
  > {
    const qs = thresholdDays != null ? `?days=${thresholdDays}` : "";
    return apiRequest<{
      threshold_days: number;
      keys: InactiveKeyAlert[];
      count: number;
    }>(`/api/v1/inactive-keys${qs}`);
  },
};
