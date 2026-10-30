export type GiftHistoryState =
  | "pending"
  | "paid"
  | "redeemed"
  | "cancelled"
  | "expired"
  | "refunded"
  | "data_issue";

export type GiftHistoryFilter =
  | "all"
  | "open"
  | "redeemed"
  | "closed"
  | "cancelled"
  | "expired"
  | "refunded"
  | "data_issue";

export type GiftHistorySort = "newest" | "oldest" | "duration" | "status";

export interface GiftHistoryRecord {
  key: string;
  /** Opaque server key. It is used for a contained detail read, never shown. */
  sourceRecordID: string | null;
  label: string;
  planLabel: string;
  durationMonths: number | null;
  status: string;
  createdAt: string | null;
  redeemedAt: string | null;
  expiresAt: string | null;
  canceledAt: string | null;
  messageRecorded: boolean | null;
  providerInvoiceLinked: boolean | null;
  gifterMemberLinked: boolean | null;
  recipientMemberLinked: boolean | null;
  issues: string[];
}

export interface GiftHistoryPage {
  items: GiftHistoryRecord[];
  total: number;
  limit: number;
  offset: number;
  snapshotAt: string | null;
  rejectedRows: number;
  recognized: boolean;
  envelopeIssues: string[];
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
  issues: string[];
}

export interface GiftHistoryCounts {
  all: number;
  open: number;
  pending: number;
  paid: number;
  redeemed: number;
  closed: number;
  cancelled: number;
  expired: number;
  refunded: number;
  data_issue: number;
  monthsRecorded: number;
  providerLinked: number;
}

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SAFE_DISPLAY_TEXT =
  /^[^\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]+$/u;
const UNSAFE_SEARCH_TEXT =
  /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu;
const GIFT_RECORD_PREFIX = /^[0-9a-f]{8,32}$/u;
const MAX_GIFT_HISTORY_PAGE_SIZE = 100;
const MAX_GIFT_HISTORY_OFFSET = 10_000;
const SUPPORTED_STATUSES = new Set([
  "pending",
  "paid",
  "granted",
  "redeemed",
  "active",
  "canceled",
  "cancelled",
  "expired",
  "refunded",
]);
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

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function finiteInteger(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    Number.isInteger(value)
    ? value
    : null;
}

function safeDisplayText(
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
  if (text.length > 128 || !SAFE_DISPLAY_TEXT.test(text)) {
    issues.push(`${field} is not safe display text.`);
    return fallback;
  }
  return text;
}

function optionalTimestamp(
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

function requiredBoolean(
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

function normalizeStatus(value: unknown, issues: string[]): string {
  const status = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!SUPPORTED_STATUSES.has(status)) {
    issues.push(
      status
        ? "Lifecycle status is not supported."
        : "Lifecycle status is missing.",
    );
  }
  return status || "unknown";
}

function lifecycleIssues(record: GiftHistoryRecord): void {
  const normalized = normalizedGiftStatus(record.status);
  if (normalized === "redeemed" && !record.redeemedAt) {
    record.issues.push("Redeemed status has no redemption timestamp.");
  }
  if (normalized === "cancelled" && !record.canceledAt) {
    record.issues.push("Cancelled status has no cancellation timestamp.");
  }
  if (
    (normalized === "pending" || normalized === "paid") &&
    (record.redeemedAt !== null || record.canceledAt !== null)
  ) {
    record.issues.push(
      "Open status conflicts with a terminal lifecycle timestamp.",
    );
  }
  if (
    record.createdAt &&
    record.redeemedAt &&
    Date.parse(record.redeemedAt) < Date.parse(record.createdAt)
  ) {
    record.issues.push("Redemption precedes record creation.");
  }
  if (
    record.createdAt &&
    record.canceledAt &&
    Date.parse(record.canceledAt) < Date.parse(record.createdAt)
  ) {
    record.issues.push("Cancellation precedes record creation.");
  }
}

export function decodeGiftHistoryRecord(
  raw: Record<string, unknown>,
  index: number,
): GiftHistoryRecord {
  const issues: string[] = [];
  const id = typeof raw.id === "string" ? raw.id.trim() : "";
  const sourceRecordID = UUID.test(id) ? id : null;
  if (!sourceRecordID) {
    issues.push("Archive record identifier is missing or invalid.");
  }
  for (const field of SENSITIVE_WIRE_FIELDS) {
    if (field in raw) {
      issues.push(
        `Unexpected sensitive field "${field}" crossed the archive boundary.`,
      );
    }
  }
  const duration = finiteInteger(raw.duration_months);
  const durationMonths =
    duration !== null && duration >= 1 && duration <= 60 ? duration : null;
  if (durationMonths === null) {
    issues.push("Gift duration is outside the supported 1–60 month range.");
  }
  const record: GiftHistoryRecord = {
    key: sourceRecordID ? `gift:${sourceRecordID}` : `gift-row:${index}`,
    sourceRecordID,
    label: safeDisplayText(
      raw.label,
      `Unidentified gift ${index + 1}`,
      "Archive label",
      issues,
    ),
    planLabel: safeDisplayText(
      raw.plan_label,
      "Plan unavailable",
      "Plan label",
      issues,
    ),
    durationMonths,
    status: normalizeStatus(raw.status, issues),
    createdAt: optionalTimestamp(raw.created_at, "Creation", issues),
    redeemedAt: optionalTimestamp(raw.redeemed_at, "Redemption", issues),
    expiresAt: optionalTimestamp(raw.expires_at, "Expiry", issues),
    canceledAt: optionalTimestamp(raw.canceled_at, "Cancellation", issues),
    messageRecorded: requiredBoolean(raw.message_recorded, "Message", issues),
    providerInvoiceLinked: requiredBoolean(
      raw.provider_invoice_linked,
      "Provider invoice",
      issues,
    ),
    gifterMemberLinked: requiredBoolean(
      raw.gifter_member_linked,
      "Gifter member linkage",
      issues,
    ),
    recipientMemberLinked: requiredBoolean(
      raw.recipient_member_linked,
      "Recipient member linkage",
      issues,
    ),
    issues,
  };
  if (!record.createdAt) issues.push("Creation timestamp is required.");
  lifecycleIssues(record);
  return record;
}

export function decodeGiftHistoryPage(value: unknown): GiftHistoryPage {
  if (!isObject(value) || !Array.isArray(value.items)) {
    return {
      items: [],
      total: 0,
      limit: 0,
      offset: 0,
      snapshotAt: null,
      rejectedRows: 0,
      recognized: false,
      envelopeIssues: ["Gift history response did not match its contract."],
    };
  }
  const envelopeIssues: string[] = [];
  const total = finiteInteger(value.total);
  const limit = finiteInteger(value.limit);
  const offset = finiteInteger(value.offset);
  const snapshotAt = optionalTimestamp(
    value.snapshot_at,
    "Snapshot",
    envelopeIssues,
  );
  if (total === null || total < 0) {
    envelopeIssues.push("Total record count is missing or invalid.");
  }
  if (limit === null || limit < 1 || limit > MAX_GIFT_HISTORY_PAGE_SIZE) {
    envelopeIssues.push("Page limit is missing or outside 1–100.");
  }
  if (offset === null || offset < 0 || offset > MAX_GIFT_HISTORY_OFFSET) {
    envelopeIssues.push("Page offset is missing or outside 0–10,000.");
  }
  if (!snapshotAt) {
    envelopeIssues.push("Snapshot timestamp is required.");
  }
  if (value.items.length > MAX_GIFT_HISTORY_PAGE_SIZE) {
    envelopeIssues.push("Page contains more than 100 records.");
  }
  if (limit !== null && limit >= 1 && value.items.length > limit) {
    envelopeIssues.push("Page contains more records than its declared limit.");
  }

  let rejectedRows = Math.max(
    0,
    value.items.length - MAX_GIFT_HISTORY_PAGE_SIZE,
  );
  const items: GiftHistoryRecord[] = [];
  for (const [index, candidate] of value.items
    .slice(0, MAX_GIFT_HISTORY_PAGE_SIZE)
    .entries()) {
    if (!isObject(candidate)) {
      rejectedRows += 1;
      continue;
    }
    items.push(decodeGiftHistoryRecord(candidate, index));
  }
  const safeTotal = total !== null && total >= 0 ? total : items.length;
  if (safeTotal < items.length) {
    envelopeIssues.push("Total record count is smaller than this page.");
  }
  return {
    items,
    total: Math.max(safeTotal, items.length),
    limit:
      limit !== null && limit >= 1 && limit <= MAX_GIFT_HISTORY_PAGE_SIZE
        ? limit
        : 24,
    offset:
      offset !== null && offset >= 0 && offset <= MAX_GIFT_HISTORY_OFFSET
        ? offset
        : 0,
    snapshotAt,
    rejectedRows,
    recognized: true,
    envelopeIssues,
  };
}

export function decodeGiftHistoryStats(
  value: unknown,
): GiftHistoryStats | null {
  if (!isObject(value)) return null;
  const fields = [
    "total",
    "pending",
    "paid",
    "granted",
    "canceled",
    "expired",
    "refunded",
  ] as const;
  const counts = fields.map((field) => finiteInteger(value[field]));
  if (counts.some((count) => count === null || count < 0)) return null;
  const [total, pending, paid, redeemed, cancelled, expired, refunded] =
    counts as [number, number, number, number, number, number, number];
  const conversionRate =
    typeof value.conversionRate === "number" &&
    Number.isFinite(value.conversionRate) &&
    value.conversionRate >= 0 &&
    value.conversionRate <= 1
      ? value.conversionRate
      : null;
  if (conversionRate === null) return null;
  const issues: string[] = [];
  const classified = pending + paid + redeemed + cancelled + expired + refunded;
  if (classified > total) {
    issues.push("Lifecycle counts exceed the total record count.");
  }
  const resolved = redeemed + cancelled + expired + refunded;
  const expectedConversion = resolved === 0 ? 0 : redeemed / resolved;
  if (Math.abs(conversionRate - expectedConversion) > 1e-9) {
    issues.push("Conversion rate conflicts with the lifecycle counts.");
  }
  const generatedAt = optionalTimestamp(
    value.generated_at,
    "Statistics generation",
    issues,
  );
  if (!generatedAt) {
    issues.push("Statistics generation timestamp is required.");
  }
  return {
    total,
    pending,
    paid,
    redeemed,
    cancelled,
    expired,
    refunded,
    unclassified: Math.max(0, total - classified),
    conversionRate,
    generatedAt,
    issues,
  };
}

export function normalizedGiftStatus(
  status: string,
): Exclude<GiftHistoryState, "data_issue"> {
  switch (status.trim().toLowerCase()) {
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
      return "pending";
  }
}

export function giftHistoryState(record: GiftHistoryRecord): GiftHistoryState {
  return record.issues.length > 0
    ? "data_issue"
    : normalizedGiftStatus(record.status);
}

export function giftStateLabel(state: GiftHistoryState): string {
  switch (state) {
    case "pending":
      return "Pending";
    case "paid":
      return "Paid · awaiting access";
    case "redeemed":
      return "Redeemed";
    case "cancelled":
      return "Cancelled";
    case "expired":
      return "Expired";
    case "refunded":
      return "Refunded";
    case "data_issue":
      return "Data issue";
  }
}

export function giftHistoryCounts(
  records: readonly GiftHistoryRecord[],
): GiftHistoryCounts {
  const counts: GiftHistoryCounts = {
    all: records.length,
    open: 0,
    pending: 0,
    paid: 0,
    redeemed: 0,
    closed: 0,
    cancelled: 0,
    expired: 0,
    refunded: 0,
    data_issue: 0,
    monthsRecorded: 0,
    providerLinked: 0,
  };
  for (const record of records) {
    const state = giftHistoryState(record);
    counts[state] += 1;
    if (state === "pending" || state === "paid") counts.open += 1;
    if (["redeemed", "cancelled", "expired", "refunded"].includes(state)) {
      counts.closed += 1;
    }
    counts.monthsRecorded += record.durationMonths ?? 0;
    if (record.providerInvoiceLinked === true) counts.providerLinked += 1;
  }
  return counts;
}

export function giftHistoryMatchesFilter(
  record: GiftHistoryRecord,
  filter: GiftHistoryFilter,
): boolean {
  const state = giftHistoryState(record);
  if (filter === "all") return true;
  if (filter === "open") return state === "pending" || state === "paid";
  if (filter === "closed") {
    return ["redeemed", "cancelled", "expired", "refunded"].includes(state);
  }
  return state === filter;
}

export function sanitizeGiftHistorySearchInput(value: string): string {
  return value.replace(UNSAFE_SEARCH_TEXT, "").slice(0, 96);
}

export function giftHistorySearchPrefix(value: string): string | undefined {
  const compact = value
    .trim()
    .toLocaleLowerCase()
    .replace(/^gift record\s+/u, "")
    .replaceAll("-", "");
  return GIFT_RECORD_PREFIX.test(compact) ? compact : undefined;
}

export function sortGiftHistory(
  records: readonly GiftHistoryRecord[],
  sort: GiftHistorySort,
): GiftHistoryRecord[] {
  const timestamp = (value: string | null): number =>
    value ? Date.parse(value) || 0 : 0;
  return [...records].sort((left, right) => {
    if (sort === "oldest") {
      return timestamp(left.createdAt) - timestamp(right.createdAt);
    }
    if (sort === "duration") {
      return (
        (right.durationMonths ?? -1) - (left.durationMonths ?? -1) ||
        timestamp(right.createdAt) - timestamp(left.createdAt)
      );
    }
    if (sort === "status") {
      return (
        giftStateLabel(giftHistoryState(left)).localeCompare(
          giftStateLabel(giftHistoryState(right)),
        ) || timestamp(right.createdAt) - timestamp(left.createdAt)
      );
    }
    return timestamp(right.createdAt) - timestamp(left.createdAt);
  });
}

export function giftHistoryServerFilter(
  filter: GiftHistoryFilter,
): Exclude<GiftHistoryFilter, "data_issue"> | undefined {
  return filter === "data_issue" ? undefined : filter;
}
