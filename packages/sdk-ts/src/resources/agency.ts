// SPDX-License-Identifier: MIT

import { ParseError, PostwaveError } from "../errors.js";
import { Resource } from "./_base.js";

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

export interface AgencyChildrenPage {
  children: AgencyChild[];
  /** Rows in this page, not a portfolio total. */
  count: number;
  has_more: boolean;
  /** Present only when has_more is true. */
  next_cursor?: string;
}

/** @deprecated Use AgencyChildrenPage. */
export type AgencyChildrenResponse = AgencyChildrenPage;

export interface AgencyChildrenParams {
  /** Integer page size from 1 through 200; server default 100. */
  limit?: number;
  /** Exact opaque continuation returned by the preceding page. */
  cursor?: string;
}

export interface AgencyCreateChildInput {
  slug: string;
  name: string;
  tier?: "studio" | "sending" | "pro";
  billing_mode?: "self" | "parent";
  reseller_markup_bps?: number;
}

export interface AgencyBranding {
  whitelabel_enabled: boolean;
  brand_name: string;
  /** Legacy reserved field; not evidence of ownership, TLS, or routing. */
  custom_domain: string;
  /** Never fetch automatically; external requests disclose viewer metadata. */
  logo_url: string;
  primary_color: string;
  support_email: string;
  /** Legacy reserved field; no public legal publication is asserted. */
  legal_entity: string;
  /** Branding revision time; legacy rows begin at the security-migration baseline. */
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

export const AGENCY_CHILD_CREATE_RELEASE_HELD_CODE =
  "agency_child_create_release_hold" as const;
export const AGENCY_CHILD_UNLINK_RELEASE_HELD_CODE =
  "agency_child_unlink_release_hold" as const;
export const AGENCY_BRANDING_UPDATE_RELEASE_HELD_CODE =
  "agency_branding_update_release_hold" as const;
export const AGENCY_BILLING_MODE_RELEASE_HELD_CODE =
  "agency_billing_mode_release_hold" as const;
export const AGENCY_INVOICE_PREVIEW_RELEASE_HELD_CODE =
  "agency_invoice_preview_release_hold" as const;

export class AgencyReleaseHeldError extends PostwaveError {
  readonly retryable = false;
  readonly committed = false;

  constructor(code: string, message: string) {
    super(message, { status: 503, code });
    this.name = "AgencyReleaseHeldError";
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const CURSOR = /^[A-Za-z0-9_-]{1,512}$/u;
const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const ETAG =
  /^"agency-branding:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:v(?:0|[1-9][0-9]*)"$/u;
const HEX_COLOR = /^(?:|#[0-9A-Fa-f]{6})$/u;
const RFC3339 =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-](\d{2}):(\d{2}))$/u;
const UNSAFE_DISPLAY =
  /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/u;
const CHILD_KEYS = new Set([
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
]);
const PAGE_KEYS = new Set(["children", "count", "has_more", "next_cursor"]);
const BRANDING_KEYS = new Set([
  "whitelabel_enabled",
  "brand_name",
  "custom_domain",
  "logo_url",
  "primary_color",
  "support_email",
  "legal_entity",
  "updated_at",
  "etag",
]);
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

function held(code: string, message: string): Promise<never> {
  return Promise.reject(new AgencyReleaseHeldError(code, message));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowed: Set<string>,
): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function isTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parts = RFC3339.exec(value);
  if (!parts || !Number.isFinite(Date.parse(value))) return false;
  const year = Number(parts[1]);
  const month = Number(parts[2]);
  const day = Number(parts[3]);
  return (
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= new Date(Date.UTC(year, month, 0)).getUTCDate() &&
    Number(parts[4]) <= 23 &&
    Number(parts[5]) <= 59 &&
    Number(parts[6]) <= 59 &&
    Number(parts[7] ?? 0) <= 23 &&
    Number(parts[8] ?? 0) <= 59
  );
}

function isBoundedString(value: unknown, max: number): value is string {
  return (
    typeof value === "string" &&
    value.trim() === value &&
    [...value].length <= max &&
    !UNSAFE_DISPLAY.test(value)
  );
}

function isPublicHostname(value: unknown, allowEmpty = false): value is string {
  if (value === "") return allowEmpty;
  if (
    typeof value !== "string" ||
    value.length > 253 ||
    value !== value.toLowerCase() ||
    /[\s/\\:@%*?#\[\]]/u.test(value)
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

function isSafeLogoURL(value: unknown): value is string {
  if (value === "") return true;
  if (typeof value !== "string") return false;
  try {
    const parsed = new URL(value);
    return (
      parsed.protocol === "https:" &&
      parsed.username === "" &&
      parsed.password === "" &&
      parsed.port === "" &&
      parsed.search === "" &&
      parsed.hash === "" &&
      isPublicHostname(parsed.hostname) &&
      !/\\|%00|%0a|%0d|%5c/iu.test(parsed.pathname)
    );
  } catch {
    return false;
  }
}

function isChild(value: unknown): value is AgencyChild {
  if (!isRecord(value) || !hasOnlyKeys(value, CHILD_KEYS)) return false;
  return (
    typeof value.id === "string" &&
    UUID.test(value.id) &&
    typeof value.slug === "string" &&
    SLUG.test(value.slug) &&
    isBoundedString(value.name, 120) &&
    value.name.length > 0 &&
    (value.tier === "studio" ||
      value.tier === "sending" ||
      value.tier === "pro") &&
    typeof value.parent_tenant_id === "string" &&
    UUID.test(value.parent_tenant_id) &&
    (value.billing_mode === "self" || value.billing_mode === "parent") &&
    Number.isInteger(value.reseller_markup_bps) &&
    Number(value.reseller_markup_bps) >= 0 &&
    Number(value.reseller_markup_bps) <= 100_000 &&
    typeof value.whitelabel_enabled === "boolean" &&
    isTimestamp(value.created_at) &&
    isTimestamp(value.updated_at)
  );
}

export function decodeAgencyChildrenPage(value: unknown): AgencyChildrenPage {
  if (!isRecord(value) || !hasOnlyKeys(value, PAGE_KEYS)) {
    throw invalidResponse("child roster", value);
  }
  if (
    !Array.isArray(value.children) ||
    value.children.length > 200 ||
    !value.children.every(isChild) ||
    !Number.isInteger(value.count) ||
    value.count !== value.children.length ||
    typeof value.has_more !== "boolean" ||
    (value.has_more
      ? typeof value.next_cursor !== "string" || !CURSOR.test(value.next_cursor)
      : Object.prototype.hasOwnProperty.call(value, "next_cursor"))
  ) {
    throw invalidResponse("child roster", value);
  }
  return value as unknown as AgencyChildrenPage;
}

export function decodeAgencyBranding(value: unknown): AgencyBranding {
  if (!isRecord(value) || !hasOnlyKeys(value, BRANDING_KEYS)) {
    throw invalidResponse("branding", value);
  }
  if (
    typeof value.whitelabel_enabled !== "boolean" ||
    !isBoundedString(value.brand_name, 120) ||
    !isBoundedString(value.custom_domain, 253) ||
    !isPublicHostname(value.custom_domain, true) ||
    !isBoundedString(value.logo_url, 2048) ||
    !isSafeLogoURL(value.logo_url) ||
    !isBoundedString(value.primary_color, 7) ||
    !HEX_COLOR.test(value.primary_color) ||
    !isBoundedString(value.support_email, 254) ||
    !isBoundedString(value.legal_entity, 200) ||
    !isTimestamp(value.updated_at) ||
    typeof value.etag !== "string" ||
    !ETAG.test(value.etag)
  ) {
    throw invalidResponse("branding", value);
  }
  return value as unknown as AgencyBranding;
}

function invalidResponse(surface: string, payload: unknown): ParseError {
  return new ParseError({
    status: 200,
    payload,
    message: `Agency ${surface} returned an invalid bounded response.`,
  });
}

function childrenQuery(
  params: AgencyChildrenParams,
): Record<string, string | number> {
  const query: Record<string, string | number> = {};
  if (params.limit !== undefined) {
    if (
      !Number.isInteger(params.limit) ||
      params.limit < 1 ||
      params.limit > 200
    ) {
      throw new RangeError(
        "Agency roster limit must be an integer from 1 through 200",
      );
    }
    query.limit = params.limit;
  }
  if (params.cursor !== undefined) {
    if (typeof params.cursor !== "string" || !CURSOR.test(params.cursor)) {
      throw new RangeError(
        "Agency roster cursor must be an opaque base64url value of at most 512 characters",
      );
    }
    query.cursor = params.cursor;
  }
  return query;
}

/**
 * Admin-only Agency surface. Only the bounded roster and current tenant's
 * stored audit-portal branding record perform transport in this release.
 */
export class AgencyResource extends Resource {
  listChildren(params: AgencyChildrenParams = {}): Promise<AgencyChildrenPage> {
    const query = childrenQuery(params);
    const responseLimit = params.limit ?? 100;
    return this.client
      .request<unknown>("GET", "/api/v1/agency/children", {
        query,
      })
      .then((value) => {
        const page = decodeAgencyChildrenPage(value);
        if (page.children.length > responseLimit) {
          throw invalidResponse("child roster", value);
        }
        return page;
      });
  }

  createChild(_input: AgencyCreateChildInput): Promise<never> {
    return held(
      AGENCY_CHILD_CREATE_RELEASE_HELD_CODE,
      "Agency child creation is release-held until ownership, invitation, regional bootstrap, and billing provisioning commit atomically; no tenant was created.",
    );
  }

  unlinkChild(_id: string): Promise<never> {
    return held(
      AGENCY_CHILD_UNLINK_RELEASE_HELD_CODE,
      "Agency child unlink is release-held until independent ownership and active payer authority can be proven atomically; no relationship changed.",
    );
  }

  getBranding(): Promise<AgencyBranding> {
    return this.client
      .request<unknown>("GET", "/api/v1/agency/branding")
      .then(decodeAgencyBranding);
  }

  updateBranding(_patch: AgencyBrandingPatch): Promise<never> {
    return held(
      AGENCY_BRANDING_UPDATE_RELEASE_HELD_CODE,
      "Agency branding updates are release-held until publication scope, owned logo delivery, and custom-domain ownership verification are implemented; no branding changed.",
    );
  }

  setBillingMode(_input: {
    target_tenant_id: string;
    mode: "self" | "parent";
    reason: string;
  }): Promise<never> {
    return held(
      AGENCY_BILLING_MODE_RELEASE_HELD_CODE,
      "Agency billing-mode changes are release-held until payer authority and consolidated invoicing are durable; no billing state changed.",
    );
  }

  invoicePreview(_days = 30): Promise<never> {
    return held(
      AGENCY_INVOICE_PREVIEW_RELEASE_HELD_CODE,
      "Agency invoice preview is release-held until a fixed rated ledger, temporal cutoff, payer authority, and consolidated invoice processor exist; no estimate was generated.",
    );
  }
}
