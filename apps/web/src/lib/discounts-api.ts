// SPDX-License-Identifier: AGPL-3.0-only
//
// Typed client for the mounted, read-only discount-history boundary.
// Backend: apps/api/internal/discounts/handlers.go. Redeemable codes, tenant
// IDs, provider IDs, subscriber identities, live checks, mutations, and
// exports are deliberately absent. Coupon-pool functions remain explicit
// release holds so dormant callers cannot mistake an unmounted route for an
// empty or successful response.

import { api } from "@/lib/api";

// ---------------------------------------------------------------------------
// Types (mirror the Go projections)
// ---------------------------------------------------------------------------

export type DiscountAppliesTo = "first_payment" | "recurring" | "both";

export interface DiscountHistoryRecord {
  id: string;
  /** Server-authored display label. It never contains the redeemable code. */
  label: string;
  percent_off: number | null;
  amount_off_cents: number | null;
  currency: string;
  max_redemptions: number | null;
  times_redeemed: number;
  expires_at: string | null;
  applies_to: DiscountAppliesTo;
  created_at: string;
  /** Client-derived warnings for readable legacy values outside safe rules. */
  issues: DiscountHistoryIssue[];
}

export type DiscountHistoryIssue =
  | "invalid_benefit"
  | "invalid_currency"
  | "invalid_cap"
  | "invalid_count"
  | "count_exceeds_cap";

export interface DiscountRedemptionEvent {
  redeemed_at: string;
  /** Linkage presence only. The archive never returns a subscriber identity. */
  subscriber_linked: boolean;
}

export interface DiscountRedemptionsPage {
  items: DiscountRedemptionEvent[];
  hasMore: boolean;
}

export interface DiscountHistoryPage {
  items: DiscountHistoryRecord[];
  hasMore: boolean;
}

export interface CouponPool {
  id: string;
  discount_id?: string;
  name: string;
  description: string;
  provider: string;
  code_type: string;
  status: string;
  default_code?: string;
  available_codes: number;
  assigned_codes: number;
  redeemed_codes: number;
  created_at: string;
  updated_at: string;
}

export interface UpsertCouponPoolInput {
  name: string;
  description?: string;
  provider?: string;
  code_type?: string;
  status?: string;
  default_code?: string;
  discount_code?: string;
}

export interface ImportCouponCodesResult {
  pool_id: string;
  seen: number;
  imported: number;
  duplicates: number;
  imported_at: string;
}

// ---------------------------------------------------------------------------
// Discount history
// ---------------------------------------------------------------------------

export async function listDiscountHistory(
  opts: { limit: number; offset: number; recordId?: string } = {
    limit: 50,
    offset: 0,
  },
): Promise<DiscountHistoryPage> {
  const limit = boundedInteger(opts.limit, 1, 100, "limit");
  const offset = boundedInteger(opts.offset, 0, 10_000, "offset");
  const recordIdSupplied = typeof opts.recordId === "string";
  const recordId =
    typeof opts.recordId === "string"
      ? canonicalDiscountRecordId(opts.recordId)
      : null;
  if (recordIdSupplied && !recordId) {
    throw new Error("Discount archive record ID was malformed.");
  }
  const response = await api.get<unknown>("/api/v1/discounts", {
    query: { limit, offset, ...(recordId ? { record_id: recordId } : {}) },
  });
  const source = asRecord(response);
  if (
    !hasOnlyKeys(source, ["items", "has_more"]) ||
    !Array.isArray(source.items) ||
    typeof source.has_more !== "boolean"
  ) {
    throw new Error("Discount history response was malformed.");
  }
  const rows = source.items.map(decodeDiscountHistoryRecord);
  if (
    rows.length > limit ||
    (source.has_more && rows.length !== limit) ||
    rows.some((row) => row === null)
  ) {
    throw new Error("Discount history response contained an invalid row.");
  }
  return {
    items: rows as DiscountHistoryRecord[],
    hasMore: source.has_more,
  };
}

/**
 * One bounded, server-paginated window from the PII-free recent-event
 * timeline. The server returns a bounded `has_more` signal without claiming a
 * total the endpoint does not expose.
 */
export async function listDiscountRedemptionEvents(
  recordId: string,
  opts: { limit: number; offset: number },
): Promise<DiscountRedemptionsPage> {
  const canonicalRecordId = canonicalDiscountRecordId(recordId);
  if (!canonicalRecordId) {
    throw new Error("Discount archive record ID was malformed.");
  }
  const limit = boundedInteger(opts.limit, 1, 100, "limit");
  const offset = boundedInteger(opts.offset, 0, 10_000, "offset");
  const response = await api.get<unknown>(
    `/api/v1/discounts/${encodeURIComponent(canonicalRecordId)}/redemptions`,
    { query: { limit, offset } },
  );
  const source = asRecord(response);
  if (
    !hasOnlyKeys(source, ["items", "has_more"]) ||
    !Array.isArray(source.items) ||
    typeof source.has_more !== "boolean"
  ) {
    throw new Error("Discount event history response was malformed.");
  }
  const normalized = source.items.map(decodeDiscountRedemptionEvent);
  if (
    normalized.length > limit ||
    (source.has_more && normalized.length !== limit) ||
    normalized.some((row) => row === null)
  ) {
    throw new Error(
      "Discount event history response contained an invalid row.",
    );
  }
  const rows = normalized as DiscountRedemptionEvent[];
  return { items: rows, hasMore: source.has_more };
}

// ---------------------------------------------------------------------------
// Coupon pools
// ---------------------------------------------------------------------------

export async function listCouponPools(): Promise<CouponPool[]> {
  throw releaseHeldError(
    "Coupon-pool inventory",
    "The production API does not mount coupon-pool inventory or issuance.",
  );
}

export async function upsertCouponPool(
  _input: UpsertCouponPoolInput,
): Promise<CouponPool> {
  throw releaseHeldError(
    "Coupon-pool changes",
    "The production API does not mount coupon-pool inventory or issuance.",
  );
}

/**
 * Pause / resume / archive a coupon pool (BILL-046). The upsert is keyed on
 * (tenant, name) and DO UPDATE SETs from EXCLUDED, so we must echo the pool's
 * current fields — especially provider, which the backend otherwise defaults
 * back to "postwave" — and change only the status.
 */
export function setCouponPoolStatus(
  pool: CouponPool,
  status: string,
): Promise<CouponPool> {
  return upsertCouponPool({
    name: pool.name,
    description: pool.description,
    provider: pool.provider,
    code_type: pool.code_type,
    default_code: pool.default_code,
    status,
  });
}

// --- Coupon-pool detail: codes, assignments, manual assign (BILL-029) ------
export interface CouponCode {
  id: string;
  pool_id: string;
  code: string;
  status: string;
  subscriber_email?: string;
  assigned_at?: string;
  redeemed_at?: string;
  expires_at?: string;
  created_at: string;
}

export interface CouponPageInfo {
  total?: number;
  limit?: number;
  offset?: number;
  has_more?: boolean;
}

export interface CouponCodesPage {
  items: CouponCode[];
  page_info: CouponPageInfo;
}

export interface CouponAssignment {
  id: string;
  pool_id: string;
  code: string;
  subscriber_email?: string;
  channel?: string;
  surface?: string;
  status: string;
  assigned_at: string;
  redeemed_at?: string;
  expires_at?: string;
}

export interface CouponAssignmentsPage {
  items: CouponAssignment[];
  page_info: CouponPageInfo;
}

export interface CouponAssignmentInput {
  subscriber_email?: string;
  subscriber_id?: string;
  context_key?: string;
  channel?: string;
  surface?: string;
}

export async function getCouponPool(poolId: string): Promise<CouponPool> {
  throw releaseHeldError(
    `Coupon pool ${poolId}`,
    "The production API does not mount coupon-pool inventory or issuance.",
  );
}

export async function listCouponCodes(
  poolId: string,
  _opts: { status?: string; limit?: number; offset?: number } = {},
): Promise<CouponCodesPage> {
  throw releaseHeldError(
    `Codes for coupon pool ${poolId}`,
    "The production API does not mount coupon-pool inventory or issuance.",
  );
}

export async function listCouponAssignments(
  poolId: string,
  _opts: { status?: string; limit?: number; offset?: number } = {},
): Promise<CouponAssignmentsPage> {
  throw releaseHeldError(
    `Assignments for coupon pool ${poolId}`,
    "The production API does not mount coupon-pool inventory or issuance.",
  );
}

export async function assignCoupon(
  poolId: string,
  _input: CouponAssignmentInput,
): Promise<CouponAssignment> {
  throw releaseHeldError(
    `Assignment for coupon pool ${poolId}`,
    "Coupon issuance remains release-held and cannot be simulated by the Web app.",
  );
}

export async function importCouponCodes(
  poolId: string,
  _codes: string[],
): Promise<ImportCouponCodesResult> {
  throw releaseHeldError(
    `Code import for coupon pool ${poolId}`,
    "The production API does not mount coupon-pool inventory or issuance.",
  );
}

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested)
// ---------------------------------------------------------------------------

/** Human label for a discount's value (e.g. "20% off" or "$5.00 off"). */
export function discountValueLabel(d: DiscountHistoryRecord): string {
  if (d.issues.includes("invalid_benefit")) {
    return "Stored benefit needs review";
  }
  if (d.percent_off != null) return `${d.percent_off}% off`;
  if (d.amount_off_cents != null) {
    if (d.currency === "XXX") {
      return `${d.amount_off_cents.toLocaleString()} minor units · currency unavailable`;
    }
    const amount = (d.amount_off_cents / 100).toLocaleString(undefined, {
      style: "currency",
      currency: (d.currency || "usd").toUpperCase(),
    });
    return `${amount} off`;
  }
  return "—";
}

export type DiscountHistoryState =
  | "within_stored_rules"
  | "expired"
  | "cap_reached"
  | "data_issue";

/**
 * Evaluate only the stored local expiry and counter fields. This must never be
 * presented as provider, entitlement, price, or checkout availability.
 */
export function discountHistoryState(
  d: Pick<
    DiscountHistoryRecord,
    "times_redeemed" | "max_redemptions" | "expires_at" | "issues"
  >,
  now: number = Date.now(),
): DiscountHistoryState {
  if (d.issues.length > 0) return "data_issue";
  if (d.expires_at && Date.parse(d.expires_at) <= now) return "expired";
  if (d.max_redemptions != null && d.times_redeemed >= d.max_redemptions) {
    return "cap_reached";
  }
  return "within_stored_rules";
}

export function discountHistoryIssueLabel(issue: DiscountHistoryIssue): string {
  switch (issue) {
    case "invalid_benefit":
      return "Stored benefit is missing or outside supported bounds.";
    case "invalid_currency":
      return "Stored fixed benefit has an invalid currency code.";
    case "invalid_cap":
      return "Stored redemption cap is not a positive whole number.";
    case "invalid_count":
      return "Stored redemption count is invalid.";
    case "count_exceeds_cap":
      return "Stored redemption count exceeds the stored cap.";
  }
}

export function discountAppliesToLabel(value: DiscountAppliesTo): string {
  if (value === "first_payment") return "First payment";
  if (value === "recurring") return "Recurring payments";
  return "First and recurring payments";
}

/** Parses a textarea of coupon codes (one per line / comma-separated) into a
 * deduped, trimmed, upper-cased list. */
export function parseCouponCodes(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const token of raw.split(/[\s,]+/)) {
    const code = token.trim().toUpperCase();
    if (!code || seen.has(code)) continue;
    seen.add(code);
    out.push(code);
  }
  return out;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  const accepted = new Set(allowed);
  return Object.keys(value).every((key) => accepted.has(key));
}

function releaseHeldError(capability: string, detail: string): Error {
  return new Error(`${capability} is release-held. ${detail}`);
}

function safeText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function safeNumber(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
}

const DISCOUNT_RECORD_KEYS = [
  "id",
  "label",
  "percent_off",
  "amount_off_cents",
  "currency",
  "max_redemptions",
  "times_redeemed",
  "expires_at",
  "applies_to",
  "created_at",
] as const;
const DISCOUNT_EVENT_KEYS = ["redeemed_at", "subscriber_linked"] as const;
const OPAQUE_DISCOUNT_RECORD_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const UNSAFE_ARCHIVE_LABEL =
  /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;
const ISO_CURRENCY = /^[a-z]{3}$/iu;
const POSTGRES_INTEGER_MAX = 2_147_483_647;
const POSTGRES_SMALLINT_MAX = 32_767;
const RFC3339_TIMESTAMP =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-](\d{2}):(\d{2}))$/u;
const DISCOUNT_APPLIES_TO = new Set<DiscountAppliesTo>([
  "first_payment",
  "recurring",
  "both",
]);

export function canonicalDiscountRecordId(value: string): string | null {
  if (value.trim() !== value || !OPAQUE_DISCOUNT_RECORD_ID.test(value)) {
    return null;
  }
  return value.toLowerCase();
}

export function isDiscountRecordId(value: string): boolean {
  return canonicalDiscountRecordId(value) !== null;
}

function boundedInteger(
  value: number,
  min: number,
  max: number,
  label: string,
): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${label} must be a whole number from ${min} to ${max}.`);
  }
  return value;
}

function nullableSafeInteger(value: unknown): number | null | undefined {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    return undefined;
  }
  return value;
}

function validTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || value.trim() !== value) return false;
  const match = RFC3339_TIMESTAMP.exec(value);
  if (!match || Number.isNaN(Date.parse(value))) return false;
  const [, year, month, day, hour, minute, second, offsetHour, offsetMinute] =
    match;
  const numericYear = Number(year);
  const numericMonth = Number(month);
  const numericDay = Number(day);
  const daysInMonth = new Date(
    Date.UTC(numericYear, numericMonth, 0),
  ).getUTCDate();
  return (
    numericMonth >= 1 &&
    numericMonth <= 12 &&
    numericDay >= 1 &&
    numericDay <= daysInMonth &&
    Number(hour) <= 23 &&
    Number(minute) <= 59 &&
    Number(second) <= 59 &&
    (offsetHour === undefined || Number(offsetHour) <= 23) &&
    (offsetMinute === undefined || Number(offsetMinute) <= 59)
  );
}

/** Strict decoder for the only discount projection allowed into the Web UI. */
export function decodeDiscountHistoryRecord(
  value: unknown,
): DiscountHistoryRecord | null {
  const row = asRecord(value);
  if (!hasOnlyKeys(row, DISCOUNT_RECORD_KEYS)) return null;

  const id = typeof row.id === "string" ? row.id : "";
  const label = typeof row.label === "string" ? row.label : "";
  const currency = typeof row.currency === "string" ? row.currency : "";
  const canonicalID = canonicalDiscountRecordId(id);
  const rawPercentOff = nullableSafeInteger(row.percent_off);
  const rawAmountOff = nullableSafeInteger(row.amount_off_cents);
  const rawMaxRedemptions = nullableSafeInteger(row.max_redemptions);
  const expiresAt =
    row.expires_at === null || row.expires_at === undefined
      ? null
      : validTimestamp(row.expires_at)
        ? row.expires_at
        : undefined;
  const appliesTo = row.applies_to;

  if (
    !canonicalID ||
    label.trim() !== label ||
    !label ||
    label.length > 128 ||
    UNSAFE_ARCHIVE_LABEL.test(label) ||
    currency.trim() !== currency ||
    !currency ||
    currency.length > 12 ||
    UNSAFE_ARCHIVE_LABEL.test(currency) ||
    rawPercentOff === undefined ||
    rawAmountOff === undefined ||
    rawMaxRedemptions === undefined ||
    (rawPercentOff !== null &&
      Math.abs(rawPercentOff) > POSTGRES_SMALLINT_MAX) ||
    (rawAmountOff !== null && Math.abs(rawAmountOff) > POSTGRES_INTEGER_MAX) ||
    (rawMaxRedemptions !== null &&
      Math.abs(rawMaxRedemptions) > POSTGRES_INTEGER_MAX) ||
    typeof row.times_redeemed !== "number" ||
    !Number.isSafeInteger(row.times_redeemed) ||
    Math.abs(row.times_redeemed) > POSTGRES_INTEGER_MAX ||
    expiresAt === undefined ||
    typeof appliesTo !== "string" ||
    !DISCOUNT_APPLIES_TO.has(appliesTo as DiscountAppliesTo) ||
    !validTimestamp(row.created_at)
  ) {
    return null;
  }

  const issues: DiscountHistoryIssue[] = [];
  const percentOff =
    rawPercentOff !== null && rawPercentOff >= 1 && rawPercentOff <= 100
      ? rawPercentOff
      : null;
  const amountOff =
    rawAmountOff !== null && rawAmountOff >= 1 ? rawAmountOff : null;
  if (
    (rawPercentOff !== null && percentOff === null) ||
    (rawAmountOff !== null && amountOff === null) ||
    (percentOff === null) === (amountOff === null)
  ) {
    issues.push("invalid_benefit");
  }
  const validCurrency =
    ISO_CURRENCY.test(currency) && currency.toUpperCase() !== "XXX";
  if (amountOff !== null && !validCurrency) issues.push("invalid_currency");
  const maxRedemptions =
    rawMaxRedemptions !== null && rawMaxRedemptions >= 1
      ? rawMaxRedemptions
      : null;
  if (rawMaxRedemptions !== null && maxRedemptions === null) {
    issues.push("invalid_cap");
  }
  const timesRedeemed = row.times_redeemed >= 0 ? row.times_redeemed : 0;
  if (row.times_redeemed < 0) issues.push("invalid_count");
  if (maxRedemptions !== null && timesRedeemed > maxRedemptions) {
    issues.push("count_exceeds_cap");
  }

  return {
    id: canonicalID,
    label,
    currency: validCurrency ? currency.toUpperCase() : "XXX",
    percent_off: percentOff,
    amount_off_cents: amountOff,
    max_redemptions: maxRedemptions,
    times_redeemed: timesRedeemed,
    expires_at: expiresAt,
    applies_to: appliesTo as DiscountAppliesTo,
    created_at: row.created_at,
    issues,
  };
}

/** Strict PII-free decoder. Any added identity field fails the whole page. */
export function decodeDiscountRedemptionEvent(
  value: unknown,
): DiscountRedemptionEvent | null {
  const row = asRecord(value);
  if (
    !hasOnlyKeys(row, DISCOUNT_EVENT_KEYS) ||
    !validTimestamp(row.redeemed_at) ||
    typeof row.subscriber_linked !== "boolean"
  ) {
    return null;
  }
  return {
    redeemed_at: row.redeemed_at,
    subscriber_linked: row.subscriber_linked,
  };
}

export function normalizeCouponPool(value: unknown): CouponPool | null {
  const row = asRecord(value);
  const id = safeText(row.id);
  const name = safeText(row.name);
  if (!id || !name) return null;
  return {
    id,
    ...(safeText(row.discount_id)
      ? { discount_id: safeText(row.discount_id) }
      : {}),
    name,
    description: safeText(row.description),
    provider: safeText(row.provider) || "postwave",
    code_type: safeText(row.code_type) || "imported",
    status: safeText(row.status) || "draft",
    ...(safeText(row.default_code)
      ? { default_code: safeText(row.default_code) }
      : {}),
    available_codes: safeNumber(row.available_codes),
    assigned_codes: safeNumber(row.assigned_codes),
    redeemed_codes: safeNumber(row.redeemed_codes),
    created_at: safeText(row.created_at),
    updated_at: safeText(row.updated_at),
  };
}

function normalizePageInfo(value: unknown): CouponPageInfo {
  const row = asRecord(value);
  return {
    ...(Number.isFinite(Number(row.total))
      ? { total: safeNumber(row.total) }
      : {}),
    ...(Number.isFinite(Number(row.limit))
      ? { limit: safeNumber(row.limit) }
      : {}),
    ...(Number.isFinite(Number(row.offset))
      ? { offset: safeNumber(row.offset) }
      : {}),
    ...(typeof row.has_more === "boolean" ? { has_more: row.has_more } : {}),
  };
}

export function normalizeCouponCodesPage(value: unknown): CouponCodesPage {
  const source = asRecord(value);
  if (!Array.isArray(source.items)) {
    throw new Error("Coupon-code list response was malformed.");
  }
  const rows = source.items.map((value) => {
    const row = asRecord(value);
    if (!safeText(row.id) || !safeText(row.code)) return null;
    return {
      id: safeText(row.id),
      pool_id: safeText(row.pool_id),
      code: safeText(row.code),
      status: safeText(row.status) || "unknown",
      ...(safeText(row.subscriber_email)
        ? { subscriber_email: safeText(row.subscriber_email) }
        : {}),
      ...(safeText(row.assigned_at)
        ? { assigned_at: safeText(row.assigned_at) }
        : {}),
      ...(safeText(row.redeemed_at)
        ? { redeemed_at: safeText(row.redeemed_at) }
        : {}),
      ...(safeText(row.expires_at)
        ? { expires_at: safeText(row.expires_at) }
        : {}),
      created_at: safeText(row.created_at),
    } satisfies CouponCode;
  });
  if (rows.some((row) => row === null)) {
    throw new Error("Coupon-code list response contained an invalid row.");
  }
  return {
    items: rows as CouponCode[],
    page_info: normalizePageInfo(source.page_info),
  };
}

export function normalizeCouponAssignmentsPage(
  value: unknown,
): CouponAssignmentsPage {
  const source = asRecord(value);
  if (!Array.isArray(source.items)) {
    throw new Error("Coupon-assignment list response was malformed.");
  }
  const rows = source.items.map((value) => {
    const row = asRecord(value);
    if (!safeText(row.id) || !safeText(row.code)) return null;
    return {
      id: safeText(row.id),
      pool_id: safeText(row.pool_id),
      code: safeText(row.code),
      ...(safeText(row.subscriber_email)
        ? { subscriber_email: safeText(row.subscriber_email) }
        : {}),
      ...(safeText(row.channel) ? { channel: safeText(row.channel) } : {}),
      ...(safeText(row.surface) ? { surface: safeText(row.surface) } : {}),
      status: safeText(row.status) || "unknown",
      assigned_at: safeText(row.assigned_at),
      ...(safeText(row.redeemed_at)
        ? { redeemed_at: safeText(row.redeemed_at) }
        : {}),
      ...(safeText(row.expires_at)
        ? { expires_at: safeText(row.expires_at) }
        : {}),
    } satisfies CouponAssignment;
  });
  if (rows.some((row) => row === null)) {
    throw new Error(
      "Coupon-assignment list response contained an invalid row.",
    );
  }
  return {
    items: rows as CouponAssignment[],
    page_info: normalizePageInfo(source.page_info),
  };
}
