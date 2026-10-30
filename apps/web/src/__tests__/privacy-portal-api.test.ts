// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from "vitest";

const apiMock = vi.hoisted(() => ({
  delete: vi.fn(),
  get: vi.fn(),
  patch: vi.fn(),
  post: vi.fn(),
}));
vi.mock("@/lib/api", () => ({ api: apiMock }));

import {
  cancelDoubleOptIn,
  createPrivacyRegion,
  deletePrivacyRegion,
  extendDoubleOptInWindow,
  getDoubleOptInPending,
  getPreferenceCentreBranding,
  getPrivacyPortal,
  mergeDoubleOptInPendingPages,
  savePreferenceCentreBranding,
} from "@/lib/privacy-portal-api";

const TENANT = "11111111-1111-4111-8111-111111111111";
const REGION_ID = "22222222-2222-4222-8222-222222222222";
const PENDING_ONE = "33333333-3333-4333-8333-333333333333";
const PENDING_TWO = "44444444-4444-4444-8444-444444444444";

function region(over: Record<string, unknown> = {}) {
  return {
    id: REGION_ID,
    tenantId: TENANT,
    region_code: "EU",
    framework: "gdpr",
    requires_double_optin: true,
    requires_explicit_consent: true,
    do_not_sell_default: false,
    gpc_honored: true,
    created_at: "2026-08-01T00:00:00Z",
    updated_at: "2026-08-02T00:00:00Z",
    ...over,
  };
}

function portal(over: Record<string, unknown> = {}) {
  return {
    tenantId: TENANT,
    regions: [region()],
    dsar_requests: [
      { request_type: "erasure", open: 3, overdue: 1, closed: 9 },
    ],
    suppression_breakdown: [{ reason: "hard_bounce", count: 4 }],
    consent_proof_summary: [{ source: "hosted_form", count: 12 }],
    gpc_signaled_count: 7,
    do_not_sell_count: 5,
    double_optin_pending: 2,
    generated_at: "2026-08-29T10:00:00Z",
    ...over,
  };
}

function pendingRow(
  id: string,
  sent: string,
  expires: string,
  over: Record<string, unknown> = {},
) {
  return {
    id,
    email: `${id.slice(0, 4)}@example.com`,
    sent_at: sent,
    expires_at: expires,
    ...over,
  };
}

beforeEach(() => {
  apiMock.delete.mockReset();
  apiMock.get.mockReset();
  apiMock.patch.mockReset();
  apiMock.post.mockReset();
});

describe("privacy portal read contracts", () => {
  it("decodes an exact tenant-bound aggregate and forwards cancellation", async () => {
    const signal = new AbortController().signal;
    apiMock.get.mockResolvedValue(portal());
    await expect(getPrivacyPortal(TENANT, { signal })).resolves.toEqual(
      portal(),
    );
    expect(apiMock.get).toHaveBeenCalledWith("/api/v1/privacy/portal", {
      signal,
    });
  });

  it.each([
    portal({ tenantId: "55555555-5555-4555-8555-555555555555" }),
    portal({ generated_at: "2026-02-30T10:00:00Z" }),
    portal({
      dsar_requests: [
        { request_type: "erasure", open: 0, overdue: 1, closed: 0 },
      ],
    }),
    portal({ extra: true }),
    portal({ regions: [region(), region()] }),
  ])(
    "rejects malformed, foreign, or ambiguous aggregate data",
    async (body) => {
      apiMock.get.mockResolvedValue(body);
      await expect(getPrivacyPortal(TENANT)).rejects.toThrow(/privacy/iu);
    },
  );

  it("strictly decodes and continuously merges pending pages", async () => {
    const firstRow = pendingRow(
      PENDING_ONE,
      "2026-08-29T10:00:00Z",
      "2026-10-28T10:00:00Z",
    );
    const secondRow = pendingRow(
      PENDING_TWO,
      "2026-08-28T10:00:00Z",
      "2026-10-27T10:00:00Z",
    );
    apiMock.get
      .mockResolvedValueOnce({
        tenantId: TENANT,
        pending: [firstRow],
        count: 1,
        nextCursor: "signed_cursor_one",
      })
      .mockResolvedValueOnce({
        tenantId: TENANT,
        pending: [secondRow],
        count: 1,
      });

    const first = await getDoubleOptInPending({ tenantId: TENANT, limit: 1 });
    const second = await getDoubleOptInPending({
      tenantId: TENANT,
      cursor: first.nextCursor,
      limit: 1,
    });
    expect(mergeDoubleOptInPendingPages([first, second], TENANT)).toEqual([
      firstRow,
      secondRow,
    ]);
    expect(() =>
      mergeDoubleOptInPendingPages(
        [first, { ...second, requestCursor: "wrong_cursor" }],
        TENANT,
      ),
    ).toThrow(/page chain/iu);
  });

  it("fails closed on poisoned pending queue rows", async () => {
    apiMock.get.mockResolvedValue({
      tenantId: TENANT,
      pending: [
        pendingRow(PENDING_ONE, "2026-08-29T10:00:00Z", "2026-08-28T10:00:00Z"),
      ],
      count: 1,
    });
    await expect(getDoubleOptInPending({ tenantId: TENANT })).rejects.toThrow(
      /pending/iu,
    );
  });

  it("rejects unsafe saved branding instead of previewing it", async () => {
    apiMock.get.mockResolvedValue({
      tenantId: TENANT,
      logo_url: "https://127.0.0.1/admin",
      primary_color: "#123ABC",
      footer_text: "Subscriber controls",
      show_postwave_badge: true,
    });
    await expect(getPreferenceCentreBranding(TENANT)).rejects.toThrow(
      /customization/iu,
    );
  });
});

describe("privacy portal write receipts", () => {
  const input = {
    region_code: "eu",
    framework: "gdpr" as const,
    requires_double_optin: true,
    requires_explicit_consent: true,
    do_not_sell_default: false,
    gpc_honored: true,
  };

  it("creates a canonical region online and verifies the full receipt", async () => {
    apiMock.post.mockResolvedValue(region());
    const signal = new AbortController().signal;
    await expect(createPrivacyRegion(input, TENANT, signal)).resolves.toEqual(
      region(),
    );
    expect(apiMock.post).toHaveBeenCalledWith(
      "/api/v1/privacy/portal/regions",
      { ...input, region_code: "EU" },
      { requireOnline: true, signal },
    );
  });

  it("rejects a mismatched create receipt", async () => {
    apiMock.post.mockResolvedValue(region({ framework: "other" }));
    await expect(createPrivacyRegion(input, TENANT)).rejects.toThrow(
      /creation receipt/iu,
    );
  });

  it("requires exact tenant/id receipts for deletion and confirmation actions", async () => {
    const regionReceipt = { ok: true, tenantId: TENANT, id: REGION_ID };
    apiMock.delete.mockResolvedValue(regionReceipt);
    await expect(deletePrivacyRegion(REGION_ID, TENANT)).resolves.toEqual(
      regionReceipt,
    );
    expect(apiMock.delete).toHaveBeenCalledWith(
      `/api/v1/privacy/portal/regions/${REGION_ID}`,
      { requireOnline: true, signal: undefined },
    );

    const pendingReceipt = { ok: true, tenantId: TENANT, id: PENDING_ONE };
    apiMock.post.mockResolvedValueOnce(pendingReceipt);
    await expect(extendDoubleOptInWindow(PENDING_ONE, TENANT)).resolves.toEqual(
      pendingReceipt,
    );
    expect(apiMock.post).toHaveBeenLastCalledWith(
      `/api/v1/privacy/portal/double-optin/${PENDING_ONE}/resend`,
      {},
      { maxAttempts: 1, requireOnline: true, signal: undefined },
    );

    apiMock.post.mockResolvedValueOnce({ ...pendingReceipt, id: PENDING_TWO });
    await expect(cancelDoubleOptIn(PENDING_ONE, TENANT)).rejects.toThrow(
      /mutation receipt/iu,
    );
  });

  it("saves only exact public-safe branding online", async () => {
    const inputTheme = {
      logo_url: "https://assets.example.com/logo.png",
      primary_color: "#123ABC",
      footer_text: "Subscriber controls",
      show_postwave_badge: false,
    };
    const response = { tenantId: TENANT, ...inputTheme };
    apiMock.patch.mockResolvedValue(response);
    await expect(
      savePreferenceCentreBranding(inputTheme, TENANT),
    ).resolves.toEqual(response);
    expect(apiMock.patch).toHaveBeenCalledWith(
      "/api/v1/privacy/portal/preference-center",
      inputTheme,
      { requireOnline: true, signal: undefined },
    );

    await expect(
      savePreferenceCentreBranding(
        { ...inputTheme, logo_url: "https://localhost/logo.png" },
        TENANT,
      ),
    ).rejects.toThrow(/input/iu);
    expect(apiMock.patch).toHaveBeenCalledTimes(1);
  });
});
