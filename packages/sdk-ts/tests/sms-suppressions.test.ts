import { describe, expect, it, vi } from "vitest";

import { PostwaveClient } from "../src/index.js";

const TENANT = "00000000-0000-0000-0000-000000000001";
const ROW = {
  id: "33333333-3333-4333-8333-333333333333",
  phone_e164: "+12025550101",
  reason: "manual",
  source: "manual",
  created_at: "2026-08-28T09:00:00Z",
  reversible: true,
};

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("TypeScript SMS suppression boundary", () => {
  it("exposes one tenant-bound cursor page and explicit manual continuation", async () => {
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      const parsed = new URL(url);
      expect(parsed.pathname).toBe("/api/v1/sms/suppressions");
      expect(Object.fromEntries(parsed.searchParams)).toEqual({
        cursor: "v1.b3BhcXVl",
        limit: "1",
        reason: "manual",
      });
      expect(init?.method).toBe("GET");
      return response({
        tenantId: TENANT,
        items: [ROW],
        total: 2,
        nextCursor: "v1.bmV4dA",
        snapshotAt: "2026-08-28T10:00:00Z",
      });
    });
    const client = new PostwaveClient({
      apiKey: "pw_test_admin",
      tenantId: TENANT,
      fetch,
      retries: 0,
    });

    await expect(
      client.sms.listSuppressions({
        cursor: "v1.b3BhcXVl",
        limit: 1,
        reason: "manual",
      }),
    ).resolves.toMatchObject({
      tenantId: TENANT,
      items: [ROW],
      total: 2,
      nextCursor: "v1.bmV4dA",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("keeps an exact phone in the read-only body query and binds its unique result", async () => {
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      expect(new URL(url).pathname).toBe("/api/v1/sms/suppressions/query");
      expect(new URL(url).search).toBe("");
      expect(url).not.toContain(ROW.phone_e164);
      expect(init?.method).toBe("POST");
      expect(new Headers(init?.headers).has("Idempotency-Key")).toBe(false);
      expect(JSON.parse(String(init?.body))).toEqual({
        phone: ROW.phone_e164,
      });
      return response({
        tenantId: TENANT,
        items: [ROW],
        total: 1,
        snapshotAt: "2026-08-28T10:00:00Z",
      });
    });
    const client = new PostwaveClient({
      apiKey: "pw_test_admin",
      tenantId: TENANT,
      defaultHeaders: { "idempotency-key": "inherited-key-must-not-leak" },
      fetch,
      retries: 0,
    });
    await expect(
      client.sms.listSuppressions({ phone: ROW.phone_e164 }),
    ).resolves.toMatchObject({ total: 1, items: [ROW] });
  });

  it("strictly decodes the 201 row and exact DELETE receipt", async () => {
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        expect(JSON.parse(String(init.body))).toEqual({
          phone: "+12025550101",
          reason: "manual",
        });
        return response(ROW, 201);
      }
      expect(url.endsWith(`/api/v1/sms/suppressions/${ROW.id}`)).toBe(true);
      expect(init?.method).toBe("DELETE");
      return response({ ok: true, tenantId: TENANT, id: ROW.id });
    });
    const client = new PostwaveClient({
      apiKey: "pw_test_admin",
      fetch,
      retries: 0,
    });

    await expect(
      client.sms.addSuppression({
        phone: ROW.phone_e164,
        reason: "manual",
      }),
    ).resolves.toEqual(ROW);
    await expect(client.sms.removeSuppression(ROW.id, TENANT)).resolves.toEqual(
      { ok: true, tenantId: TENANT, id: ROW.id },
    );
  });

  it("rejects spoofed input, wrong tenant, authority drift and malformed receipts before trust", async () => {
    const fetch = vi.fn(async () =>
      response({
        tenantId: "11111111-1111-4111-8111-111111111111",
        items: [{ ...ROW, reason: "stop_keyword", reversible: true }],
        total: 1,
        snapshotAt: "2026-08-28T10:00:00Z",
      }),
    );
    const client = new PostwaveClient({
      apiKey: "pw_test_admin",
      tenantId: TENANT,
      fetch,
      retries: 0,
    });

    await expect(client.sms.listSuppressions()).rejects.toMatchObject({
      code: "invalid_sms_suppression_response",
    });
    for (const invalid of [
      { cursor: " bad" },
      { cursor: "bad\u202e" },
      { cursor: "opaque" },
      { cursor: "v2.token" },
      { phone: "evil12025550101" },
      { phone: ROW.phone_e164, cursor: "v1.b3BhcXVl" },
      { phone: ROW.phone_e164, limit: 1 },
      { limit: 0 },
      { tenantId: "tenant" },
    ]) {
      await expect(
        client.sms.listSuppressions(invalid as never),
      ).rejects.toThrow();
    }
    await expect(
      client.sms.addSuppression({
        phone: "evil12025550101",
        reason: "manual",
      }),
    ).rejects.toThrow(/exact US\/Canada/u);
    await expect(
      client.sms.removeSuppression("33333333-3333-1333-8333-333333333333"),
    ).rejects.toThrow(/UUIDv4/u);
    await expect(
      new PostwaveClient({
        apiKey: "pw_test_admin",
        fetch,
        retries: 0,
      }).sms.removeSuppression(ROW.id),
    ).rejects.toThrow(/expected canonical tenant UUID/u);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    { snapshotAt: "1999-12-31T23:59:59Z" },
    { snapshotAt: "2100-01-01T00:00:00Z" },
    { snapshotAt: "2000-01-01T00:00:00+14:00" },
    { snapshotAt: "2099-12-31T23:59:59-14:00" },
    { nextCursor: "opaque", total: 2 },
    { nextCursor: "v2.token", total: 2 },
  ])("rejects cursor/projection poison %#", async (poison) => {
    const fetch = vi.fn(async () =>
      response({
        tenantId: TENANT,
        items: [ROW],
        total: 1,
        snapshotAt: "2026-08-28T10:00:00Z",
        ...poison,
      }),
    );
    await expect(
      new PostwaveClient({
        apiKey: "pw_test_admin",
        tenantId: TENANT,
        fetch,
        retries: 0,
      }).sms.listSuppressions({ limit: 1 }),
    ).rejects.toMatchObject({ code: "invalid_sms_suppression_response" });
  });

  it("rejects invented source/lock authority and mismatched creation identity", async () => {
    const listFetch = vi.fn(async () =>
      response({
        tenantId: TENANT,
        items: [
          {
            ...ROW,
            reason: "stop_keyword",
            source: "provider_webhook",
            reversible: false,
            locked_reason: "support_override",
          },
        ],
        total: 1,
        snapshotAt: "2026-08-28T10:00:00Z",
      }),
    );
    await expect(
      new PostwaveClient({
        apiKey: "pw_test_admin",
        tenantId: TENANT,
        fetch: listFetch,
        retries: 0,
      }).sms.listSuppressions(),
    ).rejects.toMatchObject({ code: "invalid_sms_suppression_response" });

    const addFetch = vi.fn(async () =>
      response({ ...ROW, phone_e164: "+12025550102" }, 201),
    );
    await expect(
      new PostwaveClient({
        apiKey: "pw_test_admin",
        fetch: addFetch,
        retries: 0,
      }).sms.addSuppression({ phone: ROW.phone_e164, reason: "manual" }),
    ).rejects.toMatchObject({ code: "invalid_sms_suppression_response" });
  });
});
