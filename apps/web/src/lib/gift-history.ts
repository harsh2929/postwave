// SPDX-License-Identifier: AGPL-3.0-only
/**
 * lib/gift-history.ts — the sanitized gift-archive projection.
 *
 * `GET /api/v1/gift-subscriptions` is the ONLY gift route the gateway mounts
 * besides `/stats` and `/{id}` (apps/api/internal/paid_tiers/gifts.go:544-546:
 * "Mutation and public-claim routes remain unmounted"). So this surface is an
 * archive, not a workspace: nothing here creates, cancels, redeems, or exports
 * a gift, and this module deliberately offers no decoder for a field the
 * server refuses to send.
 *
 * WHY A DECODER AND NOT A CAST. The value of the read is that a row can be
 * WRONG — a "redeemed" record with no redemption timestamp, a cancellation
 * dated before its own creation, a duration outside the 1–60 month range the
 * server enforces. Casting the wire shape would render those as healthy
 * history. Every check below turns one of those into a named issue the page
 * shows instead of hiding, and `giftHistoryState` promotes any record with an
 * issue out of its claimed lifecycle state and into `data_issue`.
 *
 * IDENTITY IS ABSENT BY CONTRACT, and its reappearance is a finding. The
 * server projection carries no tenant id, no purchaser or recipient address,
 * no message body, no provider identifier or payment/redemption URL, and no
 * subscriber ids — only booleans saying whether each of those was recorded.
 * `SENSITIVE_WIRE_FIELDS` therefore does not sanitize; it REPORTS, because a
 * sensitive field crossing this boundary means the server-side projection
 * regressed and silently dropping it would hide that.
 *
 * Mirrors apps/desktop/src/components/gifts/gift-history.ts so the two clients
 * classify the same row identically.
 */

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
  /** Opaque server key. Used for a contained detail read, never displayed. */
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

export const GIFT_HISTORY_PAGE_SIZE = 18;
export const MAX_GIFT_HISTORY_PAGE_SIZE = 100;
export const MAX_GIFT_HISTORY_OFFSET = 10_000;

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SAFE_DISPLAY_TEXT =
  /^[^\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]+$/u;
const UNSAFE_SEARCH_TEXT =
  /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu;
const GIFT_RECORD_PREFIX = /^[0-9a-f]{8,32}$/u;
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

const CLOSED_STATES: readonly GiftHistoryState[] = [
  "redeemed",
  "cancelled",
  "expired",
  "refunded",
];

/** Raised when the archive response cannot be read as an archive at all. */
export class GiftHistoryContractError extends Error {
  readonly code = "gift_history_contract_invalid";

  constructor(surface: string) {
    super(
      `Moosewave returned an invalid ${surface} response. Refresh and try again.`,
    );
    this.name = "GiftHistoryContractError";
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function finiteInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
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

/**
 * Contradictions between a claimed state and the timestamps that would have to
 * exist for it. These are the checks that make the archive worth reading: a
 * row can be internally impossible and still be a well-formed 200.
 */
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

/**
 * A row that fails the object check is COUNTED, not dropped silently:
 * `rejectedRows` is what lets the page say "3 rows were contained" instead of
 * showing a short page that looks complete.
 */
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
        : GIFT_HISTORY_PAGE_SIZE,
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

/**
 * A stored instant, or "" when there is nothing to show. An unparseable value
 * must not become "Invalid Date" next to real timestamps — the caller decides
 * what absence reads as ("Not recorded", "Unavailable"), because the two are
 * not the same claim.
 */
export function formatGiftTimestamp(value: string | null): string {
  if (!value) return "";
  const millis = Date.parse(value);
  if (!Number.isFinite(millis)) return "";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(millis));
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

/** A record with any readable issue is not reported under its claimed state. */
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

export function giftStateBadgeVariant(
  state: GiftHistoryState,
): "success" | "warning" | "secondary" | "outline" {
  switch (state) {
    case "redeemed":
      return "success";
    case "data_issue":
      return "warning";
    case "pending":
    case "paid":
      return "outline";
    default:
      return "secondary";
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
    if (CLOSED_STATES.includes(state)) counts.closed += 1;
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
  if (filter === "closed") return CLOSED_STATES.includes(state);
  return state === filter;
}

export function sanitizeGiftHistorySearchInput(value: string): string {
  return value.replace(UNSAFE_SEARCH_TEXT, "").slice(0, 96);
}

/**
 * Search is the record prefix and NOTHING else. The server accepts 8–32 hex
 * characters of the opaque record id (gift_history.go:158) precisely so this
 * reporting scope cannot be turned into an email-existence oracle; a typed
 * address must therefore produce no request at all, not a request that
 * quietly returns everything.
 */
export function giftHistorySearchPrefix(value: string): string | undefined {
  const compact = value
    .trim()
    .toLocaleLowerCase()
    .replace(/^gift record\s+/u, "")
    .replaceAll("-", "");
  return GIFT_RECORD_PREFIX.test(compact) ? compact : undefined;
}

/**
 * `data_issue` is a PAGE-LOCAL review mode — the server has no notion of a row
 * being self-contradictory — so it is never sent as a server filter.
 */
export function giftHistoryServerFilter(
  filter: GiftHistoryFilter,
): Exclude<GiftHistoryFilter, "data_issue"> | undefined {
  return filter === "data_issue" ? undefined : filter;
}
