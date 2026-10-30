// Typed client for the retention-cohort engine (apps/api/internal/cohorts),
// mounted at GET /api/v1/cohorts. The backend builds a Mixpanel-style retention
// matrix (signup cohort × weeks-since-signup, value = engaged count) with pure
// SQL — its own doc says "the frontend renders this as the canonical retention
// heatmap", but there was no client. This is that client. Shapes verified
// against internal/cohorts/cohorts.go.
import type { ApiRequester, ApiResult } from "./result";

export type CohortPeriod = "week" | "month";

export interface CohortRow {
  /** First day of the cohort bucket (week or month). */
  cohort_start: string;
  /** Absolute cohort size at acquisition. */
  size: number;
  /** Engaged count per column; length = windows + 1 (col 0 = signup period). */
  engagements: number[];
  /** The same vector normalised to size, 0..100. */
  pcts: number[];
}

export interface CohortMatrix {
  period: CohortPeriod;
  windows: number;
  cohorts: CohortRow[];
  /** Across-all-cohorts average retention curve. */
  average_pcts: number[];
}

// createCohortsApi wires the single mounted cohorts route.
export function createCohortsApi(request: ApiRequester) {
  return {
    // GET /api/v1/cohorts?period=&windows= — the retention matrix. period
    // defaults to "week"; windows is clamped server-side to 1..52.
    getCohorts(period: CohortPeriod = "week", windows = 12): Promise<ApiResult<CohortMatrix>> {
      const q = new URLSearchParams({ period });
      if (windows > 0) q.set("windows", String(windows));
      return request<CohortMatrix>(`/api/v1/cohorts?${q.toString()}`);
    },
  };
}

export type CohortsApi = ReturnType<typeof createCohortsApi>;
