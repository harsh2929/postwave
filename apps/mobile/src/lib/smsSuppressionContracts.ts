/** Strict Route42 SMS suppression projections and page composition. */
import { WireShapeError } from "./deliverabilityContracts";

export const SMS_SUPPRESSION_REASONS = [
  "manual",
  "stop_keyword",
  "help_keyword",
  "carrier_block",
  "complaint",
  "quiet_hours",
  "expired",
] as const;

export const SMS_SUPPRESSION_SOURCES = [
  "twilio",
  "telnyx",
  "bandwidth",
  "manual",
  "api",
  "import",
] as const;

export const SMS_SUPPRESSION_LOCKED_REASON =
  "carrier_or_system_authority" as const;

export type SmsSuppressionReason = (typeof SMS_SUPPRESSION_REASONS)[number];
export type SmsSuppressionSource = (typeof SMS_SUPPRESSION_SOURCES)[number];

export interface SmsSuppression {
  id: string;
  phone: string;
  reason: SmsSuppressionReason;
  /** The frozen authority source returned by the server. */
  source: SmsSuppressionSource;
  createdAt: string;
  reversible: boolean;
  lockedReason?: string | undefined;
}

export interface SmsSuppressionsPage {
  tenantId: string;
  items: SmsSuppression[];
  total: number;
  snapshotAt: string;
  nextCursor?: string | undefined;
}

interface SmsSuppressionEnvelope {
  tenantId: string;
  rows: unknown[];
  total: number;
  snapshotAt: string;
  nextCursor: string;
}

const ROW_KEYS = [
  "id",
  "phone_e164",
  "reason",
  "source",
  "created_at",
  "reversible",
  "locked_reason",
] as const;

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const CANONICAL_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const SMS_PHONE = /^\+1[2-9][0-9]{2}[2-9][0-9]{6}$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  const keys = new Set(allowed);
  return Object.keys(value).every((key) => keys.has(key));
}

function strictBoundedString(value: unknown, max: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) {
    return "";
  }
  if (value.trim() !== value || /[\u0000-\u001f\u007f]/u.test(value)) return "";
  return value;
}

function optionalBoundedString(value: unknown, max: number): string {
  if (value === undefined || value === null || value === "") return "";
  return strictBoundedString(value, max);
}

function strictUuidV4(value: unknown): string {
  const text = strictBoundedString(value, 36);
  return UUID_V4.test(text) ? text : "";
}

function strictCanonicalUuid(value: unknown): string {
  const text = strictBoundedString(value, 36);
  return CANONICAL_UUID.test(text) ? text : "";
}

function strictTimestamp(value: unknown): string {
  const text = strictBoundedString(value, 64);
  const parts =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|([+-])(\d{2}):(\d{2}))$/u.exec(
      text,
    );
  const parsed = Date.parse(text);
  if (
    !parts ||
    !Number.isFinite(parsed) ||
    parsed < Date.UTC(2000, 0, 1) ||
    parsed >= Date.UTC(2100, 0, 1)
  ) {
    return "";
  }
  const year = Number(parts[1]);
  const month = Number(parts[2]);
  const day = Number(parts[3]);
  if (
    year < 2000 ||
    year >= 2100 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    Number(parts[4]) > 23 ||
    Number(parts[5]) > 59 ||
    Number(parts[6]) > 59 ||
    Number(parts[8] ?? 0) > 14 ||
    (Number(parts[8] ?? 0) === 14 && Number(parts[9] ?? 0) !== 0) ||
    Number(parts[9] ?? 0) > 59 ||
    day > new Date(Date.UTC(year, month, 0)).getUTCDate()
  ) {
    return "";
  }
  return text;
}

function optionalCursor(value: unknown): string {
  if (value === undefined || value === null || value === "") return "";
  const cursor = strictBoundedString(value, 4096);
  return /^v1\.[A-Za-z0-9_-]+$/u.test(cursor) ? cursor : "";
}

function validRequestExpectation(
  expectedTenant: string,
  expectedLimit: number,
  expectedPhone?: string,
): string | null {
  const tenant = strictCanonicalUuid(expectedTenant);
  if (
    !tenant ||
    !Number.isSafeInteger(expectedLimit) ||
    expectedLimit < 1 ||
    expectedLimit > 200 ||
    (expectedPhone !== undefined && !SMS_PHONE.test(expectedPhone))
  ) {
    return null;
  }
  return tenant;
}

function decodeEnvelope(
  value: unknown,
  expectedTenant: string,
  expectedLimit: number,
  expectedPhone?: string,
): SmsSuppressionEnvelope | null {
  const tenant = validRequestExpectation(
    expectedTenant,
    expectedLimit,
    expectedPhone,
  );
  if (
    !tenant ||
    !isRecord(value) ||
    !Array.isArray(value.items) ||
    value.items.length > 200 ||
    value.items.length > expectedLimit ||
    !hasOnlyKeys(value, [
      "tenantId",
      "items",
      "total",
      "nextCursor",
      "snapshotAt",
    ])
  ) {
    return null;
  }
  const tenantId = strictCanonicalUuid(value.tenantId);
  const snapshotAt = strictTimestamp(value.snapshotAt);
  const nextCursor = optionalCursor(value.nextCursor);
  if (
    tenantId !== tenant ||
    !Number.isSafeInteger(value.total) ||
    Number(value.total) < value.items.length ||
    !snapshotAt ||
    (value.nextCursor !== undefined && !nextCursor)
  ) {
    return null;
  }
  return {
    tenantId,
    rows: value.items,
    total: Number(value.total),
    snapshotAt,
    nextCursor,
  };
}

function validAuthorityProjection(
  reason: string,
  source: string,
  reversible: unknown,
  lockedReason: string,
  lockedReasonPresent: boolean,
): reversible is boolean {
  return (
    typeof reversible === "boolean" &&
    reversible === (reason === "manual" && source === "manual") &&
    !(lockedReasonPresent && !lockedReason) &&
    (reversible || lockedReason === SMS_SUPPRESSION_LOCKED_REASON) &&
    (!reversible || !lockedReasonPresent)
  );
}

function decodeSuppressionRow(
  raw: unknown,
  snapshotAt: string,
): SmsSuppression | null {
  if (!isRecord(raw) || !hasOnlyKeys(raw, ROW_KEYS)) return null;
  const id = strictUuidV4(raw.id);
  const phone = strictBoundedString(raw.phone_e164, 16);
  const reason = strictBoundedString(raw.reason, 128);
  const source = strictBoundedString(raw.source, 128);
  const createdAt = strictTimestamp(raw.created_at);
  const lockedReason = optionalBoundedString(raw.locked_reason, 256);
  const lockedReasonPresent = raw.locked_reason !== undefined;
  if (
    !id ||
    !SMS_PHONE.test(phone) ||
    !SMS_SUPPRESSION_REASONS.includes(reason as SmsSuppressionReason) ||
    !SMS_SUPPRESSION_SOURCES.includes(source as SmsSuppressionSource) ||
    !createdAt ||
    Date.parse(createdAt) > Date.parse(snapshotAt) ||
    !validAuthorityProjection(
      reason,
      source,
      raw.reversible,
      lockedReason,
      lockedReasonPresent,
    )
  ) {
    return null;
  }
  return {
    id,
    phone,
    reason: reason as SmsSuppressionReason,
    source: source as SmsSuppressionSource,
    createdAt,
    reversible: raw.reversible,
    ...(lockedReason ? { lockedReason } : {}),
  };
}

function validPageTail(
  page: SmsSuppressionEnvelope,
  rows: readonly SmsSuppression[],
  expectedLimit: number,
  expectedPhone?: string,
): boolean {
  if (
    page.nextCursor &&
    (page.total <= rows.length || rows.length !== expectedLimit)
  ) {
    return false;
  }
  return !(
    expectedPhone !== undefined &&
    (page.total > 1 ||
      page.nextCursor !== "" ||
      rows.some((row) => row.phone !== expectedPhone))
  );
}

/** Strict frozen row/envelope contract; legacy aliases fail the entire page. */
export function parseSmsSuppressions(
  value: unknown,
  expectedTenant: string,
  expectedLimit = 100,
  expectedPhone?: string,
): SmsSuppressionsPage {
  const page = decodeEnvelope(
    value,
    expectedTenant,
    expectedLimit,
    expectedPhone,
  );
  if (!page) throw new WireShapeError("SMS suppression");
  const out: SmsSuppression[] = [];
  const ids = new Set<string>();
  const phones = new Set<string>();
  let previousAt = Number.POSITIVE_INFINITY;
  let previousId = "";
  for (const raw of page.rows) {
    const row = decodeSuppressionRow(raw, page.snapshotAt);
    const at = row ? Date.parse(row.createdAt) : Number.NaN;
    if (
      !row ||
      ids.has(row.id) ||
      phones.has(row.phone) ||
      at > previousAt ||
      (at === previousAt && previousId !== "" && row.id >= previousId)
    ) {
      throw new WireShapeError("SMS suppression");
    }
    ids.add(row.id);
    phones.add(row.phone);
    previousAt = at;
    previousId = row.id;
    out.push(row);
  }
  if (!validPageTail(page, out, expectedLimit, expectedPhone)) {
    throw new WireShapeError("SMS suppression");
  }
  return {
    tenantId: page.tenantId,
    items: out,
    total: page.total,
    snapshotAt: page.snapshotAt,
    ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
  };
}

export function mergeSmsSuppressionPages(
  pages: readonly SmsSuppressionsPage[],
): {
  items: SmsSuppression[];
  total: number;
  snapshotAt: string | null;
  hasMore: boolean;
} {
  if (pages.length === 0) {
    return { items: [], total: 0, snapshotAt: null, hasMore: false };
  }
  const first = pages[0] as SmsSuppressionsPage;
  const items: SmsSuppression[] = [];
  const ids = new Set<string>();
  const phones = new Set<string>();
  let previousAt = Number.POSITIVE_INFINITY;
  let previousId = "";
  for (const page of pages) {
    if (
      page.tenantId !== first.tenantId ||
      page.snapshotAt !== first.snapshotAt ||
      page.total !== first.total
    ) {
      throw new WireShapeError("SMS suppression");
    }
    for (const row of page.items) {
      const at = Date.parse(row.createdAt);
      if (
        ids.has(row.id) ||
        phones.has(row.phone) ||
        at > previousAt ||
        (at === previousAt && previousId !== "" && row.id >= previousId)
      ) {
        throw new WireShapeError("SMS suppression");
      }
      ids.add(row.id);
      phones.add(row.phone);
      previousAt = at;
      previousId = row.id;
      items.push(row);
    }
  }
  const hasMore = Boolean(pages.at(-1)?.nextCursor);
  if (
    items.length > first.total ||
    (!hasMore && items.length !== first.total)
  ) {
    throw new WireShapeError("SMS suppression");
  }
  return {
    items,
    total: first.total,
    snapshotAt: first.snapshotAt,
    hasMore,
  };
}

export function isReversibleManualSmsSuppression(row: SmsSuppression): boolean {
  return (
    row.reversible === true &&
    row.reason === "manual" &&
    row.source === "manual"
  );
}

/** Blank means unfiltered, null means not yet an exact US/Canada number. */
export function normalizeSmsSuppressionSearch(value: string): string | null {
  const trimmed = value.replace(/^ +| +$/gu, "");
  if (!trimmed) return "";
  let digits = "";
  for (let index = 0; index < trimmed.length; index += 1) {
    const character = trimmed[index]!;
    if (character >= "0" && character <= "9") {
      digits += character;
    } else if (character === "+" && index === 0) {
      continue;
    } else if ([" ", "(", ")", "-", "."].includes(character)) {
      continue;
    } else {
      return null;
    }
  }
  const normalized =
    digits.length === 10
      ? `+1${digits}`
      : digits.length === 11 && digits.startsWith("1")
        ? `+${digits}`
        : "";
  return SMS_PHONE.test(normalized) ? normalized : null;
}
