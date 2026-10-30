export type DiscountHistoryState =
  | "within_stored_rules"
  | "expired"
  | "cap_reached"
  | "data_issue";

export type DiscountHistoryFilter =
  | "all"
  | "within_stored_rules"
  | "closed"
  | "expired"
  | "cap_reached"
  | "data_issue";

export type DiscountHistorySort =
  | "newest"
  | "oldest"
  | "label"
  | "redemptions"
  | "expiry";

export interface DiscountHistoryRecord {
  key: string;
  id: string | null;
  /** Server-authored display label that never contains the redeemable code. */
  label: string;
  /** Opaque archive key used to request the sanitized recent-event timeline. */
  sourceRecordID: string | null;
  percentOff: number | null;
  /** Legacy `amount_off_cents` wire value, interpreted as currency minor units. */
  amountOffCents: number | null;
  currency: string;
  maxRedemptions: number | null;
  timesRedeemed: number;
  expiresAt: string | null;
  appliesTo: "first_payment" | "recurring" | "both" | "unknown";
  createdAt: string | null;
  issues: string[];
}

export interface DiscountHistoryDecodeResult {
  items: DiscountHistoryRecord[];
  rejectedRows: number;
  recognized: boolean;
}

export interface DiscountHistoryCounts {
  all: number;
  within_stored_rules: number;
  expired: number;
  cap_reached: number;
  data_issue: number;
  closed: number;
  recordedRedemptions: number;
}

const DISCOUNT_STATES = new Set(["first_payment", "recurring", "both"]);
const ISO_CURRENCY = /^[A-Z]{3}$/u;
const OPAQUE_RECORD_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const UNSAFE_LABEL_CHARACTERS =
  // Control characters and bidi controls make archive labels ambiguous.
  /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isValidTimestamp(value: string): boolean {
  return !Number.isNaN(Date.parse(value));
}

function payloadRows(value: unknown): {
  rows: unknown[];
  recognized: boolean;
} {
  if (Array.isArray(value)) return { rows: value, recognized: true };
  if (!isObject(value)) return { rows: [], recognized: false };
  for (const field of ["items", "data", "results"] as const) {
    if (Array.isArray(value[field])) {
      return { rows: value[field], recognized: true };
    }
  }
  return { rows: [], recognized: false };
}

function decodeDisplayLabel(
  raw: Record<string, unknown>,
  index: number,
  issues: string[],
): string {
  // Never fall back to raw.code: older servers used it for the redeemable
  // secret. The contained API supplies only a display-safe label.
  const rawLabel = asString(raw.label)?.trim() ?? "";
  if (!rawLabel) issues.push("Archive label is missing.");
  if (rawLabel.length > 128) {
    issues.push("Archive label is longer than 128 characters.");
  }
  if (UNSAFE_LABEL_CHARACTERS.test(rawLabel)) {
    issues.push(
      "Archive label contains control or bidirectional formatting characters.",
    );
  }
  return rawLabel &&
    rawLabel.length <= 128 &&
    !UNSAFE_LABEL_CHARACTERS.test(rawLabel)
    ? rawLabel
    : `Unidentified record ${index + 1}`;
}

function decodeIdentity(
  raw: Record<string, unknown>,
  issues: string[],
): Pick<DiscountHistoryRecord, "id" | "sourceRecordID"> {
  const id = asString(raw.id)?.trim() || null;
  const sourceRecordID = id && OPAQUE_RECORD_ID.test(id) ? id : null;
  if (!sourceRecordID) {
    issues.push(
      id
        ? "Archive record identifier is invalid."
        : "Archive record identifier is missing.",
    );
  }
  return { id, sourceRecordID };
}

function decodeBenefit(
  raw: Record<string, unknown>,
  issues: string[],
): Pick<DiscountHistoryRecord, "percentOff" | "amountOffCents" | "currency"> {
  const percent = asFiniteNumber(raw.percent_off);
  const amount = asFiniteNumber(raw.amount_off_cents);
  const validPercent =
    percent !== null &&
    Number.isInteger(percent) &&
    percent >= 1 &&
    percent <= 100;
  const validAmount =
    amount !== null && Number.isInteger(amount) && amount >= 1;
  if (percent !== null && !validPercent) {
    issues.push("Percent benefit is outside the supported 1–100 range.");
  }
  if (amount !== null && !validAmount) {
    issues.push("Fixed benefit is not a positive whole-cent amount.");
  }
  if (validPercent === validAmount) {
    issues.push(
      validPercent
        ? "Both percent and fixed benefits are present."
        : "No valid discount benefit is present.",
    );
  }

  const rawCurrency = (asString(raw.currency) ?? "USD").trim().toUpperCase();
  const currency = ISO_CURRENCY.test(rawCurrency) ? rawCurrency : "USD";
  if (amount !== null && !ISO_CURRENCY.test(rawCurrency)) {
    issues.push("Fixed benefit has an invalid ISO currency code.");
  }
  return {
    percentOff: validPercent ? percent : null,
    amountOffCents: validAmount ? amount : null,
    currency,
  };
}

function decodeUsage(
  raw: Record<string, unknown>,
  issues: string[],
): Pick<DiscountHistoryRecord, "timesRedeemed" | "maxRedemptions"> {
  const rawTimes = asFiniteNumber(raw.times_redeemed);
  const timesRedeemed =
    rawTimes !== null && Number.isInteger(rawTimes) && rawTimes >= 0
      ? rawTimes
      : 0;
  if (rawTimes === null || !Number.isInteger(rawTimes) || rawTimes < 0) {
    issues.push("Recorded redemption count is missing or invalid.");
  }

  const rawCap =
    raw.max_redemptions === null || raw.max_redemptions === undefined
      ? null
      : asFiniteNumber(raw.max_redemptions);
  const maxRedemptions =
    rawCap !== null && Number.isInteger(rawCap) && rawCap >= 1 ? rawCap : null;
  if (
    raw.max_redemptions !== null &&
    raw.max_redemptions !== undefined &&
    maxRedemptions === null
  ) {
    issues.push("Redemption cap is not a positive whole number.");
  }
  if (maxRedemptions !== null && timesRedeemed > maxRedemptions) {
    issues.push("Recorded redemptions exceed the stored cap.");
  }
  return { timesRedeemed, maxRedemptions };
}

function decodeOptionalTimestamp(
  value: unknown,
  label: "Expiry" | "Creation",
  issues: string[],
): string | null {
  const timestamp = asString(value)?.trim() || null;
  if (timestamp && !isValidTimestamp(timestamp)) {
    issues.push(`${label} timestamp is invalid.`);
  }
  return timestamp;
}

function decodeAppliesTo(
  raw: Record<string, unknown>,
  issues: string[],
): DiscountHistoryRecord["appliesTo"] {
  const rawApplies = asString(raw.applies_to)?.trim() ?? "";
  const appliesTo = DISCOUNT_STATES.has(rawApplies)
    ? (rawApplies as DiscountHistoryRecord["appliesTo"])
    : "unknown";
  if (appliesTo === "unknown") {
    issues.push("Application scope is missing or unsupported.");
  }
  return appliesTo;
}

function decodeRecord(
  raw: Record<string, unknown>,
  index: number,
): DiscountHistoryRecord {
  const issues: string[] = [];
  const label = decodeDisplayLabel(raw, index, issues);
  const identity = decodeIdentity(raw, issues);
  const benefit = decodeBenefit(raw, issues);
  const usage = decodeUsage(raw, issues);
  const expiresAt = decodeOptionalTimestamp(raw.expires_at, "Expiry", issues);
  const createdAt = decodeOptionalTimestamp(raw.created_at, "Creation", issues);
  const appliesTo = decodeAppliesTo(raw, issues);
  return {
    key: identity.id ? `id:${identity.id}` : `row:${index}:${label}`,
    ...identity,
    label,
    ...benefit,
    ...usage,
    expiresAt,
    appliesTo,
    createdAt,
    issues,
  };
}

export function decodeDiscountHistoryPayload(
  value: unknown,
): DiscountHistoryDecodeResult {
  const extracted = payloadRows(value);
  const items: DiscountHistoryRecord[] = [];
  let rejectedRows = 0;
  extracted.rows.forEach((raw, index) => {
    if (!isObject(raw)) {
      rejectedRows += 1;
      return;
    }
    items.push(decodeRecord(raw, index));
  });
  return { items, rejectedRows, recognized: extracted.recognized };
}

export function discountHistoryState(
  record: DiscountHistoryRecord,
  now = Date.now(),
): DiscountHistoryState {
  if (record.issues.length > 0) return "data_issue";
  if (record.expiresAt) {
    const expiry = Date.parse(record.expiresAt);
    if (!Number.isNaN(expiry) && expiry <= now) return "expired";
  }
  if (
    record.maxRedemptions !== null &&
    record.timesRedeemed >= record.maxRedemptions
  ) {
    return "cap_reached";
  }
  return "within_stored_rules";
}

export function discountHistoryCounts(
  records: readonly DiscountHistoryRecord[],
  now = Date.now(),
): DiscountHistoryCounts {
  const counts: DiscountHistoryCounts = {
    all: records.length,
    within_stored_rules: 0,
    expired: 0,
    cap_reached: 0,
    data_issue: 0,
    closed: 0,
    recordedRedemptions: 0,
  };
  for (const record of records) {
    const state = discountHistoryState(record, now);
    counts[state] += 1;
    if (state === "expired" || state === "cap_reached") counts.closed += 1;
    counts.recordedRedemptions += record.timesRedeemed;
  }
  return counts;
}

export function discountHistoryMatchesFilter(
  record: DiscountHistoryRecord,
  filter: DiscountHistoryFilter,
  now = Date.now(),
): boolean {
  if (filter === "all") return true;
  const state = discountHistoryState(record, now);
  if (filter === "closed")
    return state === "expired" || state === "cap_reached";
  return state === filter;
}

export function discountHistoryMatchesSearch(
  record: DiscountHistoryRecord,
  search: string,
): boolean {
  const query = search.trim().toLocaleLowerCase();
  if (!query) return true;
  return [
    record.label,
    record.currency,
    record.appliesTo,
    record.percentOff === null ? "" : String(record.percentOff),
    record.amountOffCents === null ? "" : String(record.amountOffCents),
  ]
    .join(" ")
    .toLocaleLowerCase()
    .includes(query);
}

function timestamp(value: string | null, fallback: number): number {
  if (!value) return fallback;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? fallback : parsed;
}

export function sortDiscountHistory(
  records: readonly DiscountHistoryRecord[],
  sort: DiscountHistorySort,
): DiscountHistoryRecord[] {
  const sorted = [...records];
  sorted.sort((left, right) => {
    switch (sort) {
      case "oldest":
        return (
          timestamp(left.createdAt, Number.MAX_SAFE_INTEGER) -
          timestamp(right.createdAt, Number.MAX_SAFE_INTEGER)
        );
      case "label":
        return left.label.localeCompare(right.label, undefined, {
          numeric: true,
          sensitivity: "base",
        });
      case "redemptions":
        return (
          right.timesRedeemed - left.timesRedeemed ||
          left.label.localeCompare(right.label)
        );
      case "expiry":
        return (
          timestamp(left.expiresAt, Number.MAX_SAFE_INTEGER) -
            timestamp(right.expiresAt, Number.MAX_SAFE_INTEGER) ||
          left.label.localeCompare(right.label)
        );
      case "newest":
      default:
        return (
          timestamp(right.createdAt, Number.MIN_SAFE_INTEGER) -
            timestamp(left.createdAt, Number.MIN_SAFE_INTEGER) ||
          left.label.localeCompare(right.label)
        );
    }
  });
  return sorted;
}

export function discountBenefitLabel(record: DiscountHistoryRecord): string {
  if (record.percentOff !== null) return `${record.percentOff}% off`;
  if (record.amountOffCents !== null) {
    try {
      const formatter = new Intl.NumberFormat(undefined, {
        style: "currency",
        currency: record.currency,
      });
      const fractionDigits =
        formatter.resolvedOptions().maximumFractionDigits ?? 2;
      const amount = record.amountOffCents / 10 ** fractionDigits;
      return `${formatter.format(amount)} off`;
    } catch {
      return `${(record.amountOffCents / 100).toFixed(2)} ${record.currency} off`;
    }
  }
  return "Benefit unavailable";
}

export function discountAppliesLabel(
  appliesTo: DiscountHistoryRecord["appliesTo"],
): string {
  switch (appliesTo) {
    case "first_payment":
      return "First payment";
    case "recurring":
      return "Recurring";
    case "both":
      return "First + recurring";
    case "unknown":
    default:
      return "Scope unavailable";
  }
}

export function discountStateLabel(state: DiscountHistoryState): string {
  switch (state) {
    case "within_stored_rules":
      return "Within stored rules";
    case "expired":
      return "Expired in record";
    case "cap_reached":
      return "Recorded cap reached";
    case "data_issue":
      return "Data needs review";
  }
}
