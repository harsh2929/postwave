// SPDX-License-Identifier: AGPL-3.0-only

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

export interface SmsSuppressionRow {
  id: string;
  phone_e164: string;
  reason: SmsSuppressionReason;
  source: SmsSuppressionSource;
  created_at: string;
  reversible: boolean;
  locked_reason?: typeof SMS_SUPPRESSION_LOCKED_REASON;
}

export interface SmsSuppressionsPage {
  tenantId: string;
  items: SmsSuppressionRow[];
  total: number;
  snapshotAt: string;
  nextCursor?: string;
}

export class SmsSuppressionContractError extends Error {
  constructor() {
    super("Invalid SMS suppression response");
    this.name = "SmsSuppressionContractError";
  }
}

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const TENANT_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const PHONE = /^\+1[2-9][0-9]{2}[2-9][0-9]{6}$/u;
const RFC3339 =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|([+-])(\d{2}):(\d{2}))$/u;
const UNSAFE_TEXT =
  /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/u;

function fail(): never {
  throw new SmsSuppressionContractError();
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail();
  return value as Record<string, unknown>;
}

function exactKeys(
  source: Record<string, unknown>,
  allowed: readonly string[],
): void {
  const keys = new Set(allowed);
  if (Object.keys(source).some((key) => !keys.has(key))) fail();
}

function text(value: unknown, max: number): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > max ||
    value.trim() !== value ||
    UNSAFE_TEXT.test(value)
  ) {
    fail();
  }
  return value;
}

function uuid(value: unknown): string {
  const result = text(value, 36);
  if (!UUID_V4.test(result)) fail();
  return result;
}

function tenantUuid(value: unknown): string {
  const result = text(value, 36);
  if (!TENANT_UUID.test(result)) fail();
  return result;
}

function timestamp(value: unknown): string {
  const result = text(value, 64);
  const parts = RFC3339.exec(result);
  const parsed = Date.parse(result);
  if (
    !parts ||
    !Number.isFinite(parsed) ||
    parsed < Date.UTC(2000, 0, 1) ||
    parsed >= Date.UTC(2100, 0, 1)
  )
    fail();
  const year = Number(parts[1]);
  const month = Number(parts[2]);
  const day = Number(parts[3]);
  if (
    year < 2000 ||
    year >= 2100 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > new Date(Date.UTC(year, month, 0)).getUTCDate() ||
    Number(parts[4]) > 23 ||
    Number(parts[5]) > 59 ||
    Number(parts[6]) > 59 ||
    Number(parts[8] ?? 0) > 14 ||
    (Number(parts[8] ?? 0) === 14 && Number(parts[9] ?? 0) !== 0) ||
    Number(parts[9] ?? 0) > 59
  ) {
    fail();
  }
  return result;
}

function optionalText(value: unknown, max: number): string | undefined {
  return value === undefined ? undefined : text(value, max);
}

function optionalCursor(value: unknown): string | undefined {
  const result = optionalText(value, 4_096);
  if (result !== undefined && !/^v1\.[A-Za-z0-9_-]+$/u.test(result)) fail();
  return result;
}

export function decodeSmsSuppressionRow(raw: unknown): SmsSuppressionRow {
  const row = object(raw);
  exactKeys(row, [
    "id",
    "phone_e164",
    "reason",
    "source",
    "created_at",
    "reversible",
    "locked_reason",
  ]);
  const id = uuid(row.id);
  const phoneE164 = text(row.phone_e164, 16);
  const reason = text(row.reason, 128);
  const rowSource = text(row.source, 128);
  const createdAt = timestamp(row.created_at);
  const lockedReason = optionalText(row.locked_reason, 256);
  const reversible = row.reversible;
  if (
    !PHONE.test(phoneE164) ||
    !SMS_SUPPRESSION_REASONS.includes(reason as SmsSuppressionReason) ||
    !SMS_SUPPRESSION_SOURCES.includes(rowSource as SmsSuppressionSource) ||
    typeof reversible !== "boolean" ||
    reversible !== (reason === "manual" && rowSource === "manual") ||
    (reversible && row.locked_reason !== undefined) ||
    (!reversible && lockedReason !== SMS_SUPPRESSION_LOCKED_REASON)
  ) {
    fail();
  }
  return {
    id,
    phone_e164: phoneE164,
    reason: reason as SmsSuppressionReason,
    source: rowSource as SmsSuppressionSource,
    created_at: createdAt,
    reversible,
    ...(lockedReason
      ? { locked_reason: SMS_SUPPRESSION_LOCKED_REASON }
      : {}),
  };
}

export function isReversibleManualSmsSuppression(
  row: SmsSuppressionRow,
): boolean {
  return (
    row.reversible === true &&
    row.reason === "manual" &&
    row.source === "manual"
  );
}

export function decodeSmsSuppressions(
  raw: unknown,
  expectedTenantId: string,
  expectedLimit = 100,
  expectedReason?: SmsSuppressionReason,
  expectedPhone?: string,
): SmsSuppressionsPage {
  const source = object(raw);
  exactKeys(source, ["tenantId", "items", "total", "nextCursor", "snapshotAt"]);
  const tenantId = tenantUuid(source.tenantId);
  if (tenantUuid(expectedTenantId) !== tenantId || !Array.isArray(source.items))
    fail();
  if (
    !Number.isSafeInteger(expectedLimit) ||
    expectedLimit < 1 ||
    expectedLimit > 200 ||
    source.items.length > expectedLimit
  )
    fail();
  if (
    !Number.isSafeInteger(source.total) ||
    (source.total as number) < source.items.length
  ) {
    fail();
  }
  const snapshotAt = timestamp(source.snapshotAt);
  const nextCursor = optionalCursor(source.nextCursor);
  const ids = new Set<string>();
  const phones = new Set<string>();
  let priorAt = Number.POSITIVE_INFINITY;
  let priorId = "";
  const items = source.items.map((value) => {
    const decoded = decodeSmsSuppressionRow(value);
    const { id, phone_e164: phoneE164, created_at: createdAt } = decoded;
    const createdTime = Date.parse(createdAt);
    if (
      ids.has(id) ||
      phones.has(phoneE164) ||
      (expectedReason !== undefined && decoded.reason !== expectedReason) ||
      (expectedPhone !== undefined && phoneE164 !== expectedPhone) ||
      createdTime > Date.parse(snapshotAt) ||
      createdTime > priorAt ||
      (createdTime === priorAt && priorId !== "" && id >= priorId)
    ) {
      fail();
    }
    ids.add(id);
    phones.add(phoneE164);
    priorAt = createdTime;
    priorId = id;
    return decoded;
  });
  if (
    nextCursor &&
    ((source.total as number) <= items.length || items.length !== expectedLimit)
  )
    fail();
  if (
    expectedPhone !== undefined &&
    ((source.total as number) > 1 || nextCursor !== undefined)
  )
    fail();
  return {
    tenantId,
    items,
    total: source.total as number,
    snapshotAt,
    ...(nextCursor ? { nextCursor } : {}),
  };
}

export function mergeSmsSuppressionPages(
  pages: readonly SmsSuppressionsPage[],
): {
  items: SmsSuppressionRow[];
  total: number;
  snapshotAt: string | null;
  hasMore: boolean;
} {
  if (pages.length === 0) {
    return { items: [], total: 0, snapshotAt: null, hasMore: false };
  }
  const first = pages[0]!;
  const items: SmsSuppressionRow[] = [];
  const ids = new Set<string>();
  const phones = new Set<string>();
  let priorAt = Number.POSITIVE_INFINITY;
  let priorId = "";
  for (const page of pages) {
    if (
      page.tenantId !== first.tenantId ||
      page.snapshotAt !== first.snapshotAt ||
      page.total !== first.total
    ) {
      fail();
    }
    for (const row of page.items) {
      const createdTime = Date.parse(row.created_at);
      if (
        ids.has(row.id) ||
        phones.has(row.phone_e164) ||
        createdTime > priorAt ||
        (createdTime === priorAt && priorId !== "" && row.id >= priorId)
      ) {
        fail();
      }
      ids.add(row.id);
      phones.add(row.phone_e164);
      priorAt = createdTime;
      priorId = row.id;
      items.push(row);
    }
  }
  const hasMore = Boolean(pages.at(-1)?.nextCursor);
  if (
    items.length > first.total ||
    (!hasMore && items.length !== first.total)
  ) {
    fail();
  }
  return {
    items,
    total: first.total,
    snapshotAt: first.snapshotAt,
    hasMore,
  };
}
