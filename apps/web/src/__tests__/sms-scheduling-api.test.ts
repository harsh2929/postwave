// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  delete: vi.fn(),
  get: vi.fn(),
  patch: vi.fn(),
  post: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  api: {
    delete: mocks.delete,
    get: mocks.get,
    patch: mocks.patch,
    post: mocks.post,
  },
}));

import {
  createSmsQuietHours,
  deleteSmsQuietHours,
  listSmsQuietHours,
  updateSmsQuietHours,
  type SmsQuietHoursMutationInput,
} from "@/lib/sms-scheduling-api";

const TENANT = "22222222-2222-4222-8222-222222222222";

function row(over: Record<string, unknown> = {}) {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    tenant_id: TENANT,
    label: "Tenant-global night",
    country_code: "",
    start_minute: 1260,
    end_minute: 540,
    start_local: "21:00",
    end_local: "09:00",
    days: [1, 2, 3],
    timezone: "America/New_York",
    enabled: true,
    created_at: "2026-08-21T09:00:00Z",
    updated_at: "2026-08-21T09:00:00Z",
    ...over,
  };
}

beforeEach(() => {
  mocks.delete.mockReset();
  mocks.get.mockReset();
  mocks.patch.mockReset();
  mocks.post.mockReset();
});

describe("SMS quiet-hours tenant envelope", () => {
  it("accepts a verified empty inventory and forwards cancellation", async () => {
    const signal = new AbortController().signal;
    mocks.get.mockResolvedValue({ tenantId: TENANT, items: [] });

    await expect(listSmsQuietHours(TENANT, { signal })).resolves.toEqual([]);
    expect(mocks.get).toHaveBeenCalledWith("/api/v1/sms/quiet-hours", {
      signal,
    });
  });

  it("strictly decodes a tenant-global row", async () => {
    mocks.get.mockResolvedValue({ tenantId: TENANT, items: [row()] });
    await expect(listSmsQuietHours(TENANT)).resolves.toEqual([row()]);
  });

  it("admits bounded historical scopes so an admin can atomically retire them", async () => {
    const historical = row({ country_code: "US" });
    mocks.get.mockResolvedValue({ tenantId: TENANT, items: [historical] });
    await expect(listSmsQuietHours(TENANT)).resolves.toEqual([historical]);
  });

  it.each([
    { items: [] },
    { tenantId: "33333333-3333-4333-8333-333333333333", items: [] },
    { tenantId: TENANT, items: [], extra: true },
    {
      tenantId: TENANT,
      items: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          tenant_id: "33333333-3333-4333-8333-333333333333",
        },
      ],
    },
  ])("rejects malformed or foreign empty/row envelopes", async (payload) => {
    mocks.get.mockResolvedValue(payload);
    await expect(listSmsQuietHours(TENANT)).rejects.toThrow(
      /quiet-hours (?:envelope|row)/u,
    );
  });

  it.each([
    row({ country_code: "GB" }),
    row({ start_minute: 1260.5 }),
    row({ start_local: "21:01" }),
    row({ days: [1, 1] }),
    row({ timezone: "Not/AZone" }),
    row({ label: "Night\u202Eunsafe" }),
    row({ created_at: "2000-01-01T00:00:00+14:00" }),
    { ...row(), extra: true },
  ])("rejects row poison and unsupported country scope", async (poison) => {
    mocks.get.mockResolvedValue({ tenantId: TENANT, items: [poison] });
    await expect(listSmsQuietHours(TENANT)).rejects.toThrow(/quiet-hours row/u);
  });
});

describe("SMS quiet-hours mutation receipts", () => {
  const input: SmsQuietHoursMutationInput = {
    label: "Tenant-global night",
    country_code: "",
    start_minute: 1260,
    end_minute: 540,
    days: [1, 2, 3],
    timezone: "America/New_York",
    enabled: true,
  };

  it("creates online-only and verifies the complete returned policy", async () => {
    mocks.post.mockResolvedValue(row());
    const signal = new AbortController().signal;

    await expect(createSmsQuietHours(input, TENANT, signal)).resolves.toEqual(
      row(),
    );
    expect(mocks.post).toHaveBeenCalledWith("/api/v1/sms/quiet-hours", input, {
      requireOnline: true,
      signal,
    });
  });

  it("uses exact CAS state on update and rejects an unchanged or mismatched receipt", async () => {
    const updated = row({
      enabled: false,
      updated_at: "2026-08-21T09:00:00.000001Z",
    });
    mocks.patch.mockResolvedValueOnce(updated);
    await expect(
      updateSmsQuietHours(
        row().id,
        { ...input, enabled: false },
        row().updated_at,
        TENANT,
      ),
    ).resolves.toEqual(updated);
    expect(mocks.patch).toHaveBeenCalledWith(
      `/api/v1/sms/quiet-hours/${row().id}`,
      { ...input, enabled: false, expected_updated_at: row().updated_at },
      { requireOnline: true, signal: undefined },
    );

    mocks.patch.mockResolvedValueOnce(row({ enabled: false }));
    await expect(
      updateSmsQuietHours(
        row().id,
        { ...input, enabled: false },
        row().updated_at,
        TENANT,
      ),
    ).rejects.toThrow(/mutation receipt/u);
  });

  it("binds deletion to row version, tenant and exact receipt", async () => {
    const receipt = { ok: true, tenantId: TENANT, id: row().id };
    mocks.delete.mockResolvedValueOnce(receipt);
    await expect(
      deleteSmsQuietHours(row().id, row().updated_at, TENANT),
    ).resolves.toEqual(receipt);
    expect(mocks.delete).toHaveBeenCalledWith(
      `/api/v1/sms/quiet-hours/${row().id}`,
      {
        body: { expected_updated_at: row().updated_at },
        requireOnline: true,
        signal: undefined,
      },
    );

    mocks.delete.mockResolvedValueOnce({ ...receipt, tenantId: "foreign" });
    await expect(
      deleteSmsQuietHours(row().id, row().updated_at, TENANT),
    ).rejects.toThrow(/deletion receipt/u);
  });

  it.each([
    { ...input, country_code: "US" },
    { ...input, days: [] },
    { ...input, days: [2, 1] },
    { ...input, timezone: "Not/AZone" },
    { ...input, label: "unsafe\u202E" },
  ])("rejects unsupported input before sending a write", async (invalid) => {
    await expect(
      createSmsQuietHours(invalid as SmsQuietHoursMutationInput, TENANT),
    ).rejects.toThrow(/policy input/u);
    expect(mocks.post).not.toHaveBeenCalled();
  });
});
