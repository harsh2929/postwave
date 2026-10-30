/**
 * Transport seam for the privacy-portal operator surface — given exactly the
 * `{data, error}` envelope rawRequest resolves to, do the right requests
 * leave and do the right rows come back?
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  cancelDoubleOptin,
  createPrivacyRegion,
  deletePrivacyRegion,
  extendDoubleOptin,
  listDoubleOptinPending,
} from "./privacyPortal";

const { rawRequest } = vi.hoisted(() => ({ rawRequest: vi.fn() }));
vi.mock("@/api/request", () => ({ rawRequest }));

beforeEach(() => rawRequest.mockReset());

describe("double opt-in queue transport", () => {
  it("lists pending rows from the real envelope with a bounded limit", async () => {
    rawRequest.mockResolvedValue({
      data: {
        pending: [
          {
            id: "p-1",
            email: "a@example.com",
            sent_at: "2026-08-01T00:00:00Z",
            expires_at: "2026-09-30T00:00:00Z",
          },
        ],
        count: 1,
      },
      error: null,
    });
    const page = await listDoubleOptinPending();
    expect(rawRequest).toHaveBeenCalledWith(
      "GET",
      "/api/v1/privacy/portal/double-optin/pending?limit=50",
      undefined,
    );
    expect(page.rows).toHaveLength(1);
  });

  it("POSTs the extend to the server's resend route", async () => {
    rawRequest.mockResolvedValue({ data: { ok: true }, error: null });
    await extendDoubleOptin("p-1");
    expect(rawRequest).toHaveBeenCalledWith(
      "POST",
      "/api/v1/privacy/portal/double-optin/p-1/resend",
      {},
    );
  });

  it("POSTs the cancel and surfaces a 404 with its code", async () => {
    rawRequest.mockResolvedValue({
      data: null,
      error: { status: 404, code: "not_found", message: "pending row not found" },
    });
    await expect(cancelDoubleOptin("p-2")).rejects.toMatchObject({
      status: 404,
      code: "not_found",
    });
    expect(rawRequest).toHaveBeenCalledWith(
      "POST",
      "/api/v1/privacy/portal/double-optin/p-2/cancel",
      {},
    );
  });
});

describe("regions transport", () => {
  it("normalises the input the way the server will (upper code, lower framework)", async () => {
    rawRequest.mockResolvedValue({
      data: { id: "r-9", region_code: "EU", framework: "gdpr" },
      error: null,
    });
    const row = await createPrivacyRegion({
      regionCode: " eu ",
      framework: "GDPR",
      requiresDoubleOptIn: true,
      requiresExplicitConsent: false,
      doNotSellDefault: false,
      gpcHonored: false,
    });
    expect(rawRequest).toHaveBeenCalledWith(
      "POST",
      "/api/v1/privacy/portal/regions",
      expect.objectContaining({
        region_code: "EU",
        framework: "gdpr",
        requires_double_optin: true,
      }),
    );
    expect(row?.id).toBe("r-9");
  });

  it("DELETEs by id and keeps the conflict/permission codes readable", async () => {
    rawRequest.mockResolvedValue({ data: null, error: null });
    await deletePrivacyRegion("r-1");
    expect(rawRequest).toHaveBeenCalledWith(
      "DELETE",
      "/api/v1/privacy/portal/regions/r-1",
      undefined,
    );
    rawRequest.mockResolvedValue({
      data: null,
      error: { status: 409, code: "region_conflict", message: "duplicate" },
    });
    await expect(
      createPrivacyRegion({
        regionCode: "EU",
        framework: "gdpr",
        requiresDoubleOptIn: false,
        requiresExplicitConsent: false,
        doNotSellDefault: false,
        gpcHonored: false,
      }),
    ).rejects.toMatchObject({ code: "region_conflict" });
  });
});
