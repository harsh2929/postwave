// SPDX-License-Identifier: MIT
import { Resource } from "./_base.js";

export type AppliesTo = "first_payment" | "recurring" | "both";

/**
 * Sanitized local-history projection. Redeemable codes, tenant identifiers,
 * provider identifiers, and subscriber identities are deliberately absent.
 * This record is historical evidence, not provider or checkout truth.
 */
export interface Discount {
  id: string;
  label: string;
  percent_off?: number | null;
  amount_off_cents?: number | null;
  currency: string;
  max_redemptions?: number | null;
  times_redeemed: number;
  expires_at?: string | null;
  applies_to: AppliesTo;
  created_at: string;
}

export interface DiscountListPage {
  items: Discount[];
  has_more: boolean;
}

export interface DiscountListParams {
  /** Exact opaque discount record UUID; never a redeemable code. */
  record_id?: string;
  /** Integer page size from 1 through 100; server default 50. */
  limit?: number;
  /** Archive offset from 0 through 10,000; server default 0. */
  offset?: number;
}

/** PII-free event returned for one opaque discount record. */
export interface DiscountRedemptionEvent {
  redeemed_at: string;
  subscriber_linked: boolean;
}

export interface DiscountRedemptionsPage {
  items: DiscountRedemptionEvent[];
  has_more: boolean;
}

export interface DiscountRedemptionsParams {
  /** Integer page size from 1 through 100; server default 50. */
  limit?: number;
  /** Archive offset from 0 through 10,000; server default 0. */
  offset?: number;
}

const DISCOUNT_RECORD_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

function canonicalRecordId(value: string): string {
  if (typeof value !== "string") {
    throw new TypeError("Discount history record_id must be a string");
  }
  if (!DISCOUNT_RECORD_ID_PATTERN.test(value)) {
    throw new RangeError("Discount history record_id must be a canonical UUID");
  }
  return value.toLowerCase();
}

function boundedInteger(
  name: "limit" | "offset",
  value: number | undefined,
  minimum: number,
  maximum: number,
): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(
      `Discount history ${name} must be an integer between ${minimum} and ${maximum}`,
    );
  }
  return value;
}

/**
 * Read-only access to sanitized, tenant-scoped discount history. Live code
 * checks, exports, and mutations are not part of the production contract.
 */
export class DiscountsResource extends Resource {
  list(params: DiscountListParams = {}): Promise<DiscountListPage> {
    const recordId =
      params.record_id === undefined
        ? undefined
        : canonicalRecordId(params.record_id);
    const suffix = pageQuery(params, recordId);
    return this.client.request("GET", `/api/v1/discounts${suffix}`);
  }

  redemptions(
    recordId: string,
    params: DiscountRedemptionsParams = {},
  ): Promise<DiscountRedemptionsPage> {
    const id = canonicalRecordId(recordId);
    const suffix = pageQuery(params);
    return this.client.request(
      "GET",
      `/api/v1/discounts/${encodeURIComponent(id)}/redemptions${suffix}`,
    );
  }
}

function pageQuery(
  params: DiscountListParams | DiscountRedemptionsParams,
  recordId?: string,
): string {
  const limit = boundedInteger("limit", params.limit, 1, 100);
  const offset = boundedInteger("offset", params.offset, 0, 10_000);
  const query = new URLSearchParams();
  if (recordId !== undefined) query.set("record_id", recordId);
  if (limit !== undefined) query.set("limit", String(limit));
  if (offset !== undefined) query.set("offset", String(offset));
  const encodedQuery = query.toString();
  return encodedQuery ? `?${encodedQuery}` : "";
}
