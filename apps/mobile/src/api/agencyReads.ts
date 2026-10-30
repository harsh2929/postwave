/** The only Agency transports mobile may issue in this release. */
import { type AIApiResult, rawRequest } from "./request";
import {
  parseAgencyBrandingWire,
  parseAgencyChildrenWire,
  type AgencyBrandingWire,
  type AgencyChildrenWire,
  type AgencyChildWire,
} from "@/lib/agencyWire";

export type MobileAgencyBranding = AgencyBrandingWire;
export type MobileAgencyChild = AgencyChildWire;

export const MOBILE_AGENCY_CHILDREN_PAGE_SIZE = 20;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

async function strictAgencyResult<T>(
  resultPromise: Promise<AIApiResult<unknown>>,
  parse: (value: unknown) => T,
): Promise<AIApiResult<T>> {
  const result = await resultPromise;
  if (result.error) return { data: null, error: result.error };
  try {
    return { data: parse(result.data), error: null };
  } catch (error) {
    return {
      data: null,
      error: {
        status: 0,
        code: "invalid_agency_response",
        message:
          error instanceof Error
            ? error.message
            : "The agency response was malformed.",
        retryable: false,
      },
    };
  }
}

export async function getMobileAgencyBranding(
  expectedTenantId: string,
  signal?: AbortSignal,
): Promise<AIApiResult<MobileAgencyBranding>> {
  if (!UUID.test(expectedTenantId)) return invalidAuthorityResult();
  let responseETag: string | null = null;
  const result = await strictAgencyResult(
    rawRequest<unknown>("GET", "/api/v1/agency/branding", undefined, {
      ...(signal ? { signal } : {}),
      onResponseHeaders: (headers) => {
        responseETag = headers.get("etag");
      },
    }),
    parseAgencyBrandingWire,
  );
  if (result.error) return result;
  if (
    !responseETag ||
    responseETag !== result.data.etag ||
    !result.data.etag.startsWith(`"agency-branding:${expectedTenantId}:v`)
  ) {
    return {
      data: null,
      error: {
        status: 0,
        code: "invalid_agency_response",
        message: "The agency branding response returned conflicting versions.",
        retryable: false,
      },
    };
  }
  return result;
}

export async function listMobileAgencyChildrenPage(
  expectedParentTenantId: string,
  cursor?: string,
  signal?: AbortSignal,
): Promise<AIApiResult<AgencyChildrenWire>> {
  if (!UUID.test(expectedParentTenantId)) return invalidAuthorityResult();
  if (
    cursor !== undefined &&
    (cursor.length === 0 ||
      cursor.length > 512 ||
      !/^[A-Za-z0-9_-]+$/u.test(cursor))
  ) {
    return {
      data: null,
      error: {
        status: 0,
        code: "invalid_agency_cursor",
        message: "The agency child-workspace cursor was invalid.",
        retryable: false,
      },
    };
  }
  const path = `/api/v1/agency/children?limit=${MOBILE_AGENCY_CHILDREN_PAGE_SIZE}${
    cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""
  }`;
  const result = await strictAgencyResult(
    rawRequest<unknown>(
      "GET",
      path,
      undefined,
      signal ? { signal } : undefined,
    ),
    (value) => parseAgencyChildrenWire(value, MOBILE_AGENCY_CHILDREN_PAGE_SIZE),
  );
  if (result.error) return result;
  const ids = new Set<string>();
  for (const child of result.data.children) {
    if (
      child.parent_tenant_id !== expectedParentTenantId ||
      child.id === expectedParentTenantId ||
      ids.has(child.id)
    ) {
      return {
        data: null,
        error: {
          status: 0,
          code: "invalid_agency_response",
          message:
            "The agency child-workspace response did not match its authority owner.",
          retryable: false,
        },
      };
    }
    ids.add(child.id);
  }
  return result;
}

function invalidAuthorityResult<T>(): AIApiResult<T> {
  return {
    data: null,
    error: {
      status: 0,
      code: "invalid_agency_authority",
      message: "The agency authority owner was unresolved.",
      retryable: false,
    },
  };
}

/** Local failure: invoice preview never reaches transport. */
export async function getMobileAgencyInvoicePreview(
  _days = 30,
): Promise<AIApiResult<never>> {
  return {
    data: null,
    error: {
      status: 503,
      code: "agency_invoice_preview_release_hold",
      message:
        "Agency billing estimates are release-held until invoicing and history consumers are qualified.",
      retryable: false,
    },
  };
}
