// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  del: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  api: { get: mocks.get, post: mocks.post, delete: mocks.del },
}));

import {
  conversionsApi,
  listConversions,
  parseConversionPage,
  parseTrackingKeys,
} from "@/lib/conversions-api";

const TENANT = "22222222-2222-4222-8222-222222222222";

function conversion(id: number, occurredAt = "2026-08-30T10:00:00Z") {
  return {
    id,
    tenant_id: TENANT,
    subscriber_email: "synthetic@example.invalid",
    event_name: "purchase",
    amount_cents: 4900,
    currency: "USD",
    attributed_via: "explicit",
    properties: { source: "test" },
    occurred_at: occurredAt,
  };
}

function key() {
  return {
    id: "key-1",
    tenant_id: TENANT,
    label: "Storefront",
    prefix: "pwk_12345678",
    revoked_at: null,
    created_at: "2026-08-30T10:00:00Z",
  };
}

beforeEach(() => vi.clearAllMocks());

describe("conversion parity API", () => {
  it("verifies tenant binding and deterministic row ordering", () => {
    expect(
      parseConversionPage(
        [conversion(2), conversion(1, "2026-08-29T10:00:00Z")],
        TENANT,
      ).items,
    ).toHaveLength(2);
    expect(() =>
      parseConversionPage(
        [{ ...conversion(1), tenant_id: "another-tenant" }],
        TENANT,
      ),
    ).toThrow(/invalid row/i);
    expect(() =>
      parseConversionPage(
        [conversion(1), conversion(2, "2026-08-31T10:00:00Z")],
        TENANT,
      ),
    ).toThrow(/ordering/i);
  });

  it("uses the timestamp and ID cursor as one pair", async () => {
    mocks.get.mockResolvedValue([]);
    const signal = new AbortController().signal;
    await listConversions({
      tenantId: TENANT,
      cursor: { before: "2026-08-30T10:00:00Z", beforeId: 42 },
      signal,
    });
    expect(mocks.get).toHaveBeenCalledWith("/api/v1/conversions", {
      query: { before: "2026-08-30T10:00:00Z", before_id: 42 },
      signal,
    });
    await expect(
      listConversions({
        tenantId: TENANT,
        cursor: { before: "bad", beforeId: 42 },
      }),
    ).rejects.toThrow(/cursor/i);
  });

  it("strictly parses the admin key register and binds it to the workspace", () => {
    expect(parseTrackingKeys([key()], TENANT)).toEqual([key()]);
    expect(() =>
      parseTrackingKeys([{ ...key(), tenant_id: "other" }], TENANT),
    ).toThrow(/invalid row/i);
    expect(() => parseTrackingKeys([key(), key()], TENANT)).toThrow(
      /duplicate/i,
    );
  });

  it("keeps one-time create and revoke operations online, one-shot, and verified", async () => {
    mocks.post.mockResolvedValue({
      key: key(),
      plaintext: "pwk_12345678_full-secret",
    });
    await expect(
      conversionsApi.createKey(" Storefront ", {
        expectedTenantId: TENANT,
        idempotencyKey: "request-1",
      }),
    ).resolves.toMatchObject({ plaintext: "pwk_12345678_full-secret" });
    expect(mocks.post).toHaveBeenCalledWith(
      "/api/v1/conversions/keys",
      { label: "Storefront" },
      { requireOnline: true, maxAttempts: 1, idempotencyKey: "request-1" },
    );

    mocks.del.mockResolvedValue({ ok: true });
    await expect(
      conversionsApi.revokeKey("key-1", { idempotencyKey: "request-2" }),
    ).resolves.toEqual({ ok: true });
    expect(mocks.del).toHaveBeenCalledWith("/api/v1/conversions/keys/key-1", {
      requireOnline: true,
      maxAttempts: 1,
      idempotencyKey: "request-2",
    });
  });
});
