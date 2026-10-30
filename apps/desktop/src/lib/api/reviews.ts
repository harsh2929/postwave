import type { ApiResult } from "./result";

interface NativeFacadeRequestOptions {
  timeoutMs?: number;
  maxAttempts?: number;
  requireOnline?: boolean;
  signal?: AbortSignal;
}

type ReviewsRequester = <T>(
  path: string,
  init?: RequestInit,
  opts?: NativeFacadeRequestOptions,
) => Promise<ApiResult<T>>;

/* ---------- KLV-11 Reviews (reviews) -------------------------------- */

/** A public reply attached to a review (reviews.PublicReply). */
export interface ReviewPublicReply {
  id?: string;
  tenant_id?: string;
  review_id?: string;
  author?: string;
  body: string;
  status: string;
  metadata?: Record<string, unknown>;
  created_at?: string;
  updated_at?: string;
}

/** A product/store review (reviews.Review), field names 1:1 with Go tags. */
export interface Review {
  id: string;
  tenant_id?: string;
  product_id?: string;
  variant_id?: string;
  request_id?: string;
  order_id?: string;
  customer_id?: string;
  source_platform?: string;
  source_ref?: string;
  review_type?: string;
  reviewer_name?: string;
  reviewer_email?: string;
  rating: number;
  title?: string;
  body?: string;
  /** pending | approved | rejected | spam | archived */
  status: string;
  verified_buyer: boolean;
  incentivized: boolean;
  featured: boolean;
  moderation_reason?: string;
  submitted_at?: string;
  published_at?: string | null;
  moderated_at?: string | null;
  metadata?: Record<string, unknown>;
  raw_payload?: Record<string, unknown>;
  created_at?: string;
  updated_at?: string;
  public_replies?: ReviewPublicReply[];
}

/** Per-product rating rollup (reviews.Summary). */
export interface ReviewSummary {
  product_id?: string;
  average_rating: number;
  rating_counts: Record<string, number>;
  approved_count?: number;
  rating_sum?: number;
}

/** A storefront review widget (reviews.Widget). */
export interface ReviewWidget {
  id: string;
  tenant_id?: string;
  slug?: string;
  name: string;
  status: string;
  widget_type: string;
  product_filter?: Record<string, unknown>;
  display_settings?: Record<string, unknown>;
  moderation_settings?: Record<string, unknown>;
  language?: string;
  styling?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  public_url?: string;
  created_at?: string;
  updated_at?: string;
}

/** GET /api/v1/reviews/catalog — descriptor of allowed enum values. */
export interface ReviewsCatalog {
  statuses: string[];
  widget_types: string[];
  review_types?: string[];
  [k: string]: unknown;
}

interface ReviewsReadOptions {
  signal?: AbortSignal;
}

function nativeReadOptions(
  signal: AbortSignal | undefined,
): NativeFacadeRequestOptions | undefined {
  return signal ? { signal } : undefined;
}

export function createReviewsApi(request: ReviewsRequester) {
  return {
    /** GET /api/v1/reviews/catalog — status / widget-type / review-type enums. */
    catalog(opts: ReviewsReadOptions = {}): Promise<ApiResult<ReviewsCatalog>> {
      return request<ReviewsCatalog>(
        "/api/v1/reviews/catalog",
        undefined,
        nativeReadOptions(opts.signal),
      );
    },
    /** GET /api/v1/reviews?status=&product_id= → `{items}`. */
    list(
      opts: {
        status?: string;
        productId?: string;
        signal?: AbortSignal;
      } = {},
    ): Promise<ApiResult<{ items: Review[] }>> {
      const params = new URLSearchParams();
      if (opts.status) params.set("status", opts.status);
      if (opts.productId) params.set("product_id", opts.productId);
      const qs = params.toString();
      return request<{ items: Review[] }>(
        `/api/v1/reviews${qs ? `?${qs}` : ""}`,
        undefined,
        nativeReadOptions(opts.signal),
      );
    },
    /** GET /api/v1/reviews/{id}. */
    get(id: string, opts: ReviewsReadOptions = {}): Promise<ApiResult<Review>> {
      return request<Review>(
        `/api/v1/reviews/${encodeURIComponent(id)}`,
        undefined,
        nativeReadOptions(opts.signal),
      );
    },
    /** PATCH /api/v1/reviews/{id} — featured/status/moderation_reason (admin). */
    update(id: string, patch: Partial<Review>): Promise<ApiResult<Review>> {
      return request<Review>(`/api/v1/reviews/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: JSON.stringify(patch),
      });
    },
    /** POST /api/v1/reviews/{id}/approve (admin). */
    approve(id: string): Promise<ApiResult<Review>> {
      return request<Review>(
        `/api/v1/reviews/${encodeURIComponent(id)}/approve`,
        { method: "POST", body: "{}" },
      );
    },
    /** POST /api/v1/reviews/{id}/reject (admin). */
    reject(id: string): Promise<ApiResult<Review>> {
      return request<Review>(
        `/api/v1/reviews/${encodeURIComponent(id)}/reject`,
        {
          method: "POST",
          body: "{}",
        },
      );
    },
    /** POST /api/v1/reviews/{id}/reply — public reply (admin). */
    reply(id: string, body: string): Promise<ApiResult<ReviewPublicReply>> {
      return request<ReviewPublicReply>(
        `/api/v1/reviews/${encodeURIComponent(id)}/reply`,
        { method: "POST", body: JSON.stringify({ body }) },
      );
    },
    /** GET /api/v1/reviews/products/{productId}/summary. */
    productSummary(
      productId: string,
      opts: ReviewsReadOptions = {},
    ): Promise<ApiResult<ReviewSummary>> {
      return request<ReviewSummary>(
        `/api/v1/reviews/products/${encodeURIComponent(productId)}/summary`,
        undefined,
        nativeReadOptions(opts.signal),
      );
    },
    /** GET /api/v1/reviews/widgets → `{items}`. */
    listWidgets(
      opts: ReviewsReadOptions = {},
    ): Promise<ApiResult<{ items: ReviewWidget[] }>> {
      return request<{ items: ReviewWidget[] }>(
        "/api/v1/reviews/widgets",
        undefined,
        nativeReadOptions(opts.signal),
      );
    },
    /** POST /api/v1/reviews/widgets (admin). */
    createWidget(input: {
      name: string;
      widget_type: string;
      language?: string;
    }): Promise<ApiResult<ReviewWidget>> {
      return request<ReviewWidget>("/api/v1/reviews/widgets", {
        method: "POST",
        body: JSON.stringify(input),
      });
    },
    /** GET /api/v1/reviews/widgets/{id}/embed/{flavor} → `{flavor, snippet}`. */
    widgetEmbed(
      id: string,
      flavor: string,
      opts: ReviewsReadOptions = {},
    ): Promise<ApiResult<{ flavor: string; snippet: string }>> {
      return request<{ flavor: string; snippet: string }>(
        `/api/v1/reviews/widgets/${encodeURIComponent(id)}/embed/${encodeURIComponent(flavor)}`,
        undefined,
        nativeReadOptions(opts.signal),
      );
    },
  };
}
