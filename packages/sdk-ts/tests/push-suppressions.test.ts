import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import { PostwaveClient } from "../src/index.js";

const TENANT = "00000000-0000-0000-0000-000000000001";
const OTHER_TENANT = "00000000-0000-0000-0000-000000000002";
const ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SECOND_ID = "99999999-9999-4999-8999-999999999999";
const ROW = {
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
};

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function page(overrides: Record<string, unknown> = {}) {
  return {
    tenantId: TENANT,
    items: [ROW],
    total: 1,
    snapshotAt: "2026-08-28T12:00:00Z",
    ...overrides,
  };
}

describe("TypeScript Route43 push suppression boundary", () => {
  it("binds one snapshot page to tenant, filters, cursor, and abort signal", async () => {
    const abort = new AbortController();
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      const parsed = new URL(url);
      expect(parsed.pathname).toBe("/api/v1/push/suppressions");
      expect(Object.fromEntries(parsed.searchParams)).toEqual({
        cursor: "eyJ2IjoxLCJwYWdlIjoxfQ",
        hash_prefix: "01234567",
        limit: "1",
        platform: "fcm",
        reason: "manual",
      });
      expect(init?.method).toBe("GET");
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      expect(init?.signal?.aborted).toBe(false);
      return response(
        page({
          total: 2,
          nextCursor: "eyJ2IjoxLCJwYWdlIjoyfQ",
        }),
      );
    });
    const client = new PostwaveClient({
      apiKey: "pw_test_admin",
      tenantId: TENANT,
      fetch,
      retries: 0,
    });
    await expect(
      client.pushSuppressions.list({
        platform: "fcm",
        reason: "manual",
        hashPrefix: "01234567",
        cursor: "eyJ2IjoxLCJwYWdlIjoxfQ",
        limit: 1,
        signal: abort.signal,
      }),
    ).resolves.toMatchObject({
      tenantId: TENANT,
      total: 2,
      nextCursor: "eyJ2IjoxLCJwYWdlIjoyfQ",
    });
  });

  it("accepts only the finite public provenance and exact lock reason", async () => {
    const locked = {
      ...ROW,
      platform: "apns",
      reason: "unregistered",
      source: "provider",
      reversible: false,
      locked_reason: "provider_authority",
    };
    const fetch = vi.fn(async () => response(page({ items: [locked] })));
    await expect(
      new PostwaveClient({
        apiKey: "pw_test_admin",
        tenantId: TENANT,
        fetch,
        retries: 0,
      }).pushSuppressions.list(),
    ).resolves.toMatchObject({ items: [locked] });
  });

  it("accepts revision-snapshot rows after the wall clock rolls back", async () => {
    const futureDated = {
      ...ROW,
      created_at: "2026-08-28T13:00:00Z",
      updated_at: "2026-08-28T13:00:01Z",
    };
    const fetch = vi.fn(async () =>
      response(
        page({
          items: [futureDated],
          snapshotAt: "2026-08-28T12:00:00Z",
        }),
      ),
    );
    await expect(
      new PostwaveClient({
        apiKey: "pw_test_admin",
        tenantId: TENANT,
        fetch,
        retries: 0,
      }).pushSuppressions.list(),
    ).resolves.toMatchObject({ items: [futureDated] });
  });

  it.each([
    ["wrong tenant", { ...ROW, tenant_id: OTHER_TENANT }],
    ["full digest", { ...ROW, device_token_hash: "a".repeat(64) }],
    ["invented platform", { ...ROW, platform: "ios" }],
    ["invented reason", { ...ROW, reason: "bounce" }],
    ["internal source", { ...ROW, source: "apns.production" }],
    ["manual locked", { ...ROW, reversible: false, locked_reason: "x" }],
    [
      "provider reversible",
      { ...ROW, reason: "expired", source: "provider", reversible: true },
    ],
    [
      "provider without lock",
      { ...ROW, reason: "expired", source: "provider", reversible: false },
    ],
    [
      "provider with complaint lock",
      {
        ...ROW,
        reason: "expired",
        source: "provider",
        reversible: false,
        locked_reason: "complaint_authority",
      },
    ],
    [
      "user provenance with provider reason",
      {
        ...ROW,
        reason: "expired",
        source: "user",
        reversible: false,
        locked_reason: "user_opt_out_authority",
      },
    ],
    ["bad calendar", { ...ROW, created_at: "2026-02-30T10:00:00Z" }],
    ["non-UTC time", { ...ROW, created_at: "2026-08-28T10:00:00+05:30" }],
    ["updated before create", { ...ROW, updated_at: "2026-08-27T10:00:00Z" }],
    ["bad version", { ...ROW, version: 0 }],
    ["secret field", { ...ROW, source_event_id: "provider-secret" }],
  ])("rejects malformed row: %s", async (_name, item) => {
    const fetch = vi.fn(async () => response(page({ items: [item] })));
    await expect(
      new PostwaveClient({
        apiKey: "pw_test_admin",
        tenantId: TENANT,
        fetch,
        retries: 0,
      }).pushSuppressions.list(),
    ).rejects.toMatchObject({ code: "invalid_push_suppression_response" });
  });

  it("strictly decodes manual add and compare-and-swap delete receipts", async () => {
    const token = "fcm-device-token-with-enough-entropy-123";
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        expect(new URL(url).pathname).toBe("/api/v1/push/suppressions");
        expect(JSON.parse(String(init.body))).toEqual({
          device_token: token,
          platform: "fcm",
          reason: "manual",
        });
        return response(ROW, 201);
      }
      expect(new URL(url).pathname).toBe(`/api/v1/push/suppressions/${ID}`);
      expect(init?.method).toBe("DELETE");
      expect(JSON.parse(String(init?.body))).toEqual({ expected_version: 1 });
      return response({
        ok: true,
        tenantId: TENANT,
        id: ID,
        version: 2,
        stillSuppressed: false,
      });
    });
    const client = new PostwaveClient({
      apiKey: "pw_test_admin",
      tenantId: TENANT,
      fetch,
      retries: 0,
    });
    await expect(
      client.pushSuppressions.add({
        device_token: token,
        platform: "fcm",
        reason: "manual",
      }),
    ).resolves.toEqual(ROW);
    await expect(client.pushSuppressions.remove(ID, 1)).resolves.toEqual({
      ok: true,
      tenantId: TENANT,
      id: ID,
      version: 2,
      stillSuppressed: false,
    });
  });

  it("strictly binds atomic bulk receipts to input order and versions", async () => {
    const imports = [
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
    const second = {
      ...ROW,
      id: SECOND_ID,
      platform: "web",
      device_token_hash: "fedcba9876543210",
      version: 4,
    };
    const removals = [
      { id: ID, expected_version: 1 },
      { id: SECOND_ID, expected_version: 4 },
    ];
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname;
      if (path.endsWith("bulk-import")) {
        expect(JSON.parse(String(init?.body))).toEqual({ items: imports });
        return response({
          ok: true,
          tenantId: TENANT,
          created: 1,
          existing: 1,
          items: [ROW, second],
        });
      }
      expect(path).toBe("/api/v1/push/suppressions/bulk-remove");
      expect(JSON.parse(String(init?.body))).toEqual({ items: removals });
      return response({
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
      });
    });
    const client = new PostwaveClient({
      apiKey: "pw_test_admin",
      tenantId: TENANT,
      fetch,
      retries: 0,
    });
    await expect(
      client.pushSuppressions.bulkImport(imports),
    ).resolves.toMatchObject({
      created: 1,
      existing: 1,
    });
    await expect(
      client.pushSuppressions.bulkRemove(removals),
    ).resolves.toMatchObject({
      removed: 2,
      stillSuppressed: 1,
    });
  });

  it("rejects invalid local inputs without a protected request", async () => {
    const fetch = vi.fn(async () => response({}));
    const client = new PostwaveClient({
      apiKey: "pw_test_admin",
      tenantId: TENANT,
      fetch,
      retries: 0,
    });
    const operations: Array<() => Promise<unknown>> = [
      () => client.pushSuppressions.list({ hashPrefix: "0123456" }),
      () => client.pushSuppressions.list({ hashPrefix: "0123ABCD" }),
      () => client.pushSuppressions.list({ cursor: "bad.cursor" }),
      () => client.pushSuppressions.list({ limit: 101 }),
      () =>
        client.pushSuppressions.add({
          device_token: "short",
          platform: "fcm",
          reason: "manual",
        }),
      () => client.pushSuppressions.remove(ID.toUpperCase(), 1),
      () => client.pushSuppressions.remove(ID, 0),
      () =>
        client.pushSuppressions.bulkRemove([
          { id: ID, expected_version: 1 },
          { id: ID, expected_version: 1 },
        ]),
    ];
    for (const operation of operations) {
      await expect(operation()).rejects.toBeInstanceOf(Error);
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("requires an explicit canonical tenant binding", async () => {
    const client = new PostwaveClient({
      apiKey: "pw_test_admin",
      fetch: vi.fn(async () => response(page())),
      retries: 0,
    });
    await expect(client.pushSuppressions.list()).rejects.toThrow(
      /expected canonical tenant UUID/u,
    );
  });

  it("documents the exact-admin private registry, CAS, and delivery hold", () => {
    const readme = readFileSync(
      new URL("../README.md", import.meta.url),
      "utf8",
    ).replace(/\s+/gu, " ");

    for (const method of [
      "list",
      "add",
      "remove",
      "bulkImport",
      "bulkRemove",
    ]) {
      expect(readme).toContain(method);
    }
    expect(readme).toContain("exact-admin credential");
    expect(readme).toContain("tenant-customer APNs/FCM/Web registry");
    expect(readme).toContain("not operator Expo-device management");
    expect(readme).toContain("minimized 16-hex");
    expect(readme).toContain("never the raw customer token or full digest");
    expect(readme).toContain("expected_version");
    expect(readme).toContain("stillSuppressed");
    expect(readme).toContain("HOLD / NO-GO");
    expect(readme).toContain("automatic provider feedback");
    expect(readme).toContain("Web is registry-only");
  });
});
