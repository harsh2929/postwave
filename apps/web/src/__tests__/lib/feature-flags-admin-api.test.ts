// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  delete: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  api: { get: mocks.get, post: mocks.post, delete: mocks.delete },
}));

import {
  featureFlagDraftError,
  listFeatureFlagRegistry,
  removeFeatureFlagOverride,
  resolveFeatureFlag,
  sameFeatureFlagRevision,
  upsertFeatureFlagOverride,
} from "@/lib/feature-flags-admin-api";

const TENANT = "11111111-1111-4111-8111-111111111111";

function flag(overrides: Record<string, unknown> = {}) {
  return {
    id: "22222222-2222-4222-8222-222222222222",
    key: "new_composer",
    value: "on",
    note: "Beta workspace",
    tenant_id: TENANT,
    is_default: false,
    enabled: true,
    created_at: "2026-08-30T10:00:00Z",
    updated_at: "2026-08-30T10:01:00Z",
    ...overrides,
  };
}

beforeEach(() => vi.clearAllMocks());

describe("feature flag administration client", () => {
  it("strictly binds override rows to the expected tenant and reconciles count", async () => {
    const payload = {
      flags: [
        flag(),
        flag({
          id: "33333333-3333-4333-8333-333333333333",
          tenant_id: undefined,
          is_default: true,
          value: "off",
        }),
      ],
      count: 2,
    };
    mocks.get.mockResolvedValue(payload);
    await expect(listFeatureFlagRegistry(TENANT)).resolves.toMatchObject([
      { isDefault: false, tenantId: TENANT },
      { isDefault: true, tenantId: null },
    ]);
    expect(mocks.get).toHaveBeenCalledWith("/api/v1/feature-flags", {
      signal: undefined,
    });
  });

  it.each([
    [
      "cross-tenant override",
      { flags: [flag({ tenant_id: "other" })], count: 1 },
    ],
    ["default with tenant", { flags: [flag({ is_default: true })], count: 1 }],
    ["count mismatch", { flags: [flag()], count: 2 }],
    [
      "duplicate source/key",
      { flags: [flag(), flag({ id: "other" })], count: 2 },
    ],
    ["malformed time", { flags: [flag({ updated_at: "today" })], count: 1 }],
  ])("fails closed on %s", async (_label, payload) => {
    mocks.get.mockResolvedValue(payload);
    await expect(listFeatureFlagRegistry(TENANT)).rejects.toThrow();
  });

  it("normalizes a bounded online-only override write and verifies its echo", async () => {
    const signal = new AbortController().signal;
    mocks.post.mockResolvedValue({
      id: flag().id,
      key: "new_composer",
      value: "on",
    });
    await expect(
      upsertFeatureFlagOverride(
        { key: " new_composer ", value: " on ", note: " beta " },
        signal,
      ),
    ).resolves.toMatchObject({ key: "new_composer", value: "on" });
    expect(mocks.post).toHaveBeenCalledWith(
      "/api/v1/feature-flags",
      { key: "new_composer", value: "on", note: "beta" },
      { requireOnline: true, maxAttempts: 1, signal },
    );
  });

  it("bounds request bytes, not only JavaScript character count", () => {
    expect(
      featureFlagDraftError({ key: "é".repeat(101), value: "on", note: "" }),
    ).toMatch(/UTF-8 bytes/u);
    expect(
      featureFlagDraftError({
        key: "safe_key",
        value: "on",
        note: "é".repeat(1_501),
      }),
    ).toMatch(/3,000 UTF-8 bytes/u);
    expect(
      featureFlagDraftError({ key: "safe_key", value: "on", note: "reviewed" }),
    ).toBeNull();
  });

  it("resolves only a matching key and closed source vocabulary", async () => {
    mocks.get.mockResolvedValue({
      key: "new_composer",
      value: "on",
      source: "tenant",
    });
    await expect(resolveFeatureFlag(" new_composer ")).resolves.toEqual({
      key: "new_composer",
      value: "on",
      source: "tenant",
    });
    mocks.get.mockResolvedValue({
      key: "new_composer",
      value: "on",
      source: "environment",
    });
    await expect(resolveFeatureFlag("new_composer")).rejects.toThrow(/source/u);
  });

  it("treats canonical 204 removal as success and detects revision changes", async () => {
    mocks.delete.mockResolvedValue(undefined);
    await expect(
      removeFeatureFlagOverride("new_composer"),
    ).resolves.toBeUndefined();
    expect(mocks.delete).toHaveBeenCalledWith(
      "/api/v1/feature-flags/new_composer",
      { requireOnline: true, maxAttempts: 1, signal: undefined },
    );

    mocks.get.mockResolvedValue({ flags: [flag()], count: 1 });
    const [baseline] = await listFeatureFlagRegistry(TENANT);
    expect(baseline).toBeDefined();
    if (!baseline) return;
    expect(sameFeatureFlagRevision(baseline, { ...baseline })).toBe(true);
    expect(
      sameFeatureFlagRevision(baseline, {
        ...baseline,
        updatedAt: "2026-08-30T10:02:00Z",
      }),
    ).toBe(false);
  });
});
