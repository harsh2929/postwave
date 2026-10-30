import { describe, expect, it } from "vitest";

import {
  createPushSuppressionsApi,
  type PushSuppressionListResponse,
  type PushSuppressionPlatform,
  type PushSuppressionReason,
} from "../../lib/api/push-suppressions";
import type {
  ApiRequester,
  ApiRequesterOptions,
  ApiResult,
} from "../../lib/api/result";

const TENANT = "00000000-0000-0000-0000-000000000001";
const OTHER_TENANT = "00000000-0000-0000-0000-000000000002";
const ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SECOND_ID = "99999999-9999-4999-8999-999999999999";
const SNAPSHOT = "2026-08-28T12:00:00Z";

interface Call {
  path: string;
  init?: RequestInit;
  options?: ApiRequesterOptions;
}

function requester(responses: ApiResult<unknown>[] = []): {
  calls: Call[];
  request: ApiRequester;
} {
  const calls: Call[] = [];
  const request: ApiRequester = async <T>(
    path: string,
    init?: RequestInit,
    options?: ApiRequesterOptions,
  ): Promise<ApiResult<T>> => {
    calls.push({
      path,
      ...(init ? { init } : {}),
      ...(options ? { options } : {}),
    });
    return (responses.shift() ?? { data: {} }) as ApiResult<T>;
  };
  return { calls, request };
}

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: ID,
    tenant_id: TENANT,
    device_token_hash: "0123456789abcdef",
    platform: "fcm",
    reason: "manual",
    source: "dashboard",
    created_at: "2026-08-28T10:00:00Z",
    updated_at: "2026-08-28T10:00:01Z",
    version: 1,
    reversible: true,
    ...overrides,
  };
}

function page(
  overrides: Partial<PushSuppressionListResponse> = {},
): PushSuppressionListResponse {
  return {
    tenantId: TENANT,
    items: [row()] as PushSuppressionListResponse["items"],
    total: 1,
    snapshotAt: SNAPSHOT,
    ...overrides,
  };
}

function api(request: ApiRequester, identity?: { generation: () => number }) {
  return createPushSuppressionsApi(request, {
    getTenantId: () => TENANT,
    getApiIdentityGeneration: identity?.generation ?? (() => 7),
  });
}

describe("Route43 private push suppression transport", () => {
  it("binds filters, cursor, page size, abort signal, and verified workspace", async () => {
    const abort = new AbortController();
    const { calls, request } = requester([
      {
        data: page({
          total: 2,
          nextCursor: "eyJ2IjoxLCJwYWdlIjoyfQ",
        }),
      },
    ]);

    await expect(
      api(request).list({
        platform: "fcm",
        reason: "manual",
        query: "01234567",
        cursor: "eyJ2IjoxLCJwYWdlIjoxfQ",
        limit: 1,
        signal: abort.signal,
      }),
    ).resolves.toMatchObject({ data: { tenantId: TENANT, total: 2 } });

    expect(calls).toEqual([
      {
        path: "/api/v1/push/suppressions?platform=fcm&reason=manual&hash_prefix=01234567&cursor=eyJ2IjoxLCJwYWdlIjoxfQ&limit=1",
        init: { signal: abort.signal },
      },
    ]);
  });

  it("accepts locked system authority only with explicit lock provenance", async () => {
    const locked = row({
      reason: "unregistered",
      source: "provider",
      platform: "apns",
      reversible: false,
      locked_reason: "provider_authority",
    });
    const { request } = requester([
      { data: page({ items: [locked] as never }) },
    ]);
    await expect(api(request).list()).resolves.toMatchObject({
      data: {
        items: [{ reversible: false, locked_reason: "provider_authority" }],
      },
    });
  });

  it("accepts revision-snapshot rows after the wall clock rolls back", async () => {
    const futureDated = row({
      created_at: "2026-08-28T13:00:00Z",
      updated_at: "2026-08-28T13:00:01Z",
    });
    const { request } = requester([
      {
        data: page({
          items: [futureDated] as never,
          snapshotAt: "2026-08-28T12:00:00Z",
        }),
      },
    ]);
    await expect(api(request).list()).resolves.toMatchObject({
      data: { items: [futureDated] },
    });
  });

  it.each([
    ["wrong tenant", row({ tenant_id: OTHER_TENANT })],
    ["full digest", row({ device_token_hash: "a".repeat(64) })],
    ["unknown platform", row({ platform: "ios" })],
    ["unknown reason", row({ reason: "bounce" })],
    ["unknown source", row({ source: "mystery" })],
    [
      "manual marked locked",
      row({ reversible: false, locked_reason: "locked" }),
    ],
    [
      "system marked reversible",
      row({ reason: "expired", source: "provider" }),
    ],
    [
      "system missing lock",
      row({ reason: "expired", source: "provider", reversible: false }),
    ],
    [
      "provider with complaint lock",
      row({
        reason: "expired",
        source: "provider",
        reversible: false,
        locked_reason: "complaint_authority",
      }),
    ],
    [
      "user provenance with provider reason",
      row({
        reason: "expired",
        source: "user",
        reversible: false,
        locked_reason: "user_opt_out_authority",
      }),
    ],
    ["invalid created time", row({ created_at: "2026-02-30T10:00:00Z" })],
    ["updated before created", row({ updated_at: "2026-08-27T10:00:00Z" })],
    ["invalid version", row({ version: 0 })],
    ["unexpected wire key", row({ raw_token: "secret" })],
  ])("rejects malformed 2xx row: %s", async (_name, invalid) => {
    const { request } = requester([
      { data: page({ items: [invalid] as never }) },
    ]);
    await expect(api(request).list()).resolves.toMatchObject({
      error: { code: "invalid_push_suppression_response" },
    });
  });

  it("rejects duplicate, unsorted, and incomplete first-page envelopes", async () => {
    const later = row({
      id: SECOND_ID,
      created_at: "2026-08-28T11:00:00Z",
      updated_at: "2026-08-28T11:00:00Z",
    });
    for (const invalid of [
      page({ items: [row(), row()] as never, total: 2 }),
      page({ items: [row(), later] as never, total: 2 }),
      page({ total: 2 }),
      { ...page(), extra: true },
    ]) {
      const { request } = requester([{ data: invalid }]);
      await expect(api(request).list()).resolves.toMatchObject({
        error: { code: "invalid_push_suppression_response" },
      });
    }
  });

  it("discards a valid response after the workspace identity generation changes", async () => {
    let generation = 3;
    let resolve!: (result: ApiResult<unknown>) => void;
    const pending = new Promise<ApiResult<unknown>>((done) => {
      resolve = done;
    });
    const request: ApiRequester = async <T>() =>
      pending as Promise<ApiResult<T>>;
    const result = api(request, { generation: () => generation }).list();
    generation = 4;
    resolve({ data: page() });
    await expect(result).resolves.toMatchObject({
      error: { code: "identity_changed" },
    });
  });

  it("sends manual adds online-only and validates the tenant-bound row", async () => {
    const { calls, request } = requester([{ data: row() }]);
    const token = "fcm-device-token-with-enough-entropy-123";
    await expect(
      api(request).add({
        device_token: token,
        platform: "fcm",
        reason: "manual",
      }),
    ).resolves.toMatchObject({
      data: { source: "dashboard", reversible: true },
    });
    expect(calls).toEqual([
      {
        path: "/api/v1/push/suppressions",
        init: {
          method: "POST",
          body: JSON.stringify({
            device_token: token,
            platform: "fcm",
            reason: "manual",
          }),
        },
        options: { requireOnline: true },
      },
    ]);
  });

  it("requires a versioned, tenant-bound removal receipt", async () => {
    const { calls, request } = requester([
      {
        data: {
          ok: true,
          tenantId: TENANT,
          id: ID,
          version: 3,
          stillSuppressed: false,
        },
      },
    ]);
    await expect(
      api(request).remove(ID, { expected_version: 2 }),
    ).resolves.toMatchObject({
      data: { id: ID, version: 3, stillSuppressed: false },
    });
    expect(calls[0]).toMatchObject({
      path: `/api/v1/push/suppressions/${ID}`,
      init: { method: "DELETE", body: '{"expected_version":2}' },
      options: { requireOnline: true },
    });
  });

  it("binds all-or-nothing bulk import and removal receipts to input order", async () => {
    const importItems = [
      {
        device_token: "fcm-device-token-with-enough-entropy-123",
        platform: "fcm" as const,
        reason: "manual" as const,
      },
      {
        device_token: "web-device-token-with-enough-entropy-456",
        platform: "web" as const,
        reason: "manual" as const,
      },
    ];
    const first = row();
    const second = row({
      id: SECOND_ID,
      device_token_hash: "fedcba9876543210",
      platform: "web",
    });
    const { calls, request } = requester([
      {
        data: {
          ok: true,
          tenantId: TENANT,
          created: 1,
          existing: 1,
          items: [first, second],
        },
      },
      {
        data: {
          ok: true,
          tenantId: TENANT,
          removed: 2,
          stillSuppressed: 1,
          items: [
            {
              ok: true,
              tenantId: TENANT,
              id: ID,
              version: 2,
              stillSuppressed: false,
            },
            {
              ok: true,
              tenantId: TENANT,
              id: SECOND_ID,
              version: 5,
              stillSuppressed: true,
            },
          ],
        },
      },
    ]);
    const client = api(request);
    await expect(client.bulkImport(importItems)).resolves.toMatchObject({
      data: { created: 1, existing: 1, items: [first, second] },
    });
    const removals = [
      { id: ID, expected_version: 1 },
      { id: SECOND_ID, expected_version: 4 },
    ];
    await expect(client.bulkRemove(removals)).resolves.toMatchObject({
      data: { removed: 2, stillSuppressed: 1 },
    });
    expect(calls).toEqual([
      {
        path: "/api/v1/push/suppressions/bulk-import",
        init: {
          method: "POST",
          body: JSON.stringify({ items: importItems }),
        },
        options: { requireOnline: true },
      },
      {
        path: "/api/v1/push/suppressions/bulk-remove",
        init: {
          method: "POST",
          body: JSON.stringify({ items: removals }),
        },
        options: { requireOnline: true },
      },
    ]);
  });

  it("rejects duplicate bulk inputs and count or item receipt drift", async () => {
    const duplicate = {
      device_token: "fcm-device-token-with-enough-entropy-123",
      platform: "fcm" as const,
      reason: "manual" as const,
    };
    const { calls, request } = requester([
      {
        data: {
          ok: true,
          tenantId: TENANT,
          created: 2,
          existing: 0,
          items: [row()],
        },
      },
      {
        data: {
          ok: true,
          tenantId: TENANT,
          removed: 1,
          stillSuppressed: 0,
          items: [
            {
              ok: true,
              tenantId: TENANT,
              id: ID,
              version: 99,
              stillSuppressed: false,
            },
          ],
        },
      },
    ]);
    const client = api(request);
    await expect(
      client.bulkImport([duplicate, duplicate]),
    ).resolves.toMatchObject({
      error: { code: "invalid_push_suppression_request" },
    });
    await expect(
      client.bulkRemove([
        { id: ID, expected_version: 1 },
        { id: ID, expected_version: 1 },
      ]),
    ).resolves.toMatchObject({
      error: { code: "invalid_push_suppression_request" },
    });
    await expect(
      client.bulkImport([duplicate, { ...duplicate, platform: "web" }]),
    ).resolves.toMatchObject({
      error: { code: "invalid_push_suppression_response" },
    });
    await expect(
      client.bulkRemove([{ id: ID, expected_version: 1 }]),
    ).resolves.toMatchObject({
      error: { code: "invalid_push_suppression_response" },
    });
    expect(calls).toHaveLength(2);
  });

  it("rejects invalid local inputs without starting protected requests", async () => {
    const { calls, request } = requester();
    const client = api(request);
    const invalidLists = [
      client.list({ query: "0123456" }),
      client.list({ query: "0123ABCD" }),
      client.list({ cursor: "bad\nvalue" }),
      client.list({ limit: 101 }),
      client.list({ platform: "ios" as PushSuppressionPlatform }),
      client.list({ reason: "bounce" as PushSuppressionReason }),
    ];
    const invalidWrites = [
      client.add({ device_token: "short", platform: "fcm", reason: "manual" }),
      client.add({
        device_token: "token with whitespace and enough characters",
        platform: "fcm",
        reason: "manual",
      }),
      client.add({
        device_token: "fcm-device-token-with-enough-entropy-123",
        platform: "fcm",
        reason: "expired" as "manual",
      }),
      client.remove(ID.toUpperCase(), { expected_version: 1 }),
      client.remove(ID, { expected_version: 0 }),
    ];
    for (const result of await Promise.all([
      ...invalidLists,
      ...invalidWrites,
    ])) {
      expect(result).toMatchObject({
        error: { code: "invalid_push_suppression_request" },
      });
    }
    expect(calls).toEqual([]);
  });

  it("preserves typed server errors without adopting unverified data", async () => {
    const failure: ApiResult<unknown> = {
      error: {
        kind: "http",
        status: 409,
        code: "suppression_version_conflict",
        message: "stale",
      },
      retryability: "not-retryable",
    };
    const { request } = requester([failure]);
    await expect(api(request).list()).resolves.toEqual(failure);
  });
});
