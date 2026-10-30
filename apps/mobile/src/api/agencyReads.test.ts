import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  getMobileAgencyBranding,
  getMobileAgencyInvoicePreview,
  listMobileAgencyChildrenPage,
  MOBILE_AGENCY_CHILDREN_PAGE_SIZE,
} from "./agencyReads";

const { rawRequest } = vi.hoisted(() => ({ rawRequest: vi.fn() }));
vi.mock("./request", () => ({ rawRequest }));

const CHILD = {
  id: "11111111-1111-4111-8111-111111111111",
  slug: "acme-child",
  name: "Acme Child",
  tier: "studio",
  parent_tenant_id: "22222222-2222-4222-8222-222222222222",
  billing_mode: "self",
  reseller_markup_bps: 250,
  whitelabel_enabled: false,
  created_at: "2026-09-01T00:00:00Z",
  updated_at: "2026-09-02T00:00:00Z",
};

const BRANDING = {
  whitelabel_enabled: false,
  brand_name: "",
  custom_domain: "legacy.example.com",
  logo_url: "",
  primary_color: "",
  support_email: "",
  legal_entity: "Legacy LLC",
  updated_at: "2026-09-02T00:00:00Z",
  etag: '"agency-branding:22222222-2222-4222-8222-222222222222:v1"',
};
const TENANT_ID = "22222222-2222-4222-8222-222222222222";

beforeEach(() => rawRequest.mockReset());

describe("mobile agency read transport", () => {
  it("requests one bounded roster page and forwards cancellation", async () => {
    rawRequest.mockResolvedValueOnce({
      data: { children: [CHILD], count: 1, has_more: false },
      error: null,
    });
    const controller = new AbortController();

    await expect(
      listMobileAgencyChildrenPage(TENANT_ID, undefined, controller.signal),
    ).resolves.toMatchObject({ data: { count: 1, has_more: false } });
    expect(rawRequest).toHaveBeenCalledWith(
      "GET",
      `/api/v1/agency/children?limit=${MOBILE_AGENCY_CHILDREN_PAGE_SIZE}`,
      undefined,
      { signal: controller.signal },
    );
    expect(rawRequest).toHaveBeenCalledTimes(1);
  });

  it("puts an opaque continuation cursor in exactly one GET", async () => {
    rawRequest.mockResolvedValueOnce({
      data: {
        children: [CHILD],
        count: 1,
        has_more: true,
        next_cursor: "eyJpZCI6IjEifQ",
      },
      error: null,
    });

    await listMobileAgencyChildrenPage(TENANT_ID, "eyJwYWdlIjoyfQ");
    expect(rawRequest).toHaveBeenCalledWith(
      "GET",
      `/api/v1/agency/children?limit=${MOBILE_AGENCY_CHILDREN_PAGE_SIZE}&cursor=eyJwYWdlIjoyfQ`,
      undefined,
      undefined,
    );
    expect(rawRequest).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed pages and cursors without manufacturing rows", async () => {
    rawRequest.mockResolvedValueOnce({
      data: {
        children: [CHILD],
        count: 1,
        has_more: false,
        next_cursor: "must-not-exist",
      },
      error: null,
    });
    await expect(
      listMobileAgencyChildrenPage(TENANT_ID),
    ).resolves.toMatchObject({
      data: null,
      error: { code: "invalid_agency_response", retryable: false },
    });
    rawRequest.mockClear();
    await expect(
      listMobileAgencyChildrenPage(TENANT_ID, "../bad"),
    ).resolves.toMatchObject({
      data: null,
      error: { code: "invalid_agency_cursor", retryable: false },
    });
    expect(rawRequest).not.toHaveBeenCalled();

    await expect(
      listMobileAgencyChildrenPage("00000000-0000-0000-0000-000000000000"),
    ).resolves.toMatchObject({
      data: null,
      error: { code: "invalid_agency_authority", retryable: false },
    });
    await expect(
      getMobileAgencyBranding("00000000-0000-0000-0000-000000000000"),
    ).resolves.toMatchObject({
      data: null,
      error: { code: "invalid_agency_authority", retryable: false },
    });
    expect(rawRequest).not.toHaveBeenCalled();
  });

  it("requires the branding body and response header to carry one ETag", async () => {
    rawRequest.mockImplementationOnce(
      async (
        _method: string,
        _path: string,
        _body: unknown,
        options: { onResponseHeaders?: (headers: Headers) => void },
      ) => {
        options.onResponseHeaders?.(new Headers({ etag: BRANDING.etag }));
        return { data: BRANDING, error: null };
      },
    );
    await expect(getMobileAgencyBranding(TENANT_ID)).resolves.toEqual({
      data: BRANDING,
      error: null,
    });

    rawRequest.mockImplementationOnce(
      async (
        _method: string,
        _path: string,
        _body: unknown,
        options: { onResponseHeaders?: (headers: Headers) => void },
      ) => {
        options.onResponseHeaders?.(
          new Headers({
            etag: '"agency-branding:22222222-2222-4222-8222-222222222222:v2"',
          }),
        );
        return { data: BRANDING, error: null };
      },
    );
    await expect(getMobileAgencyBranding(TENANT_ID)).resolves.toMatchObject({
      data: null,
      error: { code: "invalid_agency_response", retryable: false },
    });
  });

  it("returns a non-retryable invoice hold without transport", async () => {
    await expect(getMobileAgencyInvoicePreview(30)).resolves.toMatchObject({
      data: null,
      error: {
        code: "agency_invoice_preview_release_hold",
        retryable: false,
        status: 503,
      },
    });
    expect(rawRequest).not.toHaveBeenCalled();
  });
});
