/** Strict runtime boundaries for the two released Agency reads. */
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const CURSOR = /^[A-Za-z0-9_-]{1,512}$/u;
const UNSAFE_TEXT =
  /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/u;
const RFC3339 =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(?:Z|([+-])(\d{2}):(\d{2}))$/u;
const HEX = /^#[0-9a-f]{6}$/iu;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
const BRANDING_ETAG =
  /^"agency-branding:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}:v(?:0|[1-9][0-9]*)"$/u;
const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const RESERVED_HOST_SUFFIXES = [
  "localhost",
  "local",
  "internal",
  "lan",
  "home",
  "home.arpa",
  "arpa",
  "onion",
  "test",
  "invalid",
  "example",
] as const;

export class AgencyWireError extends Error {
  readonly code = "invalid_agency_response";

  constructor(message: string) {
    super(message);
    this.name = "AgencyWireError";
  }
}

interface AgencyChildrenWireBase {
  children: AgencyChildWire[];
  /** Rows in this page, not a portfolio total. */
  count: number;
}

export type AgencyChildrenWire = AgencyChildrenWireBase &
  (
    | { has_more: true; next_cursor: string }
    | { has_more: false; next_cursor?: never }
  );

export interface AgencyChildWire {
  id: string;
  slug: string;
  name: string;
  tier: "studio" | "sending" | "pro";
  parent_tenant_id: string;
  billing_mode: "self" | "parent";
  reseller_markup_bps: number;
  whitelabel_enabled: boolean;
  created_at: string;
  updated_at: string;
}

export interface AgencyBrandingWire {
  whitelabel_enabled: boolean;
  brand_name: string;
  custom_domain: string;
  logo_url: string;
  primary_color: string;
  support_email: string;
  legal_entity: string;
  updated_at: string;
  etag: string;
}

function fail(surface: string): never {
  throw new AgencyWireError(`The ${surface} response was malformed.`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
): boolean {
  const allowed = new Set(required);
  return (
    required.every((key) => Object.prototype.hasOwnProperty.call(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key))
  );
}

function boundedText(
  value: unknown,
  max: number,
  options: { empty?: boolean; trimmed?: boolean } = {},
): value is string {
  return (
    typeof value === "string" &&
    [...value].length <= max &&
    (options.empty === true || value.length > 0) &&
    (options.trimmed !== true || value.trim() === value) &&
    !UNSAFE_TEXT.test(value)
  );
}

function canonicalUUID(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

function safeInteger(
  value: unknown,
  min = 0,
  max = Number.MAX_SAFE_INTEGER,
): value is number {
  return (
    Number.isSafeInteger(value) && Number(value) >= min && Number(value) <= max
  );
}

function validDate(value: unknown): value is string {
  return boundedText(value, 128) && rfc3339EpochNanoseconds(value) !== null;
}

function rfc3339EpochNanoseconds(value: string): bigint | null {
  const match = RFC3339.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = Number(match[9] ?? 0);
  const offsetMinute = Number(match[10] ?? 0);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (
    year < 1 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > (days[month - 1] ?? 0) ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHour > 23 ||
    offsetMinute > 59
  ) {
    return null;
  }
  const epochMillis = Date.parse(value);
  if (!Number.isFinite(epochMillis)) return null;
  const fraction = (match[7] ?? "").padEnd(9, "0");
  return (
    BigInt(Math.floor(epochMillis / 1_000)) * 1_000_000_000n +
    BigInt(fraction || "0")
  );
}

function validTier(value: unknown): value is AgencyChildWire["tier"] {
  return value === "studio" || value === "sending" || value === "pro";
}

function validMode(value: unknown): value is AgencyChildWire["billing_mode"] {
  return value === "self" || value === "parent";
}

function parseChild(value: unknown): AgencyChildWire {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      "id",
      "slug",
      "name",
      "tier",
      "parent_tenant_id",
      "billing_mode",
      "reseller_markup_bps",
      "whitelabel_enabled",
      "created_at",
      "updated_at",
    ]) ||
    !canonicalUUID(value.id) ||
    !canonicalUUID(value.parent_tenant_id) ||
    !boundedText(value.slug, 63, { trimmed: true }) ||
    !SLUG.test(value.slug) ||
    !boundedText(value.name, 120, { trimmed: true }) ||
    !validTier(value.tier) ||
    !validMode(value.billing_mode) ||
    !safeInteger(value.reseller_markup_bps, 0, 100_000) ||
    typeof value.whitelabel_enabled !== "boolean" ||
    !validDate(value.created_at) ||
    !validDate(value.updated_at)
  ) {
    fail("agency child-workspace");
  }
  const createdAt = rfc3339EpochNanoseconds(value.created_at);
  const updatedAt = rfc3339EpochNanoseconds(value.updated_at);
  if (createdAt === null || updatedAt === null || updatedAt < createdAt) {
    fail("agency child-workspace");
  }
  return value as unknown as AgencyChildWire;
}

export function parseAgencyChildrenWire(
  value: unknown,
  maxRows = 200,
): AgencyChildrenWire {
  if (
    !safeInteger(maxRows, 1, 200) ||
    !isRecord(value) ||
    typeof value.has_more !== "boolean" ||
    !exactKeys(
      value,
      value.has_more
        ? ["children", "count", "has_more", "next_cursor"]
        : ["children", "count", "has_more"],
    ) ||
    !Array.isArray(value.children) ||
    value.children.length > maxRows ||
    !safeInteger(value.count, 0, maxRows) ||
    value.count !== value.children.length ||
    (value.has_more &&
      (!boundedText(value.next_cursor, 512) || !CURSOR.test(value.next_cursor)))
  ) {
    fail("agency child-workspace list");
  }
  return {
    children: value.children.map(parseChild),
    count: value.count,
    ...(value.has_more
      ? { has_more: true as const, next_cursor: value.next_cursor as string }
      : { has_more: false as const }),
  };
}

export function parseAgencyBrandingWire(value: unknown): AgencyBrandingWire {
  const textFields = [
    "brand_name",
    "custom_domain",
    "logo_url",
    "primary_color",
    "support_email",
    "legal_entity",
  ] as const;
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      "whitelabel_enabled",
      ...textFields,
      "updated_at",
      "etag",
    ]) ||
    typeof value.whitelabel_enabled !== "boolean" ||
    !validDate(value.updated_at) ||
    !boundedText(value.etag, 256) ||
    !BRANDING_ETAG.test(value.etag)
  ) {
    fail("agency branding");
  }
  for (const key of textFields) {
    if (!boundedText(value[key], 2_048, { empty: true, trimmed: true })) {
      fail("agency branding");
    }
  }
  if (
    (typeof value.brand_name === "string" &&
      [...value.brand_name].length > 120) ||
    (typeof value.custom_domain === "string" &&
      !validPublicHostname(value.custom_domain, true)) ||
    (typeof value.logo_url === "string" && !validLogoURL(value.logo_url)) ||
    (typeof value.primary_color === "string" &&
      value.primary_color !== "" &&
      !HEX.test(value.primary_color)) ||
    (typeof value.support_email === "string" &&
      value.support_email !== "" &&
      (value.support_email.length > 254 || !EMAIL.test(value.support_email))) ||
    (typeof value.legal_entity === "string" &&
      [...value.legal_entity].length > 200)
  ) {
    fail("agency branding");
  }
  return value as unknown as AgencyBrandingWire;
}

function validPublicHostname(value: string, empty = false): boolean {
  if (value === "") return empty;
  if (value.length > 253 || value !== value.toLowerCase()) return false;
  if (
    [...value].some(
      (character) => "/\\:@%*?#[]".includes(character) || /\s/u.test(character),
    )
  ) {
    return false;
  }
  const labels = value.split(".");
  if (labels.length < 2 || !labels.every((label) => DNS_LABEL.test(label))) {
    return false;
  }
  if (
    labels.length <= 4 &&
    labels.every((label) => /^(?:0x[0-9a-f]+|[0-9]+)$/u.test(label))
  ) {
    return false;
  }
  return !RESERVED_HOST_SUFFIXES.some(
    (suffix) => value === suffix || value.endsWith(`.${suffix}`),
  );
}

function validLogoURL(value: string): boolean {
  if (value === "") return true;
  try {
    const parsed = new URL(value);
    if (
      parsed.protocol !== "https:" ||
      parsed.username ||
      parsed.password ||
      parsed.port ||
      parsed.search ||
      parsed.hash ||
      !validPublicHostname(parsed.hostname)
    ) {
      return false;
    }
    return !/\\|%00|%0a|%0d|%5c/iu.test(parsed.pathname);
  } catch {
    return false;
  }
}

export interface AgencyChildrenProjection {
  children: AgencyChildWire[];
  issue: string | null;
}

/** Merge only a contiguous, non-overlapping keyset sequence. */
export function mergeAgencyChildrenWirePages(
  pages: readonly AgencyChildrenWire[] | undefined,
  pageParams: readonly unknown[] | undefined,
): AgencyChildrenProjection {
  if (!pages && !pageParams) return { children: [], issue: null };
  if (!pages || !pageParams || pages.length !== pageParams.length) {
    return {
      children: [],
      issue: "The child roster returned inconsistent pagination metadata.",
    };
  }
  const seenIds = new Set<string>();
  const seenSlugs = new Set<string>();
  const seenCursors = new Set<string>();
  const children: AgencyChildWire[] = [];
  for (let index = 0; index < pages.length; index += 1) {
    const page = pages[index];
    const rawParam = pageParams[index];
    const requestedCursor = typeof rawParam === "string" ? rawParam : "";
    if (!page || (index === 0 ? requestedCursor !== "" : !requestedCursor)) {
      return {
        children: [],
        issue: "The child roster returned an invalid page sequence.",
      };
    }
    if (index > 0) {
      const previous = pages[index - 1];
      if (!previous?.has_more || previous.next_cursor !== requestedCursor) {
        return {
          children: [],
          issue: "The child roster returned an invalid page sequence.",
        };
      }
    }
    if (requestedCursor) {
      if (seenCursors.has(requestedCursor)) {
        return {
          children: [],
          issue: "The child roster repeated a pagination cursor.",
        };
      }
      seenCursors.add(requestedCursor);
    }
    for (const child of page.children) {
      if (seenIds.has(child.id) || seenSlugs.has(child.slug)) {
        return {
          children: [],
          issue:
            "The child roster returned the same workspace id or slug more than once.",
        };
      }
      seenIds.add(child.id);
      seenSlugs.add(child.slug);
      children.push(child);
    }
    if (page.has_more && seenCursors.has(page.next_cursor)) {
      return {
        children: [],
        issue: "The child roster repeated a pagination cursor.",
      };
    }
  }
  return { children, issue: null };
}
