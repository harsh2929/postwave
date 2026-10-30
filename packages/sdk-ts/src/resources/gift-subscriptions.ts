// SPDX-License-Identifier: MIT
import { Resource } from "./_base.js";

const GIFT_HISTORY_SEARCH_PATTERN = /^[0-9a-f]{8,32}$/iu;
const GIFT_HISTORY_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

function boundedInteger(
  name: "limit" | "offset",
  value: number | undefined,
  minimum: number,
  maximum: number,
): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(
      `Gift history ${name} must be an integer between ${minimum} and ${maximum}`,
    );
  }
  return value;
}

function compactGiftHistorySearch(
  value: string | undefined,
): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new TypeError("Gift history q must be a string");
  }
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const compact = trimmed
    .replace(/^gift record\s+/iu, "")
    .replaceAll("-", "")
    .toLowerCase();
  if (!GIFT_HISTORY_SEARCH_PATTERN.test(compact)) {
    throw new RangeError(
      "Gift history q must be an 8-32 character hexadecimal record prefix",
    );
  }
  return compact;
}

function canonicalGiftHistoryId(value: string): string {
  if (typeof value !== "string") {
    throw new TypeError("Gift history id must be a string");
  }
  if (!GIFT_HISTORY_ID_PATTERN.test(value)) {
    throw new RangeError("Gift history id must be a canonical UUID");
  }
  return value.toLowerCase();
}

export type GiftSubStatus =
  | "pending"
  | "paid"
  | "redeemed"
  | "cancelled"
  | "expired"
  | "refunded"
  | "unclassified";

/**
 * Identity-minimized archive projection. Personal identities, messages,
 * tenant IDs, payment/redemption URLs, provider IDs and subscriber IDs are
 * intentionally absent.
 */
export interface GiftSubscription {
  id: string;
  label: string;
  plan_label: string;
  duration_months: number;
  status: GiftSubStatus;
  created_at: string;
  redeemed_at: string | null;
  expires_at: string | null;
  canceled_at: string | null;
  message_recorded: boolean;
  provider_invoice_linked: boolean;
  gifter_member_linked: boolean;
  recipient_member_linked: boolean;
}

export interface GiftSubscriptionListPage {
  items: GiftSubscription[];
  total: number;
  limit: number;
  offset: number;
  snapshot_at: string;
}

export interface GiftSubscriptionListParams {
  /** Integer page size from 1 through 100. */
  limit?: number;
  /** Integer archive offset from 0 through 10,000. */
  offset?: number;
  /**
   * Opaque 8-32 character hexadecimal record prefix. A copied
   * `Gift record XXXXXXXX` label or hyphenated UUID prefix is accepted and
   * normalized to compact lowercase hexadecimal before transport.
   */
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

/** Read-only access to sanitized historical gift lifecycle evidence. */
export class GiftSubscriptionsResource extends Resource {
  list(
    params: GiftSubscriptionListParams = {},
  ): Promise<GiftSubscriptionListPage> {
    const query = new URLSearchParams();
    const limit = boundedInteger("limit", params.limit, 1, 100);
    const offset = boundedInteger("offset", params.offset, 0, 10_000);
    const search = compactGiftHistorySearch(params.q);
    if (limit !== undefined) query.set("limit", String(limit));
    if (offset !== undefined) query.set("offset", String(offset));
    if (search) query.set("q", search);
    if (params.filter && params.filter !== "all") {
      query.set("filter", params.filter);
    }
    if (params.sort && params.sort !== "newest") {
      query.set("sort", params.sort);
    }
    const encodedQuery = query.toString();
    const suffix = encodedQuery ? `?${encodedQuery}` : "";
    return this.client.request("GET", `/api/v1/gift-subscriptions${suffix}`);
  }

  stats(): Promise<GiftSubscriptionStats> {
    return this.client.request("GET", "/api/v1/gift-subscriptions/stats");
  }

  get(id: string): Promise<GiftSubscription> {
    const giftId = canonicalGiftHistoryId(id);
    return this.client.request(
      "GET",
      `/api/v1/gift-subscriptions/${encodeURIComponent(giftId)}`,
    );
  }
}
