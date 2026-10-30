/**
 * The manual push-add's pure rules: the client echo of the handler's token
 * validation (pushsuppressions/handlers.go validateToken), the pinned wire
 * body, and the add receipt's authority check — which must refuse any row
 * that is not this tenant's own manual dashboard authority.
 */
import { describe, expect, it } from "vitest";

import {
  parsePushSuppressionAddReceipt,
  pushSuppressionAddBody,
  pushTokenProblem,
  PUSH_TOKEN_MAX_BYTES,
  PUSH_TOKEN_MIN_BYTES,
} from "./pushSuppressionAdd";

const TENANT = "11111111-1111-4111-8111-111111111111";
const GOOD_TOKEN = "a".repeat(64);

function receipt(over: Record<string, unknown> = {}) {
  return {
    id: "33333333-3333-4333-8333-333333333333",
    tenant_id: TENANT,
    device_token_hash: "0123456789abcdef",
    platform: "apns",
    reason: "manual",
    source: "dashboard",
    created_at: "2026-08-29T09:00:00Z",
    updated_at: "2026-08-29T09:00:00Z",
    version: 1,
    reversible: true,
    ...over,
  };
}

describe("pushTokenProblem — the handler's byte rules, said before the request", () => {
  it("accepts a real-shaped token", () => {
    expect(pushTokenProblem(GOOD_TOKEN)).toBeNull();
    expect(pushTokenProblem("x".repeat(PUSH_TOKEN_MIN_BYTES))).toBeNull();
    expect(pushTokenProblem("x".repeat(PUSH_TOKEN_MAX_BYTES))).toBeNull();
  });

  it("rejects a token outside 20–4096 bytes", () => {
    expect(pushTokenProblem("short")).toMatch(/20–4096 bytes/u);
    expect(pushTokenProblem("x".repeat(PUSH_TOKEN_MAX_BYTES + 1))).toMatch(
      /20–4096 bytes/u,
    );
  });

  it("counts BYTES, not characters, like the server does", () => {
    // 10 four-byte emoji = 40 bytes: acceptable; 4 of them = 16 bytes: not.
    expect(pushTokenProblem("😀".repeat(10))).toBeNull();
    expect(pushTokenProblem("😀".repeat(4))).toMatch(/bytes/u);
  });

  it("rejects whitespace and control characters anywhere in the token", () => {
    expect(pushTokenProblem(`${GOOD_TOKEN} tail`)).toMatch(/no spaces/u);
    expect(pushTokenProblem(`${GOOD_TOKEN}\n`)).toMatch(/no spaces/u);
    expect(pushTokenProblem(`${GOOD_TOKEN}\u0007`)).toMatch(/no spaces/u);
  });

  it("rejects a lone surrogate instead of counting it", () => {
    expect(pushTokenProblem(`${GOOD_TOKEN}\uD800`)).toMatch(/cannot be sent/u);
  });
});

describe("pushSuppressionAddBody", () => {
  it("pins the wire shape and the only reason the server admits", () => {
    expect(
      pushSuppressionAddBody({ deviceToken: GOOD_TOKEN, platform: "fcm" }),
    ).toEqual({ device_token: GOOD_TOKEN, platform: "fcm", reason: "manual" });
  });
});

describe("parsePushSuppressionAddReceipt", () => {
  it("accepts the tenant's own manual dashboard authority for the requested platform", () => {
    expect(
      parsePushSuppressionAddReceipt(receipt(), { tenantId: TENANT, platform: "apns" }),
    ).toMatchObject({ tenantId: TENANT, platform: "apns", version: 1 });
  });

  it("refuses a row from another tenant", () => {
    expect(() =>
      parsePushSuppressionAddReceipt(
        receipt({ tenant_id: "44444444-4444-4444-8444-444444444444" }),
        { tenantId: TENANT, platform: "apns" },
      ),
    ).toThrow(/could not be verified/u);
  });

  it("refuses a platform other than the one requested", () => {
    expect(() =>
      parsePushSuppressionAddReceipt(receipt({ platform: "fcm" }), {
        tenantId: TENANT,
        platform: "apns",
      }),
    ).toThrow(/could not be verified/u);
  });

  it("refuses anything but a reversible manual dashboard authority", () => {
    for (const over of [
      { reason: "complaint" },
      { source: "provider" },
      { reversible: false },
      { version: 0 },
    ]) {
      expect(() =>
        parsePushSuppressionAddReceipt(receipt(over), {
          tenantId: TENANT,
          platform: "apns",
        }),
      ).toThrow(/could not be verified/u);
    }
  });

  it("refuses non-row, partial, and expanded wire shapes", () => {
    const partial: Record<string, unknown> = receipt();
    delete partial.created_at;
    expect(() =>
      parsePushSuppressionAddReceipt(null, { tenantId: TENANT, platform: "apns" }),
    ).toThrow(/could not be verified/u);
    expect(() =>
      parsePushSuppressionAddReceipt(partial, {
        tenantId: TENANT,
        platform: "apns",
      }),
    ).toThrow(/could not be verified/u);
    expect(() =>
      parsePushSuppressionAddReceipt(receipt({ extra: true }), {
        tenantId: TENANT,
        platform: "apns",
      }),
    ).toThrow(/could not be verified/u);
  });
});
