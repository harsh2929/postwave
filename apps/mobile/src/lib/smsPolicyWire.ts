/** Shared strict primitives for tenant-bound SMS policy wire decoders. */
import { isKnownTimezone } from "./sendingForm";

const PROJECTION_TIME =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|([+-])(\d{2}):(\d{2}))$/u;
const SAFE_CONTROL_OR_FORMAT = /[\p{Cc}\p{Cf}]/u;
const CANONICAL_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

export const SMS_POLICY_UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export type SmsPolicyWireRow = Record<string, unknown>;

export interface SmsPolicyProjectionPair {
  created: number;
  updated: number;
  createdText: string;
  updatedText: string;
}

export function asSmsPolicyWireRow(value: unknown): SmsPolicyWireRow | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as SmsPolicyWireRow)
    : null;
}

export function smsPolicyExactKeys(
  row: SmsPolicyWireRow,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(row).sort();
  const wanted = [...expected].sort();
  return (
    actual.length === wanted.length &&
    actual.every((key, index) => key === wanted[index])
  );
}

export function expectedSmsPolicyTenant(value: string): string {
  if (!CANONICAL_UUID.test(value)) {
    throw new Error("Invalid SMS policy tenant identity");
  }
  return value;
}

export function smsPolicyEnvelopeItems(
  payload: unknown,
  expectedTenant: string,
  maximum: number,
  label: string,
): unknown[] {
  const envelope = asSmsPolicyWireRow(payload);
  if (
    !envelope ||
    !smsPolicyExactKeys(envelope, ["tenantId", "items"]) ||
    envelope.tenantId !== expectedTenant ||
    !Array.isArray(envelope.items) ||
    envelope.items.length > maximum
  ) {
    throw new Error(`Invalid SMS ${label} envelope`);
  }
  return envelope.items;
}

export function smsPolicyUnicodeSize(
  value: string,
): { bytes: number; runes: number } | null {
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

export function validSmsPolicyText(
  value: unknown,
  maxRunes: number,
  maxBytes: number,
): value is string {
  if (typeof value !== "string") return false;
  const size = smsPolicyUnicodeSize(value);
  return (
    size !== null &&
    size.runes <= maxRunes &&
    size.bytes <= maxBytes &&
    !SAFE_CONTROL_OR_FORMAT.test(value)
  );
}

export function smsPolicyTimestamp(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const match = PROJECTION_TIME.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[7] === "Z" ? 0 : Number(match[9]);
  const offsetMinute = match[7] === "Z" ? 0 : Number(match[10]);
  const maxDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (
    year < 2000 ||
    year >= 2100 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > maxDay ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
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

export function smsPolicyProjectionPair(
  row: SmsPolicyWireRow,
): SmsPolicyProjectionPair | null {
  const created = smsPolicyTimestamp(row.created_at);
  const updated = smsPolicyTimestamp(row.updated_at);
  if (created === null || updated === null || updated < created) return null;
  return {
    created,
    updated,
    createdText: row.created_at as string,
    updatedText: row.updated_at as string,
  };
}

export function validSmsPolicyTimezone(value: unknown): value is string {
  if (
    !validSmsPolicyText(value, 128, 512) ||
    value === "" ||
    value.trim() !== value
  ) {
    return false;
  }
  // The engine-knows-this-zone question is owned by `sendingForm`
  // (isKnownTimezone) so exactly one module in the app constructs an Intl
  // formatter for it — see lib/format.consistency's Intl allowlist. The text
  // rules above already reject "" and untrimmed input, so this is purely the
  // zone-database lookup.
  return isKnownTimezone(value);
}
