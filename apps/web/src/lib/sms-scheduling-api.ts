/** Strict, cancellable quiet-hours CRUD for an exact-admin surface. */
import { api } from "@/lib/api";

const TENANT_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const ROW_UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const RFC3339 =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|([+-])(\d{2}):(\d{2}))$/u;
const UNSAFE_TEXT = /[\p{Cc}\p{Cf}\p{Cs}]/u;
const ROW_KEYS = [
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

export interface SmsQuietHoursProjection {
  id: string;
  tenant_id: string;
  label: string;
  /** Historical US/CA scopes are visible only so an admin can retire them. */
  country_code: "" | "US" | "CA";
  start_minute: number;
  end_minute: number;
  start_local: string;
  end_local: string;
  days: number[];
  timezone: string;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

export interface SmsQuietHoursMutationInput {
  label: string;
  /** New and edited policies are tenant-wide. Country scope is release-held. */
  country_code: "";
  start_minute: number;
  end_minute: number;
  days: number[];
  timezone: string;
  enabled: boolean;
}

export interface SmsQuietHoursDeleteReceipt {
  ok: true;
  tenantId: string;
  id: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value);
  return (
    actual.length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function safeText(value: unknown, maxRunes: number, maxBytes: number): boolean {
  return (
    typeof value === "string" &&
    [...value].length <= maxRunes &&
    new TextEncoder().encode(value).length <= maxBytes &&
    !UNSAFE_TEXT.test(value)
  );
}

function projectionTime(value: unknown): number | null {
  if (typeof value !== "string" || value.length > 64) return null;
  const match = RFC3339.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = Date.parse(value);
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
    Number(match[9] ?? 0) > 14 ||
    (Number(match[9] ?? 0) === 14 && Number(match[10] ?? 0) !== 0) ||
    Number(match[10] ?? 0) > 59 ||
    !Number.isFinite(parsed) ||
    parsed < Date.UTC(2000, 0, 1) ||
    parsed >= Date.UTC(2100, 0, 1)
  ) {
    return null;
  }
  return parsed;
}

function validTimezone(value: unknown): value is string {
  if (
    !safeText(value, 128, 512) ||
    typeof value !== "string" ||
    value === "" ||
    value.trim() !== value
  ) {
    return false;
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(0);
    return true;
  } catch {
    return false;
  }
}

function requireTenant(expectedTenantId: string): void {
  if (!TENANT_UUID.test(expectedTenantId)) {
    throw new Error("Invalid SMS quiet-hours tenant identity");
  }
}

function requireRowId(id: string): void {
  if (!ROW_UUID_V4.test(id)) {
    throw new Error("Invalid SMS quiet-hours row identity");
  }
}

function requireVersion(value: string): void {
  if (
    value.trim() !== value ||
    value.length > 64 ||
    projectionTime(value) === null
  ) {
    throw new Error("Invalid SMS quiet-hours row version");
  }
}

function canonicalMutationInput(
  input: SmsQuietHoursMutationInput,
): SmsQuietHoursMutationInput {
  if (
    !isRecord(input) ||
    !exactKeys(input, [
      "label",
      "country_code",
      "start_minute",
      "end_minute",
      "days",
      "timezone",
      "enabled",
    ]) ||
    typeof input.label !== "string" ||
    typeof input.timezone !== "string" ||
    input.country_code !== "" ||
    !safeText(input.label.trim(), 128, 512) ||
    !Number.isInteger(input.start_minute) ||
    input.start_minute < 0 ||
    input.start_minute > 1439 ||
    !Number.isInteger(input.end_minute) ||
    input.end_minute < 0 ||
    input.end_minute > 1439 ||
    !Array.isArray(input.days) ||
    input.days.length < 1 ||
    input.days.length > 7 ||
    input.days.some(
      (day, index) =>
        !Number.isInteger(day) ||
        day < 0 ||
        day > 6 ||
        (index > 0 && day <= input.days[index - 1]!),
    ) ||
    !validTimezone(input.timezone) ||
    typeof input.enabled !== "boolean"
  ) {
    throw new Error("Invalid SMS quiet-hours policy input");
  }
  const label = input.label.trim();
  return { ...input, label };
}

function localMinute(value: number): string {
  return `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
}

function decodeRow(
  value: unknown,
  expectedTenantId: string,
): { row: SmsQuietHoursProjection; created: number } {
  if (!isRecord(value) || !exactKeys(value, ROW_KEYS)) {
    throw new Error("Invalid SMS quiet-hours row");
  }
  const start = value.start_minute;
  const end = value.end_minute;
  const days = value.days;
  const created = projectionTime(value.created_at);
  const updated = projectionTime(value.updated_at);
  if (
    typeof value.id !== "string" ||
    !ROW_UUID_V4.test(value.id) ||
    value.tenant_id !== expectedTenantId ||
    !safeText(value.label, 128, 512) ||
    (value.country_code !== "" &&
      value.country_code !== "US" &&
      value.country_code !== "CA") ||
    !Number.isInteger(start) ||
    Number(start) < 0 ||
    Number(start) > 1439 ||
    !Number.isInteger(end) ||
    Number(end) < 0 ||
    Number(end) > 1439 ||
    value.start_local !== localMinute(Number(start)) ||
    value.end_local !== localMinute(Number(end)) ||
    !Array.isArray(days) ||
    days.length < 1 ||
    days.length > 7 ||
    days.some(
      (day, index) =>
        !Number.isInteger(day) ||
        Number(day) < 0 ||
        Number(day) > 6 ||
        (index > 0 && Number(day) <= Number(days[index - 1])),
    ) ||
    !validTimezone(value.timezone) ||
    typeof value.enabled !== "boolean" ||
    created === null ||
    updated === null ||
    updated < created
  ) {
    throw new Error("Invalid SMS quiet-hours row");
  }
  return {
    row: value as unknown as SmsQuietHoursProjection,
    created,
  };
}

function assertMutationReceipt(
  raw: unknown,
  expectedTenantId: string,
  input: SmsQuietHoursMutationInput,
  expectedId?: string,
  previousVersion?: string,
): SmsQuietHoursProjection {
  const { row } = decodeRow(raw, expectedTenantId);
  if (
    (expectedId !== undefined && row.id !== expectedId) ||
    (previousVersion !== undefined && row.updated_at === previousVersion) ||
    row.label !== input.label ||
    row.country_code !== "" ||
    row.start_minute !== input.start_minute ||
    row.end_minute !== input.end_minute ||
    row.timezone !== input.timezone ||
    row.enabled !== input.enabled ||
    row.days.length !== input.days.length ||
    row.days.some((day, index) => day !== input.days[index])
  ) {
    throw new Error("Invalid SMS quiet-hours mutation receipt");
  }
  return row;
}

export async function listSmsQuietHours(
  expectedTenantId: string,
  opts: { signal?: AbortSignal } = {},
): Promise<SmsQuietHoursProjection[]> {
  requireTenant(expectedTenantId);
  const response = await api.get<unknown>("/api/v1/sms/quiet-hours", opts);
  if (
    !isRecord(response) ||
    !exactKeys(response, ["tenantId", "items"]) ||
    response.tenantId !== expectedTenantId ||
    !Array.isArray(response.items) ||
    response.items.length > 256
  ) {
    throw new Error("Invalid SMS quiet-hours envelope");
  }
  const seen = new Set<string>();
  let previousCreated = -1;
  let previousId = "";
  const rows: SmsQuietHoursProjection[] = [];
  for (const value of response.items) {
    const { row, created } = decodeRow(value, expectedTenantId);
    if (
      seen.has(row.id) ||
      created < previousCreated ||
      (created === previousCreated && row.id <= previousId)
    ) {
      throw new Error("Invalid SMS quiet-hours row");
    }
    seen.add(row.id);
    previousCreated = created;
    previousId = row.id;
    rows.push(row);
  }
  return rows;
}

export async function createSmsQuietHours(
  input: SmsQuietHoursMutationInput,
  expectedTenantId: string,
  signal?: AbortSignal,
): Promise<SmsQuietHoursProjection> {
  requireTenant(expectedTenantId);
  const canonical = canonicalMutationInput(input);
  const raw = await api.post<unknown>("/api/v1/sms/quiet-hours", canonical, {
    requireOnline: true,
    signal,
  });
  return assertMutationReceipt(raw, expectedTenantId, canonical);
}

export async function updateSmsQuietHours(
  id: string,
  input: SmsQuietHoursMutationInput,
  expectedUpdatedAt: string,
  expectedTenantId: string,
  signal?: AbortSignal,
): Promise<SmsQuietHoursProjection> {
  requireTenant(expectedTenantId);
  requireRowId(id);
  requireVersion(expectedUpdatedAt);
  const canonical = canonicalMutationInput(input);
  const raw = await api.patch<unknown>(
    `/api/v1/sms/quiet-hours/${encodeURIComponent(id)}`,
    { ...canonical, expected_updated_at: expectedUpdatedAt },
    { requireOnline: true, signal },
  );
  return assertMutationReceipt(
    raw,
    expectedTenantId,
    canonical,
    id,
    expectedUpdatedAt,
  );
}

export async function deleteSmsQuietHours(
  id: string,
  expectedUpdatedAt: string,
  expectedTenantId: string,
  signal?: AbortSignal,
): Promise<SmsQuietHoursDeleteReceipt> {
  requireTenant(expectedTenantId);
  requireRowId(id);
  requireVersion(expectedUpdatedAt);
  const raw = await api.delete<unknown>(
    `/api/v1/sms/quiet-hours/${encodeURIComponent(id)}`,
    {
      body: { expected_updated_at: expectedUpdatedAt },
      requireOnline: true,
      signal,
    },
  );
  if (
    !isRecord(raw) ||
    !exactKeys(raw, ["ok", "tenantId", "id"]) ||
    raw.ok !== true ||
    raw.tenantId !== expectedTenantId ||
    raw.id !== id
  ) {
    throw new Error("Invalid SMS quiet-hours deletion receipt");
  }
  return { ok: true, tenantId: expectedTenantId, id };
}
