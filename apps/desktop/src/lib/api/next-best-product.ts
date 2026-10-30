// Typed client for the Next-Best-Product (nbp) recommender — the item-item
// collaborative-filtering engine mounted at /api/v1/nbp/* (apps/api/internal/nbp).
// G-26/G-54: the engine runs (builder worker + recommend endpoint) but had no UI
// consumer; this is the client layer the Personalization > Recommendations panel
// drives. Shapes verified against apps/api/internal/nbp/types.go + handlers.go.
import type { ApiResult } from "./result";

export type NextBestProductRequester = <T>(
  path: string,
  init?: RequestInit,
) => Promise<ApiResult<T>>;

// The strategy the recommender used, matching Go's nbp.Strategy exactly
// (internal/nbp/types.go): item-item cosine CF (the default), catalog-popularity
// cold-start, or a per-subscriber cold-start fallback. Only item_item_cf and
// popularity are selectable as the refresher_strategy.
export type NbpStrategy = "item_item_cf" | "popularity" | "cold_start_fallback";

export interface NbpRecommendation {
  product_id: string;
  title?: string;
  url?: string;
  image_url?: string;
  price_cents?: number;
  currency?: string;
  score: number;
  strategy: NbpStrategy;
  // Products in the subscriber's history that drove this recommendation
  // ("because you bought X").
  anchors?: string[];
}

export interface NbpRecommendResponse {
  items: NbpRecommendation[];
  subscriber_id: string;
  // The Liquid helper name the compose editor uses to render recommendations.
  helper_name: string;
}

export interface NbpSettings {
  enabled: boolean;
  recency_exclude_days: number;
  top_n_per_user: number;
  similarity_floor: number;
  refresher_strategy: NbpStrategy;
  refresh_interval_hours: number;
  bloom_target_fpr: number;
  similarity_computed_at?: string;
  affinity_computed_at?: string;
  model_version: number;
  strategy_available: boolean;
}

export interface NbpSyntaxExample {
  helper_name: string;
  example: string;
}

// createNextBestProductApi wires typed methods over the mounted nbp routes.
export function createNextBestProductApi(request: NextBestProductRequester) {
  return {
    // GET /api/v1/nbp/settings — the recommender configuration for the tenant.
    getSettings(): Promise<ApiResult<NbpSettings>> {
      return request<NbpSettings>("/api/v1/nbp/settings");
    },

    // PUT /api/v1/nbp/settings — update the recommender configuration (admin).
    updateSettings(patch: Partial<NbpSettings>): Promise<ApiResult<NbpSettings>> {
      return request<NbpSettings>("/api/v1/nbp/settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      });
    },

    // GET /api/v1/nbp/recommend — top recommendations for one subscriber. limit
    // is clamped server-side to [1,24]; the compose preview renders items[].
    recommend(
      subscriberId: string,
      limit?: number,
    ): Promise<ApiResult<NbpRecommendResponse>> {
      const q = new URLSearchParams({ subscriber_id: subscriberId });
      if (limit && limit > 0) q.set("limit", String(limit));
      return request<NbpRecommendResponse>(`/api/v1/nbp/recommend?${q.toString()}`);
    },

    // GET /api/v1/nbp/syntax-example — the Liquid snippet the compose UI shows.
    syntaxExample(): Promise<ApiResult<NbpSyntaxExample>> {
      return request<NbpSyntaxExample>("/api/v1/nbp/syntax-example");
    },
  };
}

export type NextBestProductApi = ReturnType<typeof createNextBestProductApi>;
