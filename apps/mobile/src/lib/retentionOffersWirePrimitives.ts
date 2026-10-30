/**
 * lib/retentionOffersWirePrimitives.ts — the field-level half of the
 * retention wire codec: the mismatch error, the bounds every decoder shares,
 * and the scalar and envelope validators the four `normalize*` functions in
 * `retentionOffersWire.ts` compose.
 *
 * The rule these enforce is the one stated in that sibling, and it is why they
 * are shaped as they are: a malformed 2xx response is an ERROR. Nothing here
 * repairs a bad field, normalizes it away, or substitutes a default — every
 * one of them throws, so a broken projection can never reach the screen as a
 * successful empty catalogue, zero funnel or partial tier index.
 *
 * Split out of `retentionOffersWire.ts`, which re-exports `RetentionPayloadError`
 * so the surface its callers import is unchanged. Import-free, so the contract
 * remains testable under node.
 */
export const MAX_RETENTION_ROWS = 1_000;
export const MAX_HEADLINE_BYTES = 1_000;
export const MAX_BODY_BYTES = 10_000;
export const MAX_PROVIDER_REFERENCE_BYTES = 512;
export const MAX_TIER_NAME_BYTES = 1_000;
export const MAX_TIER_DESCRIPTION_BYTES = 10_000;
export const POSTGRES_INTEGER_MAX = 2_147_483_647;
// `funnelTotals` adds all four counters across every decoded row. This bound
// keeps that aggregate inside Number.MAX_SAFE_INTEGER as well as each value.
export const MAX_EVENT_COUNT = Math.floor(
  Number.MAX_SAFE_INTEGER / (MAX_RETENTION_ROWS * 4),
);
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const RFC3339_RE =
  /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.\d{1,9})?(?:Z|[+-]([01]\d|2[0-3]):([0-5]\d))$/u;
const UNSAFE_DISPLAY_CHARACTER_RE =
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u;

/** A 2xx response whose body does not match the server contract. */
export class RetentionPayloadError extends Error {
  readonly path: string;

  constructor(path: string, expectation: string) {
    super(`Retention response mismatch at ${path}: expected ${expectation}`);
    this.name = "RetentionPayloadError";
    this.path = path;
  }
}

export function mismatch(path: string, expectation: string): never {
  throw new RetentionPayloadError(path, expectation);
}

export function record(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return mismatch(path, "an object");
  }
  return value as Record<string, unknown>;
}

export function exactKeys(
  value: Record<string, unknown>,
  path: string,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const allowed = new Set([...required, ...optional]);
  if (
    !required.every((key) =>
      Object.prototype.hasOwnProperty.call(value, key),
    ) ||
    !Object.keys(value).every((key) => allowed.has(key))
  ) {
    mismatch(path, "the exact documented field set");
  }
}

function utf8ByteLength(value: string): number {
  let length = 0;
  for (let index = 0; index < value.length; index += 1) {
    const codePoint = value.codePointAt(index) ?? 0;
    if (codePoint > 0xffff) index += 1;
    length +=
      codePoint <= 0x7f
        ? 1
        : codePoint <= 0x7ff
          ? 2
          : codePoint <= 0xffff
            ? 3
            : 4;
  }
  return length;
}

export function boundedString(
  value: unknown,
  path: string,
  maxBytes: number,
  options: { required?: boolean } = {},
): string {
  if (
    typeof value !== "string" ||
    value !== value.trim() ||
    (options.required === true && value.length === 0) ||
    utf8ByteLength(value) > maxBytes ||
    UNSAFE_DISPLAY_CHARACTER_RE.test(value)
  ) {
    return mismatch(
      path,
      `${options.required === true ? "a non-empty" : "a"} trimmed safe string of at most ${maxBytes} UTF-8 bytes`,
    );
  }
  return value;
}

export function optionalBoundedString(
  row: Record<string, unknown>,
  key: string,
  path: string,
  maxBytes: number,
): string {
  if (!Object.prototype.hasOwnProperty.call(row, key)) return "";
  // Go's `omitempty` projection never emits an empty optional string. Treat
  // one as contract drift instead of silently normalizing it to absence.
  return boundedString(row[key], path, maxBytes, { required: true });
}

export function uuid(value: unknown, path: string): string {
  if (
    typeof value !== "string" ||
    value !== value.trim() ||
    !UUID_RE.test(value)
  ) {
    return mismatch(path, "a canonical UUID");
  }
  return value.toLowerCase();
}

export function bool(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") return mismatch(path, "a boolean");
  return value;
}

export function integer(
  value: unknown,
  path: string,
  options: { min: number; max: number },
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < options.min ||
    value > options.max
  ) {
    return mismatch(path, `an integer in [${options.min}, ${options.max}]`);
  }
  return value;
}

export function finiteNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return mismatch(path, "a finite number");
  }
  return value;
}

export function rfc3339(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length > 64) {
    return mismatch(path, "an RFC 3339 timestamp");
  }
  const match = RFC3339_RE.exec(value);
  if (!match || match[1] === "0000") {
    return mismatch(path, "an RFC 3339 timestamp");
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > (days[month - 1] ?? 0)) {
    return mismatch(path, "a calendar-valid RFC 3339 timestamp");
  }
  return value;
}

export function instantMillis(value: string, path: string): number {
  const result = Date.parse(value);
  if (!Number.isFinite(result))
    return mismatch(path, "a representable instant");
  return result;
}

export function countedRows(
  raw: unknown,
  key: "offers" | "tiles",
): Record<string, unknown>[] {
  const envelope = record(raw, "$response");
  exactKeys(envelope, "$response", [key, "count"]);
  const rows = envelope[key];
  if (!Array.isArray(rows) || rows.length > MAX_RETENTION_ROWS) {
    return mismatch(
      `$response.${key}`,
      `an array of at most ${MAX_RETENTION_ROWS} records`,
    );
  }
  const count = integer(envelope.count, "$response.count", {
    min: 0,
    max: MAX_RETENTION_ROWS,
  });
  if (count !== rows.length) {
    mismatch("$response.count", `the ${key} array length (${rows.length})`);
  }
  return rows.map((entry, index) =>
    record(entry, `$response.${key}[${index}]`),
  );
}
