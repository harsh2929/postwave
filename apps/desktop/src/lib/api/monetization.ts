import type { ApiRequester, ApiResult } from "./result";

const GIFT_RECORD_PREFIX = /^[0-9a-f]{8,32}$/u;

export type DiscountAppliesTo = "first_payment" | "recurring" | "both";

export interface DiscountHistoryWireRecord {
  id: string;
  /** Server-authored archive label; never the redeemable code. */
  label: string;
  percent_off?: number | null;
  amount_off_cents?: number | null;
  currency: string;
  max_redemptions?: number | null;
  times_redeemed: number;
  expires_at?: string | null;
  applies_to: DiscountAppliesTo;
  created_at: string;
}

export interface DiscountsResponse {
  items?: DiscountHistoryWireRecord[];
  data?: DiscountHistoryWireRecord[];
  results?: DiscountHistoryWireRecord[];
}

export interface DiscountHistoryEvent {
  /** The archive exposes linkage presence, never subscriber identity. */
  subscriber_linked: boolean;
  redeemed_at: string;
}

export interface DiscountRedemptionsResponse {
  items?: DiscountHistoryEvent[];
  data?: DiscountHistoryEvent[];
  results?: DiscountHistoryEvent[];
}

export interface GiftHistoryWireRecord {
  id: string;
  /** Server-authored label; never a purchaser, recipient, token, or code. */
  label: string;
  /** Server-authored display label; raw provider price IDs are withheld. */
  plan_label: string;
  duration_months: number;
  status: string;
  created_at: string;
  redeemed_at?: string | null;
  expires_at?: string | null;
  canceled_at?: string | null;
  message_recorded: boolean;
  provider_invoice_linked: boolean;
  gifter_member_linked: boolean;
  recipient_member_linked: boolean;
}

export interface GiftSubscriptionStats {
  total: number;
  pending: number;
  paid: number;
  granted: number;
  canceled: number;
  expired: number;
  refunded: number;
  conversionRate: number;
  generated_at: string;
}

export interface GiftHistoryPageResponse {
  items: GiftHistoryWireRecord[];
  total: number;
  limit: number;
  offset: number;
  snapshot_at: string;
}

export interface GiftHistoryListOptions {
  limit?: number;
  offset?: number;
  q?: string;
  filter?:
    | "all"
    | "open"
    | "pending"
    | "redeemed"
    | "closed"
    | "cancelled"
    | "expired"
    | "refunded";
  sort?: "newest" | "oldest" | "duration" | "status";
}

export interface DiscountsAndGiftsApi {
  listDiscounts(): Promise<ApiResult<DiscountsResponse>>;
  listDiscountRedemptions(
    recordID: string,
    opts?: { limit?: number; offset?: number },
  ): Promise<ApiResult<DiscountRedemptionsResponse>>;
  listGiftSubscriptions(
    opts?: GiftHistoryListOptions,
  ): Promise<ApiResult<GiftHistoryPageResponse>>;
  getGiftSubscriptionStats(): Promise<ApiResult<GiftSubscriptionStats>>;
  getGiftSubscription(id: string): Promise<ApiResult<GiftHistoryWireRecord>>;
}

/** Build the monetization method bag against the facade's shared transport. */
export function createMonetizationApi(
  request: ApiRequester,
): DiscountsAndGiftsApi {
  return {
    listDiscounts() {
      return request<DiscountsResponse>("/api/v1/discounts");
    },
    listDiscountRedemptions(recordID, opts = {}) {
      const params = new URLSearchParams();
      if (typeof opts.limit === "number") {
        params.set("limit", String(opts.limit));
      }
      if (typeof opts.offset === "number") {
        params.set("offset", String(opts.offset));
      }
      const query = params.toString();
      return request<DiscountRedemptionsResponse>(
        `/api/v1/discounts/${encodeURIComponent(recordID)}/redemptions${query ? `?${query}` : ""}`,
      );
    },
    listGiftSubscriptions(opts = {}) {
      const params = new URLSearchParams();
      if (typeof opts.limit === "number") {
        params.set(
          "limit",
          String(Math.min(100, Math.max(1, Math.trunc(opts.limit)))),
        );
      }
      if (typeof opts.offset === "number") {
        params.set(
          "offset",
          String(Math.min(10_000, Math.max(0, Math.trunc(opts.offset)))),
        );
      }
      if (opts.q) {
        const prefix = opts.q.trim().toLocaleLowerCase();
        if (GIFT_RECORD_PREFIX.test(prefix)) {
          params.set("q", prefix);
        }
      }
      if (opts.filter && opts.filter !== "all") {
        params.set("filter", opts.filter);
      }
      if (opts.sort && opts.sort !== "newest") {
        params.set("sort", opts.sort);
      }
      const query = params.toString();
      return request<GiftHistoryPageResponse>(
        `/api/v1/gift-subscriptions${query ? `?${query}` : ""}`,
      );
    },
    getGiftSubscriptionStats() {
      return request<GiftSubscriptionStats>("/api/v1/gift-subscriptions/stats");
    },
    getGiftSubscription(id) {
      return request<GiftHistoryWireRecord>(
        `/api/v1/gift-subscriptions/${encodeURIComponent(id)}`,
      );
    },
  };
}
