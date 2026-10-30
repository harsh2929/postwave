/**
 * Field-level Helpdesk wire primitives: the checks every row, page and catalog
 * parser is built from.
 *
 * Two rules are load-bearing here rather than at the call sites. Unknown
 * fields are REFUSED (`exactObject`/`allowedObject`), so a server that starts
 * sending something this release cannot reason about fails closed instead of
 * being silently dropped. And display strings are rejected outright when they
 * carry hidden control or bidirectional-override characters, because a
 * conversation is attacker-supplied text rendered to an admin.
 */
import {
  HelpdeskContractError,
  type HelpdeskPageInfo,
} from "@/lib/helpdeskTypes";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const TOKEN_RE = /^[a-z0-9_-]{1,64}$/u;
const RFC3339_NANO_UTC_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u;
const HELPDESK_TIME_MIN_MS = Date.UTC(2000, 0, 1);
const HELPDESK_TIME_MAX_MS = Date.UTC(2100, 0, 1);
export const UNSAFE_DISPLAY_RE =
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/u;
const UNSAFE_OPAQUE_CURSOR_RE =
  /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/u;

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HelpdeskContractError(label + " must be an object");
  }
  return value as Record<string, unknown>;
}

export function exactObject(
  value: unknown,
  label: string,
  expectedKeys: readonly string[],
): Record<string, unknown> {
  const raw = object(value, label);
  const actual = Object.keys(raw).sort();
  const expected = [...expectedKeys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new HelpdeskContractError(label + " has unsupported fields");
  }
  return raw;
}

export function allowedObject(
  value: unknown,
  label: string,
  allowedKeys: readonly string[],
): Record<string, unknown> {
  const raw = object(value, label);
  const allowed = new Set(allowedKeys);
  if (Object.keys(raw).some((key) => !allowed.has(key))) {
    throw new HelpdeskContractError(label + " has unsupported fields");
  }
  return raw;
}

export function displayString(
  value: unknown,
  label: string,
  maxBytes: number,
  required = false,
): string | null {
  if (value === undefined || value === null || value === "") {
    if (required) throw new HelpdeskContractError(label + " is required");
    return null;
  }
  if (typeof value !== "string") {
    throw new HelpdeskContractError(label + " must be a string");
  }
  if (UNSAFE_DISPLAY_RE.test(value)) {
    throw new HelpdeskContractError(
      label + " contains hidden control characters and was not displayed",
    );
  }
  if (!value.trim()) {
    throw new HelpdeskContractError(
      required ? label + " is required" : label + " is invalid",
    );
  }
  if (helpdeskUtf8Bytes(value) > maxBytes) {
    throw new HelpdeskContractError(label + " is too long to display safely");
  }
  return value;
}

export function normalizeHelpdeskOpaqueCursor(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim() ||
    value.length > 4096 ||
    UNSAFE_OPAQUE_CURSOR_RE.test(value)
  ) {
    throw new HelpdeskContractError("Helpdesk cursor is invalid");
  }
  return value;
}

export function canonicalUUID(value: unknown, label: string): string {
  if (typeof value !== "string" || !UUID_RE.test(value)) {
    throw new HelpdeskContractError(label + " is invalid");
  }
  return value;
}

export function normalizeHelpdeskId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const id = value.trim().toLowerCase();
  return UUID_RE.test(id) ? id : null;
}

export function token(
  value: unknown,
  label: string,
  required = false,
): string | null {
  const parsed = displayString(value, label, 64, required);
  if (parsed !== null && !TOKEN_RE.test(parsed)) {
    throw new HelpdeskContractError(label + " is invalid");
  }
  return parsed;
}

export function enumToken(
  value: unknown,
  label: string,
  allowedValues: ReadonlySet<string>,
): string {
  const parsed = token(value, label, true) as string;
  if (!allowedValues.has(parsed)) {
    throw new HelpdeskContractError(label + " is unsupported");
  }
  return parsed;
}

export function timestamp(
  value: unknown,
  label: string,
  required = false,
): string | null {
  const raw = displayString(value, label, 64, required);
  if (raw === null) return null;
  const match = RFC3339_NANO_UTC_RE.exec(raw);
  const fraction = /\.(\d+)Z$/u.exec(raw)?.[1] ?? null;
  const epochMillis = Date.parse(raw);
  if (
    !match ||
    (fraction !== null && fraction.endsWith("0")) ||
    !Number.isFinite(epochMillis) ||
    !calendarTimestampMatches(raw, epochMillis) ||
    epochMillis < HELPDESK_TIME_MIN_MS ||
    epochMillis >= HELPDESK_TIME_MAX_MS
  ) {
    throw new HelpdeskContractError(label + " is invalid");
  }
  return raw;
}

function calendarTimestampMatches(raw: string, epochMillis: number): boolean {
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/u.exec(raw);
  if (!parts) return false;
  const date = new Date(epochMillis);
  return (
    date.getUTCFullYear() === Number(parts[1]) &&
    date.getUTCMonth() + 1 === Number(parts[2]) &&
    date.getUTCDate() === Number(parts[3]) &&
    date.getUTCHours() === Number(parts[4]) &&
    date.getUTCMinutes() === Number(parts[5]) &&
    date.getUTCSeconds() === Number(parts[6])
  );
}

export function resourceVersion(value: unknown, label = "version"): string {
  return timestamp(value, label, true) as string;
}

export function helpdeskStrongEntityTag(
  value: string | null | undefined,
  version: string,
): string {
  const expected = `"${version}"`;
  if (value !== expected) {
    throw new HelpdeskContractError(
      "Helpdesk response omitted its exact strong resource validator",
    );
  }
  return expected;
}

export function stringList(value: unknown, label: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value))
    throw new HelpdeskContractError(label + " must be an array");
  return value.map((item, index) => {
    const parsed = displayString(item, label + "[" + index + "]", 100, true);
    return parsed as string;
  });
}

export function boundedStringList(
  value: unknown,
  label: string,
  maxItems: number,
  maxItemBytes: number,
): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > maxItems) {
    throw new HelpdeskContractError(label + " exceeds its safe item bound");
  }
  return value.map(
    (item, index) =>
      displayString(
        item,
        label + "[" + index + "]",
        maxItemBytes,
        true,
      ) as string,
  );
}

export function assertRowTenant(
  raw: Record<string, unknown>,
  expectedTenantId: string,
): string {
  const tenantId = canonicalUUID(raw["tenant_id"], "tenant_id");
  const tenantBinding = canonicalUUID(raw["tenantId"], "tenantId");
  const expected = normalizeHelpdeskId(expectedTenantId);
  if (!expected || tenantId !== tenantBinding || tenantId !== expected) {
    throw new HelpdeskContractError(
      "Helpdesk response crossed the active tenant boundary",
    );
  }
  return tenantId;
}

export function assertEnvelopeTenant(
  raw: Record<string, unknown>,
  expectedTenantId: string,
): string {
  const tenantId = canonicalUUID(raw["tenantId"], "tenantId");
  const expected = normalizeHelpdeskId(expectedTenantId);
  if (!expected || tenantId !== expected) {
    throw new HelpdeskContractError(
      "Helpdesk envelope crossed the active tenant boundary",
    );
  }
  return tenantId;
}

export function pageInfo(
  value: unknown,
  consistency: HelpdeskPageInfo["consistency"],
): HelpdeskPageInfo {
  const raw = exactObject(value, "page", [
    "has_more",
    "next_cursor",
    "as_of",
    "consistency",
    "may_reorder",
  ]);
  if (typeof raw["has_more"] !== "boolean") {
    throw new HelpdeskContractError("page.has_more must be a boolean");
  }
  const cursorValue = raw["next_cursor"];
  const nextCursor =
    cursorValue === null ? null : normalizeHelpdeskOpaqueCursor(cursorValue);
  if (raw["has_more"] !== (nextCursor !== null)) {
    throw new HelpdeskContractError("page cursor and has_more disagree");
  }
  const asOf = timestamp(raw["as_of"], "page.as_of", true) as string;
  if (raw["consistency"] !== consistency || raw["may_reorder"] !== true) {
    throw new HelpdeskContractError(
      "page consistency and reorder facts do not match this client release",
    );
  }
  return {
    hasMore: raw["has_more"],
    nextCursor,
    asOf,
    consistency,
    mayReorder: true,
  };
}

export function chronologicalTimestampKey(value: string): string {
  const fractionStart = value.indexOf(".", 19);
  const fraction =
    fractionStart === -1 ? "" : value.slice(fractionStart + 1, -1);
  return value.slice(0, 19) + "." + fraction.padEnd(9, "0") + "Z";
}

export function nonnegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new HelpdeskContractError(label + " must be a non-negative integer");
  }
  return value as number;
}

export function requiredBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw new HelpdeskContractError(label + " must be a boolean");
  }
  return value;
}

export function assertUnique(ids: readonly string[], label: string): void {
  if (new Set(ids).size !== ids.length) {
    throw new HelpdeskContractError(label + " page contains duplicate ids");
  }
}

export function assertOrdered<T>(
  values: readonly T[],
  compare: (left: T, right: T) => number,
  label: string,
): void {
  for (let index = 1; index < values.length; index += 1) {
    if (compare(values[index - 1] as T, values[index] as T) > 0) {
      throw new HelpdeskContractError(
        label + " page is not deterministically ordered",
      );
    }
  }
}

export function assertOnePageWindow(
  pages: readonly HelpdeskPageInfo[],
  label: string,
): void {
  const first = pages[0];
  if (!first) return;
  if (
    pages.some(
      (page) =>
        page.asOf !== first.asOf || page.consistency !== first.consistency,
    )
  ) {
    throw new HelpdeskContractError(
      label + " pages came from different windows",
    );
  }
}

export function helpdeskUtf8Bytes(value: string): number {
  let bytes = 0;
  for (const rune of value) {
    const point = rune.codePointAt(0) as number;
    bytes += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
  }
  return bytes;
}
