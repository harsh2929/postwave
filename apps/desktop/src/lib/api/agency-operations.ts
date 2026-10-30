import type { ApiErr, ApiResult } from "./result";
import { DEMO_DATA_FALLBACK_ENABLED } from "../config";

export interface AgencyRequestOptions {
  timeoutMs?: number;
  maxAttempts?: number;
  requireOnline?: boolean;
  signal?: AbortSignal;
  /** Observe final response headers without exposing or retaining the body. */
  onResponseHeaders?: (headers: Headers) => void;
}

export type AgencyRequester = <T>(
  path: string,
  init?: RequestInit,
  opts?: AgencyRequestOptions,
) => Promise<ApiResult<T>>;

export interface AgencyOperationsDependencies {
  request: AgencyRequester;
}

const CANONICAL_AGENCY_TENANT_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const CANONICAL_AGENCY_ETAG_VERSION_PATTERN = /^(?:0|[1-9][0-9]*)$/u;

export interface AgencyChild {
  id: string;
  slug: string;
  name: string;
  tier: string;
  parent_tenant_id: string;
  billing_mode: "self" | "parent";
  reseller_markup_bps: number;
  whitelabel_enabled: boolean;
  created_at: string;
  updated_at: string;
}

export interface AgencyChildrenResponse {
  children: AgencyChild[];
  count: number;
  has_more: boolean;
  next_cursor?: string;
}

export interface AgencyListChildrenOptions {
  limit?: number;
  cursor?: string;
  signal?: AbortSignal;
}

export interface AgencyGetBrandingOptions {
  expectedTenantId: string;
  signal?: AbortSignal;
}

export interface AgencyCreateChildInput {
  slug: string;
  name: string;
  tier?: "studio" | "sending" | "pro";
  billing_mode?: "self" | "parent";
  reseller_markup_bps?: number;
}

export interface AgencyCreateChildResponse {
  id: string;
  slug: string;
  name: string;
  tier: string;
  parent_tenant_id: string;
  billing_mode: string;
}

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

export interface AgencyInvoiceLine {
  child_tenant_id: string;
  child_slug: string;
  child_tier: string;
  billing_mode: string;
  sends_last_30d: number;
  base_cost_usd: number;
  reseller_markup_bps: number;
  markup_usd: number;
  line_total_usd: number;
}

export interface AgencyInvoicePreview {
  agency_tenant_id: string;
  window_days: number;
  price_per_thousand_usd: number;
  lines: AgencyInvoiceLine[];
  subtotal_usd: number;
  total_usd: number;
  note?: string;
}

export function createAgencyListChildren({
  request,
}: AgencyOperationsDependencies) {
  return function agencyListChildren(
    options: AgencyListChildrenOptions = {},
  ): Promise<ApiResult<AgencyChildrenResponse>> {
    if (
      (options.limit !== undefined &&
        (!Number.isInteger(options.limit) ||
          options.limit < 1 ||
          options.limit > 200)) ||
      (options.cursor !== undefined &&
        (options.cursor.length < 1 ||
          options.cursor.length > 512 ||
          !/^[A-Za-z0-9_-]+$/u.test(options.cursor)))
    ) {
      return Promise.resolve({
        error: {
          kind: "invalid_config",
          code: "invalid_agency_children_page",
          message:
            "Agency roster pages require a limit from 1 through 200 and an exact URL-safe continuation cursor.",
        },
        retryability: "not-retryable",
      });
    }
    const query = new URLSearchParams();
    if (options.limit !== undefined) query.set("limit", String(options.limit));
    if (options.cursor !== undefined) query.set("cursor", options.cursor);
    const suffix = query.size > 0 ? `?${query.toString()}` : "";
    return request<AgencyChildrenResponse>(
      `/api/v1/agency/children${suffix}`,
      undefined,
      options.signal ? { signal: options.signal } : undefined,
    );
  };
}

function agencyReleaseHeld(code: string, message: string): Promise<ApiErr> {
  return Promise.resolve({
    error: {
      kind: "http",
      status: 503,
      code,
      message,
    },
    retryability: "not-retryable",
  });
}

export function createAgencyCreateChild({
  request: _request,
}: AgencyOperationsDependencies) {
  return function agencyCreateChild(
    _input: AgencyCreateChildInput,
  ): Promise<ApiErr> {
    return agencyReleaseHeld(
      "agency_child_create_release_hold",
      "Sub-account creation is release-held until ownership, membership, onboarding, workspace switching, and billing provisioning are authoritative.",
    );
  };
}

export function createAgencyUnlinkChild({
  request: _request,
}: AgencyOperationsDependencies) {
  return function agencyUnlinkChild(_id: string): Promise<ApiErr> {
    return agencyReleaseHeld(
      "agency_child_unlink_release_hold",
      "Sub-account unlink is release-held until independent ownership and active billing authority can be proven atomically.",
    );
  };
}

export function createAgencyGetBranding({
  request,
}: AgencyOperationsDependencies) {
  return async function agencyGetBranding(
    options: AgencyGetBrandingOptions,
  ): Promise<ApiResult<AgencyBranding>> {
    if (!CANONICAL_AGENCY_TENANT_PATTERN.test(options.expectedTenantId)) {
      return {
        error: {
          kind: "invalid_config",
          code: "invalid_agency_branding_authority",
          message:
            "Agency branding requires an exact current workspace identity before any request is made.",
        },
        retryability: "not-retryable",
      };
    }
    let responseETag: string | null = null;
    const result = await request<AgencyBranding>(
      "/api/v1/agency/branding",
      undefined,
      {
        ...(options.signal ? { signal: options.signal } : {}),
        onResponseHeaders: (headers) => {
          responseETag = headers.get("etag");
        },
      },
    );
    if (result.error) return result;
    if (
      (!responseETag && !DEMO_DATA_FALLBACK_ENABLED) ||
      typeof result.data?.etag !== "string" ||
      (responseETag !== null && result.data.etag !== responseETag) ||
      !brandingETagBelongsToTenant(result.data.etag, options.expectedTenantId)
    ) {
      return {
        error: {
          kind: "parse",
          code: "agency_branding_etag_mismatch",
          message:
            "The agency branding response did not include matching body and ETag-header validators.",
        },
        retryability: "not-retryable",
      };
    }
    return result;
  };
}

function brandingETagBelongsToTenant(
  etag: string,
  expectedTenantId: string,
): boolean {
  const prefix = `"agency-branding:${expectedTenantId}:v`;
  if (!etag.startsWith(prefix) || !etag.endsWith('"')) return false;
  return CANONICAL_AGENCY_ETAG_VERSION_PATTERN.test(
    etag.slice(prefix.length, -1),
  );
}

export function createAgencyUpdateBranding({
  request: _request,
}: AgencyOperationsDependencies) {
  return function agencyUpdateBranding(
    _patch: Partial<AgencyBranding>,
  ): Promise<ApiErr> {
    return agencyReleaseHeld(
      "agency_branding_update_release_hold",
      "Agency branding changes are release-held until the audit-portal consumer honors the enable boundary and unpublished fields remain contained.",
    );
  };
}

export function createAgencyInvoicePreview({
  request: _request,
}: AgencyOperationsDependencies) {
  return function agencyInvoicePreview(_days?: number): Promise<ApiErr> {
    return agencyReleaseHeld(
      "agency_invoice_preview_release_hold",
      "Usage and invoice projections are release-held until consolidated billing has a fixed rated ledger, temporal cutoff, and payer authority.",
    );
  };
}

export function createAgencySetBillingMode({
  request: _request,
}: AgencyOperationsDependencies) {
  return function agencySetBillingMode(_input: {
    target_tenant_id?: string;
    mode: "self" | "parent";
    reason?: string;
  }): Promise<ApiErr> {
    return agencyReleaseHeld(
      "agency_billing_mode_release_hold",
      "Billing-owner changes are release-held until payer authority and consolidated invoicing are durably implemented.",
    );
  };
}

export function createAgencyOperationsMethods(
  dependencies: AgencyOperationsDependencies,
) {
  return {
    agencyListChildren: createAgencyListChildren(dependencies),
    agencyCreateChild: createAgencyCreateChild(dependencies),
    agencyUnlinkChild: createAgencyUnlinkChild(dependencies),
    agencyGetBranding: createAgencyGetBranding(dependencies),
    agencyUpdateBranding: createAgencyUpdateBranding(dependencies),
    agencyInvoicePreview: createAgencyInvoicePreview(dependencies),
    agencySetBillingMode: createAgencySetBillingMode(dependencies),
  };
}
