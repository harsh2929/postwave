import type {
  CustomDomain,
  CustomDomainPurpose,
  DNSRecord,
  DomainVerifyResponse,
} from "../../lib/api-client";

export const CUSTOM_DOMAIN_LIST_LIMIT = 500;
const MAX_RECORDS = 16;
const MAX_IDENTIFIER = 128;
const MAX_HOSTNAME = 253;
// Registration prepends `_postwave-verify.` to a canonical hostname, so a
// valid server-issued TXT record owner can be 270 characters even though the
// customer hostname itself remains capped at 253.
const MAX_DNS_RECORD_NAME = 270;
const MAX_RECORD_VALUE = 2_048;
const MAX_RECORD_ERROR = 512;
const SAFE_ID = /^[a-z0-9][a-z0-9._:-]{0,127}$/iu;
const SAFE_RECORD_TYPE = /^[a-z0-9][a-z0-9_-]{0,15}$/iu;

export type CustomDomainFilter = "all" | "verified" | "pending";
export type CustomDomainSort = "newest" | "oldest" | "domain" | "status";

export interface CustomDomainInventory {
  rows: CustomDomain[];
  total: number;
  verified: number;
  pending: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedString(value: unknown, maximum: number): string | null {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximum &&
    !/[\u0000-\u001f\u007f]/u.test(value)
    ? value
    : null;
}

const RFC3339_TIMESTAMP =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|([+-])(\d{2}):(\d{2}))$/u;

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function validRFC3339Timestamp(value: string): boolean {
  const match = RFC3339_TIMESTAMP.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[8] === undefined ? 0 : Number(match[8]);
  const offsetMinute = match[9] === undefined ? 0 : Number(match[9]);
  const daysByMonth = [
    31,
    isLeapYear(year) ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  return (
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= daysByMonth[month - 1]! &&
    hour <= 23 &&
    minute <= 59 &&
    second <= 59 &&
    offsetHour <= 23 &&
    offsetMinute <= 59
  );
}

function optionalDate(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  if (typeof value !== "string" || value.length > 64) return undefined;
  return validRFC3339Timestamp(value) ? value : undefined;
}

function parseDNSRecord(value: unknown): DNSRecord | null {
  if (!isRecord(value)) return null;
  const type = boundedString(value["type"], 16);
  const name = boundedString(value["name"], MAX_DNS_RECORD_NAME);
  const recordValue = boundedString(value["value"], MAX_RECORD_VALUE);
  const recordError =
    value["error"] === undefined || value["error"] === ""
      ? null
      : boundedString(value["error"], MAX_RECORD_ERROR);
  if (
    !type ||
    !SAFE_RECORD_TYPE.test(type) ||
    !name ||
    !recordValue ||
    (value["verified"] !== undefined &&
      typeof value["verified"] !== "boolean") ||
    (value["error"] !== undefined && value["error"] !== "" && !recordError)
  ) {
    return null;
  }
  return {
    type: type.toUpperCase(),
    name,
    value: recordValue,
    ...(typeof value["verified"] === "boolean"
      ? { verified: value["verified"] }
      : {}),
    ...(recordError ? { error: recordError } : {}),
  };
}

function parseCustomDomain(value: unknown): CustomDomain | null {
  if (!isRecord(value)) return null;
  const id = boundedString(value["id"], MAX_IDENTIFIER);
  const domain = boundedString(value["domain"], MAX_HOSTNAME);
  const purpose = boundedString(value["purpose"], 32);
  const records = value["dns_records"];
  const createdAt = optionalDate(value["createdAt"]);
  const verifiedAt = optionalDate(value["verifiedAt"]);
  const tenantId =
    value["tenantId"] === undefined
      ? undefined
      : boundedString(value["tenantId"], MAX_IDENTIFIER);
  if (
    !id ||
    !SAFE_ID.test(id) ||
    !domain ||
    !purpose ||
    typeof value["verified"] !== "boolean" ||
    !Array.isArray(records) ||
    records.length > MAX_RECORDS ||
    (value["tenantId"] !== undefined && !tenantId) ||
    (value["createdAt"] !== undefined && createdAt === undefined) ||
    (value["verifiedAt"] !== undefined && verifiedAt === undefined)
  ) {
    return null;
  }
  const parsedRecords = records.map(parseDNSRecord);
  if (parsedRecords.some((record) => record === null)) return null;
  return {
    id,
    domain: domain.toLowerCase(),
    purpose,
    verified: value["verified"],
    dns_records: parsedRecords as DNSRecord[],
    ...(tenantId ? { tenantId } : {}),
    ...(typeof createdAt === "string" ? { createdAt } : {}),
    ...(verifiedAt !== undefined ? { verifiedAt } : {}),
  };
}

/** Strict current-wire decoder. Malformed or oversized lists fail closed. */
export function parseCustomDomainList(value: unknown): CustomDomain[] | null {
  if (!Array.isArray(value) || value.length > CUSTOM_DOMAIN_LIST_LIMIT) {
    return null;
  }
  const parsed = value.map(parseCustomDomain);
  if (parsed.some((row) => row === null)) return null;
  return parsed as CustomDomain[];
}

export function parseDomainVerification(
  value: unknown,
): DomainVerifyResponse | null {
  if (!isRecord(value) || typeof value["verified"] !== "boolean") return null;
  const records = value["records"];
  if (records === undefined) return { verified: value["verified"] };
  if (!Array.isArray(records) || records.length > MAX_RECORDS) return null;
  const parsed = records.map(parseDNSRecord);
  if (parsed.some((record) => record === null)) return null;
  return { verified: value["verified"], records: parsed as DNSRecord[] };
}

export function inventoryForCustomDomains(
  rows: readonly CustomDomain[],
): CustomDomainInventory {
  const verified = rows.filter((row) => row.verified).length;
  return {
    rows: [...rows],
    total: rows.length,
    verified,
    pending: rows.length - verified,
  };
}

export function customDomainPurposeLabel(purpose: string): string {
  const labels: Record<CustomDomainPurpose, string> = {
    forms: "Legacy form hostname",
    links: "Legacy link hostname",
    web: "Legacy hosted-web hostname",
    tracking: "Legacy tracking hostname",
  };
  return labels[purpose as CustomDomainPurpose] ?? "Legacy custom hostname";
}

function createdTime(row: CustomDomain): number {
  const parsed = row.createdAt ? Date.parse(row.createdAt) : Number.NaN;
  return Number.isNaN(parsed) ? 0 : parsed;
}

export function filterAndSortCustomDomains(
  rows: readonly CustomDomain[],
  query: string,
  filter: CustomDomainFilter,
  sort: CustomDomainSort,
): CustomDomain[] {
  const needle = query.trim().toLocaleLowerCase().slice(0, 253);
  const visible = rows.filter((row) => {
    if (filter === "verified" && !row.verified) return false;
    if (filter === "pending" && row.verified) return false;
    return (
      !needle ||
      row.domain.toLocaleLowerCase().includes(needle) ||
      customDomainPurposeLabel(row.purpose).toLocaleLowerCase().includes(needle)
    );
  });
  return visible.sort((left, right) => {
    if (sort === "domain") return left.domain.localeCompare(right.domain);
    if (sort === "status") {
      return (
        Number(left.verified) - Number(right.verified) ||
        left.domain.localeCompare(right.domain)
      );
    }
    const delta = createdTime(left) - createdTime(right);
    return sort === "oldest" ? delta : -delta;
  });
}
