import type {
  AgencyBranding,
  AgencyChild,
  AgencyChildrenResponse,
} from "../../lib/api-client";
import { rfc3339EpochNanoseconds } from "../../lib/rfc3339-revision";
import {
  remoteFailureFromError,
  type RemoteApiError,
} from "../../lib/remote-resource";

const FALLBACK_PRIMARY_COLOR = "#1d4ed8";
const LIGHT_FOREGROUND = "#ffffff";
const DARK_FOREGROUND = "#000000";
const HEX_COLOR_PATTERN = /^#[0-9a-f]{6}$/iu;
const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const DNS_LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const UNSAFE_TEXT_PATTERN =
  /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/u;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const CURSOR_PATTERN = /^[A-Za-z0-9_-]{1,512}$/u;
const BRANDING_ETAG_PATTERN =
  /^"agency-branding:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}:v(?:0|[1-9][0-9]*)"$/u;
const MAX_AGENCY_CHILDREN_PAGE_SIZE = 200;
const RESERVED_PUBLIC_HOST_SUFFIXES = [
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
const CHILD_TIERS = new Set(["studio", "sending", "pro"]);
const CHILD_RESPONSE_KEYS = [
  "children",
  "count",
  "has_more",
  "next_cursor",
] as const;
const CHILD_KEYS = [
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
] as const;
const BRANDING_KEYS = [
  "whitelabel_enabled",
  "brand_name",
  "custom_domain",
  "logo_url",
  "primary_color",
  "support_email",
  "legal_entity",
  "updated_at",
  "etag",
] as const;

export interface ContrastPair {
  background: string;
  foreground: string;
  ratio: number;
  foregroundName: "black" | "white";
}

export interface SafeFailurePresentation {
  message: string;
  reference: string | null;
}

export function isNotAgencyError(
  error:
    | {
        code?: string;
      }
    | null
    | undefined,
): boolean {
  return error?.code?.trim().toLowerCase() === "not_agency";
}

export function safePublicHttpsLogoUrl(value: string): string | null {
  const candidate = value.trim();
  if (!candidate || candidate.length > 2048) return null;
  try {
    const parsed = new URL(candidate);
    if (
      parsed.protocol !== "https:" ||
      parsed.username ||
      parsed.password ||
      parsed.hash ||
      parsed.search ||
      parsed.port ||
      candidate.includes("\\") ||
      /%00|%0a|%0d|%5c/iu.test(parsed.pathname) ||
      isIneligiblePublicHost(parsed.hostname)
    ) {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

export function contrastPairFor(
  value: string | null | undefined,
): ContrastPair {
  const candidate = value?.trim() ?? "";
  const background = HEX_COLOR_PATTERN.test(candidate)
    ? candidate.toLowerCase()
    : FALLBACK_PRIMARY_COLOR;
  const luminance = relativeLuminance(background);
  const whiteRatio = 1.05 / (luminance + 0.05);
  const blackRatio = (luminance + 0.05) / 0.05;
  const useWhite = whiteRatio >= blackRatio;
  return {
    background,
    foreground: useWhite ? LIGHT_FOREGROUND : DARK_FOREGROUND,
    ratio: useWhite ? whiteRatio : blackRatio,
    foregroundName: useWhite ? "white" : "black",
  };
}

export function safeFailurePresentation(
  error: unknown,
): SafeFailurePresentation {
  const normalized = isRemoteErrorLike(error)
    ? error
    : ({ kind: "network" } satisfies RemoteApiError);
  const failure = remoteFailureFromError(normalized);
  const reference = [failure.code, failure.requestId]
    .filter(Boolean)
    .join(" · ");
  return { message: failure.message, reference: reference || null };
}

export function parseAgencyChildren(
  value: unknown,
): AgencyChildrenResponse | null {
  if (
    !isExactRecord(value, CHILD_RESPONSE_KEYS, [
      "children",
      "count",
      "has_more",
    ]) ||
    !Array.isArray(value.children) ||
    value.children.length > MAX_AGENCY_CHILDREN_PAGE_SIZE ||
    !boundedNumber(value.count, 0, MAX_AGENCY_CHILDREN_PAGE_SIZE) ||
    !Number.isInteger(value.count) ||
    value.count !== value.children.length ||
    typeof value.has_more !== "boolean" ||
    (value.has_more
      ? typeof value.next_cursor !== "string" ||
        !CURSOR_PATTERN.test(value.next_cursor)
      : value.next_cursor !== undefined)
  ) {
    return null;
  }
  const rows: AgencyChild[] = [];
  const ids = new Set<string>();
  const slugs = new Set<string>();
  for (const candidate of value.children) {
    if (!isValidChild(candidate)) return null;
    if (ids.has(candidate.id) || slugs.has(candidate.slug)) return null;
    ids.add(candidate.id);
    slugs.add(candidate.slug);
    rows.push(candidate);
  }
  return {
    children: rows,
    count: rows.length,
    has_more: value.has_more,
    ...(value.has_more ? { next_cursor: value.next_cursor as string } : {}),
  };
}

export function parseAgencyBranding(value: unknown): AgencyBranding | null {
  if (
    !isExactRecord(value, BRANDING_KEYS) ||
    typeof value.whitelabel_enabled !== "boolean" ||
    !trimmedStringWithin(value.brand_name, 120) ||
    !trimmedStringWithin(value.custom_domain, 253) ||
    (value.custom_domain !== "" &&
      isIneligiblePublicHost(value.custom_domain)) ||
    !trimmedStringWithin(value.logo_url, 2048) ||
    (value.logo_url !== "" &&
      safePublicHttpsLogoUrl(value.logo_url) === null) ||
    !trimmedStringWithin(value.primary_color, 7) ||
    (value.primary_color !== "" &&
      !HEX_COLOR_PATTERN.test(value.primary_color)) ||
    !trimmedStringWithin(value.support_email, 254) ||
    !trimmedStringWithin(value.legal_entity, 200) ||
    typeof value.updated_at !== "string" ||
    rfc3339EpochNanoseconds(value.updated_at) === null ||
    typeof value.etag !== "string" ||
    !BRANDING_ETAG_PATTERN.test(value.etag)
  ) {
    return null;
  }
  return {
    whitelabel_enabled: value.whitelabel_enabled,
    brand_name: value.brand_name,
    custom_domain: value.custom_domain,
    logo_url: value.logo_url,
    primary_color: value.primary_color,
    support_email: value.support_email,
    legal_entity: value.legal_entity,
    updated_at: value.updated_at,
    etag: value.etag,
  };
}

export function formatInteger(value: number): string {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(
    value,
  );
}

export function formatInstant(value: string | number): string {
  const instant = typeof value === "number" ? new Date(value) : new Date(value);
  if (!Number.isFinite(instant.getTime())) return "Unknown time";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(instant);
}

function relativeLuminance(hex: string): number {
  const channels = [1, 3, 5].map(
    (offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255,
  );
  const linear = channels.map((channel) =>
    channel <= 0.04045
      ? channel / 12.92
      : Math.pow((channel + 0.055) / 1.055, 2.4),
  );
  return (
    0.2126 * (linear[0] ?? 0) +
    0.7152 * (linear[1] ?? 0) +
    0.0722 * (linear[2] ?? 0)
  );
}

function isIneligiblePublicHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  const labels = host.split(".");
  if (
    hostname !== hostname.toLowerCase() ||
    host.length > 253 ||
    labels.length < 2 ||
    !labels.every((label) => DNS_LABEL_PATTERN.test(label))
  ) {
    return true;
  }
  if (
    RESERVED_PUBLIC_HOST_SUFFIXES.some(
      (suffix) => host === suffix || host.endsWith(`.${suffix}`),
    )
  ) {
    return true;
  }
  if (host.includes(":")) return true;
  const octets = host.split(".").map(Number);
  if (
    octets.length !== 4 ||
    octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)
  ) {
    return (
      labels.length >= 2 &&
      labels.length <= 4 &&
      labels.every((label) => /^(?:0x[0-9a-f]+|[0-9]+)$/u.test(label))
    );
  }
  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isExactRecord<const Key extends string>(
  value: unknown,
  allowed: readonly Key[],
  required: readonly Key[] = allowed,
): value is Record<Key, unknown> {
  if (!isRecord(value)) return false;
  const allowedKeys = new Set<string>(allowed);
  return (
    required.every((key) => Object.prototype.hasOwnProperty.call(value, key)) &&
    Object.keys(value).every((key) => allowedKeys.has(key))
  );
}

function stringWithin(value: unknown, max: number): value is string {
  return (
    typeof value === "string" &&
    value.length <= max &&
    !UNSAFE_TEXT_PATTERN.test(value)
  );
}

function trimmedStringWithin(value: unknown, max: number): value is string {
  return stringWithin(value, max) && value.trim() === value;
}

function isUUID(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value === value.toLowerCase() &&
    UUID_PATTERN.test(value)
  );
}

function boundedString(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

function boundedNumber(
  value: unknown,
  min: number,
  max: number,
): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= min &&
    value <= max
  );
}

function isValidChild(value: unknown): value is AgencyChild {
  if (
    !(
      isExactRecord(value, CHILD_KEYS) &&
      isUUID(value.id) &&
      typeof value.slug === "string" &&
      SLUG_PATTERN.test(value.slug) &&
      boundedString(value.name, 120) &&
      value.name.trim() === value.name &&
      !UNSAFE_TEXT_PATTERN.test(value.name) &&
      typeof value.tier === "string" &&
      CHILD_TIERS.has(value.tier) &&
      isUUID(value.parent_tenant_id) &&
      (value.billing_mode === "self" || value.billing_mode === "parent") &&
      boundedNumber(value.reseller_markup_bps, 0, 100000) &&
      Number.isInteger(value.reseller_markup_bps) &&
      typeof value.whitelabel_enabled === "boolean" &&
      boundedString(value.created_at, 128) &&
      boundedString(value.updated_at, 128)
    )
  ) {
    return false;
  }
  const createdAt = rfc3339EpochNanoseconds(value.created_at);
  const updatedAt = rfc3339EpochNanoseconds(value.updated_at);
  return createdAt !== null && updatedAt !== null && updatedAt >= createdAt;
}

function isRemoteErrorLike(value: unknown): value is RemoteApiError {
  if (!isRecord(value)) return false;
  return (
    value.status === undefined ||
    (typeof value.status === "number" && Number.isFinite(value.status))
  );
}
