/** Import-free, fail-closed parsing for the privacy-minimized Gift archive. */

export type GiftHistoryStatus =
  | "pending"
  | "paid"
  | "redeemed"
  | "cancelled"
  | "expired"
  | "refunded"
  | "unclassified";

export type GiftHistoryFilter =
  | "all"
  | "open"
  | "pending"
  | "redeemed"
  | "closed"
  | "cancelled"
  | "expired"
  | "refunded";

export type GiftHistorySort = "newest" | "oldest" | "duration" | "status";

export interface GiftHistoryRecord {
  /** Opaque route key. It is never rendered or copied to the clipboard. */
  id: string;
  label: string;
  planLabel: string;
  durationMonths: number | null;
  status: GiftHistoryStatus;
  createdAt: string | null;
  redeemedAt: string | null;
  expiresAt: string | null;
  canceledAt: string | null;
  messageRecorded: boolean | null;
  providerInvoiceLinked: boolean | null;
  gifterMemberLinked: boolean | null;
  recipientMemberLinked: boolean | null;
  issues: readonly string[];
}

export interface GiftHistoryPage {
  items: GiftHistoryRecord[];
  total: number;
  limit: number;
  offset: number;
  snapshotAt: string | null;
  rejectedRows: number;
  envelopeIssues: readonly string[];
  recognized: boolean;
}

export interface GiftHistoryStats {
  total: number;
  pending: number;
  paid: number;
  redeemed: number;
  cancelled: number;
  expired: number;
  refunded: number;
  unclassified: number;
  conversionRate: number;
  generatedAt: string | null;
  issues: readonly string[];
}

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SAFE_TEXT =
  /^[^\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]+$/u;
const UNSAFE_QUERY_TEXT =
  /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu;
const GIFT_RECORD_PREFIX = /^[0-9a-f]{8,32}$/u;
const MAX_GIFT_HISTORY_PAGE_SIZE = 100;
const MAX_GIFT_HISTORY_OFFSET = 10_000;
const SENSITIVE_WIRE_FIELDS = [
  "tenant_id",
  "purchaser_email",
  "recipient_email",
  "message",
  "stripe_invoice_id",
  "stripe_payment_url",
  "redemption_url",
  "cancel_reason",
  "gifter_subscriber_id",
  "gifter_attribution_token",
  "redeemed_by_subscriber_id",
] as const;

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function integer(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    Number.isInteger(value)
    ? value
    : null;
}

function displayText(
  value: unknown,
  fallback: string,
  field: string,
  issues: string[],
): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) {
    issues.push(`${field} is missing.`);
    return fallback;
  }
  if (text.length > 128 || !SAFE_TEXT.test(text)) {
    issues.push(`${field} is not safe display text.`);
    return fallback;
  }
  return text;
}

function timestamp(
  value: unknown,
  field: string,
  issues: string[],
): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    issues.push(`${field} timestamp is invalid.`);
    return null;
  }
  return value;
}

function evidence(
  value: unknown,
  field: string,
  issues: string[],
): boolean | null {
  if (typeof value !== "boolean") {
    issues.push(`${field} evidence is missing or invalid.`);
    return null;
  }
  return value;
}

export function giftHistoryStatus(value: unknown): GiftHistoryStatus {
  const status =
    typeof value === "string" ? value.trim().toLocaleLowerCase() : "";
  switch (status) {
    case "pending":
      return "pending";
    case "paid":
      return "paid";
    case "granted":
    case "redeemed":
    case "active":
      return "redeemed";
    case "canceled":
    case "cancelled":
      return "cancelled";
    case "expired":
      return "expired";
    case "refunded":
      return "refunded";
    default:
      return "unclassified";
  }
}

export function isGiftHistoryID(value: string): boolean {
  return UUID.test(value.trim());
}

function lifecycleIssues(record: GiftHistoryRecord, issues: string[]): void {
  if (record.status === "redeemed" && !record.redeemedAt) {
    issues.push("Redeemed status has no redemption timestamp.");
  }
  if (record.status === "cancelled" && !record.canceledAt) {
    issues.push("Cancelled status has no cancellation timestamp.");
  }
  if (
    (record.status === "pending" || record.status === "paid") &&
    (record.redeemedAt || record.canceledAt)
  ) {
    issues.push("Open status conflicts with a terminal timestamp.");
  }
  if (
    record.createdAt &&
    record.redeemedAt &&
    Date.parse(record.redeemedAt) < Date.parse(record.createdAt)
  ) {
    issues.push("Redemption precedes creation.");
  }
  if (
    record.createdAt &&
    record.canceledAt &&
    Date.parse(record.canceledAt) < Date.parse(record.createdAt)
  ) {
    issues.push("Cancellation precedes creation.");
  }
}

export function normalizeGiftHistoryRecord(
  raw: unknown,
  index = 0,
): GiftHistoryRecord | null {
  const row = object(raw);
  if (!row) return null;
  const issues: string[] = [];
  const id = typeof row["id"] === "string" ? row["id"].trim() : "";
  if (!UUID.test(id)) {
    // A detail read cannot be safely addressed without an opaque UUID.
    return null;
  }
  for (const field of SENSITIVE_WIRE_FIELDS) {
    if (field in row) {
      issues.push(`Sensitive field "${field}" crossed the archive boundary.`);
    }
  }
  const rawDuration = integer(row["duration_months"]);
  const durationMonths =
    rawDuration !== null && rawDuration >= 1 && rawDuration <= 60
      ? rawDuration
      : null;
  if (durationMonths === null) {
    issues.push("Duration is outside the supported 1–60 month range.");
  }
  const status = giftHistoryStatus(row["status"]);
  if (status === "unclassified") {
    issues.push("Lifecycle status is missing or unsupported.");
  }
  const record: GiftHistoryRecord = {
    id,
    label: displayText(
      row["label"],
      `Gift record ${index + 1}`,
      "Archive label",
      issues,
    ),
    planLabel: displayText(
      row["plan_label"],
      "Plan on record",
      "Plan label",
      issues,
    ),
    durationMonths,
    status,
    createdAt: timestamp(row["created_at"], "Creation", issues),
    redeemedAt: timestamp(row["redeemed_at"], "Redemption", issues),
    expiresAt: timestamp(row["expires_at"], "Expiry", issues),
    canceledAt: timestamp(row["canceled_at"], "Cancellation", issues),
    messageRecorded: evidence(row["message_recorded"], "Message", issues),
    providerInvoiceLinked: evidence(
      row["provider_invoice_linked"],
      "Provider invoice",
      issues,
    ),
    gifterMemberLinked: evidence(
      row["gifter_member_linked"],
      "Gifter member linkage",
      issues,
    ),
    recipientMemberLinked: evidence(
      row["recipient_member_linked"],
      "Recipient member linkage",
      issues,
    ),
    issues,
  };
  if (!record.createdAt) issues.push("Creation timestamp is required.");
  lifecycleIssues(record, issues);
  return record;
}

function validGiftHistoryLimit(value: number | null): value is number {
  return value !== null && value >= 1 && value <= MAX_GIFT_HISTORY_PAGE_SIZE;
}

function validGiftHistoryOffset(value: number | null): value is number {
  return value !== null && value >= 0 && value <= MAX_GIFT_HISTORY_OFFSET;
}

function normalizeGiftHistoryItems(candidates: readonly unknown[]): {
  items: GiftHistoryRecord[];
  rejectedRows: number;
} {
  const items: GiftHistoryRecord[] = [];
  let rejectedRows = Math.max(
    0,
    candidates.length - MAX_GIFT_HISTORY_PAGE_SIZE,
  );
  for (const [index, candidate] of candidates
    .slice(0, MAX_GIFT_HISTORY_PAGE_SIZE)
    .entries()) {
    const record = normalizeGiftHistoryRecord(candidate, index);
    if (record) items.push(record);
    else rejectedRows += 1;
  }
  return { items, rejectedRows };
}

export function normalizeGiftHistoryPage(raw: unknown): GiftHistoryPage {
  const envelope = object(raw);
  if (!envelope || !Array.isArray(envelope["items"])) {
    return {
      items: [],
      total: 0,
      limit: 0,
      offset: 0,
      snapshotAt: null,
      rejectedRows: 0,
      envelopeIssues: ["Gift history response did not match its contract."],
      recognized: false,
    };
  }
  const issues: string[] = [];
  const total = integer(envelope["total"]);
  const limit = integer(envelope["limit"]);
  const offset = integer(envelope["offset"]);
  const snapshotAt = timestamp(envelope["snapshot_at"], "Snapshot", issues);
  if (total === null || total < 0) issues.push("Total count is invalid.");
  if (!validGiftHistoryLimit(limit)) {
    issues.push("Page limit is outside 1–100.");
  }
  if (!validGiftHistoryOffset(offset)) {
    issues.push("Page offset is outside 0–10,000.");
  }
  if (!snapshotAt) issues.push("Snapshot timestamp is required.");
  if (envelope["items"].length > MAX_GIFT_HISTORY_PAGE_SIZE) {
    issues.push("Page contains more than 100 records.");
  }
  if (limit !== null && limit >= 1 && envelope["items"].length > limit) {
    issues.push("Page contains more records than its declared limit.");
  }

  const { items, rejectedRows } = normalizeGiftHistoryItems(envelope["items"]);
  const safeTotal = total !== null && total >= 0 ? total : items.length;
  if (safeTotal < items.length) {
    issues.push("Total count is smaller than this page.");
  }
  return {
    items,
    total: Math.max(safeTotal, items.length),
    limit: validGiftHistoryLimit(limit) ? limit : 24,
    offset: validGiftHistoryOffset(offset) ? offset : 0,
    snapshotAt,
    rejectedRows,
    envelopeIssues: issues,
    recognized: true,
  };
}

export function normalizeGiftHistoryStats(
  raw: unknown,
): GiftHistoryStats | null {
  const value = object(raw);
  if (!value) return null;
  const names = [
    "total",
    "pending",
    "paid",
    "granted",
    "canceled",
    "expired",
    "refunded",
  ] as const;
  const counts = names.map((name) => integer(value[name]));
  if (counts.some((count) => count === null || count < 0)) return null;
  const [total, pending, paid, redeemed, cancelled, expired, refunded] =
    counts as [number, number, number, number, number, number, number];
  const rate = value["conversionRate"];
  if (
    typeof rate !== "number" ||
    !Number.isFinite(rate) ||
    rate < 0 ||
    rate > 1
  ) {
    return null;
  }
  const issues: string[] = [];
  const classified = pending + paid + redeemed + cancelled + expired + refunded;
  if (classified > total) {
    issues.push("Lifecycle counts exceed the total count.");
  }
  const resolved = redeemed + cancelled + expired + refunded;
  const expectedConversion = resolved === 0 ? 0 : redeemed / resolved;
  if (Math.abs(rate - expectedConversion) > 1e-9) {
    issues.push("Conversion rate conflicts with the lifecycle counts.");
  }
  const generatedAt = timestamp(
    value["generated_at"],
    "Statistics generation",
    issues,
  );
  if (!generatedAt) issues.push("Statistics generation timestamp is required.");
  return {
    total,
    pending,
    paid,
    redeemed,
    cancelled,
    expired,
    refunded,
    unclassified: Math.max(0, total - classified),
    conversionRate: rate,
    generatedAt,
    issues,
  };
}

export function sanitizeGiftHistoryQuery(value: string): string {
  return value.replace(UNSAFE_QUERY_TEXT, "").slice(0, 96);
}

export function giftHistoryQueryPrefix(value: string): string | undefined {
  const compact = value
    .trim()
    .toLocaleLowerCase()
    .replace(/^gift record\s+/u, "")
    .replaceAll("-", "");
  return GIFT_RECORD_PREFIX.test(compact) ? compact : undefined;
}

export function nextGiftHistoryOffset(
  page: GiftHistoryPage,
): number | undefined {
  const consumed = page.items.length + page.rejectedRows;
  const next = page.offset + consumed;
  if (consumed === 0 || next >= page.total || next > MAX_GIFT_HISTORY_OFFSET) {
    return undefined;
  }
  return next;
}

export function mergeGiftHistoryPages(
  pages: readonly GiftHistoryPage[],
): GiftHistoryRecord[] {
  const seen = new Set<string>();
  const records: GiftHistoryRecord[] = [];
  for (const page of pages) {
    for (const record of page.items) {
      if (seen.has(record.id)) continue;
      seen.add(record.id);
      records.push(record);
    }
  }
  return records;
}
