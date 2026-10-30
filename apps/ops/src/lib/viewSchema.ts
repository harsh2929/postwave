// SPDX-License-Identifier: AGPL-3.0-only

export const MAX_VIEW_ROWS = 500;
export const MAX_VIEW_RESPONSE_BYTES = 1024 * 1024;

const CANONICAL_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const RFC3339_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function hasOnlyKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const requiredSet = new Set(required);
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key)) &&
    requiredSet.size === required.length
  );
}

export function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

function hasDisallowedControlCharacter(
  value: string,
  allowMultilineWhitespace: boolean,
): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code > 31 && code !== 127) continue;
    if (allowMultilineWhitespace && (code === 9 || code === 10 || code === 13)) {
      continue;
    }
    return true;
  }
  return false;
}

function isBoundedUTF8Text(
  value: unknown,
  maximumCodePoints: number,
  maximumBytes: number,
  allowMultilineWhitespace: boolean,
): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    [...value].length <= maximumCodePoints &&
    new TextEncoder().encode(value).byteLength <= maximumBytes &&
    !hasDisallowedControlCharacter(value, allowMultilineWhitespace)
  );
}

export function isBoundedText(
  value: unknown,
  maximumCodePoints: number,
  maximumBytes = maximumCodePoints * 4,
): value is string {
  return isBoundedUTF8Text(value, maximumCodePoints, maximumBytes, false);
}

export function isBoundedMultilineText(
  value: unknown,
  maximumCodePoints: number,
  maximumBytes = maximumCodePoints * 4,
): value is string {
  return isBoundedUTF8Text(value, maximumCodePoints, maximumBytes, true);
}

export function isCanonicalUUID(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value !== "00000000-0000-0000-0000-000000000000" &&
    CANONICAL_UUID.test(value)
  );
}

// A registry check id ("billing.dlq-depth"): lowercase only, since registry
// slugs are lowercase, and bounded so it can be safely placed in a forwarded
// path without an id like "../../v1/subscribers" aiming the operator's cookie
// at a different endpoint. The single definition both the board reader
// (board.ts) and the action proxy (opsApi.ts) validate against.
const CHECK_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/u;

export function isCheckID(value: unknown): value is string {
  return typeof value === "string" && CHECK_ID.test(value);
}

export function isTimestamp(value: unknown): value is string {
  if (!isBoundedText(value, 64, 64)) return false;
  const match = RFC3339_TIMESTAMP.exec(value);
  if (!match || !Number.isFinite(Date.parse(value))) return false;
  const [year, month, day] = value.slice(0, 10).split("-").map(Number);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth[month - 1];
}

export function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

export function isNonNegativeFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function parseTruncatedEnvelope(
  body: unknown,
  rowsKey: string,
): { rows: unknown[]; truncated: boolean } | undefined {
  if (!isRecord(body) || !hasOnlyKeys(body, [rowsKey, "truncated"])) {
    return undefined;
  }
  const rows = body[rowsKey];
  if (!Array.isArray(rows) || rows.length > MAX_VIEW_ROWS) return undefined;
  if (typeof body.truncated !== "boolean") return undefined;
  return { rows, truncated: body.truncated };
}

export function hasDuplicateKey<T>(
  rows: readonly T[],
  key: (row: T) => string,
): boolean {
  const seen = new Set<string>();
  for (const row of rows) {
    const value = key(row);
    if (seen.has(value)) return true;
    seen.add(value);
  }
  return false;
}
