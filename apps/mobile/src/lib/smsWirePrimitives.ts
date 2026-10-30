/**
 * smsWirePrimitives — the strict field validators every SMS wire decoder
 * shares.
 *
 * Extracted verbatim from `smsConversationWire.ts` when that file crossed the
 * 450-line source budget more than twice over; the three wire modules
 * (`smsConversationWire`, `smsThreadWire`, `smsContextWire`) and the inbox-ops
 * decoders import from here instead of re-declaring near-identical helpers.
 * These functions throw `SmsContractError` and never coerce: a response that
 * fails a check renders as an error state, not as partially-trusted rows.
 */
import { SmsContractError, type SmsDirection } from "./smsConversation";

export const SMS_WIRE_E164 = /^\+1[2-9][0-9]{2}[2-9][0-9]{6}$/u;
export const SMS_WIRE_TOKEN = /^[a-z0-9][a-z0-9_.:-]{0,127}$/iu;
const RFC3339 =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|([+-])(\d{2}):(\d{2}))$/u;
const CONTROL = /[\u0000-\u001f\u007f]/u;
const MAX_COUNT = 2_147_483_647;
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export function wireObject(
  value: unknown,
  path: string,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SmsContractError(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

export function wireExactKeys(
  source: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
): void {
  const keys = new Set(allowed);
  const unexpected = Object.keys(source).find((key) => !keys.has(key));
  if (unexpected) {
    throw new SmsContractError(
      `${path}.${unexpected} is not part of the contract`,
    );
  }
}

export function wireString(
  value: unknown,
  path: string,
  options: { max?: number; empty?: boolean; token?: boolean } = {},
): string {
  const max = options.max ?? 1024;
  if (typeof value !== "string" || (!options.empty && value.length === 0)) {
    throw new SmsContractError(`${path} must be a string`);
  }
  if (value.length > max || wireUtf8Bytes(value) > max * 4) {
    throw new SmsContractError(`${path} is too long`);
  }
  if (options.token && !SMS_WIRE_TOKEN.test(value)) {
    throw new SmsContractError(`${path} is not a valid token`);
  }
  return value;
}

export function wireOptionalString(
  source: Record<string, unknown>,
  key: string,
  path: string,
  max = 1024,
): string | undefined {
  const value = source[key];
  if (value === undefined) return undefined;
  return wireString(value, `${path}.${key}`, { max });
}

export function wireInteger(value: unknown, path: string): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 0 ||
    (value as number) > MAX_COUNT
  ) {
    throw new SmsContractError(`${path} must be a non-negative integer`);
  }
  return value as number;
}

export function wireBoolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean")
    throw new SmsContractError(`${path} must be a boolean`);
  return value;
}

export function wireTimestamp(value: unknown, path: string): string {
  const text = wireString(value, path, { max: 64 });
  const parts = RFC3339.exec(text);
  if (
    !parts ||
    !validRfc3339Parts(parts) ||
    !Number.isFinite(Date.parse(text))
  ) {
    throw new SmsContractError(`${path} must be RFC3339`);
  }
  return text;
}

function validRfc3339Parts(parts: RegExpExecArray): boolean {
  const year = Number(parts[1]);
  const month = Number(parts[2]);
  const day = Number(parts[3]);
  const hour = Number(parts[4]);
  const minute = Number(parts[5]);
  const second = Number(parts[6]);
  const offsetHour = Number(parts[8] ?? 0);
  const offsetMinute = Number(parts[9] ?? 0);
  if (
    year < 1 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHour > 23 ||
    offsetMinute > 59
  ) {
    return false;
  }
  return day <= new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function wireOptionalTimestamp(
  source: Record<string, unknown>,
  key: string,
  path: string,
): string | undefined {
  const value = source[key];
  return value === undefined
    ? undefined
    : wireTimestamp(value, `${path}.${key}`);
}

export function wirePhone(value: unknown, path: string): string {
  const text = wireString(value, path, { max: 16 });
  if (!SMS_WIRE_E164.test(text)) {
    throw new SmsContractError(`${path} must be a US/Canada (+1) number`);
  }
  return text;
}

export function wireUuid(value: unknown, path: string): string {
  const text = wireString(value, path, { max: 36 });
  if (!UUID_V4.test(text)) {
    throw new SmsContractError(`${path} must be a canonical lowercase UUIDv4`);
  }
  return text;
}

export function wireTenantEnvelope(
  source: Record<string, unknown>,
  expectedTenant: string,
  path: string,
): string {
  const tenantId = wireUuid(source.tenantId, `${path}.tenantId`);
  if (tenantId !== expectedTenant) {
    throw new SmsContractError(`${path} belongs to another tenant`);
  }
  return tenantId;
}

export function wireDirection(value: unknown, path: string): SmsDirection {
  if (value !== "inbound" && value !== "outbound") {
    throw new SmsContractError(`${path} has an unknown direction`);
  }
  return value;
}

export function wireNextCursor(
  source: Record<string, unknown>,
  path: string,
): string | undefined {
  const value = source.nextCursor;
  if (value === undefined) return undefined;
  const result = wireString(value, `${path}.nextCursor`, { max: 4096 });
  if (CONTROL.test(result))
    throw new SmsContractError(`${path}.nextCursor contains controls`);
  return result;
}

export function wireUtf8Bytes(value: string): number {
  let bytes = 0;
  for (const point of value) {
    const code = point.codePointAt(0) ?? 0;
    bytes += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
  }
  return bytes;
}
