// SPDX-License-Identifier: AGPL-3.0-only
import { beforeEach, describe, expect, it, vi } from "vitest";

const apiMock = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  delete: vi.fn(),
}));
vi.mock("@/lib/api", () => ({ api: apiMock }));

import type { MeResponse } from "@/lib/auth-api";
import {
  addPushSuppression,
  authorizePushSuppressionAdmin,
  bulkImportPushSuppressions,
  bulkRemovePushSuppressions,
  decodePushSuppressionPage,
  listPushSuppressions,
  mergePushSuppressionPages,
  parsePushSuppressionImportCsv,
  removePushSuppression,
  validateRawPushToken,
} from "@/lib/push-suppressions-api";

const TENANT = "11111111-1111-4111-8111-111111111111";
const USER = "admin-user";
const ID_ONE = "33333333-3333-4333-8333-333333333333";
const ID_TWO = "22222222-2222-4222-8222-222222222222";
const TOKEN_ONE = "apns-token-1234567890abcdef";
const TOKEN_TWO = "fcm-token-1234567890-zyxwv";
const SNAPSHOT = "2026-08-29T10:00:00Z";

function me(over: Partial<MeResponse> = {}): MeResponse {
  return {
    user_id: USER,
    tenant_id: TENANT,
    email: "admin@example.test",
    role: "admin",
    auth_provider: "password",
    email_verified: true,
    workspace_name: "Workspace",
    workspace_slug: "workspace",
    ...over,
  };
}

async function fingerprint(token: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(token),
  );
  return Array.from(new Uint8Array(digest).slice(0, 8), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function row(
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: ID_ONE,
    tenant_id: TENANT,
    device_token_hash: "0123456789abcdef",
    platform: "apns",
    reason: "manual",
    source: "dashboard",
    created_at: "2026-08-29T09:00:00Z",
    updated_at: "2026-08-29T09:00:00Z",
    version: 3,
    reversible: true,
    ...over,
  };
}

function page(
  items: unknown[],
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    tenantId: TENANT,
    items,
    total: items.length,
    snapshotAt: SNAPSHOT,
    ...over,
  };
}

beforeEach(() => {
  apiMock.get.mockReset();
  apiMock.post.mockReset();
  apiMock.delete.mockReset();
});

describe("push suppression management authority", () => {
  it("mints authority only for the exact active owner/admin identity", () => {
    expect(authorizePushSuppressionAdmin(me(), TENANT, USER)).toMatchObject({
      tenantId: TENANT,
      userId: USER,
    });
    for (const candidate of [
      me({ role: "viewer" }),
      me({ role: "owner", effective_role: "viewer" }),
      me({ viewer_mode: true }),
      me({ tenant_id: "22222222-2222-4222-8222-222222222222" }),
      me({ user_id: "other-user" }),
    ]) {
      expect(() =>
        authorizePushSuppressionAdmin(candidate, TENANT, USER),
      ).toThrow(/identity|admin role/iu);
    }
  });

  it("rejects an unbranded write authority before transport", async () => {
    await expect(
      addPushSuppression(
        { tenantId: TENANT, userId: USER } as never,
        { deviceToken: TOKEN_ONE, platform: "apns" },
      ),
    ).rejects.toThrow(/authorization/iu);
    expect(apiMock.post).not.toHaveBeenCalled();
  });
});

describe("push suppression list contract", () => {
  it("binds filters, page size, cursor, tenant and cancellation", async () => {
    const controller = new AbortController();
    apiMock.get.mockResolvedValue(
      page([row()], { total: 2, nextCursor: "signed_cursor" }),
    );
    await expect(
      listPushSuppressions({
        tenantId: TENANT,
        platform: "apns",
        reason: "manual",
        hashPrefix: "01234567",
        limit: 1,
        signal: controller.signal,
      }),
    ).resolves.toMatchObject({ total: 2, nextCursor: "signed_cursor" });
    expect(apiMock.get).toHaveBeenCalledWith(
      "/api/v1/push/suppressions?platform=apns&reason=manual&hash_prefix=01234567&limit=1",
      { signal: controller.signal },
    );

    apiMock.get.mockResolvedValue(
      page(
        [
          row({
            id: ID_TWO,
            created_at: "2026-08-29T08:00:00Z",
            updated_at: "2026-08-29T08:00:00Z",
          }),
        ],
        { total: 2 },
      ),
    );
    const second = await listPushSuppressions({
      tenantId: TENANT,
      cursor: "signed_cursor",
      limit: 1,
    });
    expect(second.requestCursor).toBe("signed_cursor");
  });

  it("merges only a continuous, same-snapshot, globally ordered chain", () => {
    const first = decodePushSuppressionPage(
      page([row()], { total: 2, nextCursor: "signed_cursor" }),
      { tenantId: TENANT, limit: 1 },
    );
    const second = decodePushSuppressionPage(
      page(
        [
          row({
            id: ID_TWO,
            created_at: "2026-08-29T08:00:00Z",
            updated_at: "2026-08-29T08:00:00Z",
          }),
        ],
        { total: 2 },
      ),
      { tenantId: TENANT, cursor: "signed_cursor", limit: 1 },
    );
    expect(mergePushSuppressionPages([first, second])).toMatchObject({
      total: 2,
      hasMore: false,
      items: [{ id: ID_ONE }, { id: ID_TWO }],
    });
    expect(() =>
      mergePushSuppressionPages([
        first,
        { ...second, requestCursor: "different_cursor" },
      ]),
    ).toThrow(/unverifiable/iu);
  });

  it("fails closed on extra fields, filter drift and impossible geometry", () => {
    for (const malformed of [
      page([], { extra: true }),
      page([row({ platform: "fcm" })]),
      page([], { total: 1 }),
      page([row()], { total: 1, nextCursor: "cursor" }),
      page([], { snapshotAt: "2026-02-31T10:00:00Z" }),
    ]) {
      expect(() =>
        decodePushSuppressionPage(malformed, {
          tenantId: TENANT,
          platform: "apns",
          limit: 2,
        }),
      ).toThrow(/unverifiable|impossible/iu);
    }
  });
});

describe("push suppression write receipts", () => {
  it("verifies add against the exact token digest and forces online one-shot transport", async () => {
    const authority = authorizePushSuppressionAdmin(me(), TENANT, USER);
    const expectedFingerprint = await fingerprint(TOKEN_ONE);
    apiMock.post.mockResolvedValue(
      row({ device_token_hash: expectedFingerprint }),
    );
    await expect(
      addPushSuppression(authority, {
        deviceToken: TOKEN_ONE,
        platform: "apns",
      }),
    ).resolves.toMatchObject({ fingerprint: expectedFingerprint });
    expect(apiMock.post).toHaveBeenCalledWith(
      "/api/v1/push/suppressions",
      { device_token: TOKEN_ONE, platform: "apns", reason: "manual" },
      { signal: undefined, requireOnline: true, maxAttempts: 1 },
    );

    apiMock.post.mockResolvedValue(
      row({ device_token_hash: "ffffffffffffffff" }),
    );
    await expect(
      addPushSuppression(authority, {
        deviceToken: TOKEN_ONE,
        platform: "apns",
      }),
    ).rejects.toThrow(/unverifiable/iu);
  });

  it("requires an exact CAS delete receipt and forwards abort", async () => {
    const authority = authorizePushSuppressionAdmin(me(), TENANT, USER);
    const controller = new AbortController();
    apiMock.delete.mockResolvedValue({
      ok: true,
      tenantId: TENANT,
      id: ID_ONE,
      version: 4,
      stillSuppressed: false,
    });
    await expect(
      removePushSuppression(
        authority,
        { id: ID_ONE, expectedVersion: 3 },
        { signal: controller.signal },
      ),
    ).resolves.toMatchObject({ version: 4, stillSuppressed: false });
    expect(apiMock.delete).toHaveBeenCalledWith(
      `/api/v1/push/suppressions/${ID_ONE}`,
      {
        body: { expected_version: 3 },
        signal: controller.signal,
        requireOnline: true,
        maxAttempts: 1,
      },
    );
    apiMock.delete.mockResolvedValue({
      ok: true,
      tenantId: TENANT,
      id: ID_ONE,
      version: 3,
      stillSuppressed: false,
    });
    await expect(
      removePushSuppression(authority, { id: ID_ONE, expectedVersion: 3 }),
    ).rejects.toThrow(/unverifiable/iu);
  });

  it("verifies every bulk import row by order, platform and exact digest", async () => {
    const authority = authorizePushSuppressionAdmin(me(), TENANT, USER);
    const firstHash = await fingerprint(TOKEN_ONE);
    const secondHash = await fingerprint(TOKEN_TWO);
    apiMock.post.mockResolvedValue({
      ok: true,
      tenantId: TENANT,
      created: 1,
      existing: 1,
      items: [
        row({ device_token_hash: firstHash }),
        row({
          id: ID_TWO,
          platform: "fcm",
          device_token_hash: secondHash,
        }),
      ],
    });
    const result = await bulkImportPushSuppressions(authority, [
      { platform: "apns", deviceToken: TOKEN_ONE },
      { platform: "fcm", deviceToken: TOKEN_TWO },
    ]);
    expect(result).toMatchObject({ created: 1, existing: 1 });
    expect(result.items[0]).not.toHaveProperty("deviceToken");
    expect(apiMock.post.mock.calls[0]?.[2]).toMatchObject({
      requireOnline: true,
      maxAttempts: 1,
    });

    apiMock.post.mockResolvedValue({
      ok: true,
      tenantId: TENANT,
      created: 2,
      existing: 0,
      items: [
        row({ device_token_hash: secondHash }),
        row({ id: ID_TWO, platform: "fcm", device_token_hash: firstHash }),
      ],
    });
    await expect(
      bulkImportPushSuppressions(authority, [
        { platform: "apns", deviceToken: TOKEN_ONE },
        { platform: "fcm", deviceToken: TOKEN_TWO },
      ]),
    ).rejects.toThrow(/unverifiable/iu);

    apiMock.post.mockClear();
    await expect(
      bulkImportPushSuppressions(authority, [
        { platform: "apns", deviceToken: TOKEN_ONE },
        { platform: "apns", deviceToken: TOKEN_ONE },
      ]),
    ).rejects.toThrow(/cannot repeat/iu);
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it("verifies aggregate and per-row bulk removal receipts", async () => {
    const authority = authorizePushSuppressionAdmin(me(), TENANT, USER);
    const items = [
      { id: ID_ONE, expectedVersion: 3 },
      { id: ID_TWO, expectedVersion: 7 },
    ];
    apiMock.post.mockResolvedValue({
      ok: true,
      tenantId: TENANT,
      removed: 2,
      stillSuppressed: 1,
      items: [
        {
          ok: true,
          tenantId: TENANT,
          id: ID_ONE,
          version: 4,
          stillSuppressed: false,
        },
        {
          ok: true,
          tenantId: TENANT,
          id: ID_TWO,
          version: 8,
          stillSuppressed: true,
        },
      ],
    });
    await expect(
      bulkRemovePushSuppressions(authority, items),
    ).resolves.toMatchObject({ removed: 2, stillSuppressed: 1 });
    expect(apiMock.post).toHaveBeenCalledWith(
      "/api/v1/push/suppressions/bulk-remove",
      {
        items: [
          { id: ID_ONE, expected_version: 3 },
          { id: ID_TWO, expected_version: 7 },
        ],
      },
      { signal: undefined, requireOnline: true, maxAttempts: 1 },
    );

    apiMock.post.mockResolvedValue({
      ok: true,
      tenantId: TENANT,
      removed: 2,
      stillSuppressed: 0,
      items: [],
    });
    await expect(
      bulkRemovePushSuppressions(authority, items),
    ).rejects.toThrow(/unverifiable/iu);
  });
});

describe("push suppression raw token and CSV validation", () => {
  it("keeps the backend exact-token rules without trimming or normalization", () => {
    expect(validateRawPushToken(TOKEN_ONE, "apns")).toBeNull();
    expect(validateRawPushToken(` ${TOKEN_ONE}`, "apns")).toMatch(/exact/iu);
    expect(validateRawPushToken(`${TOKEN_ONE}\n`, "apns")).toMatch(/exact/iu);
    expect(validateRawPushToken("short", "apns")).toMatch(/20/iu);
  });

  it("parses an exact bounded CSV and rejects duplicate or ambiguous rows", () => {
    expect(
      parsePushSuppressionImportCsv(
        `platform,device_token\napns,${TOKEN_ONE}\nfcm,"${TOKEN_TWO},suffix"`,
      ),
    ).toMatchObject({
      ok: true,
      platformCounts: { apns: 1, fcm: 1, web: 0 },
    });
    expect(
      parsePushSuppressionImportCsv(
        `platform,device_token\napns,${TOKEN_ONE}\napns,${TOKEN_ONE}`,
      ),
    ).toMatchObject({ ok: false, message: expect.stringMatching(/repeats/iu) });
    expect(
      parsePushSuppressionImportCsv(`device_token,platform\n${TOKEN_ONE},apns`),
    ).toMatchObject({ ok: false, message: expect.stringMatching(/header/iu) });
    expect(
      parsePushSuppressionImportCsv(
        `platform,device_token\napns,${TOKEN_ONE}\u202e`,
      ),
    ).toMatchObject({ ok: false, message: expect.stringMatching(/control/iu) });
  });
});
