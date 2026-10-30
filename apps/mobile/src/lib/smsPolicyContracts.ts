/** Strict, tenant-bound decoders for the private Route42 policy registries. */
import type {
  SmsKeywordAction,
  SmsKeywordResponse,
  SmsQuietHoursRule,
} from "./smsPolicies";
import {
  asSmsPolicyWireRow,
  expectedSmsPolicyTenant,
  SMS_POLICY_UUID_V4,
  smsPolicyEnvelopeItems,
  smsPolicyExactKeys,
  smsPolicyProjectionPair,
  smsPolicyTimestamp,
  smsPolicyUnicodeSize,
  type SmsPolicyWireRow,
  validSmsPolicyText,
  validSmsPolicyTimezone,
} from "./smsPolicyWire";

const KEYWORD_TOKEN = /^[A-Z0-9_.:-]+$/u;
const AUTO_REPLY_HOLD = "sms_auto_reply_dispatch_release_held" as const;

const QUIET_KEYS = [
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
] as const;

const KEYWORD_KEYS = [
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

const KEYWORD_ACTIONS: readonly SmsKeywordAction[] = ["reply_only", "opt_out"];

/** Provider-reserved state commands cannot be replaced by tenant policy. */
export const RESERVED_SMS_KEYWORDS = [
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
] as const;

const RESERVED_SMS_KEYWORD_SET = new Set<string>(RESERVED_SMS_KEYWORDS);

interface QuietIdentity {
  id: string;
  label: string;
  countryCode: string;
}

interface QuietWindow {
  startMinute: number;
  endMinute: number;
  days: number[];
}

interface KeywordIdentity {
  id: string;
  keyword: string;
}

interface KeywordReply {
  responseBody: string;
  action: SmsKeywordAction;
}

function localMinute(value: unknown, rendered: unknown): number | null {
  if (!Number.isInteger(value) || Number(value) < 0 || Number(value) >= 1440) {
    return null;
  }
  const minute = Number(value);
  const expected = `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
  return rendered === expected ? minute : null;
}

function quietDays(value: unknown): number[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > 7)
    return null;
  const valid = value.every(
    (day, index) =>
      Number.isInteger(day) &&
      Number(day) >= 0 &&
      Number(day) <= 6 &&
      (index === 0 || Number(day) > Number(value[index - 1])),
  );
  return valid ? ([...value] as number[]) : null;
}

function quietIdentity(
  row: SmsPolicyWireRow,
  tenant: string,
): QuietIdentity | null {
  if (
    !smsPolicyExactKeys(row, QUIET_KEYS) ||
    typeof row.id !== "string" ||
    !SMS_POLICY_UUID_V4.test(row.id) ||
    row.tenant_id !== tenant ||
    !validSmsPolicyText(row.label, 128, 512) ||
    (row.country_code !== "" &&
      row.country_code !== "US" &&
      row.country_code !== "CA")
  ) {
    return null;
  }
  return {
    id: row.id,
    label: row.label,
    countryCode: row.country_code,
  };
}

function quietWindow(row: SmsPolicyWireRow): QuietWindow | null {
  const startMinute = localMinute(row.start_minute, row.start_local);
  const endMinute = localMinute(row.end_minute, row.end_local);
  const days = quietDays(row.days);
  if (startMinute === null || endMinute === null || !days) return null;
  return { startMinute, endMinute, days };
}

function decodeQuietRow(
  row: SmsPolicyWireRow,
  tenant: string,
): SmsQuietHoursRule | null {
  const identity = quietIdentity(row, tenant);
  const window = quietWindow(row);
  const projection = smsPolicyProjectionPair(row);
  if (
    !identity ||
    !window ||
    !projection ||
    !validSmsPolicyTimezone(row.timezone) ||
    typeof row.enabled !== "boolean"
  ) {
    return null;
  }
  return {
    ...identity,
    ...window,
    timezone: row.timezone,
    enabled: row.enabled,
    createdAt: projection.createdText,
    updatedAt: projection.updatedText,
  };
}

/** Rejects a malformed row rather than silently presenting an incomplete policy. */
export function parseQuietHoursRules(
  payload: unknown,
  expectedTenantId: string,
): SmsQuietHoursRule[] {
  const tenant = expectedSmsPolicyTenant(expectedTenantId);
  const rows = smsPolicyEnvelopeItems(payload, tenant, 256, "quiet-hours");
  const out: SmsQuietHoursRule[] = [];
  const seen = new Set<string>();
  let previousCreated = -1;
  let previousId = "";
  for (const entry of rows) {
    const wire = asSmsPolicyWireRow(entry);
    const decoded = wire ? decodeQuietRow(wire, tenant) : null;
    const created = decoded ? smsPolicyTimestamp(decoded.createdAt) : null;
    if (
      !decoded ||
      created === null ||
      seen.has(decoded.id) ||
      created < previousCreated ||
      (created === previousCreated && decoded.id <= previousId)
    ) {
      throw new Error("Invalid SMS quiet-hours row");
    }
    seen.add(decoded.id);
    previousCreated = created;
    previousId = decoded.id;
    out.push(decoded);
  }
  return out;
}

function validKeyword(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const size = smsPolicyUnicodeSize(value);
  return (
    value !== "" &&
    value.trim() === value &&
    value.toUpperCase() === value &&
    KEYWORD_TOKEN.test(value) &&
    size !== null &&
    size.runes <= 80 &&
    size.bytes <= 320 &&
    !RESERVED_SMS_KEYWORD_SET.has(value)
  );
}

function keywordIdentity(
  row: SmsPolicyWireRow,
  tenant: string,
): KeywordIdentity | null {
  if (
    !smsPolicyExactKeys(row, KEYWORD_KEYS) ||
    typeof row.id !== "string" ||
    !SMS_POLICY_UUID_V4.test(row.id) ||
    row.tenant_id !== tenant ||
    !validKeyword(row.keyword)
  ) {
    return null;
  }
  return { id: row.id, keyword: row.keyword };
}

function keywordReply(row: SmsPolicyWireRow): KeywordReply | null {
  if (
    typeof row.response_body !== "string" ||
    typeof row.response_text !== "string" ||
    row.response_body !== row.response_text ||
    !KEYWORD_ACTIONS.includes(row.action as SmsKeywordAction)
  ) {
    return null;
  }
  const size = smsPolicyUnicodeSize(row.response_body);
  if (
    size === null ||
    size.runes > 4800 ||
    size.bytes > 16384 ||
    row.response_body.trim() === "" ||
    row.response_body.includes("\0")
  ) {
    return null;
  }
  return {
    responseBody: row.response_body,
    action: row.action as SmsKeywordAction,
  };
}

function validKeywordPolicy(row: SmsPolicyWireRow): boolean {
  return (
    typeof row.enabled === "boolean" &&
    row.autoReplyDispatchAvailable === false &&
    row.autoReplyDispatchUnavailableReason === AUTO_REPLY_HOLD &&
    Number.isInteger(row.opt_in_count) &&
    Number(row.opt_in_count) >= 0 &&
    Number(row.opt_in_count) <= 2_147_483_647
  );
}

function decodeKeywordRow(
  row: SmsPolicyWireRow,
  tenant: string,
): SmsKeywordResponse | null {
  const identity = keywordIdentity(row, tenant);
  const reply = keywordReply(row);
  const projection = smsPolicyProjectionPair(row);
  if (!identity || !reply || !projection || !validKeywordPolicy(row)) {
    return null;
  }
  return {
    ...identity,
    ...reply,
    enabled: row.enabled as boolean,
    optInCount: Number(row.opt_in_count),
    autoReplyDispatchAvailable: false,
    autoReplyDispatchUnavailableReason: AUTO_REPLY_HOLD,
    createdAt: projection.createdText,
    updatedAt: projection.updatedText,
  };
}

/** Rejects duplicates, aliases that disagree, and noncanonical ordering. */
export function parseKeywordResponses(
  payload: unknown,
  expectedTenantId: string,
): SmsKeywordResponse[] {
  const tenant = expectedSmsPolicyTenant(expectedTenantId);
  const rows = smsPolicyEnvelopeItems(payload, tenant, 512, "keyword-response");
  const out: SmsKeywordResponse[] = [];
  const seenIds = new Set<string>();
  const seenKeywords = new Set<string>();
  let previousKeyword = "";
  let previousId = "";
  for (const entry of rows) {
    const wire = asSmsPolicyWireRow(entry);
    const decoded = wire ? decodeKeywordRow(wire, tenant) : null;
    if (
      !decoded ||
      seenIds.has(decoded.id) ||
      seenKeywords.has(decoded.keyword) ||
      (previousKeyword !== "" &&
        (decoded.keyword < previousKeyword ||
          (decoded.keyword === previousKeyword && decoded.id <= previousId)))
    ) {
      throw new Error("Invalid SMS keyword-response row");
    }
    seenIds.add(decoded.id);
    seenKeywords.add(decoded.keyword);
    previousKeyword = decoded.keyword;
    previousId = decoded.id;
    out.push(decoded);
  }
  return out;
}
