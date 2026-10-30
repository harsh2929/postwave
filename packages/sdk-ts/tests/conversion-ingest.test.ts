import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import {
  ConflictError,
  PostwaveClient,
  computeConversionEmailHMACSHA256,
  computeConversionIngestSignatureHex,
} from "../src/index.js";

const credentials = {
  keyId: "orders-primary",
  secret: "sk_conversion_test_super_secret",
};
const timestamp = 1_786_242_151;

function independentSignature(body: string, keyId = credentials.keyId): string {
  const keyBytes = Buffer.byteLength(keyId, "utf8");
  const timestampText = String(timestamp);
  const timestampBytes = Buffer.byteLength(timestampText, "utf8");
  const preimage = Buffer.concat([
    Buffer.from(
      `postwave-conversion-v2\n${keyBytes}\n${keyId}${timestampBytes}\n${timestampText}`,
      "utf8",
    ),
    Buffer.from(body, "utf8"),
  ]);
  return createHmac("sha256", credentials.secret).update(preimage).digest("hex");
}

describe("ConversionIngestResource", () => {
  it("signs and sends the exact single/batch bytes without bearer or tenant headers", async () => {
    const requests: Array<{
      url: string;
      headers: Record<string, string>;
      body: string;
    }> = [];
    const fetch = vi.fn(async (url: string, init: RequestInit = {}) => {
      requests.push({
        url,
        headers: init.headers as Record<string, string>,
        body: String(init.body),
      });
      return new Response(
        JSON.stringify({
          accepted: url.endsWith("/batch") ? 2 : 1,
          conversion_ids: url.endsWith("/batch") ? [41, 42] : [40],
          key_id: credentials.keyId,
        }),
        { status: 202, headers: { "content-type": "application/json" } },
      );
    });
    const client = new PostwaveClient({
      apiKey: "pw_dashboard_must_not_leak",
      tenantSlug: "tenant-must-not-leak",
      defaultHeaders: {
        authorization: "Bearer default-must-not-leak",
        "x-tenant-slug": "default-tenant-must-not-leak",
      },
      fetch,
      retries: 0,
    });
    const conversion = {
      event_name: "purchase",
      occurred_at: "2026-08-09T10:22:31Z",
      identity: { external_id: "customer-1" },
      value: 129,
      currency: "USD",
      metadata: { order_id: "ord-1" },
    };

    const single = await client.conversionIngest.ingest(
      conversion,
      credentials,
      { timestamp, idempotencyKey: "order-1" },
    );
    const batch = await client.conversionIngest.ingestBatch(
      [conversion, { ...conversion, identity: { click_id: "click-2" } }],
      credentials,
      { timestamp, idempotencyKey: "orders-batch-1" },
    );

    expect(single).toEqual({ accepted: 1, conversion_ids: [40], key_id: "orders-primary" });
    expect(batch.accepted).toBe(2);
    expect(requests.map((request) => request.url)).toEqual([
      "https://api.moosewave.com/api/public/conversions/ingest",
      "https://api.moosewave.com/api/public/conversions/ingest/batch",
    ]);
    for (const request of requests) {
      const lowerHeaders = Object.fromEntries(
        Object.entries(request.headers).map(([key, value]) => [key.toLowerCase(), value]),
      );
      expect(lowerHeaders.authorization).toBeUndefined();
      expect(lowerHeaders["x-tenant-slug"]).toBeUndefined();
      expect(lowerHeaders["x-postwave-timestamp"]).toBe(String(timestamp));
      expect(lowerHeaders["content-type"]).toBe("application/json");
      expect(lowerHeaders["x-postwave-signature"]).toBe(
        `keyid=${credentials.keyId},v2=${independentSignature(request.body)}`,
      );
    }
    expect(requests[0]?.headers["Idempotency-Key"]).toBe("order-1");
    expect(requests[1]?.headers["Idempotency-Key"]).toBe("orders-batch-1");
    expect(JSON.parse(requests[0]?.body ?? "{}")).toEqual(conversion);
    expect(JSON.parse(requests[1]?.body ?? "{}")).toEqual({
      conversions: [conversion, { ...conversion, identity: { click_id: "click-2" } }],
    });
  });

  it("binds the routing key and rejects unsafe values before transport", async () => {
    const body = `{"event_name":"purchase","identity":{"external_id":"c-1"}}`;
    const good = await computeConversionIngestSignatureHex(body, credentials, timestamp);
    const other = await computeConversionIngestSignatureHex(
      body,
      { ...credentials, keyId: "orders-secondary" },
      timestamp,
    );
    expect(good).toBe(independentSignature(body));
    expect(other).not.toBe(good);

    const identityHMAC = await computeConversionEmailHMACSHA256(
      "  Buyer@Example.COM  ",
      credentials,
    );
    expect(identityHMAC).toBe(
      createHmac("sha256", credentials.secret)
        .update("buyer@example.com")
        .digest("hex"),
    );
    expect(
      await computeConversionEmailHMACSHA256("buyer@example.com", {
        ...credentials,
        secret: "a-rotated-secret",
      }),
    ).not.toBe(identityHMAC);

    const fetch = vi.fn();
    const client = new PostwaveClient({ apiKey: "pw_test", fetch, retries: 0 });
    expect(() => client.conversionIngest.ingestBatch([], credentials)).toThrow(/1 to 500/);
    expect(() =>
      client.conversionIngest.ingest(
        { event_name: "purchase", identity: {} },
        credentials,
      ),
    ).toThrow(/identity/);
    await expect(
      client.conversionIngest.ingest(
        { event_name: "purchase", identity: { external_id: "c" } },
        { ...credentials, keyId: "unsafe,key" },
      ),
    ).rejects.toThrow(/keyId/);
    expect(() =>
      client.conversionIngest.ingest(
        {
          event_name: "purchase",
          identity: { email_hmac_sha256: "not-a-digest" },
        },
        credentials,
      ),
    ).toThrow(/email_hmac_sha256/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("preserves the flat public error code as a typed conflict", async () => {
    const client = new PostwaveClient({
      apiKey: "pw_test",
      retries: 0,
      fetch: vi.fn(async () =>
        new Response(
          JSON.stringify({
            error: "idempotency_conflict",
            message: "different bytes",
          }),
          { status: 409, headers: { "content-type": "application/json" } },
        ),
      ),
    });
    try {
      await client.conversionIngest.ingest(
        { event_name: "purchase", identity: { external_id: "c-1" } },
        credentials,
        { timestamp, idempotencyKey: "conflict-1" },
      );
      expect.fail("expected conflict");
    } catch (error) {
      expect(error).toBeInstanceOf(ConflictError);
      expect((error as ConflictError).code).toBe("idempotency_conflict");
      expect((error as ConflictError).message).toBe("different bytes");
    }
  });
});
