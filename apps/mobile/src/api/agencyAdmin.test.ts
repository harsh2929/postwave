import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  createAgencyChild,
  setAgencyBillingMode,
  unlinkAgencyChild,
  updateAgencyBranding,
} from "./agencyAdmin";

const { rawRequest } = vi.hoisted(() => ({ rawRequest: vi.fn() }));
vi.mock("@/api/request", () => ({ rawRequest }));

beforeEach(() => rawRequest.mockReset());

describe("agency mutation release holds", () => {
  it.each([
    [
      "create",
      () =>
        createAgencyChild({
          slug: "acme",
          name: "Acme",
          tier: "studio",
          billingMode: "self",
          resellerMarkupBps: 0,
        }),
      "agency_child_create_release_hold",
    ],
    [
      "unlink",
      () => unlinkAgencyChild("11111111-1111-4111-8111-111111111111"),
      "agency_child_unlink_release_hold",
    ],
    [
      "billing",
      () =>
        setAgencyBillingMode({
          targetTenantId: "11111111-1111-4111-8111-111111111111",
          mode: "parent",
          reason: "test",
        }),
      "agency_billing_mode_release_hold",
    ],
    [
      "branding",
      () =>
        updateAgencyBranding({
          current: {
            whitelabel_enabled: false,
            brand_name: "",
            custom_domain: "legacy.example.com",
            logo_url: "",
            primary_color: "",
            support_email: "",
            legal_entity: "Legacy LLC",
            updated_at: "2026-09-10T00:00:00Z",
            etag: '"agency-branding:1"',
          },
          payload: {
            whitelabel_enabled: false,
            brand_name: "",
            logo_url: "",
            primary_color: "",
            support_email: "",
          },
        }),
      "agency_branding_update_release_hold",
    ],
  ])("blocks %s before transport", async (_label, invoke, code) => {
    await expect(invoke()).rejects.toMatchObject({
      ambiguous: false,
      code,
      retryable: false,
      status: 503,
    });
    expect(rawRequest).not.toHaveBeenCalled();
  });
});
