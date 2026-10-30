// SPDX-License-Identifier: AGPL-3.0-only

export type SmsKeywordAction = "reply_only" | "opt_out";

export interface SmsKeywordResponse {
  id: string;
  tenant_id: string;
  keyword: string;
  response_body: string;
  response_text: string;
  action: SmsKeywordAction;
  enabled: boolean;
  autoReplyDispatchAvailable: false;
  autoReplyDispatchUnavailableReason: "sms_auto_reply_dispatch_release_held";
  opt_in_count: number;
  created_at: string;
  updated_at: string;
}

export interface SmsKeywordResponseInput {
  keyword: string;
  response_body: string;
  action: "opt_out";
  enabled?: boolean;
}

export interface SmsKeywordDeleteReceipt {
  ok: true;
  tenantId: string;
  id: string;
}

export const SMS_AUTO_REPLY_DISPATCH_RELEASE_HELD_CODE =
  "sms_auto_reply_dispatch_release_held" as const;

const TENANT_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const KEYWORD_TOKEN = /^[A-Z0-9_.:-]+$/u;
const PROJECTION_TIME =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|([+-])(\d{2}):(\d{2}))$/u;
const RESERVED = new Set([
  "STOP",
  "STOPALL",
  "UNSUBSCRIBE",
  "CANCEL",
  "END",
  "QUIT",
  "REVOKE",
  "OPTOUT",
  "START",
  "UNSTOP",
  "HELP",
]);
const ROW_KEYS = [
  "id",
  "tenant_id",
  "keyword",
  "response_body",
  "response_text",
  "action",
  "enabled",
  "autoReplyDispatchAvailable",
  "autoReplyDispatchUnavailableReason",
  "opt_in_count",
  "created_at",
  "updated_at",
] as const;

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return (
    actual.length === wanted.length &&
    actual.every((key, index) => key === wanted[index])
  );
}

function unicodeSize(value: string): { bytes: number; runes: number } | null {
  let bytes = 0;
  let runes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const low = value.charCodeAt(index + 1);
      if (!(low >= 0xdc00 && low <= 0xdfff)) return null;
      index += 1;
      bytes += 4;
      runes += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return null;
    } else {
      bytes += unit <= 0x7f ? 1 : unit <= 0x7ff ? 2 : 3;
      runes += 1;
    }
  }
  return { bytes, runes };
}

function projectionTime(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const match = PROJECTION_TIME.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const offsetHour = match[7] === "Z" ? 0 : Number(match[9]);
  const offsetMinute = match[7] === "Z" ? 0 : Number(match[10]);
  if (
    year < 2000 ||
    year >= 2100 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > new Date(Date.UTC(year, month, 0)).getUTCDate() ||
    Number(match[4]) > 23 ||
    Number(match[5]) > 59 ||
    Number(match[6]) > 59 ||
    offsetHour > 14 ||
    offsetMinute > 59 ||
    (offsetHour === 14 && offsetMinute !== 0)
  ) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) &&
    parsed >= Date.UTC(2000, 0, 1) &&
    parsed < Date.UTC(2100, 0, 1)
    ? parsed
    : null;
}

export function canonicalSmsKeyword(value: unknown): string {
  if (typeof value !== "string") return "";
  const keyword = value.trim().toUpperCase();
  const size = unicodeSize(keyword);
  return keyword !== "" &&
    KEYWORD_TOKEN.test(keyword) &&
    size !== null &&
    size.runes <= 80 &&
    size.bytes <= 320 &&
    !RESERVED.has(keyword)
    ? keyword
    : "";
}

function validResponseBody(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.trim() === "" ||
    value.includes("\0")
  ) {
    return false;
  }
  const size = unicodeSize(value);
  return size !== null && size.runes <= 4800 && size.bytes <= 16384;
}

export function requireSmsKeywordTenant(value: string): string {
  if (!TENANT_UUID.test(value)) {
    throw new Error("SMS keyword responses require a canonical tenant UUID");
  }
  return value;
}

export function requireSmsKeywordId(value: string): string {
  if (!UUID_V4.test(value)) {
    throw new Error("SMS keyword responses require a canonical UUIDv4");
  }
  return value;
}

export function requireSmsKeywordVersion(value: string): string {
  if (projectionTime(value) === null) {
    throw new Error("Invalid SMS keyword updated_at revision");
  }
  return value;
}

export function decodeSmsKeywordResponse(
  raw: unknown,
  expectedTenantId: string,
): SmsKeywordResponse {
  const tenantId = requireSmsKeywordTenant(expectedTenantId);
  if (!record(raw) || !exactKeys(raw, ROW_KEYS)) {
    throw new Error("Invalid SMS keyword-response row");
  }
  const created = projectionTime(raw.created_at);
  const updated = projectionTime(raw.updated_at);
  const keyword = canonicalSmsKeyword(raw.keyword);
  if (
    typeof raw.id !== "string" ||
    !UUID_V4.test(raw.id) ||
    raw.tenant_id !== tenantId ||
    typeof raw.keyword !== "string" ||
    keyword !== raw.keyword ||
    !validResponseBody(raw.response_body) ||
    raw.response_text !== raw.response_body ||
    (raw.action !== "reply_only" && raw.action !== "opt_out") ||
    typeof raw.enabled !== "boolean" ||
    raw.autoReplyDispatchAvailable !== false ||
    raw.autoReplyDispatchUnavailableReason !==
      SMS_AUTO_REPLY_DISPATCH_RELEASE_HELD_CODE ||
    !Number.isInteger(raw.opt_in_count) ||
    Number(raw.opt_in_count) < 0 ||
    Number(raw.opt_in_count) > 2_147_483_647 ||
    created === null ||
    updated === null ||
    updated < created
  ) {
    throw new Error("Invalid SMS keyword-response row");
  }
  return raw as unknown as SmsKeywordResponse;
}

export function decodeSmsKeywordResponseList(
  raw: unknown,
  expectedTenantId: string,
): { tenantId: string; items: SmsKeywordResponse[] } {
  const tenantId = requireSmsKeywordTenant(expectedTenantId);
  if (
    !record(raw) ||
    !exactKeys(raw, ["tenantId", "items"]) ||
    raw.tenantId !== tenantId ||
    !Array.isArray(raw.items) ||
    raw.items.length > 512
  ) {
    throw new Error("Invalid SMS keyword-response envelope");
  }
  const items = raw.items.map((row) =>
    decodeSmsKeywordResponse(row, expectedTenantId),
  );
  const ids = new Set<string>();
  const keywords = new Set<string>();
  let previousKeyword = "";
  let previousId = "";
  for (const row of items) {
    if (
      ids.has(row.id) ||
      keywords.has(row.keyword) ||
      (previousKeyword !== "" &&
        (row.keyword < previousKeyword ||
          (row.keyword === previousKeyword && row.id <= previousId)))
    ) {
      throw new Error("Invalid SMS keyword-response row");
    }
    ids.add(row.id);
    keywords.add(row.keyword);
    previousKeyword = row.keyword;
    previousId = row.id;
  }
  return { tenantId, items };
}

export function decodeSmsKeywordDeleteReceipt(
  raw: unknown,
  expectedTenantId: string,
  expectedId: string,
): SmsKeywordDeleteReceipt {
  const tenantId = requireSmsKeywordTenant(expectedTenantId);
  const id = requireSmsKeywordId(expectedId);
  if (
    !record(raw) ||
    !exactKeys(raw, ["ok", "tenantId", "id"]) ||
    raw.ok !== true ||
    raw.tenantId !== tenantId ||
    raw.id !== id
  ) {
    throw new Error("Invalid SMS keyword deletion receipt");
  }
  return { ok: true, tenantId, id };
}
