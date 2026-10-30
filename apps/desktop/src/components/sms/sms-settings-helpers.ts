/**
 * sms-settings-helpers — pure helpers shared by SmsQuietHoursCard and
 * SmsKeywordResponsesCard.
 *
 * Kept in a plain .ts module (no JSX, no api-client runtime import) so
 * the node-environment vitest suite can import the real functions
 * instead of mirroring them (convention: notifications-panel-helpers,
 * subscriber-status).
 *
 * Day-of-week convention: the backend (apps/api/internal/sms/
 * quiet_hours.go) stores `days` as LOCAL weekdays with 0=Sunday ..
 * 6=Saturday — Go's time.Weekday / JS Date#getDay numbering, NOT ISO.
 * Everything here follows that.
 */

import type { SmsKeywordAction } from "../../lib/api/sms-keyword-responses";
import type { SmsKeywordResponseRow } from "../../lib/api/sms-keyword-responses";
import type { SmsQuietHoursRow } from "../../lib/api-client";

type UnknownRecord = Record<string, unknown>;

const CANONICAL_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const CANONICAL_UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const RFC3339 =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|([+-])(\d{2}):(\d{2}))$/u;
const UNSAFE_OPERATOR_TEXT = /[\p{Cc}\p{Cf}\p{Cs}]/u;
const ASCII_TOKEN = /^[A-Z0-9_.:-]+$/u;
const QUIET_POLICY_MAX_ITEMS = 256;
const KEYWORD_POLICY_MAX_ITEMS = 512;
const INT32_MAX = 2_147_483_647;
const QUIET_ROW_KEYS = new Set([
  "id",
  "tenant_id",
  "label",
  "country_code",
  "start_minute",
  "end_minute",
  "start_local",
  "end_local",
  "days",
  "timezone",
  "enabled",
  "created_at",
  "updated_at",
]);
const KEYWORD_ROW_KEYS = new Set([
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
]);

function isRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value: UnknownRecord, keys: ReadonlySet<string>): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.size && actual.every((key) => keys.has(key));
}

function isSafeText(
  value: unknown,
  {
    allowEmpty,
    maxBytes,
    maxScalars,
  }: {
    allowEmpty: boolean;
    maxBytes: number;
    maxScalars: number;
  },
): value is string {
  if (
    typeof value !== "string" ||
    value.trim() !== value ||
    (!allowEmpty && value === "") ||
    UNSAFE_OPERATOR_TEXT.test(value)
  ) {
    return false;
  }
  return (
    Array.from(value).length <= maxScalars &&
    new TextEncoder().encode(value).byteLength <= maxBytes
  );
}

function isSafeUntrimmedOperatorText(
  value: unknown,
  maxScalars: number,
  maxBytes: number,
): value is string {
  return (
    typeof value === "string" &&
    !UNSAFE_OPERATOR_TEXT.test(value) &&
    Array.from(value).length <= maxScalars &&
    new TextEncoder().encode(value).byteLength <= maxBytes
  );
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

/** Mirrors validSMSInboxBody: body text is content, not trusted UI chrome. */
function isSmsBody(value: unknown): value is string {
  return (
    typeof value === "string" &&
    !hasUnpairedSurrogate(value) &&
    !value.includes("\u0000") &&
    value.trim().length > 0 &&
    Array.from(value).length <= 4_800 &&
    new TextEncoder().encode(value).byteLength <= 16_384
  );
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    return leap ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function timestampMillis(value: unknown): number | null {
  if (typeof value !== "string" || value.length > 64) return null;
  const parts = RFC3339.exec(value);
  if (!parts) return null;
  const year = Number(parts[1]);
  const month = Number(parts[2]);
  const day = Number(parts[3]);
  const offsetHour = Number(parts[8] ?? 0);
  const offsetMinute = Number(parts[9] ?? 0);
  if (
    year < 2000 ||
    year >= 2100 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth(year, month) ||
    Number(parts[4]) > 23 ||
    Number(parts[5]) > 59 ||
    Number(parts[6]) > 59 ||
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

function isTimezone(value: unknown): value is string {
  if (
    !isSafeText(value, { allowEmpty: false, maxBytes: 512, maxScalars: 128 })
  ) {
    return false;
  }
  try {
    new Intl.DateTimeFormat("en", { timeZone: value }).format(0);
    return true;
  } catch {
    return false;
  }
}

/** Renderer-side mirror for operator text written into trusted policy chrome. */
export function isSafeSmsOperatorText(
  value: string,
  maxScalars: number,
  maxBytes = maxScalars * 4,
  allowEmpty = true,
): boolean {
  return isSafeText(value, { allowEmpty, maxBytes, maxScalars });
}

/** A bounded safe IANA zone that the current runtime can resolve. */
export function isValidSmsTimezone(value: string): boolean {
  return isTimezone(value);
}

/** Exact custom-keyword token admitted by the private SMS policy contract. */
export function isValidSmsKeywordToken(value: string): boolean {
  return (
    isSafeText(value, {
      allowEmpty: false,
      maxBytes: 320,
      maxScalars: 80,
    }) &&
    value === value.toUpperCase() &&
    ASCII_TOKEN.test(value)
  );
}

/** User input form before ASCII-only upper-casing; rejects Unicode aliases. */
export function isValidSmsKeywordInput(value: string): boolean {
  return (
    isSafeText(value, {
      allowEmpty: false,
      maxBytes: 320,
      maxScalars: 80,
    }) && /^[A-Za-z0-9_.:-]+$/u.test(value)
  );
}

function isExpectedTenant(value: unknown, expectedTenantId: string): boolean {
  return (
    CANONICAL_UUID.test(expectedTenantId) &&
    typeof value === "string" &&
    CANONICAL_UUID.test(value) &&
    value === expectedTenantId
  );
}

function isMinute(value: unknown): value is number {
  return (
    Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) < 1440
  );
}

function isStrictQuietRow(
  row: unknown,
  expectedTenantId: string,
): row is SmsQuietHoursRow {
  if (!isRecord(row) || !hasOnlyKeys(row, QUIET_ROW_KEYS)) return false;
  const created = timestampMillis(row.created_at);
  const updated = timestampMillis(row.updated_at);
  const days = row.days;
  if (
    typeof row.id !== "string" ||
    !CANONICAL_UUID_V4.test(row.id) ||
    !isExpectedTenant(row.tenant_id, expectedTenantId) ||
    !isSafeUntrimmedOperatorText(row.label, 128, 512) ||
    (row.country_code !== "" &&
      row.country_code !== "US" &&
      row.country_code !== "CA") ||
    !isMinute(row.start_minute) ||
    !isMinute(row.end_minute) ||
    row.start_local !== minuteToHHMM(row.start_minute) ||
    row.end_local !== minuteToHHMM(row.end_minute) ||
    !Array.isArray(days) ||
    days.length < 1 ||
    days.length > 7 ||
    !days.every(
      (day, index) =>
        Number.isSafeInteger(day) &&
        Number(day) >= 0 &&
        Number(day) <= 6 &&
        (index === 0 || Number(day) > Number(days[index - 1])),
    ) ||
    !isTimezone(row.timezone) ||
    typeof row.enabled !== "boolean" ||
    created === null ||
    updated === null ||
    updated < created
  ) {
    return false;
  }
  return true;
}

function isStrictKeywordRow(
  row: unknown,
  expectedTenantId: string,
): row is SmsKeywordDispatchRow {
  if (!isRecord(row) || !hasOnlyKeys(row, KEYWORD_ROW_KEYS)) return false;
  const created = timestampMillis(row.created_at);
  const updated = timestampMillis(row.updated_at);
  return (
    typeof row.id === "string" &&
    CANONICAL_UUID_V4.test(row.id) &&
    isExpectedTenant(row.tenant_id, expectedTenantId) &&
    isSafeText(row.keyword, {
      allowEmpty: false,
      maxBytes: 320,
      maxScalars: 80,
    }) &&
    row.keyword === row.keyword.toUpperCase() &&
    ASCII_TOKEN.test(row.keyword) &&
    !isReservedSmsKeyword(row.keyword) &&
    isSmsBody(row.response_body) &&
    row.response_text === row.response_body &&
    (row.action === "reply_only" || row.action === "opt_out") &&
    typeof row.enabled === "boolean" &&
    row.autoReplyDispatchAvailable === false &&
    row.autoReplyDispatchUnavailableReason ===
      "sms_auto_reply_dispatch_release_held" &&
    Number.isSafeInteger(row.opt_in_count) &&
    Number(row.opt_in_count) >= 0 &&
    Number(row.opt_in_count) <= INT32_MAX &&
    created !== null &&
    updated !== null &&
    updated >= created
  );
}

/** Fail closed on a malformed 2xx quiet-hours envelope. */
export function parseSmsQuietHoursRows(
  value: unknown,
  expectedTenantId: string,
): SmsQuietHoursRow[] | null {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, new Set(["tenantId", "items"])) ||
    !isExpectedTenant(value.tenantId, expectedTenantId) ||
    !Array.isArray(value.items) ||
    value.items.length > QUIET_POLICY_MAX_ITEMS ||
    !value.items.every((row) => isStrictQuietRow(row, expectedTenantId))
  )
    return null;
  const ids = new Set<string>();
  for (const [index, row] of value.items.entries()) {
    if (ids.has(row.id)) return null;
    const previous = value.items[index - 1];
    if (previous) {
      const previousCreated = timestampMillis(previous.created_at);
      const created = timestampMillis(row.created_at);
      if (
        previousCreated === null ||
        created === null ||
        previousCreated > created ||
        (previousCreated === created && previous.id >= row.id)
      ) {
        return null;
      }
    }
    ids.add(row.id);
  }
  return value.items;
}

/** Fail closed before keyword rows reach string/action rendering helpers. */
export function parseSmsKeywordResponseRows(
  value: unknown,
  expectedTenantId: string,
): SmsKeywordDispatchRow[] | null {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, new Set(["tenantId", "items"])) ||
    !isExpectedTenant(value.tenantId, expectedTenantId) ||
    !Array.isArray(value.items) ||
    value.items.length > KEYWORD_POLICY_MAX_ITEMS ||
    !value.items.every((row) => isStrictKeywordRow(row, expectedTenantId))
  )
    return null;
  const ids = new Set<string>();
  const keywords = new Set<string>();
  for (const [index, row] of value.items.entries()) {
    if (ids.has(row.id) || keywords.has(row.keyword)) return null;
    const previous = value.items[index - 1];
    if (
      previous &&
      (previous.keyword > row.keyword ||
        (previous.keyword === row.keyword && previous.id >= row.id))
    ) {
      return null;
    }
    ids.add(row.id);
    keywords.add(row.keyword);
  }
  return value.items;
}

/** Strict receipt for policy deletion endpoints (unknown fields fail closed). */
export function parseSmsPolicyDeleteReceipt(
  value: unknown,
  expectedTenantId: string,
  expectedId: string,
): boolean {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, new Set(["ok", "tenantId", "id"])) &&
    value.ok === true &&
    isExpectedTenant(value.tenantId, expectedTenantId) &&
    CANONICAL_UUID_V4.test(expectedId) &&
    value.id === expectedId
  );
}

export type SmsKeywordDispatchRow = SmsKeywordResponseRow & {
  autoReplyDispatchAvailable: boolean;
  autoReplyDispatchUnavailableReason?:
    | "sms_auto_reply_dispatch_release_held"
    | undefined;
};

/* ---------- quiet hours ------------------------------------------- */

export const QUIET_DAY_OPTIONS: ReadonlyArray<{
  value: number;
  short: string;
  long: string;
}> = [
  { value: 0, short: "Sun", long: "Sunday" },
  { value: 1, short: "Mon", long: "Monday" },
  { value: 2, short: "Tue", long: "Tuesday" },
  { value: 3, short: "Wed", long: "Wednesday" },
  { value: 4, short: "Thu", long: "Thursday" },
  { value: 5, short: "Fri", long: "Friday" },
  { value: 6, short: "Sat", long: "Saturday" },
];

/** 0..1439 → "HH:MM". Out-of-range values clamp into the day. */
export function minuteToHHMM(minute: number): string {
  const m = Math.min(1439, Math.max(0, Math.trunc(minute)));
  const h = Math.trunc(m / 60);
  const mm = m % 60;
  return `${String(h).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

/**
 * Strict 24-hour "HH:MM" → minutes-since-midnight, or null when the
 * string isn't a valid time. `<input type="time">` emits this format,
 * but the value can also be "" (cleared) — that returns null too.
 */
export function hhmmToMinute(value: string): number | null {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value.trim());
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

/**
 * An overnight window starts late and ends the next morning
 * (start > end, e.g. 21:00 → 09:00). Valid per the backend window
 * math; the window stays active past midnight into the next day.
 */
export function isOvernightWindow(
  startMinute: number,
  endMinute: number,
): boolean {
  return startMinute > endMinute;
}

/** Dedupes, drops out-of-range values, and sorts Sun→Sat. */
export function normalizeQuietDays(days: number[]): number[] {
  const seen = new Set<number>();
  for (const d of days) {
    if (Number.isInteger(d) && d >= 0 && d <= 6) seen.add(d);
  }
  return [...seen].sort((a, b) => a - b);
}

/**
 * Human label for a `days` array: "Every day", "Weekdays",
 * "Weekends", or the short names ("Mon, Wed, Fri").
 */
export function formatQuietDays(days: number[]): string {
  const norm = normalizeQuietDays(days);
  if (norm.length === 0) return "—";
  if (norm.length === 7) return "Every day";
  const key = norm.join(",");
  if (key === "1,2,3,4,5") return "Weekdays";
  if (key === "0,6") return "Weekends";
  return norm.map((d) => QUIET_DAY_OPTIONS[d]?.short ?? String(d)).join(", ");
}

/**
 * Display label for a window's time range. Mirrors the backend
 * semantics (quiet_hours.go):
 *   - start == end  → the whole listed day is quiet ("All day")
 *   - start >  end  → overnight, crosses midnight into the next day
 *   - start <  end  → plain same-day range
 */
export function quietWindowLabel(
  startMinute: number,
  endMinute: number,
): string {
  if (startMinute === endMinute) return "All day";
  const range = `${minuteToHHMM(startMinute)} – ${minuteToHHMM(endMinute)}`;
  return isOvernightWindow(startMinute, endMinute)
    ? `${range} (overnight)`
    : range;
}

/* ---------- keyword responses -------------------------------------- */

/**
 * Carrier compliance keywords the server refuses to store as tenant
 * rows (422 `reserved_keyword`; migration 0370 CHECK backs it).
 * Mirrors reservedSMSKeywords in apps/api/internal/sms/
 * keyword_responses.go — keep in sync.
 */
export const RESERVED_SMS_KEYWORDS: ReadonlyArray<string> = [
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
];

/** Canonical keyword form: trimmed + upper-cased (server does the same). */
export function normalizeSmsKeyword(raw: string): string {
  return raw.trim().toUpperCase();
}

/** Case-insensitive reserved check (matches ReservedSMSKeyword in Go). */
export function isReservedSmsKeyword(raw: string): boolean {
  return RESERVED_SMS_KEYWORDS.includes(normalizeSmsKeyword(raw));
}

/**
 * Inbound matching uses the FIRST word of the message, so a keyword
 * containing whitespace can never match. Server 422s on these.
 */
export function smsKeywordHasWhitespace(raw: string): boolean {
  return /\s/.test(raw.trim());
}

export const SMS_KEYWORD_ACTIONS: ReadonlyArray<{
  value: SmsKeywordAction;
  label: string;
  description: string;
}> = [
  {
    value: "opt_out",
    label: "Opt-out state rule",
    description:
      "Record revoked consent and a suppression row when the inbound keyword matches. Automatic confirmation dispatch is release-held.",
  },
];

/** Only opt-out rows mutate state; reply-only rows are held/read-only. */
export function canMutateSmsKeywordAction(action: string): boolean {
  return action === "opt_out";
}

/** Badge metadata for an action value (unknown values fall back gray). */
export function keywordActionMeta(action: string): {
  label: string;
  badgeClass: string;
} {
  switch (action) {
    case "opt_out":
      return { label: "Opt out", badgeClass: "badge danger" };
    case "reply_only":
      return { label: "Stored reply — dispatch held", badgeClass: "badge" };
    default:
      return { label: action || "—", badgeClass: "badge" };
  }
}

/** Single-line preview for list rows: collapse whitespace + ellipsize. */
export function previewSmsResponse(body: string, max = 80): string {
  const flat = body.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}
