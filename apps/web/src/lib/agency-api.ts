/** Strict client boundary for the agency portfolio and branding projection. */
import { api } from "@/lib/api";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const ROSTER_SLUG = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const CURSOR = /^[A-Za-z0-9_-]{1,512}$/u;
const UNSAFE_TEXT =
  /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/u;
const RFC3339 =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-](\d{2}):(\d{2}))$/u;
const HEX = /^#[0-9a-f]{6}$/iu;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
const BRANDING_ETAG =
  /^"agency-branding:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:v(?:0|[1-9]\d*)"$/u;
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

export interface AgencyRequestOptions {
  signal?: AbortSignal;
  requireOnline?: boolean;
  maxAttempts?: number;
}

export interface AgencyChild {
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

interface AgencyChildrenPageBase {
  children: AgencyChild[];
  count: number;
}

export type AgencyChildrenResponse = AgencyChildrenPageBase &
  (
    | { has_more: true; next_cursor: string }
    | { has_more: false; next_cursor?: never }
  );

export interface AgencyBranding {
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

export type AgencyBrandingPatch = Partial<
  Pick<
    AgencyBranding,
    | "whitelabel_enabled"
    | "brand_name"
    | "custom_domain"
    | "logo_url"
    | "primary_color"
    | "support_email"
    | "legal_entity"
  >
>;

export interface AgencyBillingModeInput {
  target_tenant_id: string;
  mode: "self" | "parent";
  reason: string;
}

export interface AgencyCreateChildInput {
  slug: string;
  name: string;
  tier?: "studio" | "sending" | "pro";
  billing_mode?: "self" | "parent";
  reseller_markup_bps?: number;
}

export class AgencyReleaseHeldError extends Error {
  readonly status = 503;
  readonly retryable = false;
  readonly ambiguous = false;
  readonly committed = false;

  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "AgencyReleaseHeldError";
  }
}

export async function listAgencyChildrenPage(
  expectedParentTenantId: string,
  cursor: string | undefined,
  options?: AgencyRequestOptions,
): Promise<AgencyChildrenResponse> {
  if (!UUID.test(expectedParentTenantId)) {
    fail("agency authority owner");
  }
  if (cursor !== undefined && !CURSOR.test(cursor)) {
    fail("agency child-workspace cursor");
  }
  const query = new URLSearchParams({ limit: "100" });
  if (cursor) query.set("cursor", cursor);
  const page = normalizeAgencyChildrenPage(
    await api.get<unknown>(
      `/api/v1/agency/children?${query.toString()}`,
      options,
    ),
  );
  const ids = new Set<string>();
  for (const child of page.children) {
    if (
      child.parent_tenant_id !== expectedParentTenantId ||
      child.id === expectedParentTenantId ||
      ids.has(child.id)
    ) {
      fail("agency child-workspace authority");
    }
    ids.add(child.id);
  }
  return page;
}

export function normalizeAgencyChildrenPage(
  value: unknown,
): AgencyChildrenResponse {
  if (
    !isRecord(value) ||
    typeof value.has_more !== "boolean" ||
    !exactKeys(
      value,
      value.has_more
        ? ["children", "count", "has_more", "next_cursor"]
        : ["children", "count", "has_more"],
    ) ||
    !Array.isArray(value.children) ||
    value.children.length > 100 ||
    !safeInteger(value.count, 0, 100) ||
    value.count !== value.children.length ||
    (value.has_more &&
      (typeof value.next_cursor !== "string" ||
        !CURSOR.test(value.next_cursor)))
  ) {
    fail("agency child-workspace list");
  }
  const children = value.children.map((row) => {
    const child = normalizeAgencyChild(row);
    if (!child) fail("agency child-workspace row");
    return child;
  });
  return {
    children,
    count: value.count,
    ...(value.has_more
      ? { has_more: true as const, next_cursor: value.next_cursor as string }
      : { has_more: false as const }),
  };
}

export async function getAgencyBranding(
  expectedTenantId: string,
  options?: AgencyRequestOptions,
): Promise<AgencyBranding> {
  if (!UUID.test(expectedTenantId)) fail("agency authority owner");
  let responseETag: string | null = null;
  const branding = normalizeAgencyBranding(
    await api.get<unknown>("/api/v1/agency/branding", {
      ...options,
      onResponse: (response) => {
        responseETag = response.headers.get("etag");
      },
    }),
  );
  if (
    !responseETag ||
    responseETag !== branding.etag ||
    !branding.etag.startsWith(`"agency-branding:${expectedTenantId}:v`)
  ) {
    fail("agency branding version");
  }
  return branding;
}

export async function updateAgencyBranding(
  _patch: AgencyBrandingPatch,
  _options?: AgencyRequestOptions,
): Promise<never> {
  throw new AgencyReleaseHeldError(
    "agency_branding_update_release_hold",
    "Agency branding updates are release-held until publication scope, owned logo delivery, and custom-domain ownership verification are implemented; no branding changed.",
  );
}

const LIFECYCLE_HOLD =
  "Agency child lifecycle changes are release-held until owner, onboarding, invoicing, and payer handoff can complete safely.";

export async function setAgencyBillingMode(
  _input: AgencyBillingModeInput,
  _options?: AgencyRequestOptions,
): Promise<never> {
  throw new AgencyReleaseHeldError(
    "agency_billing_mode_release_hold",
    LIFECYCLE_HOLD,
  );
}

export async function createAgencyChild(
  _input: AgencyCreateChildInput,
  _options?: AgencyRequestOptions,
): Promise<never> {
  throw new AgencyReleaseHeldError(
    "agency_child_create_release_hold",
    LIFECYCLE_HOLD,
  );
}

export async function removeAgencyChild(
  _id: string,
  _options?: AgencyRequestOptions,
): Promise<never> {
  throw new AgencyReleaseHeldError(
    "agency_child_unlink_release_hold",
    LIFECYCLE_HOLD,
  );
}

export async function getAgencyInvoicePreview(
  _days?: number,
  _options?: AgencyRequestOptions,
): Promise<never> {
  throw new AgencyReleaseHeldError(
    "agency_invoice_preview_release_hold",
    "Agency billing estimates are release-held until consolidated invoicing and history consumers are qualified.",
  );
}

function fail(surface: string): never {
  throw new Error(`The ${surface} response was malformed.`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
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

function validDate(value: unknown): value is string {
  if (!boundedText(value, 128)) return false;
  const parts = RFC3339.exec(value);
  if (!parts || !Number.isFinite(Date.parse(value))) return false;
  const year = Number(parts[1]);
  const month = Number(parts[2]);
  const day = Number(parts[3]);
  return (
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= daysInMonth(year, month) &&
    Number(parts[4]) <= 23 &&
    Number(parts[5]) <= 59 &&
    Number(parts[6]) <= 59 &&
    Number(parts[7] ?? 0) <= 23 &&
    Number(parts[8] ?? 0) <= 59
  );
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    return leap ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
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

function validTier(value: unknown): value is AgencyChild["tier"] {
  return value === "studio" || value === "sending" || value === "pro";
}

function validMode(value: unknown): value is AgencyChild["billing_mode"] {
  return value === "self" || value === "parent";
}

export function normalizeAgencyChild(value: unknown): AgencyChild | null {
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
    typeof value.id !== "string" ||
    !UUID.test(value.id) ||
    typeof value.parent_tenant_id !== "string" ||
    !UUID.test(value.parent_tenant_id) ||
    !boundedText(value.slug, 63, { trimmed: true }) ||
    !ROSTER_SLUG.test(value.slug) ||
    !boundedText(value.name, 120, { trimmed: true }) ||
    !validTier(value.tier) ||
    !validMode(value.billing_mode) ||
    !safeInteger(value.reseller_markup_bps, 0, 100_000) ||
    typeof value.whitelabel_enabled !== "boolean" ||
    !validDate(value.created_at) ||
    !validDate(value.updated_at)
  ) {
    return null;
  }
  return value as unknown as AgencyChild;
}

export function normalizeAgencyBranding(value: unknown): AgencyBranding {
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
    if (
      !boundedText(value[key], 2_048, {
        empty: true,
        trimmed: true,
      })
    ) {
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
  return value as unknown as AgencyBranding;
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
