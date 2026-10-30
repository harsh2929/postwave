// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
  delete: vi.fn(),
  get: vi.fn(),
  post: vi.fn(),
}));
vi.mock("@/lib/api", () => ({ api: apiMocks }));

import {
  addSmsSuppression,
  listSmsSuppressions,
  removeSmsSuppression,
} from "@/lib/sms-api";

const TENANT = "11111111-1111-4111-8111-111111111111";
const DEMO_TENANT = "00000000-0000-0000-0000-000000000001";

beforeEach(() => {
  for (const mock of Object.values(apiMocks)) mock.mockReset();
});

describe("web SMS suppression API boundary", () => {
  it("forwards only bounded cursor pagination and tenant-decodes the envelope", async () => {
    apiMocks.get.mockResolvedValue({
      tenantId: TENANT,
      items: [],
      total: 0,
      snapshotAt: "2026-08-21T10:00:00Z",
    });
    const controller = new AbortController();
    await listSmsSuppressions({
      tenantId: TENANT,
      limit: 200,
      cursor: "v1.b3BhcXVl",
      signal: controller.signal,
    });
    expect(apiMocks.get).toHaveBeenCalledWith(
      "/api/v1/sms/suppressions?limit=200&cursor=v1.b3BhcXVl",
      { signal: controller.signal },
    );
  });

  it("accepts the authoritative canonical non-v4 demo tenant", async () => {
    apiMocks.get.mockResolvedValue({
      tenantId: DEMO_TENANT,
      items: [],
      total: 0,
      snapshotAt: "2026-08-21T10:00:00Z",
    });

    await expect(
      listSmsSuppressions({ tenantId: DEMO_TENANT }),
    ).resolves.toMatchObject({ tenantId: DEMO_TENANT });
  });

  it("keeps exact recipient identity in the read-only body query", async () => {
    apiMocks.post.mockResolvedValue({
      tenantId: TENANT,
      items: [],
      total: 0,
      snapshotAt: "2026-08-21T10:00:00Z",
    });
    const controller = new AbortController();
    await listSmsSuppressions({
      tenantId: TENANT,
      phone: "+12025550101",
      reason: "manual",
      signal: controller.signal,
    });
    expect(apiMocks.post).toHaveBeenCalledWith(
      "/api/v1/sms/suppressions/query",
      {
        phone: "+12025550101",
        reason: "manual",
      },
      {
        idempotencyKey: null,
        requireOnline: true,
        signal: controller.signal,
      },
    );
    expect(JSON.stringify(apiMocks.post.mock.calls[0]?.[0])).not.toContain(
      "+12025550101",
    );
  });

  it("rejects invalid identity, cursor, phone, and IDs before SMS transport", () => {
    expect(() => listSmsSuppressions({ tenantId: "tenant" })).toThrow(
      /canonical lowercase tenant UUID/u,
    );
    expect(() =>
      listSmsSuppressions({
        tenantId: "00000000-0000-0000-0000-00000000000A",
      }),
    ).toThrow(/canonical lowercase tenant UUID/u);
    expect(() =>
      listSmsSuppressions({ tenantId: TENANT, cursor: "bad\nvalue" }),
    ).toThrow(/cursor/u);
    expect(() =>
      listSmsSuppressions({ tenantId: TENANT, cursor: "opaque" }),
    ).toThrow(/cursor/u);
    expect(() =>
      listSmsSuppressions({
        tenantId: TENANT,
        phone: "+12025550101",
        cursor: "v1.b3BhcXVl",
      }),
    ).toThrow(/cannot continue a cursor/u);
    expect(() =>
      listSmsSuppressions({
        tenantId: TENANT,
        phone: "+12025550101",
        limit: 1,
      }),
    ).toThrow(/does not accept a limit/u);
    expect(() =>
      addSmsSuppression({ phone: "+12021230100", reason: "manual" }),
    ).toThrow(/US\/Canada/u);
    expect(() => removeSmsSuppression("not-an-id", TENANT)).toThrow(/UUIDv4/u);
    expect(() =>
      removeSmsSuppression("33333333-3333-1333-8333-333333333333", TENANT),
    ).toThrow(/UUIDv4/u);
    expect(apiMocks.get).not.toHaveBeenCalled();
    expect(apiMocks.post).not.toHaveBeenCalled();
    expect(apiMocks.delete).not.toHaveBeenCalled();
  });

  it("allows only a manual hold and strictly decodes deletion receipts", async () => {
    apiMocks.post.mockResolvedValue({
      id: "33333333-3333-4333-8333-333333333333",
      phone_e164: "+12025550101",
      reason: "manual",
      source: "manual",
      created_at: "2026-08-21T09:00:00Z",
      reversible: true,
    });
    await expect(
      addSmsSuppression({ phone: "+12025550101", reason: "manual" }),
    ).resolves.toMatchObject({ phone_e164: "+12025550101" });
    expect(apiMocks.post).toHaveBeenCalledWith("/api/v1/sms/suppressions", {
      phone: "+12025550101",
      reason: "manual",
    }, { signal: undefined });
    apiMocks.post.mockResolvedValueOnce({
      id: "33333333-3333-4333-8333-333333333333",
      phone_e164: "+12025550102",
      reason: "manual",
      source: "manual",
      created_at: "2026-08-21T09:00:00Z",
      reversible: true,
    });
    await expect(
      addSmsSuppression({ phone: "+12025550101", reason: "manual" }),
    ).rejects.toThrow(/receipt identity/u);

    apiMocks.delete.mockResolvedValueOnce({
      ok: true,
      tenantId: TENANT,
      id: "33333333-3333-4333-8333-333333333333",
    });
    await expect(
      removeSmsSuppression(
        "33333333-3333-4333-8333-333333333333",
        TENANT,
      ),
    ).resolves.toEqual({
      ok: true,
      tenantId: TENANT,
      id: "33333333-3333-4333-8333-333333333333",
    });
    apiMocks.delete.mockResolvedValueOnce({
      ok: true,
      tenantId: TENANT,
      id: "33333333-3333-4333-8333-333333333333",
      removed: 1,
    });
    await expect(
      removeSmsSuppression(
        "33333333-3333-4333-8333-333333333333",
        TENANT,
      ),
    ).rejects.toThrow(/invalid SMS suppression removal receipt/iu);
  });
});
